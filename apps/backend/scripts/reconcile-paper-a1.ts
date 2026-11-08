/**
 * A1 逐位对账（PA-15 · S4 Gate）
 *
 * 用**真实行情库（只读）**跑两条路径，逐位比较：
 *   A 纸面账本：`runPaperDecision`（决策 T）→ `settleAccountPending`（成交 T+1，逐日）→ `paper_equity` / `paper_order` / `paper_position`
 *   B 回测引擎：`runBacktest`（同策略、同参数、同费用规则、同起点）→ `result.equity` / `result.trades`
 *
 * 口径对齐要点：
 *   - 纸面落账起点 = 回测起点**前一个交易日**。纸面在 day1 决策、day2 成交；引擎 iter0 的
 *     `execDate=day2` 恰好用 `asOf=day1` 的决策 —— 两者日期序列因此逐日对齐（day2..dayN）。
 *   - 纸面 `fee_snapshot_json` 与引擎 `rules` 必须是同一份（`feeSnapshotToTradeRules`）。
 *   - 纸面 `targetsOverride` + `targetsTruncatedByCaller` 走的就是 `stepBacktestDay` 本身，
 *     所以差异只可能来自「取数时点 / 装载区间 / 停牌口径」，不是算法复制。
 *
 * 只读约束：进程只 SELECT DuckDB（`loadTradingCalendar` / `getBars` / 除权查询均为只读）。
 *
 * 用法：
 *   npx tsx apps/backend/scripts/reconcile-paper-a1.ts
 *   DUCKDB_PATH=<path> A1_DAYS=10 A1_REPORT=<path> npx tsx apps/backend/scripts/reconcile-paper-a1.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const QUOTES_PATH = process.env.DUCKDB_PATH ?? 'D:/workspace/InvestAssistantMVP/data/quotes.duckdb';
const DAY_COUNT = Number(process.env.A1_DAYS ?? 10);
const REPORT_PATH = process.env.A1_REPORT ?? path.join(REPO_ROOT, 'docs', 'audit', 'pa-a1-reconciliation.md');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-reconcile-'));

// 必须在动态 import 之前落 env：ConfigStore / DuckDB / PaperStore 都按 env 解析路径
process.env.DUCKDB_PATH = QUOTES_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP, 'business.db');
process.env.BACKTEST_DB_PATH = path.join(TMP, 'paper.db');
process.env.SYSTEM_LOG_FALLBACK_FILE = path.join(TMP, 'err.log');

const INITIAL_CASH = 1_000_000;
const STRATEGY_ID = 'ref-buy-and-hold';
const STRATEGY_VERSION = '0.1.0';
const BENCHMARK = 'sh510300';

/** 与内置默认费用一致（`FeeSnapshot` 形状；账户 `fee_config_id = NULL`） */
const FEE_SNAPSHOT = {
  source: 'builtin',
  feeConfigId: null,
  name: '内置默认（不可配置）',
  brokerName: null,
  commissionRate: 0.0001,
  minCommission: 5,
  stampDutyRate: 0,
  transferFeeRate: 0,
  slippageRate: 0.0001,
  lotSize: 100,
  minNotional: 10,
  priceLimitPct: 0.1,
};

interface Tolerances {
  atol: number;
  rtol: number;
}

const TOL: Tolerances = { atol: 1e-6, rtol: 1e-9 };

function diff(a: number | null | undefined, b: number | null | undefined): number {
  if (a === null || a === undefined || b === null || b === undefined) {
    return a === b ? 0 : Number.POSITIVE_INFINITY;
  }
  return Math.abs(a - b);
}

function within(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return diff(a, b) <= TOL.atol + TOL.rtol * Math.max(Math.abs(a), Math.abs(b));
}

