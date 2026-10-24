/**
 * tests/http/_helpers.ts —— 「**真 listen**」HTTP 测试的共享 bootstrap
 *
 * ════════════════════════════════════════════════════════════════════════
 * 🔴 **为什么这个目录必须真 `listen()`**（AGENTS.md「测试分层与端口依赖」）
 * ════════════════════════════════════════════════════════════════════════
 *   `app.inject()` 走**内存**，不经 HTTP 传输层 ⇒ 测不了：
 *     · 真实往返耗时（PE2 / PE4 这类性能门槛**必须**含 socket 往返）
 *     · socket 层的真实行为（keep-alive / 并发 / 连接复用）
 *   ⇒ 本目录的每个文件都必须 `app.listen({ port, host: '127.0.0.1' })`，
 *     并用 {@link assertRealListen} 断言「**确实在监听**」——
 *     否则「用 inject() 测了却忘了 listen」会得到**恒绿**的假通过。
 *
 * ── 端口分配（AGENTS.md 端口分配表：其他测试用 51200-51999）──
 *   每个测试文件**独占一段**，避免并行跑时 `EADDRINUSE`：
 *     cors.test.ts              → 51200-51219
 *     https-se1.test.ts         → 51220-51239
 *     pe2-scan.test.ts          → 51240-51259
 *     pe4-holding-p99.test.ts   → 51260-51279
 *     pe5-sqlite-concurrency.test.ts → 51280-51299
 *     pe1-pe3-browser.test.ts   → 51300-51319
 *     holding-nplus1.test.ts    → 51320-51339
 *
 * ── SQLite 隔离 ──
 *   业务库用 `mkdtemp` 出来的**临时库**（`SQLITE_DB_PATH` 覆盖），
 *   ⇒ **绝不污染** `data/business.db`（AGENTS.md：开发库不是测试库）。
 *
 * ── 行情库档位 ──
 *   由 `tests/setup.ts` 的统一入口解析（`MARKET_DATA_MODE` + `DUCKDB_PATH`），
 *   本文件**不改** `DUCKDB_PATH`（改了会破坏档位解析）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录 */
export const REPO_ROOT = path.resolve(__dirname, '../../../..');
/** 后端源码根目录 */
export const BACKEND_SRC = path.resolve(__dirname, '../../src');

/** 监听地址（AGENTS.md 硬约束：只监听 127.0.0.1） */
export const HOST = '127.0.0.1';

/**
 * 🔴 **生产 CORS 白名单** —— 必须与 `src/server.ts` 的 `app.register(cors, …)` **逐字一致**。
 *
 * ⚠️ 为什么在这里复制一份而不是直接 import `server.ts`：
 *   `server.ts` 是**入口脚本**（顶层 `bootstrap()` 立即启动并 listen）⇒ 不能被测试 import。
 *   ⇒ 用 {@link readProductionCorsOrigins} 从源码里**解析**出生产白名单，
 *     并由 `cors.test.ts` 的口径守卫断言「本文件的白名单 == 生产白名单」——
 *     生产端改了 CORS 配置而测试没跟上 ⇒ 守卫立刻红（而不是悄悄测错口径）。
 */
export const PRODUCTION_CORS_ORIGINS: readonly string[] = ['http://127.0.0.1:5173', 'http://localhost:5173'];

/**
 * 从 `src/server.ts` 解析生产 CORS 白名单（口径守卫用）
 *
 * 解析失败（源码结构变了）⇒ **抛错**，不静默返回空数组 ——
 * 守卫的价值就在于「生产改了要能发现」。
 */
export function readProductionCorsOrigins(): string[] {
  const src = readFileSync(path.join(BACKEND_SRC, 'server.ts'), 'utf8');
  const m = src.match(/origin:\s*\[([^\]]*)\]/);
  if (!m) {
    throw new Error(
      '无法从 src/server.ts 解析 CORS 白名单（未匹配到 origin: [...]）—— 生产配置结构已变，测试口径需同步',
    );
  }
  // 生产用的是**反引号**模板字符串（`http://127.0.0.1:5173`）⇒ 三种引号都要认
  const found = [...m[1].matchAll(/'([^']+)'|"([^"]+)"|`([^`]+)`/g)]
    .map((x) => x[1] ?? x[2] ?? x[3])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (found.length === 0) {
    throw new Error('从 src/server.ts 解析到的 CORS 白名单为空 —— 生产配置结构已变，测试口径需同步');
  }
  return found;
}

