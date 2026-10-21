/**
 * T55 stockscan 公共过滤（asset_type / exclude_st / industry_code / market_cap_max）
 *
 * ⚠️ 本文件的表名/列名**全部来自实测**，不是文档抄写（2026-10-18 `data/quotes.duckdb`，
 *    information_schema.tables / .columns 直查）：
 *   raw_symbol_class(symbol, class)            —— **没有 is_st / is_listing**（SDD §3.3 那张表写错了）
 *   raw_symbol_name(symbol, name, class)       —— symbol 实测唯一
 *   raw_basic_daily(date, symbol, close, preclose, change_pct, amplitude, turnover, floatmv, totalmv)
 *   raw_tdx_blocks_member(stock_symbol, block_code) —— 成分股列名是 stock_symbol，不是 symbol
 *   raw_tdx_blocks_info(block_type, block_name, block_symbol, block_code, parent_code, block_level)
 *   视图 6 张：v_stock_{qfq,hfq,bfq} / v_etf_{qfq,hfq,bfq}
 *
 * ⚠️ 已知数据前提（实测，写进断言以免后人误判）：
 *   1. raw_tdx_blocks_info / raw_tdx_blocks_member **均为 0 行** → 任何 industry_code 都返回 0 条
 *   2. raw_holidays 最近一个交易日是 2026-10-07，但行情数据只到 2026-10-12 且**不含 10-07**
 *      → 路由自动取到的 tradeDate 当天无行情，totalCandidates 恒为 0（属 C1/C2 校验域，不在本任务范围）
 *      故依赖真实行情的断言一律直接打 buildPoolQuery + 指定 tradeDate，不依赖路由自动取日期
 *   3. ETF 在 raw_basic_daily 里 totalmv 多为 0 → market_cap_max 对 ETF 基本不起作用
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';

/**
 * 🔴 2026-10-19 CI 教训：CI 环境只有 12KB 空壳行情库（无 `v_stock_qfq` 等表），
 *   依赖**真实行情数据**的断言在本地全绿、CI 全红（PR #15 的后续 commit 从未过 CI）。
 *   → 下面这些用例**需要真实行情库**，无库时跳过（与 `smoke-m1` 的既有做法一致：
 *     「m2/m3 依赖 DuckDB 本地文件和 tdx2db init，CI 环境无法运行」）。
 *
 * 🔴 2026-10-21 **两层开关**：本文件用例分两类 ——
 *   · **数值型**（numeric）：迷你库**可信**（它是真库的逐位一致子集）→ 可在 CI 跑
 *   · **规模型**（scale）：「5000 候选」「池子 >3000」这类**数量**门槛 → **必须真库**
 *   ⇒ 用 `itNumeric` / `itScale` 分别守卫，**不能**统一用一个开关
 *     （统一开关会让迷你库上的规模断言**假装通过**）。
 */
import { marketDataUsableFor, marketDataTier } from '../_marketData.js';

/** 数值型用例可跑？（迷你库即可） */
const MARKET_DATA_NUMERIC_AVAILABLE = await marketDataUsableFor('numeric');
/** 规模型用例可跑？（**必须真库**） */
const MARKET_DATA_SCALE_AVAILABLE = await marketDataUsableFor('scale');

// ── SQLite 隔离：选股路由会经 writeSystemLog 打开 ConfigStore，
//    不隔离就会写到开发库 data/business.db（AGENTS.md / T60 隔离范式）──
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t55-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 't55.db');

const { ConfigStore } = await import('../../src/config/configStore.js');
const { queryDuckDB, closeDuckDBInstance } = await import('../../src/db/duckdb.js');
const { batchGetDailyRangeByView, getLatestMarketSnapshot } =
  await import('../../src/services/marketData.js');
const { buildPoolQuery, loadCandidateDaily, parseScanFilters, registerStockScanRoutes } =
  await import('../../src/routes/stockscan.js');
type AppliedScanFilters = import('../../src/routes/stockscan.js').AppliedScanFilters;

