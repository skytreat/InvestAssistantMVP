/**
 * 行情库可用性判定 —— **三档切换 + 两层开关**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 🔴 **背景（2026-10-19/21 实测）**
 *
 * CI 环境**没有真实行情库** —— 仓库里的 `data/quotes.duckdb` 只是 12KB 的**空壳**
 * （无 `v_stock_qfq` 等表），而本地开发机指向 `/opt/invol/quotes.duckdb`（1.24GB 真数据）。
 * 于是「依赖真实行情数据」的测试在**本地全绿、CI 全红**（PR #15 后续 24 个 commit
 * 从未过 CI 就是这个原因）。
 *
 * ⚠️ **不能用 `fs.existsSync` 判定** —— CI 里那个空壳文件**是存在的**，
 *   但里面没有表 → 必须探测**表是否存在**。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 📐 **三档切换**（env `MARKET_DATA_MODE`）
 *
 * | 档 | 取值 | 行情库来源 | 用途 |
 * |---|---|---|---|
 * | dev  | `mini`  | 磁盘上已有的迷你库（`data/quotes.mini.duckdb`）| 本地开发 |
 * | CI   | `ci`    | **现生成**（临时目录，每次 CI 跑现建）| CI |
 * | full | `full`  | **真库**（`DUCKDB_PATH`，**显式**指定）| 规模/性能实测 |
 * | auto | `auto`  | `DUCKDB_PATH` 有值 → full；否则 → mini | **默认** |
 *
 * `auto` 的默认行为刻意保持向后兼容：**本机 `.env.local` 里有 `DUCKDB_PATH`** → 走 full；
 * **CI 没有** → 走 mini（由已入库的 Parquet 现生成）。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 📐 **两层开关**（能力分级）—— 解决「一个 `MARKET_DATA_AVAILABLE` 混了两类」的问题
 *
 * | 能力 | 迷你库能否 | 真库能否 | 判据 |
 * |---|---|---|---|
 * | `numeric`（数值型）    | ✅ 可信 | ✅ | 迷你库是���库的**逐位一致子集**（实测 6 张视图 34839 行 0 差异）|
 * | `scale`（规模型）      | ❌ | ✅ | 迷你库只有 250 只标的（真库 12449）|
 * | `performance`（性能型）| ❌ | ✅ | 迷你库测不出「5000 标的 ≤3s」|
 *
 * ⚠️ **一个开关混两类是最危险的**：迷你库能过「数值对不对」，但**过不了**「规模够不够」
 *   —— 用 `MARKET_DATA_AVAILABLE` 统一守卫，会让 F7/PE2 在迷你库上**假装通过**。
 *   ⇒ 规模/性能类用例必须用 {@link marketDataSupports} 的 `scale` / `performance` 守卫。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 🔴 **生效时机（本文件是测试辅助，必须在 `src/db/duckdb.ts` 之前求值）**
 *
 * `src/db/duckdb.ts` 在**模块加载时**快照 `process.env.DUCKDB_PATH`：
 *   `const DUCKDB_PATH = process.env.DUCKDB_PATH ?? path.resolve(...'data/quotes.duckdb')`
 * ⇒ 档位解析必须**在本文件模块体里同步完成**（含迷你库的同步构建），
 *   否则 duckdb.ts 会拿到切换前的旧路径。
 *   本文件被测试文件**静态 import**（先于它们对 `src/db/duckdb.js` 的动态 import）→ 顺序成立。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

/** 判定用��表（真实行情库的标志） */
const PROBE_TABLE = 'v_stock_qfq';

/** 迷你库的 Parquet 源（**入库形态 = Parquet**，不是二进制 .duckdb） */
const MINI_PARQUET_DIR = path.join(REPO_ROOT, 'apps/backend/tests/fixtures/mini-market');
/** 迷你库生成脚本 */
const MINI_BUILDER = path.join(REPO_ROOT, 'scripts/make-mini-duckdb.mjs');
/** dev 档：磁盘上的迷你库（gitignored，靠 `make-mini-duckdb.mjs build` 生成） */
const MINI_DB_PATH = path.join(REPO_ROOT, 'data/quotes.mini.duckdb');
/** CI 档：临时目录里的迷你库（现生成，不入库） */
const CI_MINI_DB_PATH = path.join(os.tmpdir(), 'invest-mini-market', 'quotes.mini.duckdb');

