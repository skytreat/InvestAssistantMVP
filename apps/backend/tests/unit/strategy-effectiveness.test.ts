import { describe, it, expect } from 'vitest';
import {
  ETF_FEES,
  STOCK_FEES,
  buildEffectivenessCsv,
  buildReport,
  computeFees,
  evaluateSignal,
  feeModelLabel,
  feeRatesForClass,
  finalizeHorizonStats,
  summarizeHorizon,
  type EvaluateOptions,
  type MarketContext,
  type PriceBar,
  type SignalOutcome,
  type SignalRecord,
} from '../../src/services/strategyEffectiveness.js';

// ── 测试替身：固定日期序列（与真实交易日无关，只验证「第 N 根」口径）────────
function mkBar(date: string, open: number, close: number, volume = 1000): PriceBar {
  return { date, open, close, volume };
}

const DATES = [
  '2026-01-06',
  '2026-01-07',
  '2026-01-08',
  '2026-01-09',
  '2026-01-12',
  '2026-01-13',
  '2026-01-14',
  '2026-01-15',
  '2026-01-16',
  '2026-01-19',
];

function mkSignal(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: 1,
    assetCode: 'sh510300',
    pluginId: 'rsi_oversold',
    tradeDate: '2026-01-05',
    grade: 'medium',
    origin: 'replay',
    ...overrides,
  };
}

function mkOptions(overrides: Partial<EvaluateOptions> = {}): EvaluateOptions {
  return {
    from: '2026-01-01',
    to: '2026-01-31',
    horizons: ['t1', 't5', 't10'],
    groupBy: 'plugin',
    notional: 50_000,
    priceLimit: 0.1,
    ...overrides,
  };
}

function mkContext(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    barsBySymbol: new Map(),
    classBySymbol: new Map(),
    industryBySymbol: new Map(),
    benchmarkCode: 'sh510300',
    benchmarkClass: 'etf',
    benchmarkBars: [],
    ...overrides,
  };
}

// ── 费率 ────────────────────────────────────────────────────────────────────
describe('computeFees（Step A 口径）', () => {
  it('ETF 0/0：买入含滑点 + 最低佣金，卖出含滑点，无印花税/过户费', () => {
    const f = computeFees(50_000, 0.1, feeRatesForClass('etf'));
    expect(f.buyCommission).toBe(5);
    expect(f.buyTransfer).toBe(0);
    expect(f.buyTotal).toBe(50_010); // 50000×1.0001 + 5
    expect(f.sellStampDuty).toBe(0);
    expect(f.sellNet).toBeCloseTo(55_000 * 0.9999 - 5.5, 2);
    expect(f.totalFees).toBeCloseTo(f.buyCommission + f.sellCommission, 2);
  });

  it('股票口径：印花税仅卖出、过户费双边，净收益显著低于 ETF', () => {
    const gross = 0.02;
    const etf = computeFees(50_000, gross, feeRatesForClass('etf'));
    const stock = computeFees(50_000, gross, feeRatesForClass('stock'));

    expect(stock.buyTransfer).toBeCloseTo(1, 2); // 50000×0.00002
    expect(stock.sellTransfer).toBeCloseTo(1.02, 2); // 51000×0.00002
    expect(stock.sellStampDuty).toBeCloseTo(51, 2); // 51000×0.001
    expect(stock.totalFees).toBeCloseTo(63.12, 2);

    const etfNet = etf.sellNet / etf.buyTotal - 1;
    const stockNet = stock.sellNet / stock.buyTotal - 1;
    expect(etfNet).toBeGreaterThan(stockNet);
    // 费率差 ≈ 0.11pp（0.02 毛收益下），不可忽略
    expect(etfNet - stockNet).toBeGreaterThan(0.0008);
  });

  it('口径标签明确区分 ETF / 股票', () => {
    expect(feeModelLabel(feeRatesForClass('etf'))).toContain('ETF 口径（印花税 0 / 过户费 0）');
    expect(feeModelLabel(feeRatesForClass('stock'))).toContain('股票 口径（印花税 0.001 / 过户费 0.00002）');
    expect(STOCK_FEES.stampDutyRate).toBe(0.001);
    expect(ETF_FEES.stampDutyRate).toBe(0);
  });
});

