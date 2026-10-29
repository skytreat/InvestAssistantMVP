/**
 * admin.test.ts — API 集成测试（admin 管理链路）
 *
 * 覆盖 SDD §12.4 admin 类：
 *   - POST /api/admin/datacheck/trigger → 200 + summaries[]
 *   - POST /api/admin/run-signal → 200 + stats
 *   - GET /api/admin/system-log 分页 + filter
 *   - 非 admin → 403 FORBIDDEN（已在 auth.test.ts 覆盖，这里可以轻量）
 *   - **G7.4 · 全部 admin 端点逐端点 403**（普通用户 → 403 FORBIDDEN + 零副作用）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, makeUserToken } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;
let userToken: string; // role=user（非 admin）—— 用来断言 admin 端点对普通用户 403
let normalUserId = 0; // 普通用户 id —— 用于 PATCH /api/admin/role/:userId 的越权探测
const DUCKDB_PATH = process.env.DUCKDB_PATH ?? path.resolve('data', 'quotes.duckdb');
const DUCKDB_EXISTS = fs.existsSync(DUCKDB_PATH);

beforeAll(async () => {
  bundle = await createTestApp();
  // 造一个普通用户（直接 INSERT 绕开 seed 的 409），拿它的 token 测 403
  const adminHash = bundle.db.db
    .prepare('SELECT password_hash FROM user_account WHERE username = ?')
    .get('int_admin') as { password_hash: string };
  bundle.db.db
    .prepare('INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, ?, ?)')
    .run('int_normal', adminHash.password_hash, 'user');
  const row = bundle.db.db.prepare('SELECT id FROM user_account WHERE username = ?').get('int_normal') as {
    id: number;
  };
  normalUserId = row.id;
  userToken = makeUserToken(row.id, 'int_normal');
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
});

function adminHeaders() {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

describe('Admin · run-datacheck', () => {
  it('admin 触发 → 200 + summaries 数组', async () => {
    if (!DUCKDB_EXISTS) return;
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/admin/datacheck/trigger',
      headers: adminHeaders(),
      payload: {},
    });
    // DuckDB 慢或缺表时 validator 可能返回部分 ERROR
    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body);
      expect(body.code).toBe(0);
      expect(Array.isArray(body.data.summaries)).toBe(true);
      expect(body.data.summaries.length).toBeGreaterThan(0);
    }
  }, 90_000);

  it('指定 trade_date → summaries 用该日期', async () => {
    if (!DUCKDB_EXISTS) return;
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/admin/datacheck/trigger',
      headers: adminHeaders(),
      payload: { trade_date: '2026-10-14' },
    });
    expect([200, 500]).toContain(res.statusCode);
  }, 90_000);
});

describe('Admin · run-signal', () => {
  it('admin 触发信号生成 → 200 + stats', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/admin/run-signal',
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);
    expect(body.data.stats).toBeDefined();
    expect(typeof body.data.stats.total).toBe('number');
    expect(typeof body.data.stats.success).toBe('number');
    expect(typeof body.data.stats.timeout).toBe('number');
    expect(typeof body.data.stats.error).toBe('number');
  }, 30000);
});

describe('Admin · system-log 分页查询', () => {
  // 🔴 T81 顺序依赖修复：本块断言「至少有 1 条 system_log」，
  //   原本靠同文件前面的用例产生日志 → shuffle 下随机失败。
  //   → 块级 beforeAll 自己造一条 log。
  beforeAll(() => {
    bundle.db.db
      .prepare(
        "INSERT INTO system_log (log_date, log_type, level, message) VALUES (date('now','localtime'), 'trade', 'INFO', '分页测试用日志')",
      )
      .run();
  });

  // 先造条 log 验证分页
  it('log 分页基本结构', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log?page=1&page_size=5',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.pageSize).toBe(5);
    expect(typeof body.pagination.total).toBe('number');
    expect(body.pagination.totalPages).toBeGreaterThanOrEqual(1);
  });

  it('log_type 过滤', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log?log_type=trade&page_size=3',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // 每行都得是 trade
    for (const row of body.data) {
      expect(row.log_type).toBe('trade');
    }
  });

  it('默认 page=1 / page_size 超限自动截断到 200', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log?page=999&page_size=9999',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pagination.pageSize).toBe(200); // min(200, 9999)
    // page=999 可能超过总行数 → data=[] 是合理的
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe('Admin · system-log 日期区间过滤（Wave 7 · 卡 1 · 裁决 D-3）', () => {
  // 区间过滤的判据：`system_log.log_date` 是 `YYYY-MM-DD` 定长格式 → 直接字符串比较
  const RANGE_START = '2026-10-05';
  const RANGE_END = '2026-10-15';

  beforeAll(() => {
    const insert = bundle.db.db.prepare(
      "INSERT INTO system_log (log_date, log_type, level, message) VALUES (?, 'trade', 'INFO', ?)",
    );
    insert.run('2026-10-01', '区间过滤-之前');
    insert.run('2026-10-10', '区间过滤-区间内');
    insert.run('2026-10-21', '区间过滤-之后');
  });

  it('admin 日志区间过滤：start_date/end_date 只返回区间内行', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: `/api/admin/system-log?start_date=${RANGE_START}&end_date=${RANGE_END}&page_size=200`,
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);

    // 每一条都在区间内（闭区间）
    for (const row of body.data) {
      expect(row.log_date >= RANGE_START).toBe(true);
      expect(row.log_date <= RANGE_END).toBe(true);
    }

    // 区间外的行不返回
    const messages = body.data.map((r: { message: string }) => r.message);
    expect(messages).toContain('区间过滤-区间内');
    expect(messages).not.toContain('区间过滤-之前');
    expect(messages).not.toContain('区间过滤-之后');
  });

  it('单日 trade_date 仍可用（历史参数语义不变：等值）', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log?trade_date=2026-10-10&page_size=200',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    for (const row of body.data) {
      expect(row.log_date).toBe('2026-10-10');
    }
    const messages = body.data.map((r: { message: string }) => r.message);
    expect(messages).toContain('区间过滤-区间内');
    expect(messages).not.toContain('区间过滤-之前');
    expect(messages).not.toContain('区间过滤-之后');
  });

  it('只给 start_date → 开区间（返回该日及之后）', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log?start_date=2026-10-05&page_size=200',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    for (const row of body.data) {
      expect(row.log_date >= '2026-10-05').toBe(true);
    }
    const messages = body.data.map((r: { message: string }) => r.message);
    expect(messages).toContain('区间过滤-区间内');
    expect(messages).toContain('区间过滤-之后');
    expect(messages).not.toContain('区间过滤-之前');
  });
});

describe('Admin · 系统日志降级记录（Wave 7 · 卡 1 · I-13）', () => {
  const tmpFile = path.join(os.tmpdir(), `invest-fallback-${process.pid}-${Date.now()}.log`);
  const missingFile = path.join(os.tmpdir(), `invest-fallback-missing-${process.pid}.log`);
  const origFallbackEnv = process.env.SYSTEM_LOG_FALLBACK_FILE;

  afterAll(() => {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {
      /* ignore */
    }
    if (origFallbackEnv === undefined) delete process.env.SYSTEM_LOG_FALLBACK_FILE;
    else process.env.SYSTEM_LOG_FALLBACK_FILE = origFallbackEnv;
  });

  it('admin 降级日志端点：普通用户 403 / admin 返回 exists+lines', async () => {
    // 1) 普通用户 → 403（G7.4「全部 admin 端点均 403」的一部分）
    const forbidden = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log/fallback',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(JSON.parse(forbidden.body).error).toBe('FORBIDDEN');

    // 2) admin + 兜底文件存在 → exists=true + 逐行内容
    fs.writeFileSync(
      tmpFile,
      '{"source":"invest-assistant","level":"ERROR","message":"降级第一行"}\n' +
        '{"source":"invest-assistant","level":"WARN","message":"降级第二行"}\n',
      'utf8',
    );
    process.env.SYSTEM_LOG_FALLBACK_FILE = tmpFile;

    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log/fallback',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);
    expect(body.data.exists).toBe(true);
    expect(body.data.lines).toHaveLength(2);
    expect(body.data.lines[0]).toContain('降级第一行');
    expect(body.data.lines[1]).toContain('降级第二行');

    // ⚠️ 响应体**不含文件路径**（路径泄露 = 告诉攻击者去读哪个文件）
    expect(res.body).not.toContain(tmpFile);
    expect(res.body).not.toContain('SYSTEM_LOG_FALLBACK_FILE');

    // 3) 兜底文件不存在 → 空态（exists:false / lines:[]），**不是错误**
    process.env.SYSTEM_LOG_FALLBACK_FILE = missingFile;
    const empty = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log/fallback',
      headers: adminHeaders(),
    });
    expect(empty.statusCode).toBe(200);
    const emptyBody = JSON.parse(empty.body);
    expect(emptyBody.code).toBe(0);
    expect(emptyBody.data.exists).toBe(false);
    expect(emptyBody.data.lines).toEqual([]);
  });
});

