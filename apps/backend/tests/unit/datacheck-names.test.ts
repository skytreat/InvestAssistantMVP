/**
 * datacheck-names.test.ts —— C1-C12 **名称契约** + **12 条补齐语义** + **编号边界**
 * （Wave 7 · 卡 3 · 🔒 G7.6 的后端侧载体）
 *
 * ## 为什么这三个断言必须放在后端
 *
 * G7.6 的原文是：
 * > 「12 项校验卡片真实渲染 12 条（不再是空态 / `checkId` 只有 2 个），
 * >   且卡片显示的**校验名称与 SDD §5.7 主表一致**
 * >   （停牌/退市/ST 等扩展校验**不得占用 C 编号**）」
 *
 * 拆成三个可自动验证的子句：
 *
 * | 子句 | 本文件的用例 |
 * |---|---|
 * | 名称与 SDD §5.7 逐字一致 | `datacheck 名称契约：…` |
 * | 12 条（少跑也要补齐） | `datacheck 补齐：…` |
 * | 扩展校验不占 C 编号 | `datacheck 编号边界：…` |
 *
 * ⚠️ **名称必须由后端出**（裁决 D-4）：前端硬编码 = 「前端自说自话 vs 前端自说自话」，
 *   名称一旦与 SDD 漂移，**没有任何一处会报错**（自证）⇒ G7.6 形同虚设。
 *   故本文件把 SDD §5.7 的 12 个小节标题**写死成期望数组**，
 *   与 `services/validator.ts` 导出的 `CHECK_NAMES` 逐字比对。
 *
 * ⚠️ **「最近一次校验日」不能靠 `MAX(log_date)`**（缺口 X-2）：
 *   开发库 `data/business.db` 的 `system_log` 里 `log_type='datacheck'` 的
 *   `MAX(log_date)` 是 **`2026-99-99`**（来自 `tests/unit/validator.test.ts` 里
 *   `runAllChecks('2026-99-99')` 的写入）⇒ 用它定位 = 被假日期劫持。
 *   本文件用 `2026-99-99` 作为回归样本，锁死「假日期不得劫持」。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-dc-names-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
// ⚠️ 必须在第一次 `ConfigStore.getInstance()` **之前**改写路径
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 'dc-names.db');

const { ConfigStore } = await import('../../src/config/configStore.js');
const { registerRoutes } = await import('../../src/routes/index.js');
const { signToken } = await import('../../src/services/auth.js');
const { CHECK_NAMES, CHECK_IDS } = await import('../../src/services/validator.js');

/**
 * SDD §5.7 主表的 12 个小节标题（**逐字**）
 *
 * ⚠️ 这是「名称与 SDD §5.7 一致」这条断言的**唯一判定基准** ——
 *   改这里等于改 SDD，须同步改 `docs/client/SDD.md` §5.7。
 */
const SDD_5_7_TITLES: ReadonlyArray<readonly [string, string]> = [
  ['C1', '当日日线行数是否正常'],
  ['C2', '交易日历匹配'],
  ['C3', '复权因子数据新鲜度'],
  ['C4', '除权除息数据新鲜度'],
  ['C5', '板块 / 概念数据完整性'],
  ['C6', '市值数据存在性'],
  ['C7', '日线价格合理性'],
  ['C8', '行情更新执行时长'],
  ['C9', '复权因子抽样数学一致性'],
  ['C10', '除权除息事件覆盖完整性'],
  ['C11', 'Tushare 免费 API 跨源校验（每日 1 次）'],
  ['C12', '东财跨源校验（20 只抽样，节流）'],
];

/** 已知污染源：测试跑出来的假日期（真实存在过的开发库污染样本） */
const FAKE_DATE = '2026-99-99';

let app: FastifyInstance;
const ADMIN_TOKEN = signToken({ sub: 1, username: 'dc_admin', role: 'admin' });
const USER_TOKEN = signToken({ sub: 2, username: 'dc_user', role: 'user' });

/** 今天（用于「最近一次真实校验日」的判定上界） */
const TODAY = new Date().toISOString().slice(0, 10);
/** 昨天（真实日历日，且必定 ≤ 今天） */
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  app = Fastify({ logger: false });
  await registerRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
});

beforeEach(() => {
  const db = ConfigStore.getInstance().db;
  db.prepare(`DELETE FROM system_log WHERE log_type = 'datacheck'`).run();
});