// ── 入场 / 出场 / 多周期 ─────────────────────────────────────────────────────
describe('evaluateSignal：多周期与可成交性', () => {
  const benchBars = [
    mkBar(DATES[0], 2.0, 2.02),
    mkBar(DATES[1], 2.02, 2.04),
    mkBar(DATES[2], 2.04, 2.06),
    mkBar(DATES[3], 2.06, 2.08),
    mkBar(DATES[4], 2.1, 2.1),
    mkBar(DATES[5], 2.12, 2.12),
    mkBar(DATES[6], 2.14, 2.14),
    mkBar(DATES[7], 2.16, 2.16),
    mkBar(DATES[8], 2.18, 2.18),
    mkBar(DATES[9], 2.2, 2.2),
  ];

  const signalBars = [
    mkBar('2026-01-05', 9.7, 9.8),
    mkBar(DATES[0], 10.0, 10.2),
    mkBar(DATES[1], 10.3, 10.5),
    mkBar(DATES[2], 10.4, 10.7),
    mkBar(DATES[3], 10.6, 10.9),
    mkBar(DATES[4], 10.8, 11.0),
    mkBar(DATES[5], 11.0, 11.1),
    mkBar(DATES[6], 11.1, 11.2),
    mkBar(DATES[7], 11.2, 11.3),
    mkBar(DATES[8], 11.3, 11.4),
    mkBar(DATES[9], 11.4, 11.5),
  ];

  it('T+1/T+5/T+10 按「信号日后第 N 根」取收盘，入场用首个可成交开盘价', () => {
    const ctx = mkContext({
      barsBySymbol: new Map([['sh510300', signalBars]]),
      classBySymbol: new Map([['sh510300', 'etf']]),
      benchmarkBars: benchBars,
    });
    const [t1, t5, t10] = evaluateSignal(mkSignal(), ctx, mkOptions());

    expect(t1.status).toBe('ok');
    expect(t1.entryDate).toBe(DATES[0]);
    expect(t1.entryPrice).toBeCloseTo(10, 6);
    expect(t1.exitDate).toBe(DATES[0]);
    expect(t1.exitPrice).toBeCloseTo(10.2, 6);
    expect(t1.grossReturn).toBeCloseTo(0.02, 8);

    expect(t5.exitDate).toBe(DATES[4]);
    expect(t5.grossReturn).toBeCloseTo(11.0 / 10 - 1, 8);
    expect(t10.exitDate).toBe(DATES[9]);
    expect(t10.grossReturn).toBeCloseTo(11.5 / 10 - 1, 8);

    // 超额 = 几何：(1+净)/(1+基准) − 1
    const fees = feeRatesForClass('etf');
    const c = computeFees(50_000, t5.grossReturn as number, fees);
    expect(t5.netReturn).toBeCloseTo(c.sellNet / c.buyTotal - 1, 10);
    expect(t5.benchmarkReturn).toBeCloseTo(2.1 / 2.0 - 1, 10);
    expect(t5.excessReturn).toBeCloseTo(
      (1 + (t5.netReturn as number)) / (1 + (t5.benchmarkReturn as number)) - 1,
      10,
    );
    // 每条结果都带费率元信息
    expect(t5.fees.stampDutyRate).toBe(0);
    expect(t5.feeModelLabel).toContain('ETF 口径');
  });

  it('首根 bar 停牌（volume=0）→ 顺延到下一根；窗口不足 → incomplete', () => {
    const suspended = [
      mkBar('2026-01-05', 9.7, 9.8),
      mkBar(DATES[0], 0, 10.0, 0),
      mkBar(DATES[1], 10.3, 10.5),
      mkBar(DATES[2], 10.4, 10.7),
    ];
    const ctx = mkContext({
      barsBySymbol: new Map([['sh510300', suspended]]),
      classBySymbol: new Map([['sh510300', 'etf']]),
    });
    const outcomes = evaluateSignal(mkSignal(), ctx, mkOptions());
    const t1 = outcomes[0];
    const t5 = outcomes[1];

    expect(t1.status).toBe('ok');
    expect(t1.entryDate).toBe(DATES[1]);
    expect(t5.status).toBe('incomplete'); // 第 5 根不存在
    expect(t5.entryDate).toBe(DATES[1]);
    expect(t5.netReturn).toBeNull();
  });

  it('开盘涨停买不进 → 顺延；全部涨停 → excluded；无后续 bar → no_entry', () => {
    const limitUp = [
      mkBar('2026-01-05', 9.7, 9.8),
      mkBar(DATES[0], 10.78, 10.9), // 9.8×1.1 = 10.78
      mkBar(DATES[1], 10.5, 10.6),
    ];
    const ctx = mkContext({
      barsBySymbol: new Map([['sh510300', limitUp]]),
      classBySymbol: new Map([['sh510300', 'etf']]),
    });
    const first = evaluateSignal(mkSignal(), ctx, mkOptions({ horizons: ['t1'] }))[0];
    expect(first.status).toBe('ok');
    expect(first.entryDate).toBe(DATES[1]);

    const allLimitUp = [
      mkBar('2026-01-05', 9.7, 9.8),
      mkBar(DATES[0], 10.78, 10.9),
      mkBar(DATES[1], 12.0, 12.1),
    ];
    const ctx2 = mkContext({
      barsBySymbol: new Map([['sh510300', allLimitUp]]),
      classBySymbol: new Map([['sh510300', 'etf']]),
    });
    expect(evaluateSignal(mkSignal(), ctx2, mkOptions({ horizons: ['t1'] }))[0].status).toBe('excluded');

    const noBars = [mkBar('2026-01-05', 9.7, 9.8)];
    const ctx3 = mkContext({
      barsBySymbol: new Map([['sh510300', noBars]]),
      classBySymbol: new Map([['sh510300', 'etf']]),
    });
    expect(evaluateSignal(mkSignal(), ctx3, mkOptions({ horizons: ['t1'] }))[0].status).toBe('no_entry');
  });

  it('基准缺失时沿用上一有效收盘（stale），不中断样本', () => {
    const bars = [mkBar('2026-01-05', 9.7, 9.8), mkBar(DATES[0], 10, 10.2), mkBar(DATES[1], 10.3, 10.5)];
    const benchOnlyOne = [mkBar('2026-01-04', 2.0, 2.0)];
    const ctx = mkContext({
      barsBySymbol: new Map([['sh510300', bars]]),
      classBySymbol: new Map([['sh510300', 'etf']]),
      benchmarkBars: benchOnlyOne,
    });
    const t1 = evaluateSignal(mkSignal(), ctx, mkOptions({ horizons: ['t1'] }))[0];
    expect(t1.status).toBe('ok');
    expect(t1.benchmarkReturn).toBeCloseTo(0, 10); // 2.0 → 2.0
    expect(t1.excessReturn).not.toBeNull();
  });
});