async function main(): Promise<void> {
  if (!fs.existsSync(QUOTES_PATH)) {
    throw new Error(`行情库不存在：${QUOTES_PATH}`);
  }

  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const { createPaperSchema } = await import('../src/services/backtest/store/paperSchema.js');
  const { loadTradingCalendar } = await import('../src/services/backtest/calendar.js');
  const { buildPaperMarketData } = await import('../src/services/paper/marketData.js');
  const { runBacktest } = await import('../src/services/backtest/engine.js');
  const { feeSnapshotToTradeRules } = await import('../src/services/paper/fees.js');
  const { resolvePaperStrategy } = await import('../src/services/paper/strategies.js');
  const { BUY_AND_HOLD_PARAMS } = await import('../src/services/backtest/strategies/buyAndHold.js');
  const { runPaperDecision } = await import('../src/services/paper/decision.js');
  const { settleAccountPending } = await import('../src/services/paper/settle.js');
  const { resolveLatestQuoteDate } = await import('../src/services/marketData.js');

  const calendar = await loadTradingCalendar();
  // 窗口必须落在真实行情覆盖范围内（日历可能有未来交易日，行情没有）
  const latestQuote = await resolveLatestQuoteDate();
  if (!latestQuote) throw new Error('无法解析最新行情日期（行情库表结构/为空）');
  const tail = calendar.lastN(latestQuote, DAY_COUNT);
  if (tail.length < 4) throw new Error(`真实行情库交易日不足：${tail.length}`);

  // day1 = 纸面落账起点 / 引擎 asOf 基准；成交序列 day2..dayN
  const startDate = tail[0];
  const endDate = tail[tail.length - 1];
  const params = { ...BUY_AND_HOLD_PARAMS } as Record<string, unknown>;
  const rules = feeSnapshotToTradeRules(FEE_SNAPSHOT as any);

  // ── A. 纸面账本 ───────────────────────────────────────────────
  const db = new BetterSqlite3(':memory:');
  createPaperSchema(db);
  const nowText = '2026-11-08 00:00:00';
  const accountId = Number(
    db
      .prepare(
        `INSERT INTO paper_account (user_id, strategy_id, strategy_version, strategy_name, name,
           params_json, rules_json, fee_config_id, fee_snapshot_json, phase, status, initial_cash, cash,
           start_date, ledger_start_date, benchmark_asset_code, created_at, updated_at)
         VALUES (1, ?, ?, '参考策略：买入持有', 'A1 对账账户', ?, ?, NULL, ?, 'ledger', 'active', ?, ?,
           ?, ?, ?, ?, ?)`,
      )
      .run(
        STRATEGY_ID,
        STRATEGY_VERSION,
        JSON.stringify(params),
        JSON.stringify({ buyBeforeSell: false, priceLimit: rules.priceLimitPct }),
        JSON.stringify(FEE_SNAPSHOT),
        INITIAL_CASH,
        INITIAL_CASH,
        startDate,
        startDate,
        BENCHMARK,
        nowText,
        nowText,
      ).lastInsertRowid,
  );
  // 切阶段种子点（与 changePaperPhase 同口径；当日结算会 UPSERT 覆盖）
  db.prepare(
    `INSERT INTO paper_equity (account_id, trade_date, equity, cash, risk_mv, cash_mv, exposure,
       benchmark_close, benchmark_stale, drawdown_ratio, stale_symbol_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, NULL, 0, 0, 0, ?, ?)`,
  ).run(accountId, startDate, INITIAL_CASH, INITIAL_CASH, nowText, nowText);

  const dates = tail;
  const paperDays: {
    tradeDate: string;
    equity: number;
    cash: number;
    riskMv: number;
    cashMv: number;
    exposure: number;
    benchmarkClose: number | null;
  }[] = [];

  for (let i = 0; i < dates.length - 1; i += 1) {
    const decisionDate = dates[i];
    const tradeDate = dates[i + 1];
    const decision = await runPaperDecision(db, accountId, {
      today: decisionDate,
      // 与生产一致：`today` 当天即可决策（calendarDate = today，quoteDate = today）
      resolveCalendarDate: async () => decisionDate,
      resolveQuoteDate: async () => decisionDate,
      loadHolidays: async () => [],
    });
    if (decision.status !== 'done') {
      throw new Error(`纸面决策失败：${decisionDate} ${JSON.stringify(decision)}`);
    }
    const outcomes = await settleAccountPending(db, accountId, {
      today: tradeDate,
      now: new Date(`${tradeDate}T09:00:00+08:00`),
      resolveCalendarDate: async () => tradeDate,
      resolveQuoteDate: async () => tradeDate,
      loadCalendar: async () => calendar,
    });
    const settled = outcomes.find((o) => o.status === 'done' && o.tradeDate === tradeDate);
    if (!settled) {
      throw new Error(`纸面结算失败：${tradeDate} ${JSON.stringify(outcomes)}`);
    }
    const row = db
      .prepare(
        `SELECT trade_date, equity, cash, risk_mv, cash_mv, exposure, benchmark_close
         FROM paper_equity WHERE account_id = ? AND trade_date = ?`,
      )
      .get(accountId, tradeDate) as any;
    paperDays.push({
      tradeDate: row.trade_date,
      equity: row.equity,
      cash: row.cash,
      riskMv: row.risk_mv,
      cashMv: row.cash_mv,
      exposure: row.exposure,
      benchmarkClose: row.benchmark_close,
    });
  }

  const paperFills = db
    .prepare(
      `SELECT trade_date, asset_code, side, filled_qty AS qty, fill_price AS price, fee
       FROM paper_order WHERE account_id = ? AND status = 'filled' AND is_deleted = 0
       ORDER BY trade_date, id`,
    )
    .all(accountId) as any[];
  const paperPositions = db
    .prepare(
      `SELECT asset_code, qty, avg_cost FROM paper_position
       WHERE account_id = ? AND is_deleted = 0 ORDER BY asset_code`,
    )
    .all(accountId) as any[];

  // ── B. 回测引擎 ───────────────────────────────────────────────
  const data = await buildPaperMarketData({
    strategyId: STRATEGY_ID,
    params,
    replayStart: startDate,
    end: endDate,
    benchmark: BENCHMARK,
    heldSymbols: [],
  });
  const result = runBacktest(data, {
    strategy: resolvePaperStrategy(STRATEGY_ID, STRATEGY_VERSION),
    params,
    start: dates[1],
    end: endDate,
    initialCash: INITIAL_CASH,
    rules,
    benchmarkSymbol: BENCHMARK,
  });

  const engineDays = result.equity
    .filter((p) => p.date >= dates[1] && p.date <= endDate)
    .map((p) => ({
      tradeDate: p.date,
      equity: p.equity,
      cash: p.cash,
      riskMv: p.riskMv,
      cashMv: p.cashMv,
      exposure: p.exposure,
      benchmarkClose: p.benchmarkClose,
    }));

  // 引擎持仓由成交反推（引擎不直接暴露期末持仓）
  const posMap = new Map<string, { qty: number; cost: number }>();
  for (const t of result.trades) {
    const cur = posMap.get(t.symbol) ?? { qty: 0, cost: 0 };
    if (t.side === 'buy') {
      cur.cost += t.qty * t.price + t.fee;
      cur.qty += t.qty;
    } else {
      cur.cost -= (cur.cost / cur.qty) * t.qty;
      cur.qty -= t.qty;
    }
    posMap.set(t.symbol, cur);
  }
  const enginePositions = [...posMap.entries()]
    .filter(([, v]) => Math.abs(v.qty) > 1e-9)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([assetCode, v]) => ({ asset_code: assetCode, qty: v.qty, avg_cost: v.cost / v.qty }));

  // ── 比较 ─────────────────────────────────────────────────────
  const fields = ['equity', 'cash', 'riskMv', 'cashMv', 'exposure', 'benchmarkClose'] as const;
  const maxDiff: Record<string, number> = {};
  const mismatches: string[] = [];
  for (const f of fields) maxDiff[f] = 0;

  if (paperDays.length !== engineDays.length) {
    mismatches.push(`净值点数不一致：纸面 ${paperDays.length} vs 引擎 ${engineDays.length}`);
  }
  const n = Math.min(paperDays.length, engineDays.length);
  for (let i = 0; i < n; i += 1) {
    const p = paperDays[i];
    const e = engineDays[i];
    if (p.tradeDate !== e.tradeDate) {
      mismatches.push(`第 ${i} 点日期不一致：${p.tradeDate} vs ${e.tradeDate}`);
      continue;
    }
    for (const f of fields) {
      const d = diff(p[f], e[f]);
      if (Number.isFinite(d)) maxDiff[f] = Math.max(maxDiff[f], d);
      if (!within(p[f], e[f])) mismatches.push(`${p.tradeDate} ${f}: 纸面 ${p[f]} vs 引擎 ${e[f]}`);
    }
  }

  const fillDiff: string[] = [];
  if (paperFills.length !== result.trades.length) {
    fillDiff.push(`成交笔数不一致：纸面 ${paperFills.length} vs 引擎 ${result.trades.length}`);
  }
  const m = Math.min(paperFills.length, result.trades.length);
  for (let i = 0; i < m; i += 1) {
    const p = paperFills[i];
    const e = result.trades[i];
    const checks: [string, any, any][] = [
      ['trade_date', p.trade_date, e.date],
      ['asset_code', p.asset_code, e.symbol],
      ['side', p.side, e.side],
      ['qty', p.qty, e.qty],
      ['price', p.price, e.price],
      ['fee', p.fee, e.fee],
    ];
    for (const [name, a, b] of checks) {
      const ok = typeof a === 'number' ? within(a, b) : a === b;
      if (!ok) fillDiff.push(`#${i} ${name}: 纸面 ${a} vs 引擎 ${b}`);
    }
  }

  const posDiff: string[] = [];
  if (paperPositions.length !== enginePositions.length) {
    posDiff.push(`持仓标的数不一致：纸面 ${paperPositions.length} vs 引擎 ${enginePositions.length}`);
  }
  for (const p of paperPositions) {
    const e = enginePositions.find((x) => x.asset_code === p.asset_code);
    if (!e) {
      posDiff.push(`${p.asset_code} 纸面有仓、引擎无仓`);
      continue;
    }
    if (!within(p.qty, e.qty)) posDiff.push(`${p.asset_code} qty: 纸面 ${p.qty} vs 引擎 ${e.qty}`);
    if (!within(p.avg_cost, e.avg_cost)) {
      posDiff.push(`${p.asset_code} avg_cost: 纸面 ${p.avg_cost} vs 引擎 ${e.avg_cost}`);
    }
  }

  const passed = mismatches.length === 0 && fillDiff.length === 0 && posDiff.length === 0;

  // ── 报告 ─────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push('# PA-15 · A1 逐位对账报告（纸面账本 vs 回测引擎）');
  lines.push('');
  lines.push(`- 生成时间（本地）：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  lines.push(
    `- 行情库：\`${QUOTES_PATH}\`（${(fs.statSync(QUOTES_PATH).size / 1024 / 1024).toFixed(1)} MB，**只读**）`,
  );
  lines.push(
    `- 区间：${startDate} ~ ${endDate}（${dates.length} 个交易日；决策 ${dates.length - 1} 天，成交序列 ${dates[1]} ~ ${endDate}）`,
  );
  lines.push(`- 策略：\`${STRATEGY_ID}@${STRATEGY_VERSION}\`，参数 \`${JSON.stringify(params)}\``);
  lines.push(
    `- 初始资金：${INITIAL_CASH.toLocaleString()}；费用：佣金 ${rules.commissionRate}（最低 ${rules.minCommission}）、滑点 ${rules.slippageRate}`,
  );
  lines.push(`- 判定：**${passed ? 'PASS' : 'FAIL'}**（atol=${TOL.atol}，rtol=${TOL.rtol}）`);
  lines.push('');
  lines.push('## 1. 逐日净值');
  lines.push('');
  lines.push(
    '| 交易日 | 纸面 equity | 引擎 equity | 差 | 纸面 cash | 引擎 cash | 差 | risk_mv 差 | cash_mv 差 | exposure 差 |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (let i = 0; i < n; i += 1) {
    const p = paperDays[i];
    const e = engineDays[i];
    lines.push(
      `| ${p.tradeDate} | ${p.equity.toFixed(6)} | ${e.equity.toFixed(6)} | ${diff(p.equity, e.equity).toExponential(2)} | ` +
        `${p.cash.toFixed(6)} | ${e.cash.toFixed(6)} | ${diff(p.cash, e.cash).toExponential(2)} | ` +
        `${diff(p.riskMv, e.riskMv).toExponential(2)} | ${diff(p.cashMv, e.cashMv).toExponential(2)} | ${diff(p.exposure, e.exposure).toExponential(2)} |`,
    );
  }
  lines.push('');
  lines.push('## 2. 最大绝对差（逐字段）');
  lines.push('');
  lines.push('| 字段 | max\\|Δ\\| |');
  lines.push('|---|---|');
  for (const f of fields) lines.push(`| ${f} | ${maxDiff[f].toExponential(3)} |`);
  lines.push('');
  lines.push('## 3. 成交');
  lines.push('');
  lines.push(`- 纸面 ${paperFills.length} 笔 / 引擎 ${result.trades.length} 笔`);
  for (const p of paperFills) {
    lines.push(`  - ${p.trade_date} ${p.asset_code} ${p.side} qty=${p.qty} price=${p.price} fee=${p.fee}`);
  }
  lines.push(`- 成交差异：${fillDiff.length === 0 ? '无' : fillDiff.join('；')}`);
  lines.push('');
  lines.push('## 4. 期末持仓');
  lines.push('');
  lines.push('| 标的 | 纸面 qty | 引擎 qty | 纸面 avg_cost | 引擎 avg_cost |');
  lines.push('|---|---|---|---|---|');
  for (const p of paperPositions) {
    const e = enginePositions.find((x) => x.asset_code === p.asset_code);
    lines.push(
      `| ${p.asset_code} | ${p.qty} | ${e?.qty ?? '—'} | ${p.avg_cost?.toFixed(6) ?? '—'} | ${e?.avg_cost?.toFixed(6) ?? '—'} |`,
    );
  }
  lines.push(`- 持仓差异：${posDiff.length === 0 ? '无' : posDiff.join('；')}`);
  lines.push('');
  lines.push('## 5. 差异来源判断');
  lines.push('');
  if (passed) {
    lines.push(
      '- 无差异。纸面结算复用 `stepBacktestDay`（`targetsOverride` + `targetsTruncatedByCaller`），',
    );
    lines.push('  取数走同一 `buildPaperMarketData`（信号轨 qfq / 成交轨 bfq），费用规则来自同一份快照；');
    lines.push('  日期对齐为「纸面 day1 决策 → day2 成交」= 引擎 `execDate=day2, asOf=day1`。');
  } else {
    lines.push('- 存在差异，需按下列归类逐一取证（**不得**为了让数字对齐改账本逻辑）：');
    lines.push('  - 时点：纸面每日重置 `replayStart`，策略若依赖历史窗口可能漂移；');
    lines.push('  - 成交价：bfq 开盘价 vs 复权口径；');
    lines.push('  - 费用：佣金取整/最低佣金边界；');
    lines.push('  - 除权：`corporateActions` 装载区间（纸面逐日装载 `[T, T]`，引擎一次装载全区间）。');
    lines.push('');
    lines.push('### 明细');
    lines.push('');
    for (const s of [...mismatches, ...fillDiff, ...posDiff]) lines.push(`- ${s}`);
  }
  lines.push('');
  lines.push('## 6. 复跑命令');
  lines.push('');
  lines.push('```bash');
  lines.push('DUCKDB_PATH=D:/workspace/InvestAssistantMVP/data/quotes.duckdb \\');
  lines.push('  npx tsx apps/backend/scripts/reconcile-paper-a1.ts');
  lines.push('```');
  lines.push('');

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');

  console.log(`A1 对账：${passed ? 'PASS' : 'FAIL'}；报告 → ${REPORT_PATH}`);
  console.log(`最大差：${JSON.stringify(maxDiff)}`);
  if (!passed) {
    console.log('差异明细：');
    for (const s of [...mismatches, ...fillDiff, ...posDiff]) console.log(`  - ${s}`);
    process.exitCode = 1;
  }

  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