// ════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════

/** 行情库档位 */
export type MarketDataTier = 'none' | 'mini' | 'full';

/** 行情库可信能力（两层开关） */
export type MarketDataCapability = 'numeric' | 'scale' | 'performance';

/** 三档模式（env `MARKET_DATA_MODE`） */
export type MarketDataMode = 'auto' | 'mini' | 'ci' | 'full';

// ════════════════════════════════════════════════════════════════════════
// 档位解析（**同步**，在模块体里完成 —— 见文件头「生效时机」）
// ════════════════════════════════════════════════════════════════════════

/** 迷你库构建器（同步执行；失败返回 false 而不是抛 —— 不能让测试进程崩在 import 阶段） */
function buildMiniDb(outFile: string): boolean {
  if (!fs.existsSync(MINI_PARQUET_DIR)) {
    console.warn(`[marketData] ⚠️ 找不到迷你库 Parquet 目录：${MINI_PARQUET_DIR} —— 行情库用例将**跳过**`);
    return false;
  }
  if (!fs.existsSync(MINI_BUILDER)) {
    console.warn(`[marketData] ⚠️ 找不到迷你库生成脚本：${MINI_BUILDER} —— 行情库用例将**跳过**`);
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    execFileSync(process.execPath, [MINI_BUILDER, 'build', '--parquet', MINI_PARQUET_DIR, '--out', outFile], {
      stdio: 'pipe',
      cwd: REPO_ROOT,
    });
    return fs.existsSync(outFile);
  } catch (err) {
    console.warn(
      `[marketData] ⚠️ 迷你库构建失败：${err instanceof Error ? err.message : String(err)} —— 行情库用例将**跳过**`,
    );
    return false;
  }
}

/** 解析结果 */
interface ResolvedMarketData {
  tier: MarketDataTier;
  /** 实际使用的 DuckDB 路径（tier='none' 时为 null） */
  path: string | null;
  mode: MarketDataMode;
}

let _resolved: ResolvedMarketData | null = null;

/**
 * 解析行情库档位（**同步**，幂等）
 *
 * ⚠️ 副作用：解析成功时会**写 `process.env.DUCKDB_PATH`** ——
 *   `src/db/duckdb.ts` 在模块加载时快照该变量，必须在它之前完成。
 */
export function resolveMarketData(): ResolvedMarketData {
  if (_resolved) return _resolved;

  const rawMode = (process.env.MARKET_DATA_MODE ?? 'auto').trim().toLowerCase();
  const mode: MarketDataMode = (
    rawMode === 'mini' || rawMode === 'ci' || rawMode === 'full' ? rawMode : 'auto'
  ) as MarketDataMode;

  const resolve = (): ResolvedMarketData => {
    switch (mode) {
      case 'full': {
        // 显式要求真库 —— 必须有 DUCKDB_PATH
        const p = process.env.DUCKDB_PATH;
        if (!p) {
          console.warn('[marketData] ⚠️ MARKET_DATA_MODE=full 但未设 DUCKDB_PATH —— 行情库用例将**跳过**');
          return { tier: 'none', path: null, mode };
        }
        return { tier: 'full', path: p, mode };
      }
      case 'mini': {
        if (!fs.existsSync(MINI_DB_PATH)) buildMiniDb(MINI_DB_PATH);
        return fs.existsSync(MINI_DB_PATH)
          ? { tier: 'mini', path: MINI_DB_PATH, mode }
          : { tier: 'none', path: null, mode };
      }
      case 'ci': {
        if (!fs.existsSync(CI_MINI_DB_PATH)) buildMiniDb(CI_MINI_DB_PATH);
        return fs.existsSync(CI_MINI_DB_PATH)
          ? { tier: 'mini', path: CI_MINI_DB_PATH, mode }
          : { tier: 'none', path: null, mode };
      }
      case 'auto':
      default: {
        // 有 DUCKDB_PATH → full（真库）；否则 → mini（现生成）
        const p = process.env.DUCKDB_PATH;
        if (p) return { tier: 'full', path: p, mode };
        if (!fs.existsSync(MINI_DB_PATH)) buildMiniDb(MINI_DB_PATH);
        return fs.existsSync(MINI_DB_PATH)
          ? { tier: 'mini', path: MINI_DB_PATH, mode }
          : { tier: 'none', path: null, mode };
      }
    }
  };

  _resolved = resolve();
  if (_resolved.tier !== 'none' && _resolved.path) {
    // 🔴 关键副作用：让 `src/db/duckdb.ts`（模块加载时快照）拿到切换后的路径
    process.env.DUCKDB_PATH = _resolved.path;
  }
  return _resolved;
}