// ===========================================================================
// G7.4 · 管理员二次鉴权：**全部** admin 端点对普通用户一律 403
//
// 通过标准：「逐端点参数化 → 普通用户 token → 403 + code=FORBIDDEN + 零副作用」
//
// ⚠️ **端点清单是实测枚举**（2026-10-21），不是照抄旧文档：
//   `src/routes/admin.ts` 10 个 + `src/routes/dataCheck.ts` 1 个 = 11 个 `/api/admin/**`。
//   ⚠️ 端点清单与源码漂移 ⇒ 本用例会漏检 ⇒ **改 admin 路由时必须同步改这里**。
//
// ⚠️ **为什么要断言「零副作用」**：
//   光断言 403 只能证明「返回了 403」，不能证明「鉴权发生在副作用之前」。
//   若某个端点把 role 校验写在副作用**之后**（如先跑备份/先改角色/先落日志再 403），
//   响应仍是 403，但破坏已经造成 —— 这正是本用例要抓的**危险端点**。
//   ⇒ 每次请求前后对比「副作用快照」，一旦有变化即判定该端点鉴权顺序危险。
// ===========================================================================

interface AdminEndpointCase {
  method: 'GET' | 'POST' | 'PATCH';
  /** 路由路径（与源码里的字面量逐字一致，`:userId` 保持原样 ⇒ 可与源码做**精确集合比对**） */
  path: string;
  /** 实际请求路径；PATCH 的 :userId 在 beforeAll 后才确定 ⇒ 用函数延迟求值 */
  url: string | (() => string);
  /** 请求体（破坏性端点也带完整参数 ⇒ 证明它们是「本会成功」的请求被鉴权拦下） */
  payload?: Record<string, unknown>;
}

