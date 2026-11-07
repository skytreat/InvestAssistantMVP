/**
 * T55 公共过滤 —— **规模型锚点**（必须真库；手动线 `npm run test:anchors`）
 *
 * ── 为什么从 `t55-stockscan-filter.test.ts` 挪到这里（2026-11-07）──
 *   「候选池 > 3000」「ETF 候选 > 100」是**数量门槛**：它们只在真库（约 5561 只股票 /
 *   2100 只 ETF）上成立，迷你库（真库的逐位一致子集，仅 400 余只）上跑必然假红。
 *   日常套件已默认走迷你库档 ⇒ 这类用例**不再留在日常全量里**，改为手跑，
 *   但**不再是静默 skip**：`tests/anchors.setup.ts` 会先强制 `MARKET_DATA_MODE=full`
 *   并探测真库，环境不对就直接抛错红灯。
 *
 * ⚠️ 断言与挪走前**逐字相同**（未放宽、未加容差）。
 * ⚠️ 表名/列名口径见 `t55-stockscan-filter.test.ts` 顶部注释（实测得出，勿照文档抄）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── SQLite 隔离：`buildPoolQuery` 所在模块会经 ConfigStore 打开业务库 ──
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t55-anchors-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 't55-anchors.db');

const { ConfigStore } = await import('../../src/config/configStore.js');
const { queryDuckDB, closeDuckDBInstance } = await import('../../src/db/duckdb.js');
const { buildPoolQuery } = await import('../../src/routes/stockscan.js');
type AppliedScanFilters = import('../../src/routes/stockscan.js').AppliedScanFilters;

afterAll(async () => {
  await closeDuckDBInstance();
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 实测：最近一个有行情的交易日（2026-10-12 有 5561 只股票） */
const TRADE_DATE = '2026-10-12';

const NO_FILTER: AppliedScanFilters = {
  assetType: 'stock',
  excludeSt: false,
  industryCode: null,
  marketCapMaxYi: null,
  minAmount: 0,
};

function withFilter(patch: Partial<AppliedScanFilters>): AppliedScanFilters {
  return { ...NO_FILTER, ...patch };
}

async function runPool(filters: AppliedScanFilters) {
  const { sql, params } = buildPoolQuery(TRADE_DATE, filters);
  return await queryDuckDB<{
    src_view: string;
    symbol: string;
    amount: number;
    name: string | null;
    totalmv: number | null;
  }>(sql, params);
}

describe('T55 规模型锚点（真库）', () => {
  it('基础候选池 > 3000（实测 5561）', async () => {
    const pool = await runPool(NO_FILTER);
    expect(pool.length).toBeGreaterThan(3000);
    expect(pool.some((r) => r.name !== null)).toBe(true);
  }, 120000);

  it('asset_type=etf：候选数 > 100（实测 2074）', async () => {
    const pool = await runPool(withFilter({ assetType: 'etf' }));
    expect(pool.length).toBeGreaterThan(100);
  }, 120000);
});

/**
 * 🔴 **T60c 口径守卫**：`getLatestMarketSnapshot`（`/api/market/latest` 的新实现）
 * 与旧实现（`SELECT … FROM v_stock_qfq ORDER BY date DESC LIMIT 5`）**逐条一致**。
 *
 * 背景：新实现不再物化复权视图（实测 **11.46s → 0.66s**），
 * 但它手写了前复权公式 ⇒ **必须用视图查询逐行比对**，否则前复权数值会悄悄漂移。
 * ⚠️ oracle 查询要物化 `v_stock_qfq`（真库实测 ≈11s）⇒ 归手动线，不留在日常全量。
 *
 * ⚠️ 比对口径：两者都返回「最新交易日的 5 只 stock」，但**同日期下的 tie-break 是任意的**
 * （旧写法的 `ORDER BY date DESC LIMIT 5` 在同日期下顺序同样不确定）
 * ⇒ 比对的是「**逐行的 (date, close) 集合**」而非「同一 symbol 的值」：
 *   ① 两条查询的 `date` 集合相同，且都等于最大交易日
 *   ② 每个 symbol 的 `close` 值在**两条查询里相等**（用 symbol 关联，不是按行号）
 *   ③ 全部 symbol 的 class 都是 `stock`（与视图的 `INNER JOIN … class='stock'` 一致）
 */
describe('T60c —— /api/market/latest 的新实现与视图口径逐条一致（真库锚点）', () => {
  it(
    '新实现与视图查询逐行一致（date / close / class）',
    async () => {
      const { getLatestMarketSnapshot, toDateString } = await import('../../src/services/marketData.js');
      const newRows = await getLatestMarketSnapshot(5);
      expect(newRows.length).toBe(5);

      // ⚠️ **不能假设新旧两条查询返回同一批 symbol**（同日期的 tie-break 是任意的）
      //   ⇒ 用视图作 oracle，对新实现选出的那些 symbol 逐个比对 close 值。
      const symbols = newRows.map((r) => r.symbol);
      const oracle = await queryDuckDB<{ symbol: string; date: unknown; close: number }>(
        `SELECT symbol, date, close FROM v_stock_qfq
        WHERE symbol IN (${symbols.map(() => '?').join(',')})
          AND date = (SELECT MAX(date) FROM v_stock_qfq)`,
        symbols,
      );
      const oracleBySymbol = new Map(oracle.map((r) => [r.symbol, r.close]));

      // ① 逐 symbol：close 值与视图**完全相等**（零容差）
      for (const r of newRows) {
        expect(oracleBySymbol.has(r.symbol)).toBe(true);
        expect(r.close).toBe(oracleBySymbol.get(r.symbol));
      }

      // ② 全部 date 等于最大交易日
      const maxDate = String(
        (await queryDuckDB<{ d: unknown }>('SELECT MAX(date) AS d FROM v_stock_qfq'))[0].d,
      );
      for (const r of newRows) expect(r.date).toBe(toDateString(new Date(maxDate)));

      // ③ 全部是 class='stock'（与视图的 INNER JOIN 一致）
      const classes = await queryDuckDB<{ symbol: string; class: string }>(
        `SELECT symbol, "class" FROM raw_symbol_class WHERE symbol IN (${symbols.map(() => '?').join(',')})`,
        symbols,
      );
      expect(classes.length).toBe(symbols.length);
      for (const c of classes) expect(c.class).toBe('stock');
    },
    120000,
  );
});