// ════════════════════════════════════════════════════════════════════════
// 探测（异步）
// ════════════════════════════════════════════════════════════════════════

/**
 * 真实行情库是否可用（含 `v_stock_qfq` 表）
 *
 * 判定过程：
 *   1. 文件存在？   → 否则 false
 *   2. 能打开？     → 否则 false
 *   3. 有 `v_stock_qfq` 表？ → 否则 false
 *
 * ⚠️ **打开时必须 `readOnly: true`** —— DuckDB 的文件锁是排他的，
 *   以读写方式打开会与后端进程抢锁。
 *
 * 🔴 **重试 3 次**（2026-10-21 实测）：文件存在但打开失败，通常是**瞬时锁冲突**
 *   （另一个进程刚好在写库，如 tdx2db 定时器、或上一轮测试残留的实例）。
 *   一次失败就 false ⇒ 依赖行情库的用例会**静默 skip** —— 对 🔒 硬门槛（如 F7）
 *   就是**假绿**。故这里重试 3 次（间隔 300ms），只有连续失败才判 false。
 */
export async function detectMarketDataAvailable(): Promise<boolean> {
  const resolved = resolveMarketData();
  const dbPath = resolved.path;
  if (!dbPath || !fs.existsSync(dbPath)) return false;
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { DuckDBInstance } = require('@duckdb/node-api');
      // ⚠️ `connect()` 是**异步**的（返回 Promise）—— 少 await 会拿到 Promise，
      //    后面 `.runAndReadAll` 不存在 → 被 catch 吞掉 → 误判为「无行情库」。
      const inst = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
      try {
        const conn = await inst.connect();
        try {
          // ⚠️ `runAndReadAll()` 也是**异步**的 —— 少 await 会拿到 Promise，
          //    `.getRows` 不存在 → 被 catch 吞掉 → 误判为「无行情库」。
          const res = await conn.runAndReadAll(
            `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_name = '${PROBE_TABLE}'`,
          );
          const rows = res.getRows();
          return rows.length > 0 && Number(rows[0][0]) > 0;
        } finally {
          conn.closeSync();
        }
      } finally {
        inst.closeSync();
      }
    } catch {
      // 瞬时锁冲突 → 重试；连续失败才判「无行情库」
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      console.warn(
        `[marketData] 探测行情库失败（重试 ${attempts} 次）：${dbPath} —— 依赖行情库的用例将**跳过**`,
      );
      return false;
    }
  }
  return false;
}

/**
 * 真实行情库是否可用
 *
 * ⚠️ **同步判定**：`@duckdb/node-api` 的 `connect()` 是异步的，顶层 await 在
 *   CommonJS 转换下不稳 → 这里用 `createRequire` 同步加载 DuckDB 的**同步** API
 *   不可行（该库只有异步 API）。
 *   → 折中：用一个**同步的探测**（读文件头判断是否含 `v_stock_qfq` 的表定义太脆弱），
 *     改为在**测试文件顶层 await** 时显式等待 —— 故这里导出函数 + 一个惰性缓存。
 */