afterAll(() => {
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

describe('T55 — parseScanFilters 参数校验（纯函数）', () => {
  it('默认 asset_type=stock、exclude_st=false、market_cap_max=null', () => {
    const r = parseScanFilters({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      assetType: 'stock',
      excludeSt: false,
      industryCode: null,
      marketCapMaxYi: null,
      minAmount: 0,
      maxResults: 100,
    });
  });

  it('asset_type 三值都放行，其余一律 400', () => {
    for (const t of ['stock', 'etf', 'all'] as const) {
      expect(parseScanFilters({ asset_type: t }).ok).toBe(true);
    }
    const bad = parseScanFilters({ asset_type: 'bond' as never });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.message).toContain('asset_type');
  });

  it('exclude_st 必须是 boolean（字符串 "true" 不静默放行）', () => {
    expect(parseScanFilters({ exclude_st: true }).ok).toBe(true);
    expect(parseScanFilters({ exclude_st: 'true' as never }).ok).toBe(false);
  });

  it('market_cap_max：0 / 负数 / NaN / 非数字一律拒绝', () => {
    expect(parseScanFilters({ market_cap_max: 0 }).ok).toBe(false);
    expect(parseScanFilters({ market_cap_max: -5 }).ok).toBe(false);
    expect(parseScanFilters({ market_cap_max: Number.NaN }).ok).toBe(false);
    expect(parseScanFilters({ market_cap_max: '50' as never }).ok).toBe(false);
    const ok = parseScanFilters({ market_cap_max: 50 });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.marketCapMaxYi).toBe(50);
  });

  it('industry_code 去空白；空串按「未传」处理', () => {
    const a = parseScanFilters({ industry_code: '  BK0001  ' });
    expect(a.ok && a.value.industryCode).toBe('BK0001');
    const b = parseScanFilters({ industry_code: '   ' });
    expect(b.ok && b.value.industryCode).toBeNull();
  });
});