// ── 汇总与样本门槛 ──────────────────────────────────────────────────────────
function mkOutcome(partial: Partial<SignalOutcome>): SignalOutcome {
  const fees = feeRatesForClass('etf');
  return {
    signalId: 1,
    assetCode: 'sh510300',
    assetClass: 'etf',
    pluginId: 'rsi_oversold',
    tradeDate: '2026-01-05',
    grade: null,
    industry: null,
    origin: 'replay',
    horizon: 't5',
    status: 'ok',
    entryDate: '2026-01-06',
    entryPrice: 10,
    exitDate: '2026-01-12',
    exitPrice: 10.2,
    grossReturn: 0.02,
    netReturn: 0.01,
    benchmarkReturn: 0.005,
    excessReturn: 0.005,
    fees,
    feeModelLabel: feeModelLabel(fees),
    notional: 50_000,
    ...partial,
  };
}

describe('summarizeHorizon / 样本门槛', () => {
  it('绝对胜率与超额胜率分别计算，分母可审计', () => {
    const rows = [
      mkOutcome({ netReturn: 0.01, excessReturn: 0.005 }),
      mkOutcome({ netReturn: -0.01, excessReturn: -0.002 }),
      mkOutcome({ netReturn: 0.02, excessReturn: null, benchmarkReturn: null }),
      mkOutcome({ status: 'incomplete', netReturn: null, excessReturn: null }),
    ];
    const s = summarizeHorizon(rows, 't5');
    expect(s.statusCounts.ok).toBe(3);
    expect(s.statusCounts.incomplete).toBe(1);
    expect(s.sampleSize).toBe(3);
    expect(s.excessSampleSize).toBe(2);
    expect(s.winRateAbsolute).toBeCloseTo(2 / 3, 10);
    expect(s.winRateExcess).toBeCloseTo(1 / 2, 10);
  });

  it('sampleSize < 20：finalize 清空全部百分比，只留样本数与计数', () => {
    const rows = Array.from({ length: 19 }, (_, i) =>
      mkOutcome({ signalId: i + 1, netReturn: i % 2 ? -0.01 : 0.01 }),
    );
    const stats = summarizeHorizon(rows, 't5');
    expect(stats.insufficientSample).toBe(true);
    expect(stats.winRateAbsolute).not.toBeNull();

    const safe = finalizeHorizonStats(stats);
    expect(safe.sampleSize).toBe(19);
    expect(safe.winRateAbsolute).toBeNull();
    expect(safe.winRateExcess).toBeNull();
    expect(safe.avgNetReturn).toBeNull();
    expect(safe.avgExcessReturn).toBeNull();
  });

  it('sampleSize ≥ 20：保留百分比', () => {
    const rows = Array.from({ length: 20 }, (_, i) => mkOutcome({ signalId: i + 1, netReturn: 0.01 }));
    const safe = finalizeHorizonStats(summarizeHorizon(rows, 't5'));
    expect(safe.insufficientSample).toBe(false);
    expect(safe.winRateAbsolute).toBe(1);
  });
});