/** 写一条 datacheck 日志 */
function insertCheckLog(
  logDate: string,
  checkItem: string | null,
  level: string,
  message: string,
  detail?: string,
): void {
  ConfigStore.getInstance()
    .db.prepare(
      `INSERT INTO system_log (log_date, log_type, level, check_item, message, detail)
       VALUES (?, 'datacheck', ?, ?, ?, ?)`,
    )
    .run(logDate, level, checkItem, message, detail ?? null);
}

/** 调端点并返回解析后的 body */
async function getResult(token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/datacheck/result',
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

interface SummaryItem {
  checkId: string;
  name: string;
  result: string;
  message: string;
  detail: string | null;
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('datacheck 名称契约（C1~C12 的 name 与 SDD §5.7 主表逐字一致）', () => {
  it('datacheck 名称契约：C1~C12 的 name 与 SDD §5.7 主表逐字一致', async () => {
    // ① 导出的映射本身与 SDD 标题逐字一致
    expect(Object.keys(CHECK_NAMES)).toEqual(SDD_5_7_TITLES.map(([id]) => id));
    expect(CHECK_IDS).toEqual(SDD_5_7_TITLES.map(([id]) => id));
    for (const [id, title] of SDD_5_7_TITLES) {
      expect(CHECK_NAMES[id]).toBe(title);
    }

    // ② 端点下发的 name 与 SDD 标题逐字一致（**名称由后端出**，前端只渲染）
    for (const [id] of SDD_5_7_TITLES) {
      insertCheckLog(TODAY, id, 'SUCCESS', `${id} PASS`, '明细');
    }
    const { status, body } = await getResult(ADMIN_TOKEN);
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    const items = body.data as SummaryItem[];
    expect(items).toHaveLength(12);
    for (const [id, title] of SDD_5_7_TITLES) {
      const found = items.find((it) => it.checkId === id);
      expect(found).toBeDefined();
      expect(found?.name).toBe(title);
      expect(found?.name.length).toBeGreaterThan(0);
    }
  });

  it('datacheck 补齐：只跑到 2 项时端点仍返回 12 条（缺失项 SKIP）', async () => {
    insertCheckLog(TODAY, 'C1', 'SUCCESS', 'C1 PASS', '第一项');
    insertCheckLog(TODAY, 'C2', 'WARN', 'C2 WARN', '第二项');

    const { status, body } = await getResult(ADMIN_TOKEN);
    expect(status).toBe(200);
    const items = body.data as SummaryItem[];

    // 12 条，不多不少
    expect(items).toHaveLength(12);
    // checkId 集合恰好 = {C1..C12}
    expect(items.map((it) => it.checkId)).toEqual(SDD_5_7_TITLES.map(([id]) => id));

    // 已跑的 2 项：结果与明细原样下发
    const c1 = items.find((it) => it.checkId === 'C1');
    expect(c1?.result).toBe('PASS');
    expect(c1?.detail).toBe('第一项');
    const c2 = items.find((it) => it.checkId === 'C2');
    expect(c2?.result).toBe('WARN');

    // 未跑的 10 项：SKIP + 「未运行」+ **detail 不得伪造**
    for (const item of items.filter((it) => it.checkId !== 'C1' && it.checkId !== 'C2')) {
      expect(item.result).toBe('SKIP');
      expect(item.message).toContain('未运行');
      expect(item.detail).toBeNull();
      // 名称**照样**有（补齐项也带名称）
      expect(item.name.length).toBeGreaterThan(0);
    }
  });

  it('datacheck 编号边界：C13（扩展校验）被丢弃，不占 C 编号', async () => {
    insertCheckLog(TODAY, 'C1', 'SUCCESS', 'C1 PASS');
    // 扩展校验（停牌/退市/ST 等）**不得**以 C13+ 的形式进入卡片集合
    insertCheckLog(TODAY, 'C13', 'ERROR', 'C13 ERROR', '停牌日标记一致性');
    insertCheckLog(TODAY, 'C14', 'ERROR', 'C14 ERROR', '退市标记一致性');
    // 调度器写的汇总行（check_item 为空）也不该进集合
    insertCheckLog(TODAY, null, 'INFO', 'C1-C12 校验开始');

    const { status, body } = await getResult(ADMIN_TOKEN);
    expect(status).toBe(200);
    const items = body.data as SummaryItem[];

    expect(items).toHaveLength(12);
    expect(items.map((it) => it.checkId)).toEqual(SDD_5_7_TITLES.map(([id]) => id));
    expect(items.find((it) => it.checkId === 'C13')).toBeUndefined();
    expect(items.find((it) => it.checkId === 'C14')).toBeUndefined();
    // 不得出现任何编号外的 checkId
    for (const item of items) {
      expect(SDD_5_7_TITLES.some(([id]) => id === item.checkId)).toBe(true);
    }
  });
});

describe('datacheck「最近一次校验日」的取法（缺口 X-2）', () => {
  it('datacheck 最近一次：假日期 2026-99-99 不劫持「最近一次校验日」', async () => {
    // 假日期上只有 C1 —— 若按 `MAX(log_date)` 定位，结果就会是「只有 C1 有值」
    insertCheckLog(FAKE_DATE, 'C1', 'ERROR', 'C1 ERROR');
    // 真实日期上有 C1~C3
    insertCheckLog(TODAY, 'C1', 'SUCCESS', 'C1 PASS');
    insertCheckLog(TODAY, 'C2', 'SUCCESS', 'C2 PASS');
    insertCheckLog(TODAY, 'C3', 'WARN', 'C3 WARN');

    const { status, body } = await getResult(ADMIN_TOKEN);
    expect(status).toBe(200);
    const items = body.data as SummaryItem[];

    // 取的是**真实日期**那一批（C2/C3 有值），不是假日期那一批
    expect(items.find((it) => it.checkId === 'C2')?.result).toBe('PASS');
    expect(items.find((it) => it.checkId === 'C3')?.result).toBe('WARN');
    expect(items.find((it) => it.checkId === 'C1')?.result).toBe('PASS');
    // 假日期那一批的 ERROR 没有被取到
    expect(items.find((it) => it.checkId === 'C1')?.message).toBe('C1 PASS');
    // 未跑的补齐为 SKIP
    expect(items.find((it) => it.checkId === 'C4')?.result).toBe('SKIP');
  });

  it('datacheck 最近一次：日期非法（2026-13-01 / 2026-02-30）同样不被采信', async () => {
    insertCheckLog('2026-13-01', 'C1', 'ERROR', 'C1 ERROR');
    insertCheckLog('2026-02-30', 'C1', 'ERROR', 'C1 ERROR');
    insertCheckLog(YESTERDAY, 'C5', 'SUCCESS', 'C5 PASS');

    const { status, body } = await getResult(ADMIN_TOKEN);
    expect(status).toBe(200);
    const items = body.data as SummaryItem[];
    expect(items.find((it) => it.checkId === 'C5')?.result).toBe('PASS');
    expect(items.find((it) => it.checkId === 'C1')?.result).toBe('SKIP');
  });

  it('datacheck 最近一次：完全没有 datacheck 日志时返回 12 条占位（不是空数组）', async () => {
    const { status, body } = await getResult(ADMIN_TOKEN);
    expect(status).toBe(200);
    const items = body.data as SummaryItem[];
    expect(items).toHaveLength(12);
    expect(items.every((it) => it.result === 'SKIP')).toBe(true);
    expect(items.every((it) => it.message.includes('未运行'))).toBe(true);
  });

  it('datacheck 去重：同一天同一项跑多次时保留最近一次结果', async () => {
    insertCheckLog(TODAY, 'C1', 'ERROR', 'C1 ERROR', '旧结果');
    insertCheckLog(TODAY, 'C1', 'SUCCESS', 'C1 PASS', '新结果');

    const { status, body } = await getResult(ADMIN_TOKEN);
    expect(status).toBe(200);
    const items = body.data as SummaryItem[];
    const c1 = items.find((it) => it.checkId === 'C1');
    expect(c1?.result).toBe('PASS');
    expect(c1?.detail).toBe('新结果');
  });
});

describe('datacheck 端点的管理员鉴权（裁决 D-10 / G7.4）', () => {
  it('datacheck 鉴权：普通用户访问 GET /api/admin/datacheck/result → 403', async () => {
    insertCheckLog(TODAY, 'C1', 'SUCCESS', 'C1 PASS');
    const { status, body } = await getResult(USER_TOKEN);
    expect(status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
    expect('success' in body).toBe(false);
    expect(body.code).toBe('FORBIDDEN');
  });
});