describe('T55 — buildPoolQuery SQL 形状（纯函数）', () => {
  it('asset_type → 品种分支（stock/etf 各 1 张，all 为 UNION ALL 两张）+ src_view 视图标记', () => {
    // ⚠️ 2026-10-21：候选池已改为**直查基础表**（raw_kline_daily + raw_symbol_class），
    //   不再 FROM qfq 视图 —— 池子要的 4 个字段在视图里全是未复权原值，走视图却要把
    //   1800 万行日线与 2100 万行复权因子做哈希连接（实测 685ms → 289ms）。
    //   「asset_type → 哪个品种」的映射口径不变，只是落在 class 谓词 + src_view 标记上。
    const stock = buildPoolQuery(TRADE_DATE, withFilter({ assetType: 'stock' }));
    expect(stock.sql).toContain('FROM raw_kline_daily');
    expect(stock.sql).toContain('raw_symbol_class');
    expect(stock.sql).toContain('sc."class" = \'stock\'');
    expect(stock.sql).not.toContain('sc."class" = \'etf\'');
    // src_view 标记（绑定参数）决定后续日线从哪张视图取
    expect(stock.params[0]).toBe('v_stock_qfq');

    const etf = buildPoolQuery(TRADE_DATE, withFilter({ assetType: 'etf' }));
    expect(etf.sql).toContain('sc."class" = \'etf\'');
    expect(etf.sql).not.toContain('sc."class" = \'stock\'');
    expect(etf.params[0]).toBe('v_etf_qfq');

    const all = buildPoolQuery(TRADE_DATE, withFilter({ assetType: 'all' }));
    expect(all.sql).toContain('UNION ALL');
    expect(all.params[0]).toBe('v_stock_qfq');
    // 第 2 个分支的 src_view 标记（分支顺序 = KLINE_VIEWS_BY_ASSET_TYPE 的顺序）
    const second = all.params.findIndex((p, idx) => idx > 0 && p === 'v_etf_qfq');
    expect(second).toBeGreaterThan(0);
  });

  it('占位符数量与 params 数量一致（无字符串拼接用户输入）', () => {
    const { sql, params } = buildPoolQuery(
      TRADE_DATE,
      withFilter({
        assetType: 'all',
        excludeSt: true,
        industryCode: 'BK0001',
        marketCapMaxYi: 50,
        minAmount: 1000,
      }),
    );
    const placeholders = (sql.match(/\?/g) ?? []).length;
    expect(placeholders).toBe(params.length);

    // 参数顺序 = 分支顺序（src_view 标记占位符在每个分支的第一位，date/成交额紧随其后）
    // 顺序错位会让 DuckDB 报 "Unimplemented type for cast (INTEGER -> DATE)"
    expect(params).toEqual([
      'v_stock_qfq',
      TRADE_DATE,
      1000,
      'BK0001',
      50 * 100_000_000,
      'v_etf_qfq',
      TRADE_DATE,
      1000,
      'BK0001',
      50 * 100_000_000,
    ]);

    // 用户输入不得出现在 SQL 文本里
    expect(sql).not.toContain('BK0001');
    // 市值上限换算成「元」后作为绑定参数（50 亿 = 5e9）
    expect(params).toContain(50 * 100_000_000);
  });

  it('exclude_st=false 时不出现 ST 谓词；true 时出现前缀谓词（用 COALESCE 兜底 NULL 名称）', () => {
    const off = buildPoolQuery(TRADE_DATE, withFilter({ excludeSt: false }));
    expect(off.sql).not.toContain("NOT LIKE 'ST%'");

    const on = buildPoolQuery(TRADE_DATE, withFilter({ excludeSt: true }));
    expect(on.sql).toContain("COALESCE(n.name, '') NOT LIKE 'ST%'");
    expect(on.sql).toContain("COALESCE(n.name, '') NOT LIKE '*ST%'");
  });

  it('industry_code 用 EXISTS 子查询 + 绑定参数（成分股列名是 stock_symbol）', () => {
    const { sql, params } = buildPoolQuery(TRADE_DATE, withFilter({ industryCode: 'BK0001' }));
    expect(sql).toContain('raw_tdx_blocks_member');
    expect(sql).toContain('bm.stock_symbol = k.symbol');
    expect(sql).toContain('bm.block_code = ?');
    expect(params).toContain('BK0001');
  });

  it('name（raw_symbol_name）始终 LEFT JOIN；totalmv（raw_basic_daily）**仅在按市值过滤时**才 JOIN', () => {
    // 带市值上限 → 需要 totalmv → JOIN raw_basic_daily
    const withCap = buildPoolQuery(TRADE_DATE, withFilter({ marketCapMaxYi: 30 }));
    expect(withCap.sql).toContain('LEFT JOIN raw_symbol_name n ON n.symbol = k.symbol');
    expect(withCap.sql).toContain('LEFT JOIN raw_basic_daily b ON b.symbol = k.symbol AND b.date = k.date');
    expect(withCap.sql).toContain('n.name');
    expect(withCap.sql).toContain('b.totalmv');

    // 不带市值上限 → 不需要 totalmv → **不 JOIN** 1800 万行的 raw_basic_daily（实测省 ~120ms）
    const noCap = buildPoolQuery(TRADE_DATE, withFilter({ marketCapMaxYi: null }));
    expect(noCap.sql).toContain('LEFT JOIN raw_symbol_name n ON n.symbol = k.symbol');
    expect(noCap.sql).not.toContain('raw_basic_daily');
    expect(noCap.sql).toContain('NULL AS totalmv');
  });
});

