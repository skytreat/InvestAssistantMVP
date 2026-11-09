import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle, errorStyle, pageContainerStyle, titleStyle } from './_shared';
import Spinner from '../components/Spinner';

/**
 * StrategyEffectiveness.tsx —— 策略有效性页 `/strategy/effectiveness`（V3.8 T150 · PRD_v3 §4.3）
 *
 * 交付：
 * ① 单信号后续表现 T+1/T+5/T+10（GET /api/strategy/signals/:id/outcome，真实后续行情）
 * ② 列表可按策略/标的筛选（GET /api/signal）
 *
 * ⚠️ 成本扣减与基准对比（INV-S5-*）在评估口径层（T135 后端）扩展，本页呈现 outcome 数据。
 *
 * F4 Step B（2026-11-08）：新增「有效性统计」区块 —— 主口径「按信号 × 多周期 × 超额」，
 * 支持筛选 / 汇总 / 分组下钻 / CSV 导出；**费率口径脚注常显**（不同结果之间必须核对口径）。
 * 业务库信号极少（当前 3 条）⇒ `insufficientSample` 时只显示「样本不足（N 条）」，绝不显示百分比。
 */

interface SignalRow {
  id?: number;
  asset_code?: string;
  symbol?: string;
  plugin_id?: string;
  direction?: string;
  label?: string;
  trade_date?: string;
  adopted?: number;
  ignored?: number;
}

interface Outcome {
  signalId: number;
  asset_code: string;
  trade_date: string;
  direction: string;
  baseClose: number | null;
  t1: { date: string; close: number; changePct: number } | null;
  t5: { date: string; close: number; changePct: number } | null;
  t10: { date: string; close: number; changePct: number } | null;
}

interface FeeRates {
  commissionRate: number;
  minCommission: number;
  stampDutyRate: number;
  transferFeeRate: number;
  slippageRate: number;
}

interface FeeModelInfo {
  assetClass: string;
  label: string;
  rates: FeeRates;
}

interface HorizonStats {
  horizon: 't1' | 't5' | 't10';
  sampleSize: number;
  excessSampleSize: number;
  statusCounts: Record<string, number>;
  insufficientSample: boolean;
  winRateAbsolute: number | null;
  winRateExcess: number | null;
  avgNetReturn: number | null;
  avgBenchmarkReturn: number | null;
  avgExcessReturn: number | null;
}

interface EffectivenessGroup {
  groupBy: string;
  value: string;
  stats: HorizonStats[];
  feeModels: FeeModelInfo[];
  adoption: AdoptionStats;
}

/**
 * 采纳率（F4 Step C 第 ⑤ 项）
 *
 * 分母 = 已处理 = 已采纳 + 已忽略；「未处理」只展示、不进分母。
 * `insufficientSample` 时后端把 `adoptionRate` 置 null ⇒ 前端只显示「样本不足」，绝不显示百分比。
 */
interface AdoptionStats {
  adopted: number;
  ignored: number;
  pending: number;
  processed: number;
  insufficientSample: boolean;
  adoptionRate: number | null;
}

interface EffectivenessReport {
  meta: {
    from: string;
    to: string;
    benchmark: string;
    benchmarkClass: string;
    groupBy: string;
    horizons: Array<'t1' | 't5' | 't10'>;
    notional: number;
    sampleSize: number;
    insufficientSample: boolean;
    statusCounts: Record<string, number>;
    fees: FeeRates;
    feeModelLabel: string;
    feeModels: FeeModelInfo[];
    adoption: AdoptionStats;
    generatedAt: string;
  };
  summary: HorizonStats[];
  groups: EffectivenessGroup[];
  details: unknown[];
}

const GROUP_BY_LABELS: Record<string, string> = {
  plugin: '策略',
  asset_type: '标的类型',
  grade: '强度分级',
  industry: '行业',
};

const STATUS_LABELS: Record<string, string> = {
  ok: '有效',
  incomplete: '窗未满',
  suspended: '停牌',
  no_entry: '无入场',
  excluded: '涨停买不进',
};