// ── 临时 SQLite（整个 http 套件共用一个进程级临时库）──
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-http-'));

/** 本套件使用的临时业务库路径 */
export const SQLITE_DB_PATH = path.join(TMP_DIR, 'http-test.db');

process.env.SQLITE_DB_PATH = SQLITE_DB_PATH;

/**
 * 临时目录清理（**引用计数**）
 *
 * ⚠️ 为什么不能简单地「每个文件 afterAll 就删目录」：
 *   本套件的 7 个文件**共用**一个临时库（同一个进程、同一个 ConfigStore 单例）
 *   ⇒ 先跑完的文件删掉目录，后面文件还在用 ⇒ 会炸。
 * ⇒ 用**引用计数**：每个 `createHttpApp` +1，每个 `close()` -1；
 *   归零时（最后一个文件跑完）才删目录。
 *
 * ⚠️ 为什么还需要 `process.on('exit')` 兜底：
 *   实测 vitest 的 worker 退出时**不保证**触发 `exit` 回调
 *   （本次实测留下 49 个 `/tmp/invest-http-*` 残目录）⇒ 必须双保险。
 */
let activeApps = 0;
let tmpDirRemoved = false;

function removeTmpDir(): void {
  if (tmpDirRemoved) return;
  tmpDirRemoved = true;
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

process.on('exit', () => {
  removeTmpDir();
});

/**
 * 手动清理临时目录（给「**不创建 app**」的测试文件用）
 *
 * ⚠️ 例如 `https-se1.test.ts`（它起的是 Caddy，不需要 Fastify app）
 *   ⇒ 引用计数永远归不了零 ⇒ 必须显式调本函数收尾。
 */
export function cleanupTempDir(): void {
  removeTmpDir();
}

/**
 * 在 `[start, end]` 段内找一个空闲端口
 *
 * ⚠️ 必须**真的 bind 一下再关掉**才能确认空闲（`net.createServer().listen()`）。
 */
export async function findFreePort(start: number, end: number): Promise<number> {
  for (let p = start; p <= end; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(p, HOST);
    });
    if (free) return p;
  }
  throw new Error(`${start}-${end} 段没有空闲端口，http 测试无法真实 listen`);
}

/** 已启动的 HTTP 测试应用 */
export interface HttpTestApp {
  app: FastifyInstance;
  port: number;
  /** 形如 `http://127.0.0.1:51260` */
  baseUrl: string;
  /** 关闭并释放端口 */
  close: () => Promise<void>;
}

/**
 * 启动一个**真 listen** 的 Fastify 实例（生产 CORS 配置 + 全部路由）
 *
 * ⚠️ CORS 配置**必须与生产一致**（`src/server.ts`）——
 *   `tests/integration/_helpers.ts` 用的是 `origin: true`（放行任意来源），
 *   那是**测试便利配置**，用它测 CORS 必然恒绿 ⇒ CORS 用例必须走本函数。
 */
export async function createHttpApp(opts: {
  portStart: number;
  portEnd: number;
  logger?: boolean;
}): Promise<HttpTestApp> {
  const port = await findFreePort(opts.portStart, opts.portEnd);
  const app = Fastify({ logger: opts.logger ?? false });

  await app.register(cors, {
    origin: [...PRODUCTION_CORS_ORIGINS],
    credentials: true,
  });

  // 动态 import：确保 `SQLITE_DB_PATH` 已在模块体里设好之后才加载业务模块
  const { registerRoutes } = await import('../../src/routes/index.js');
  await registerRoutes(app);

  // 🔴 **真 listen**（不是 inject）
  await app.listen({ port, host: HOST });

  activeApps += 1;

  return {
    app,
    port,
    baseUrl: `http://${HOST}:${port}`,
    close: async () => {
      await app.close().catch(() => {});
      activeApps -= 1;
      // 最后一个应用关掉 ⇒ 临时目录可以删了（见文件头的引用计数说明）
      if (activeApps <= 0) removeTmpDir();
    },
  };
}