// ── 报告装配 ───────────────────────────────────────────────────────────────
describe('buildReport：分组 / 混合口径 / CSV', () => {
  const bars = [
    mkBar('2026-01-05', 9.7, 9.8),
    mkBar(DATES[0], 10, 10.2),
    mkBar(DATES[1], 10.2, 10.4),
    mkBar(DATES[2], 10.4, 10.6),
    mkBar(DATES[3], 10.6, 10.8),
    mkBar(DATES[4], 10.8, 11.0),
  ];

  function makeContext(): MarketContext {
    return mkContext({
      barsBySymbol: new Map([
        ['sh510300', bars],
        ['sh600000', bars],
      ]),
      classBySymbol: new Map([
        ['sh510300', 'etf'],
        ['sh600000', 'stock'],
      ]),
      benchmarkBars: bars.map((b) => mkBar(b.date, 2.0, 2.0)),
    });
  }

  it('25 条合成信号：meta 带费率口径、样本充足时输出百分比、分组齐全', () => {
    const signals: SignalRecord[] = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      assetCode: i % 2 === 0 ? 'sh510300' : 'sh600000',
      pluginId: i % 3 === 0 ? 'macd_cross' : 'rsi_oversold',
      tradeDate: '2026-01-05',
      grade: 'medium',
      origin: 'replay',
    }));
    const report = buildReport({ signals, context: makeContext(), options: mkOptions() });

    expect(report.meta.sampleSize).toBe(25);
    expect(report.meta.insufficientSample).toBe(false);
    expect(report.meta.feeModels.map((m) => m.assetClass).sort()).toEqual(['etf', 'stock']);
    expect(report.meta.feeModelLabel).toContain('ETF 口径');
    expect(report.meta.feeModelLabel).toContain('股票 口径');
    expect(report.summary[1].winRateAbsolute).not.toBeNull();
    expect(report.groups.map((g) => g.value).sort()).toEqual(['macd_cross', 'rsi_oversold']);

    // 股票明细的净收益必须更低（费率更高）
    const etfRow = report.details.find((d) => d.assetCode === 'sh510300' && d.horizon === 't5');
    const stockRow = report.details.find((d) => d.assetCode === 'sh600000' && d.horizon === 't5');
    expect(etfRow?.netReturn).toBeGreaterThan(stockRow?.netReturn as number);
    expect(stockRow?.fees.stampDutyRate).toBe(0.001);
  });

  it('3 条信号（业务库现状）：对外不输出百分比，CSV 仍带费率列', () => {
    const signals: SignalRecord[] = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      assetCode: 'sh510300',
      pluginId: 'rsi_oversold',
      tradeDate: '2026-01-05',
      grade: null,
      origin: 'replay',
    }));
    const report = buildReport({ signals, context: makeContext(), options: mkOptions() });
    expect(report.meta.insufficientSample).toBe(true);
    expect(report.summary[1].winRateAbsolute).toBeNull();

    const csv = buildEffectivenessCsv(report, 'summary');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv).toContain('fee_model_label');
    expect(csv).toContain('ETF 口径（印花税 0 / 过户费 0）');
    const summaryLine = csv.split('\r\n')[1];
    // 第 13/14 列（胜率）为空 ⇒ 相邻逗号
    expect(summaryLine).toContain(',,');
  });

  it('detail CSV 每行带实际费率与状态', () => {
    const report = buildReport({
      signals: [mkSignal({ id: 7, assetCode: 'sh600000' })],
      context: makeContext(),
      options: mkOptions({ horizons: ['t5'] }),
    });
    const csv = buildEffectivenessCsv(report, 'detail');
    const row = csv.split('\r\n')[1];
    expect(row).toContain('sh600000');
    expect(row).toContain('股票 口径');
    expect(row).toContain('0.001');
    expect(row).toContain('0.00002');
    expect(row).toContain('0.0001'); // 滑点
  });
});