function todayLocal(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function pctText(value: number | null): string {
  return value == null ? '—' : `${(value * 100).toFixed(2)}%`;
}

function rateText(value: number): string {
  if (value === 0) return '0';
  return value < 0.001 ? value.toFixed(6) : value.toFixed(3);
}

/** 口径脚注：报告正文常显，避免不同口径的结果被直接比较 */
function feeFootnote(meta: EffectivenessReport['meta']): string {
  const f = meta.fees;
  const base =
    `本次结果基于 ${meta.feeModelLabel} —— 佣金率 ${rateText(f.commissionRate)}、` +
    `最低佣金 ${f.minCommission} 元、印花税 ${rateText(f.stampDutyRate)}、` +
    `过户费 ${rateText(f.transferFeeRate)}、滑点 ${rateText(f.slippageRate)}；` +
    `名义本金 ¥${meta.notional}；基准 ${meta.benchmark}（${meta.benchmarkClass}）；` +
    `分组 ${GROUP_BY_LABELS[meta.groupBy] ?? meta.groupBy}。`;
  if (meta.feeModels.length > 1) {
    const models = meta.feeModels
      .map(
        (m) =>
          `${m.assetClass}: 印花税 ${rateText(m.rates.stampDutyRate)} / 过户费 ${rateText(m.rates.transferFeeRate)}`,
      )
      .join('；');
    return `${base} 本次混合多种品种口径（${models}），明细行已逐条标注。`;
  }
  return base;
}

export default function StrategyEffectiveness() {
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [outcomeFor, setOutcomeFor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pluginFilter, setPluginFilter] = useState('');
  const [assetFilter, setAssetFilter] = useState('');

  // ── F4 Step B：有效性统计筛选 ────────────────────────────────────────────
  const [report, setReport] = useState<EffectivenessReport | null>(null);
  const [efLoading, setEfLoading] = useState(false);
  const [efError, setEfError] = useState<string | null>(null);
  const [efFrom, setEfFrom] = useState(daysAgo(90));
  const [efTo, setEfTo] = useState(todayLocal());
  const [efPlugin, setEfPlugin] = useState('');
  const [efBenchmark, setEfBenchmark] = useState('sh510300');
  const [efGroupBy, setEfGroupBy] = useState('plugin');
  const [efNotional, setEfNotional] = useState(50000);

  const efParams = useCallback(() => {
    const params: Record<string, unknown> = {
      from: efFrom,
      to: efTo,
      benchmark: efBenchmark.trim() || 'sh510300',
      group_by: efGroupBy,
      notional: efNotional,
      horizon: 't1,t5,t10',
    };
    if (efPlugin.trim()) params.plugin_id = efPlugin.trim();
    return params;
  }, [efFrom, efTo, efBenchmark, efGroupBy, efNotional, efPlugin]);

  const loadEffectiveness = useCallback(async () => {
    setEfLoading(true);
    setEfError(null);
    try {
      const res = await api.get('/strategy/effectiveness', { params: efParams() });
      const payload = res.data?.data as EffectivenessReport | undefined;
      // 缺字段（旧后端 / mock）不渲染统计区，避免把不完整对象当报告
      if (isOkEnvelope(res.data) && payload?.meta) setReport(payload);
      else setReport(null);
    } catch (e) {
      setEfError(extractErrorMessage(e, '加载失败'));
    } finally {
      setEfLoading(false);
    }
  }, [efParams]);

  useEffect(() => {
    void loadEffectiveness();
  }, [loadEffectiveness]);

  /** CSV 导出（后端 BOM + CRLF；每行带费率列） */
  const exportCsv = async (level: 'summary' | 'detail') => {
    setEfError(null);
    try {
      const res = await api.get('/strategy/effectiveness/export', {
        params: { ...efParams(), level },
        responseType: 'blob',
      });
      const blob = new Blob([res.data as BlobPart], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `strategy-effectiveness-${efFrom}-${efTo}-${level}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setEfError(extractErrorMessage(e, '导出失败'));
    }
  };

  useEffect(() => {
    setLoading(true);
    const params: Record<string, unknown> = { page: 1, page_size: 50 };
    if (pluginFilter.trim()) params.plugin_id = pluginFilter.trim();
    if (assetFilter.trim()) params.asset_code = assetFilter.trim();
    api
      .get('/signal', { params })
      .then((res) => {
        if (isOkEnvelope(res.data)) setSignals((res.data.data ?? []) as SignalRow[]);
        else setError(String(res.data?.message ?? '加载失败'));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [pluginFilter, assetFilter]);

  const loadOutcome = async (id: number) => {
    setOutcomeFor(id);
    setOutcome(null);
    setError(null);
    try {
      const res = await api.get(`/strategy/signals/${id}/outcome`);
      if (isOkEnvelope(res.data)) setOutcome(res.data.data as Outcome);
      else setError(String(res.data?.message ?? '加载失败'));
    } catch (e) {
      setError(extractErrorMessage(e, '加载失败'));
    }
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>策略有效性</h1>

      {/* ── F4 Step B：有效性统计（主口径：按信号 × 多周期 × 超额）────────── */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <h2 style={subtitleStyle}>有效性统计（主口径：信号 × 多周期 × 超额）</h2>
        <p style={hintStyle}>
          超额胜率为主口径，绝对胜率并列；停牌 / 窗未满 / 涨停买不进单独计数，不进入分母。
          费率口径随结果一同下发（见下方脚注），**不同口径的结果不可直接比较**。
        </p>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label>
            <span style={labelTextStyle}>起始</span>
            <input
              style={inputStyle}
              type="date"
              value={efFrom}
              onChange={(e) => setEfFrom(e.target.value)}
            />
          </label>
          <label>
            <span style={labelTextStyle}>结束</span>
            <input style={inputStyle} type="date" value={efTo} onChange={(e) => setEfTo(e.target.value)} />
          </label>
          <label>
            <span style={labelTextStyle}>策略</span>
            <input
              style={{ ...inputStyle, width: 140 }}
              value={efPlugin}
              onChange={(e) => setEfPlugin(e.target.value)}
              placeholder="全部"
            />
          </label>
          <label>
            <span style={labelTextStyle}>基准</span>
            <input
              style={{ ...inputStyle, width: 110 }}
              value={efBenchmark}
              onChange={(e) => setEfBenchmark(e.target.value)}
            />
          </label>
          <label>
            <span style={labelTextStyle}>分组</span>
            <select style={inputStyle} value={efGroupBy} onChange={(e) => setEfGroupBy(e.target.value)}>
              <option value="plugin">策略</option>
              <option value="asset_type">标的类型</option>
              <option value="grade">强度分级</option>
              <option value="industry">行业</option>
            </select>
          </label>
          <label>
            <span style={labelTextStyle}>名义本金</span>
            <input
              style={{ ...inputStyle, width: 110 }}
              type="number"
              min={1000}
              step={1000}
              value={efNotional}
              onChange={(e) => setEfNotional(Number(e.target.value))}
            />
          </label>
          <button style={buttonStyle} onClick={() => void loadEffectiveness()} disabled={efLoading}>
            统计
          </button>
          <button style={buttonStyle} onClick={() => void exportCsv('summary')}>
            导出汇总
          </button>
          <button style={buttonStyle} onClick={() => void exportCsv('detail')}>
            导出明细
          </button>
        </div>

        {efError && <p style={errorStyle}>{efError}</p>}
        {efLoading && <Spinner />}

        {!efLoading && report && (
          <>
            {/* 口径脚注：常显（报告正文的一部分） */}
            <p style={footnoteStyle}>{feeFootnote(report.meta)}</p>
            {report.meta.insufficientSample && (
              <p style={warnStyle}>
                样本不足（{report.meta.sampleSize} 条）——
                按统计口径不输出百分比结论，请扩大时间范围或等待更多信号。
              </p>
            )}

            {/* F4 Step C：采纳率（分母 = 已处理 = 采纳 + 忽略） */}
            <table style={{ ...tableStyle, marginBottom: 16 }}>
              <thead>
                <tr>
                  <th style={thStyle}>已采纳</th>
                  <th style={thStyle}>已忽略</th>
                  <th style={thStyle}>未处理</th>
                  <th style={thStyle}>已处理（分母）</th>
                  <th style={thStyle}>采纳率</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={tdStyle}>{report.meta.adoption.adopted}</td>
                  <td style={tdStyle}>{report.meta.adoption.ignored}</td>
                  <td style={tdStyle}>{report.meta.adoption.pending}</td>
                  <td style={tdStyle}>{report.meta.adoption.processed}</td>
                  <td style={tdStyle}>
                    {report.meta.adoption.insufficientSample
                      ? `样本不足（${report.meta.adoption.processed} 条已处理）`
                      : pctText(report.meta.adoption.adoptionRate)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p style={hintStyle}>
              采纳率分母 = 已处理（已采纳 + 已忽略）；未处理不计入分母，也不计入分母的样本门槛。
            </p>

            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>周期</th>
                  <th style={thStyle}>有效样本</th>
                  <th style={thStyle}>超额样本</th>
                  <th style={thStyle}>绝对胜率</th>
                  <th style={thStyle}>超额胜率</th>
                  <th style={thStyle}>平均净收益</th>
                  <th style={thStyle}>平均基准</th>
                  <th style={thStyle}>平均超额</th>
                  <th style={thStyle}>状态计数</th>
                </tr>
              </thead>
              <tbody>
                {report.summary.map((s) => (
                  <tr key={s.horizon}>
                    <td style={tdStyle}>{s.horizon.toUpperCase()}</td>
                    <td style={tdStyle}>
                      {s.sampleSize}
                      {s.insufficientSample ? '（不足）' : ''}
                    </td>
                    <td style={tdStyle}>{s.excessSampleSize}</td>
                    <td style={tdStyle}>{pctText(s.winRateAbsolute)}</td>
                    <td style={tdStyle}>{pctText(s.winRateExcess)}</td>
                    <td style={tdStyle}>{pctText(s.avgNetReturn)}</td>
                    <td style={tdStyle}>{pctText(s.avgBenchmarkReturn)}</td>
                    <td style={tdStyle}>{pctText(s.avgExcessReturn)}</td>
                    <td style={tdStyle}>
                      {Object.entries(s.statusCounts)
                        .filter(([, v]) => v > 0)
                        .map(([k, v]) => `${STATUS_LABELS[k] ?? k} ${v}`)
                        .join(' / ') || '—'}
                    </td>
                  </tr>
                ))}
                {report.summary.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ ...tdStyle, color: COLORS.textMuted }}>
                      无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <h3 style={{ ...subtitleStyle, marginTop: 16 }}>
              分组下钻 · {GROUP_BY_LABELS[report.meta.groupBy] ?? report.meta.groupBy}
            </h3>
            {report.meta.groupBy === 'industry' && (
              <p style={hintStyle}>行业为当前板块快照（无历史版本），历史评估存在轻微前视偏差。</p>
            )}
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>分组值</th>
                  <th style={thStyle}>周期</th>
                  <th style={thStyle}>有效样本</th>
                  <th style={thStyle}>绝对胜率</th>
                  <th style={thStyle}>超额胜率</th>
                  <th style={thStyle}>平均净收益</th>
                  <th style={thStyle}>平均超额</th>
                  <th style={thStyle}>采纳率</th>
                  <th style={thStyle}>口径</th>
                </tr>
              </thead>
              <tbody>
                {report.groups.flatMap((g) =>
                  g.stats.map((s, idx) => (
                    <tr key={`${g.value}-${s.horizon}`}>
                      <td style={tdStyle}>{idx === 0 ? g.value : ''}</td>
                      <td style={tdStyle}>{s.horizon.toUpperCase()}</td>
                      <td style={tdStyle}>
                        {s.sampleSize}
                        {s.insufficientSample ? '（不足）' : ''}
                      </td>
                      <td style={tdStyle}>{pctText(s.winRateAbsolute)}</td>
                      <td style={tdStyle}>{pctText(s.winRateExcess)}</td>
                      <td style={tdStyle}>{pctText(s.avgNetReturn)}</td>
                      <td style={tdStyle}>{pctText(s.avgExcessReturn)}</td>
                      {idx === 0 && (
                        <td style={tdStyle} rowSpan={g.stats.length}>
                          {g.adoption.insufficientSample
                            ? `样本不足（${g.adoption.processed}）`
                            : pctText(g.adoption.adoptionRate)}
                        </td>
                      )}
                      <td style={tdStyle}>
                        {g.feeModels.length === 1 ? g.feeModels[0].label : '混合口径（见明细）'}
                      </td>
                    </tr>
                  )),
                )}
                {report.groups.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ ...tdStyle, color: COLORS.textMuted }}>
                      无分组数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label>
            <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>策略：</span>
            <input
              style={{ ...inputStyle, width: 160 }}
              value={pluginFilter}
              onChange={(e) => setPluginFilter(e.target.value)}
              placeholder="如 rsi_oversold"
            />
          </label>
          <label>
            <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>标的：</span>
            <input
              style={{ ...inputStyle, width: 160 }}
              value={assetFilter}
              onChange={(e) => setAssetFilter(e.target.value)}
              placeholder="如 sh600000"
            />
          </label>
        </div>
      </div>

      {error && <p style={errorStyle}>{error}</p>}
      {loading && <Spinner />}

      {!loading && (
        <>
          {/* 信号列表 + 后续表现入口 */}
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <h2 style={subtitleStyle}>信号（近 {signals.length} 条）</h2>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>id</th>
                  <th style={thStyle}>标的</th>
                  <th style={thStyle}>策略</th>
                  <th style={thStyle}>方向</th>
                  <th style={thStyle}>日期</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s, i) => (
                  <tr key={s.id ?? i}>
                    <td style={tdStyle}>{s.id}</td>
                    <td style={tdStyle}>{s.asset_code ?? s.symbol ?? '—'}</td>
                    <td style={tdStyle}>{s.plugin_id ?? '—'}</td>
                    <td style={tdStyle}>{s.direction ?? '—'}</td>
                    <td style={tdStyle}>{s.trade_date ?? '—'}</td>
                    <td style={tdStyle}>{s.adopted ? '已采纳' : s.ignored ? '已忽略' : '未标注'}</td>
                    <td style={tdStyle}>
                      {typeof s.id === 'number' && (
                        <button
                          style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                          onClick={() => void loadOutcome(s.id!)}
                        >
                          后续表现
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {signals.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ ...tdStyle, color: COLORS.textMuted }}>
                      无信号
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* T+1 / T+5 / T+10 后续表现（真实行情，非模拟成交） */}
          {outcomeFor !== null && (
            <div style={cardStyle}>
              <h2 style={subtitleStyle}>
                #{outcomeFor} 后续表现（{outcome ? outcome.asset_code : '加载中'}）
              </h2>
              {outcome ? (
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>基准收盘</th>
                      <th style={thStyle}>T+1</th>
                      <th style={thStyle}>T+5</th>
                      <th style={thStyle}>T+10</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={tdStyle}>{outcome.baseClose ?? '—'}</td>
                      {(['t1', 't5', 't10'] as const).map((k) => {
                        const cell = outcome[k];
                        return (
                          <td key={k} style={tdStyle}>
                            {cell ? `${cell.changePct}%（${cell.date}）` : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              ) : (
                <Spinner />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const hintStyle: React.CSSProperties = {
  fontSize: TYPO.smallSize,
  color: COLORS.textSecondary,
  margin: '0 0 12px',
  lineHeight: 1.6,
};
const footnoteStyle: React.CSSProperties = {
  fontSize: TYPO.captionSize,
  color: COLORS.textSecondary,
  background: COLORS.bgPillNeutral,
  border: `1px solid ${COLORS.borderLight}`,
  borderRadius: 6,
  padding: '8px 10px',
  margin: '12px 0',
  lineHeight: 1.6,
};
const warnStyle: React.CSSProperties = {
  fontSize: TYPO.smallSize,
  color: '#b45309',
  margin: '0 0 12px',
};
const labelTextStyle: React.CSSProperties = {
  fontSize: TYPO.smallSize,
  color: COLORS.textSecondary,
  marginRight: 6,
};
const subtitleStyle: React.CSSProperties = {
  fontSize: TYPO.cardTitleSize,
  fontWeight: 600,
  margin: '0 0 8px',
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: TYPO.smallSize,
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  borderBottom: `1px solid ${COLORS.borderLight}`,
  padding: '4px 8px',
  color: COLORS.textSecondary,
};
const tdStyle: React.CSSProperties = { borderBottom: `1px solid ${COLORS.borderLight}`, padding: '4px 8px' };
const inputStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.borderMedium}`,
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: TYPO.smallSize,
  fontFamily: 'inherit',
};