const ADMIN_ENDPOINTS: AdminEndpointCase[] = [
  // —— src/routes/admin.ts ——
  { method: 'GET', path: '/api/admin/system-log', url: '/api/admin/system-log' },
  {
    method: 'GET',
    path: '/api/admin/system-log/fallback',
    url: '/api/admin/system-log/fallback',
  },
  { method: 'GET', path: '/api/admin/backups', url: '/api/admin/backups' },
  { method: 'GET', path: '/api/admin/users', url: '/api/admin/users' },
  {
    method: 'PATCH',
    path: '/api/admin/role/:userId',
    // 目标 = 普通用户自己 ⇒ 若鉴权缺失，这一刀会把他升成 admin（最危险的越权）
    url: () => `/api/admin/role/${normalUserId}`,
    payload: { role: 'admin' },
  },
  {
    method: 'POST',
    path: '/api/admin/rerun-quotes',
    url: '/api/admin/rerun-quotes',
    payload: { reason: 'G7.4 越权探测' },
  },
  { method: 'POST', path: '/api/admin/backup', url: '/api/admin/backup', payload: {} },
  {
    method: 'POST',
    path: '/api/admin/backup/:file/restore',
    // confirm:true ⇒ 若鉴权在确认检查之后，会真的执行恢复 ⇒ 这里是最强的一档探测
    url: '/api/admin/backup/business.db.2000-01-01/restore',
    payload: { confirm: true },
  },
  { method: 'POST', path: '/api/admin/run-signal', url: '/api/admin/run-signal', payload: {} },
  {
    method: 'POST',
    path: '/api/admin/datacheck/trigger',
    url: '/api/admin/datacheck/trigger',
    payload: {},
  },
  {
    method: 'POST',
    path: '/api/admin/symbol-dict/refresh',
    url: '/api/admin/symbol-dict/refresh',
    payload: {},
  },
  // —— src/routes/dataCheck.ts ——
  { method: 'GET', path: '/api/admin/datacheck/result', url: '/api/admin/datacheck/result' },
];

/** 备份目录（取 backup 服务里的**同一个**常量，避免两处各算一遍 env 口径不一） */
let backupDirCache: string | null = null;
async function getBackupDir(): Promise<string> {
  if (backupDirCache === null) {
    const mod = await import('../../src/services/backup.js');
    backupDirCache = mod.BACKUP_DIR;
  }
  return backupDirCache;
}