describe('T55 — 真实 DuckDB 数据上的过滤行为', () => {
  // 🔴 两层开关：数值型（迷你库即可）vs 规模型（必须真库）
  const itNumeric = MARKET_DATA_NUMERIC_AVAILABLE ? it : it.skip;
  const itScale = MARKET_DATA_SCALE_AVAILABLE ? it : it.skip;
  beforeAll(async () => {
    // ⚠️ 探针只在**有可用行情库**时跑 —— 否则 `queryDuckDB` 抛错会让 beforeAll 失败，
    //   把整组用例从「skip」变成「fail」（CI 空壳库时代的隐性坑）。
    if (!MARKET_DATA_NUMERIC_AVAILABLE) return;
    // 探针：确认本测试所依赖的数据前提仍成立（前提变了就报错，而不是让断言静默变绿）
    const blocks = await queryDuckDB<{ n: number }>('SELECT COUNT(*) AS n FROM raw_tdx_blocks_member');
    expect(Number(blocks[0].n)).toBe(0); // 板块表为空 → industry 过滤必然 0 条
    const cols = await queryDuckDB<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'raw_symbol_class'`,
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual(['class', 'symbol']); // 无 is_st
  }, 60000);

  afterAll(async () => {
    await closeDuckDBInstance();
  });

  itNumeric('基础候选池非空且带出 name（数值型口径）', async () => {
    const pool = await runPool(NO_FILTER);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.some((r) => r.name !== null)).toBe(true);
  });

  itScale('基础候选池 > 3000（实测 5561）—— **规模型**，必须真库', async () => {
    const pool = await runPool(NO_FILTER);
    expect(pool.length).toBeGreaterThan(3000);
    expect(pool.some((r) => r.name !== null)).toBe(true);
  });

  itNumeric(
    'exclude_st=true：结果里没有 ST / *ST 名称（实测 5561 → 5363）',
    async () => {
      // 保留基线查询（下方注释里的「两次查询」指的就是它与 filtered），但断言只用 filtered，
      // 故不取返回值 —— 否则触发 no-unused-vars
      await runPool(NO_FILTER);
      const filtered = await runPool(withFilter({ excludeSt: true }));

      expect(filtered.length).toBeGreaterThan(0);
      // 注意：候选池有 LIMIT 5000，排除 ST 后候选仍 >5000，两次查询都取满 5000 条，
      // 因此不能用「条数变少」判断过滤是否生效 —— 只能断言「结果里不含 ST 名称」。
      const stNames = filtered.filter((r) => r.name !== null && /^\*?ST/.test(r.name));
      expect(stNames).toHaveLength(0);
    },
    60000,
  );

  itNumeric('asset_type=etf：只回 ETF（与 raw_symbol_class.class 交叉核对）', async () => {
    const pool = await runPool(withFilter({ assetType: 'etf' }));
    expect(pool.length).toBeGreaterThan(0);

    const classes = await queryDuckDB<{ cls: string; n: number }>(
      `SELECT sc.class AS cls, COUNT(*) AS n
         FROM raw_symbol_class sc
        WHERE sc.symbol IN (${pool.map(() => '?').join(',')})
        GROUP BY sc.class`,
      pool.map((r) => r.symbol),
    );
    expect(classes).toEqual([{ cls: 'etf', n: pool.length }]);
    // src_view 标记决定后续日线从哪张视图取
    expect(new Set(pool.map((r) => r.src_view))).toEqual(new Set(['v_etf_qfq']));
  });

  itScale('asset_type=etf：候选数 > 100（实测 2074）—— **规模型**，必须真库', async () => {
    const pool = await runPool(withFilter({ assetType: 'etf' }));
    expect(pool.length).toBeGreaterThan(100);
  });

  itNumeric(
    'asset_type=all：同时含股票与 ETF',
    async () => {
      const pool = await runPool(withFilter({ assetType: 'all' }));
      const views = new Set(pool.map((r) => r.src_view));
      expect(views.has('v_stock_qfq')).toBe(true);
      expect(views.has('v_etf_qfq')).toBe(true);
    },
    60000,
  );

  itNumeric(
    'market_cap_max=50 亿：全部命中项 totalmv ≤ 50 亿',
    async () => {
      const pool = await runPool(withFilter({ marketCapMaxYi: 50 }));
      const base = await runPool(NO_FILTER);
      expect(pool.length).toBeGreaterThan(0);
      expect(pool.length).toBeLessThan(base.length);
      const cap = 50 * 100_000_000;
      for (const row of pool) {
        if (row.totalmv === null) continue; // 无市值记录的放行（口径见 buildPoolQuery 注释）
        expect(row.totalmv).toBeLessThanOrEqual(cap);
      }
    },
    60000,
  );

  itNumeric(
    '过滤叠加（exclude_st + market_cap_max）结果同时满足两个条件',
    async () => {
      const pool = await runPool(withFilter({ excludeSt: true, marketCapMaxYi: 30 }));
      expect(pool.length).toBeGreaterThan(0);
      for (const row of pool) {
        if (row.name !== null) expect(/^\*?ST/.test(row.name)).toBe(false);
        if (row.totalmv !== null) expect(row.totalmv).toBeLessThanOrEqual(30 * 100_000_000);
      }
    },
    60000,
  );

  itNumeric(
    'industry_code：板块成分表为 0 行 → 返回 0 条（数据缺失，不是 SQL 错）',
    async () => {
      const pool = await runPool(withFilter({ industryCode: 'BK0001' }));
      expect(pool).toHaveLength(0);
    },
    60000,
  );

  itNumeric(
    '候选池 + 日线加载 ≤ 15s（DuckDB 侧耗时上界，防劣化）',
    async () => {
      const t0 = Date.now();
      const pool = await runPool(withFilter({ excludeSt: true }));
      const daily = await loadCandidateDaily(pool, TRADE_DATE);
      const elapsed = Date.now() - t0;
      console.log(`[T55] 候选池 ${pool.length} 只 + 日线加载耗时 ${elapsed}ms`);
      expect(daily.size).toBe(pool.length);
      // ⚠️ 预算说明（本机实测基线 2026-10-19，data/quotes.duckdb = 1.2GB）：
      //    runPool 1.9~2.5s + loadCandidateDaily 1.7~3.0s。
      //    根因是 v_stock_qfq 是**非物化视图**，date 过滤无法下推 ——
      //    单日 `SELECT count(*) FROM v_stock_qfq WHERE date = ?` 就要 1.15s。
      //    即 PE2「选股 ≤ 3s」在本机**不成立**（src 侧真实性能问题，不在 T81 范围）。
      //    SDD §12.5 里 F7/PE2 的权威门槛是 integration 用例 **scan_5000_target**
      //    （端到端计时，见 tests/integration/scan5000.test.ts）；
      //    本用例只覆盖「候选池 + 单日日线」这一段，故只留一个宽松上界防劣化。
      expect(elapsed).toBeLessThan(15000);
    },
    60000,
  );

  itNumeric(
    'loadCandidateDaily：按 view 分组取回，且不产生重复 symbol',
    async () => {
      const pool = (await runPool(withFilter({ assetType: 'all' }))).slice(0, 300);
      const daily = await loadCandidateDaily(pool, TRADE_DATE);
      expect(daily.size).toBe(pool.length);
      for (const [symbol, k] of daily) {
        expect(pool.some((r) => r.symbol === symbol)).toBe(true);
        expect(k.close).toBeGreaterThan(0);
      }
    },
    60000,
  );

  /**
   * 🔴 **复权口径守卫**（2026-10-21）：选股预取走的是**显式前复权 SQL**
   *   （`marketData.ts` 的 `buildQfqRangeSql`）—— 它复刻 `v_stock_qfq` / `v_etf_qfq`
   *   的复权公式与取整位数，但**去掉了视图里两个用不上的 JOIN**（raw_symbol_class /
   *   raw_basic_daily），实测 SQL 2.0s → 1.6s。
   *
   *   ⚠️ **风险**：视图 DDL 归 tdx2db 管；若它改了复权公式或取整位数，
   *   本实现会与 K 线页（走视图）**静默分叉** → 指标/信号口径漂移。
   *   → 本用例把两条路径**逐条比对**，任何分叉立刻报错（真实行情库本地跑；CI 无库时 skip）。
   *
   *   ⚠️ 注意 **v_stock_qfq 取整 2 位、v_etf_qfq 取整 3 位**（实测自 tdx2db 视图 DDL），
   *   两个品种都必须覆盖 —— 只测股票会漏掉 ETF 的取整位数问题。
   */
  itNumeric(
    '复权口径：显式前复权 SQL 与 v_stock_qfq / v_etf_qfq 视图逐条一致',
    async () => {
      const windowStart = '2026-10-01';
      const windowEnd = TRADE_DATE;

      for (const assetType of ['stock', 'etf'] as const) {
        const pool = await runPool(withFilter({ assetType }));
        expect(pool.length).toBeGreaterThan(0);
        const symbols = pool.map((r) => r.symbol);
        const view = assetType === 'stock' ? 'v_stock_qfq' : 'v_etf_qfq';

        // ① 视图口径（K 线页走的就是这条）
        const viaView = await queryDuckDB<{
          symbol: string;
          date: string;
          open: number;
          high: number;
          low: number;
          close: number;
        }>(
          `SELECT symbol, date, open, high, low, "close" FROM ${view}
            WHERE date BETWEEN ? AND ? AND symbol IN (${symbols.map(() => '?').join(',')})
            ORDER BY symbol, date ASC`,
          [windowStart, windowEnd, ...symbols],
        );
        expect(viaView.length).toBeGreaterThan(0);

        // ② 显式前复权 SQL（选股预取走的路径）
        const viaExplicit = await batchGetDailyRangeByView(
          new Map([[view, symbols]]),
          windowStart,
          windowEnd,
        );

        // ③ 逐条比对
        let checked = 0;
        for (const row of viaView) {
          const klines = viaExplicit.get(row.symbol);
          expect(klines, `${view} 的 ${row.symbol} 应出现在预取结果里`).toBeDefined();
          const k = klines?.find((x) => x.date === row.date);
          expect(k, `${view} 的 ${row.symbol} ${row.date} 应出现在预取结果里`).toBeDefined();
          expect(k?.open).toBeCloseTo(row.open, 6);
          expect(k?.high).toBeCloseTo(row.high, 6);
          expect(k?.low).toBeCloseTo(row.low, 6);
          expect(k?.close).toBeCloseTo(row.close, 6);
          checked++;
        }
        console.log(`[T55] ${view} 复权口径逐条核对 ${checked} 行 —— 与视图一致`);

        // ④ **行数必须完全相等**（2026-10-21 补强）：
        //    上面的逐条比对用 `find` 找行，**发现不了「显式侧多出行」** ——
        //    多出的行不会让任何 `toBeDefined` 失败，却会让两条路径的分叉漏网。
        //    → 显式侧总行数必须 == 视图侧总行数。
        const explicitRows = [...viaExplicit.values()].reduce((n, l) => n + l.length, 0);
        expect(
          explicitRows,
          `${view}：显式 SQL 行数 ${explicitRows} ≠ 视图行数 ${viaView.length} —— 两条路径已分叉`,
        ).toBe(viaView.length);
      }
    },
    120000,
  );
});

describe('T55 — 路由契约（app.inject，不占端口）', () => {
  // 数值型口径（迷你库即可）：本组用例只验参数校验与回显，不涉及规模门槛
  const itReal = MARKET_DATA_NUMERIC_AVAILABLE ? it : it.skip;
  let app: Awaited<ReturnType<typeof Fastify>>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    // 只注册选股路由：本文件只验证过滤参数契约，鉴权钩子在 routes/index.ts 统一挂载
    await registerStockScanRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeDuckDBInstance();
  });

  itReal('非法 asset_type → 400 PARAM_INVALID（不静默回落 stock）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stockscan',
      payload: { plugin_id: 'rsi_oversold', asset_type: 'bond' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PARAM_INVALID');
  });

  itReal('非法 market_cap_max / exclude_st → 400 PARAM_INVALID', async () => {
    const cap = await app.inject({
      method: 'POST',
      url: '/api/stockscan',
      payload: { plugin_id: 'rsi_oversold', market_cap_max: -1 },
    });
    expect(cap.statusCode).toBe(400);

    const st = await app.inject({
      method: 'POST',
      url: '/api/stockscan',
      payload: { plugin_id: 'rsi_oversold', exclude_st: 'yes' },
    });
    expect(st.statusCode).toBe(400);
  });

  itReal('未知插件 → 400 PLUGIN_NOT_FOUND（参数校验前先判插件）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stockscan',
      payload: { plugin_id: 'no_such_plugin' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PLUGIN_NOT_FOUND');
  });

  itReal('合法请求 200 且回显生效的 filters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stockscan',
      payload: {
        plugin_id: 'rsi_oversold',
        asset_type: 'etf',
        exclude_st: true,
        market_cap_max: 100,
        industry_code: null,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe(0);
    expect(body.data.filters).toMatchObject({
      assetType: 'etf',
      excludeSt: true,
      industryCode: null,
      marketCapMaxYi: 100,
    });
    // 每条结果都带 name 字段（PRD §5.6 结果表格「标的代码 + 名称」）
    for (const item of body.data.results) {
      expect(item).toHaveProperty('name');
    }
  });

  itReal('GET /api/stockscan/plugins 仍返回 category（T83 的 plugins 列表未回退）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stockscan/plugins' });
    expect(res.statusCode).toBe(200);
    const plugins = res.json().data as { id: string; category: string }[];
    expect(plugins.some((p) => p.category === 'filter')).toBe(true);
  });
});

/**
 * 🔴 **T60c 口径守卫**：`getLatestMarketSnapshot`（`/api/market/latest` 的新实现）
 * 与旧实现（`SELECT … FROM v_stock_qfq ORDER BY date DESC LIMIT 5`）**逐条一致**。
 *
 * 背景：新实现不再物化复权视图（实测 **11.46s → 0.66s**），
 * 但它手写了前复权公式 ⇒ **必须用视图查询逐行比对**，否则前复权数值会悄悄漂移。
 *
 * ⚠️ 比对口径：两者都返回「最新交易日的 5 只 stock」，但**同日期下的 tie-break 是任意的**
 * （旧写法的 `ORDER BY date DESC LIMIT 5` 在同日期下顺序同样不确定）
 * ⇒ 比对的是「**逐行的 (date, close) 集合**」而非「同一 symbol 的值」：
 *   ① 两条查询的 `date` 集合相同，且都等于最大交易日
 *   ② 每个 symbol 的 `close` 值在**两条查询里相等**（用 symbol 关联，不是按行号）
 *   ③ 全部 symbol 的 class 都是 `stock`（与视图的 `INNER JOIN … class='stock'` 一致）
 */
describe('T60c —— /api/market/latest 的新实现与视图口径逐条一致', () => {
  const itFull = marketDataTier() === 'full' ? it : it.skip;

  // ⚠️ 显式 timeout：oracle 查询要物化复权视图（真库实测 ≈11s）+ 另两次查询 ⇒ 默认 15s 不够
  itFull(
    '新实现与视图查询逐行一致（date / close / class）',
    async () => {
      const { queryDuckDB } = await import('../../src/db/duckdb.js');
      const { toDateString } = await import('../../src/services/marketData.js');
      const newRows = await getLatestMarketSnapshot(5);
      expect(newRows.length).toBe(5);

      // ⚠️ **不能假设新旧两条查询返回同一批 symbol**：
      //   旧写法 `ORDER BY date DESC LIMIT 5` 在**同一日期**下的 tie-break 是任意的
      //   （DuckDB 不保证同日期的行序）⇒ 新旧会各取到「最大交易日的 5 只」中的**不同**子集。
      //   ⇒ 正确口径是：**用视图作 oracle，对新实现选出的那些 symbol 逐个比对 close 值**。
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