/**
 * 🔴 **「确实真 listen」守卫** —— 计划 §12.7 T60 ③ 的硬要求：
 *   「须断言该测试文件确实调了 `listen()`（放进 integration/ 用 `inject()` 测则恒绿 = 没测）」
 *
 * 三重证明（缺一不可）：
 *   ① `app.server.listening === true` —— Node 的 Server 真的在 listen
 *   ② `app.server.address().port` === 期望端口 —— 绑的是**预期那个**端口
 *   ③ **裸 socket 发一条真实 HTTP/1.1 请求并读到响应字节** ——
 *      这一条才是关键：`inject()` 根本不经过 socket，
 *      裸 socket 能拿到 `HTTP/1.1 200` ⇒ 证明请求真的走了 TCP。
 */
export async function assertRealListen(app: FastifyInstance, port: number): Promise<string> {
  // ① + ②
  if (!app.server.listening) {
    throw new Error('app.server.listening === false —— 本文件没有真正调用 listen()，测试是假绿');
  }
  const addr = app.server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
  if (boundPort !== port) {
    throw new Error(`监听端口不符：期望 ${port}，实际 ${boundPort}`);
  }

  // ③ 裸 socket 真实往返
  const raw = await rawHttpGet(port, '/api/health');
  if (!raw.startsWith('HTTP/1.1 200')) {
    throw new Error(`裸 socket 未拿到 200 响应（证明请求没走真实 TCP）：${raw.slice(0, 120)}`);
  }
  return raw;
}

/**
 * 裸 socket 发一条 HTTP/1.1 GET，返回**原始响应字节**（含状态行）
 *
 * ⚠️ 刻意**不用** `fetch`：fetch 走的是 undici 的连接池，
 *   「能拿到响应」不足以证明「服务端真的在 listen」——
 *   裸 socket 才能证明「有一个真实的 TCP 服务端在应答」。
 */
export function rawHttpGet(
  port: number,
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ port, host: HOST }, () => {
      const lines = [`GET ${requestPath} HTTP/1.1`, `Host: ${HOST}:${port}`, 'Connection: close'];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let buf = '';
    sock.setTimeout(10_000, () => {
      sock.destroy();
      reject(new Error(`裸 socket 请求超时：${requestPath}`));
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    sock.on('end', () => resolve(buf));
    sock.on('error', (err) => reject(err));
  });
}

/**
 * 业务库句柄（ConfigStore 的 better-sqlite3 实例）
 *
 * ⚠️ 用**动态 import** 而不是顶层静态 import：
 *   本文件在模块体里设了 `process.env.SQLITE_DB_PATH`，
 *   动态 import 能保证 ConfigStore **在该 env 设好之后**才被求值。
 */
export async function getDb(): Promise<any> {
  const { ConfigStore } = await import('../../src/config/configStore.js');
  return ConfigStore.getInstance().db;
}

/** 造一个测试用户（返回 user_id） */
export async function seedUser(userId: number, username: string): Promise<number> {
  const db = await getDb();
  db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
  ).run(userId, username, 'dummy-hash-for-http-tests');
  return userId;
}

/**
 * 造 N 只持仓（每个标的一条 buy）
 *
 * @param assetCodes 标的代码列表（长度 = 持仓只数）
 */
export async function seedHoldings(
  userId: number,
  assetCodes: string[],
  baseDate = '2026-01-05',
): Promise<void> {
  const db = await getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO user_trade_record
     (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
     VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, 0)`,
  );
  assetCodes.forEach((code, idx) => {
    insert.run(userId, code, baseDate, '09:30:00', 100, 10 + idx * 0.01, 0);
  });
}

/** 造一笔成交（PE5 并发写用） */
export async function seedTrade(
  userId: number,
  assetCode: string,
  tradeDate: string,
  tradeTime: string,
  quantity = 100,
  price = 10,
): Promise<void> {
  const db = await getDb();
  db.prepare(
    `INSERT OR IGNORE INTO user_trade_record
     (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
     VALUES (?, ?, 'buy', ?, ?, ?, ?, 0, 0)`,
  ).run(userId, assetCode, tradeDate, tradeTime, quantity, price);
}

/** 延迟统计（毫秒） */
export interface LatencyStats {
  count: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/**
 * 计算延迟分位数（**最近秩法 / nearest-rank**，与 autocannon 的口径一致）
 *
 * ⚠️ 口径说明：p99 = 排序后第 `ceil(0.99 × n)` 个样本（1-based），
 *   **不做插值** —— autocannon / wrk 都是这个口径。
 */
export function latencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx];
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/** 毫秒格式化（保留 1 位小数） */
export function fmtMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}