/** 副作用快照：请求前后必须**完全一致**（证明鉴权发生在副作用之前） */
function snapshotSideEffects(backupDir: string) {
  const countLog = (logType: string): number =>
    (
      bundle.db.db.prepare('SELECT COUNT(*) AS c FROM system_log WHERE log_type = ?').get(logType) as {
        c: number;
      }
    ).c;
  const roleRow = bundle.db.db.prepare('SELECT role FROM user_account WHERE id = ?').get(normalUserId) as {
    role: string;
  };
  return {
    // 手动触发类端点（trigger_manual）与备份类端点（backup）都会留痕
    triggerManualLogs: countLog('trigger_manual'),
    backupLogs: countLog('backup'),
    // 普通用户的角色（PATCH /role 越权后会变）
    normalUserRole: roleRow.role,
    // 备份目录里的文件（POST /backup 越权后会多出产物）
    backupFiles: fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : [],
  };
}

describe('G7.4 · admin 端点逐端点 403（普通用户 · 管理员二次鉴权）', () => {
  /** 探测开始时刻（用于「本次探测有没有产出新备份文件」的时间窗判定） */
  let probeStartMs = 0;

  beforeAll(() => {
    probeStartMs = Date.now();
  });

  // 端点清单的完整性守卫：源码若新增/改名 admin 端点，这里必须同步
  it('清单与源码里的 /api/admin/** 端点**精确集合一致**（漂移即红）', async () => {
    const src = [
      fs.readFileSync(new URL('../../src/routes/admin.ts', import.meta.url), 'utf8'),
      fs.readFileSync(new URL('../../src/routes/dataCheck.ts', import.meta.url), 'utf8'),
    ].join('\n');
    // 从源码字面量里抽出「方法 + 路径」
    const declared = new Set(
      [...src.matchAll(/app\.(get|post|patch|put|delete)\(\s*'(\/api\/admin\/[^']*)'/g)].map(
        (m) => `${m[1].toUpperCase()} ${m[2]}`,
      ),
    );
    const covered = new Set(ADMIN_ENDPOINTS.map((e) => `${e.method} ${e.path}`));

    // ① 源码里每个端点都必须被清单覆盖（**精确比对**，不用 includes —— 否则
    //    '/api/admin/system-log' 会被 '/api/admin/system-log/fallback' 误配）
    for (const d of declared) {
      expect(covered.has(d), `源码里的 admin 端点 ${d} 未被 G7.4 清单覆盖`).toBe(true);
    }
    // ② 清单里也不能有源码已删掉的端点（避免清单腐化）
    for (const c of covered) {
      expect(declared.has(c), `G7.4 清单里的 ${c} 在源码中已不存在`).toBe(true);
    }
    // ③ 数量兜底（源码新增端点时这两条会先红）
    expect(declared.size).toBe(12);
    expect(covered.size).toBe(12);
  });

  it.each(ADMIN_ENDPOINTS)('$method $path → 普通用户 403 FORBIDDEN 且零副作用', async (ep) => {
    const backupDir = await getBackupDir();
    const before = snapshotSideEffects(backupDir);

    const url = typeof ep.url === 'function' ? ep.url() : ep.url;
    const res = await bundle.app.inject({
      method: ep.method,
      url,
      headers: { authorization: `Bearer ${userToken}` },
      ...(ep.payload ? { payload: ep.payload } : {}),
    });

    expect(res.statusCode, `${ep.method} ${ep.path} 必须 403`).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('FORBIDDEN');
    expect(body.error).toBe('FORBIDDEN');
    // 🔴 T89b：响应体**不再有** `success` 键
    expect('success' in body).toBe(false);
    expect(body.data).toBeNull();
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);

    // 🔴 副作用快照必须完全一致 —— 不一致即说明该端点「先副作用、后鉴权」
    expect(snapshotSideEffects(backupDir), `${ep.method} ${ep.path} 产生了副作用（鉴权顺序危险）`).toEqual(
      before,
    );
  });

  it('越权探测后：普通用户角色未被提升，且探测窗口内没有新的备份产物', async () => {
    const backupDir = await getBackupDir();

    // ① 普通用户角色没被提升（PATCH /api/admin/role/:userId 的越权收益为零）
    const role = bundle.db.db.prepare('SELECT role FROM user_account WHERE id = ?').get(normalUserId) as {
      role: string;
    };
    expect(role.role).toBe('user');

    // ② 探测窗口内**没有**新产出/被改写的备份文件
    //    ⚠️ 不能断言「目录里没有 business.db.*」—— 目录里可能有**历史遗留**的真实备份
    //    （cron 每天 17:05 产出），那是正常数据，不是本用例造的。
    const fresh: string[] = [];
    if (fs.existsSync(backupDir)) {
      for (const name of fs.readdirSync(backupDir)) {
        const full = path.join(backupDir, name);
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.mtimeMs >= probeStartMs) fresh.push(name);
      }
    }
    expect(fresh, '越权探测不得产出任何备份文件').toEqual([]);
  });
});