let _cached: boolean | null = null;

/** 真实行情库是否可用（首次调用时判定并缓存） */
export async function marketDataAvailable(): Promise<boolean> {
  if (_cached === null) _cached = await detectMarketDataAvailable();
  return _cached;
}

// ════════════════════════════════════════════════════════════════════════
// 两层开关（能力分级）
// ════════════════════════════════════════════════════════════════════════

/** 当前行情库档位（'none' = 完全没有可用行情库） */
export function marketDataTier(): MarketDataTier {
  return resolveMarketData().tier;
}

/**
 * 行情库是否支持某项能力（**两层开关**）
 *
 * - `numeric`：任何可用档位都支持 —— 迷你库是真库的**逐位一致子集**
 *   （实测：10 张表行数全等、6 张视图 34839 行 0 数值差异、视图 DDL 逐字一致）
 * - `scale` / `performance`：**只有真库**支持 —— 迷你库只有 250 只标的
 *   （实测 stock 104 只 vs 真库 5561 只），撑不起「5000 候选」，也测不出「≤3s」
 */
export function marketDataSupports(capability: MarketDataCapability): boolean {
  const tier = marketDataTier();
  if (tier === 'none') return false;
  if (capability === 'numeric') return true;
  return tier === 'full';
}

/** 数值型断言可用（迷你库即可） */
export function marketDataNumericAvailable(): boolean {
  return marketDataSupports('numeric');
}

/** 规模型断言可用（**必须真库**） */
export function marketDataScaleAvailable(): boolean {
  return marketDataSupports('scale');
}

/** 性能型断言可用（**必须真库**） */
export function marketDataPerformanceAvailable(): boolean {
  return marketDataSupports('performance');
}

/**
 * 行情库**已探测可用**（含 `v_stock_qfq` 表）**且**支持指定能力
 *
 * ⚠️ 为什么要有这个组合函数：`marketDataSupports()` 只看**档位**（同步），
 *   不知道库文件是否真的有表（如 CI 那个 12KB 空壳）。
 *   → 规模/性能类用例必须用**这个**（异步探测 + 能力判定）来守卫，
 *   否则会出现「档位是 full 但库是空壳」⇒ 用例红而不是 skip。
 *
 * @example
 * ```ts
 * const itScale = (await marketDataUsableFor('scale')) ? it : it.skip;
 * ```
 */
export async function marketDataUsableFor(capability: MarketDataCapability): Promise<boolean> {
  if (!(await marketDataAvailable())) return false;
  return marketDataSupports(capability);
}

/** 统一的跳过原因文案（便于 CI 日志里看懂为什么少跑了用例） */
export const SKIP_REASON_NO_MARKET_DATA =
  '需要真实行情库（v_stock_qfq 表）；CI 环境只有 12KB 空壳，无行情数据';

/** 规模/性能型用例的跳过原因文案 */
export const SKIP_REASON_NO_SCALE_DATA =
  '需要**真库**（≥5000 标的）才能验证规模/性能；迷你库只有 250 只标的，撑不起该门槛';

// ════════════════════════════════════════════════════════════════════════
// 🔴 **模块体里就解析一次**（import 本文件即生效）
//
// 理由：`src/db/duckdb.ts` 在**模块加载时**快照 `process.env.DUCKDB_PATH`。
// 若解析只发生在 `marketDataAvailable()` 被调用时，而某个测试文件**静态** import
// 了 `src/db/duckdb.js`（早于本文件的 import 求值），duckdb.ts 就会拿到**切换前**的旧路径。
// → 在本文件模块体里先解析并写好 `process.env.DUCKDB_PATH`，把顺序问题从根上消掉。
//
// ⚠️ 必须放在文件**末尾**：`resolveMarketData()` 会读写模块级 `let _resolved`，
//    提前调用会撞上 TDZ（let 声明前不可访问）。
// ════════════════════════════════════════════════════════════════════════
resolveMarketData();
