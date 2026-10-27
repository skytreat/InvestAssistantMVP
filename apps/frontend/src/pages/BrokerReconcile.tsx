import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle, errorStyle, pageContainerStyle, titleStyle } from './_shared';

/**
 * BrokerReconcile.tsx —— 券商对账报告 `/broker/reconcile`（V3.8 T144/T145 · PRD_v3 §3.2/§3.3）
 *
 * 单页结构（PRD U6）：摘要（四宫格）+ 差额归因（残差置顶）+ 资金校验 + 回填统计 + 三口径 + 差异明细。
 * 补录（§3.3）：缺失/疑似行勾选 → trade_type 可改 → 整体事务确认 → 结果「成功 N / 失败 M」。
 * 权限：仅 admin（路由挂 AdminGuard，SDD_v3 §10.3）。
 */

interface Report {
  brokerCode: string;
  coveredRange: { from: string; to: string };
  coverageNote?: string;
  matchSummary: { factRows: number; matched: number; fuzzy: number; missing: number; extra: number };
  attribution: {
    repo: number;
    cashLikeEtf: number;
    dividend: number;
    offExchange: number;
    uncoveredPeriod: number;
    caliberDiff: number;
    residual: number;
    order: string[];
  };
  fundCheck: { applicable: number; passed: number; notApplicable: number; byReason: Record<string, number> };
  timeBackfill: { matched: number; lowConfidence: number; unmatched: number };
  repoModel: {
    pairs: unknown[];
    unpairedOpens: number;
    unpairedCloses: number;
    totalInterest: number;
    impliedAnnualRate: number;
  };
  returnSummary: { risk: number; cash: number; total: number; note: string };
  generatedAt: string;
}

interface DiffRow {
  id: number;
  event_type: string;
  raw_event_type?: string;
  asset_code: string | null;
  trade_date?: string;
  trade_time?: string | null;
  price?: number | null;
  quantity?: number | null;
  amount?: number | null;
  cash_flow?: number | null;
  match_status: string;
  exclude_reason?: string | null;
  source_file?: string | null;
}

const ATTR_LABELS: Record<string, string> = {
  residual: '残差（无法解释）',
  repo: '逆回购',
  cashLikeEtf: '货币 ETF',
  dividend: '分红送股',
  offExchange: '场外/占位',
  uncoveredPeriod: '未覆盖区间',
  caliberDiff: '口径差异',
};
const CATEGORIES = ['unmatched', 'repo', 'cashLikeEtf', 'dividend', 'offExchange', 'unknown'] as const;
const CONFIRM_TYPES = ['buy', 'add', 'reduce', 'clear'] as const;

/** 补录候选行（从差异明细勾选） */
interface ConfirmItem {
  sourceId: number;
  tradeType: string;
  asset_code: string | null;
  trade_date?: string;
  trade_time?: string | null;
}

export default function BrokerReconcile() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const brokerCode = params.get('brokerCode') ?? '';
  const [brokerOptions, setBrokerOptions] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── 差异明细 ──
  const [category, setCategory] = useState<string>('unmatched');
  const [diffRows, setDiffRows] = useState<DiffRow[]>([]);
  const [diffTotal, setDiffTotal] = useState(0);
  const [page, setPage] = useState(1);

  // ── 补录对话框（T145）──
  const [selected, setSelected] = useState<Map<number, ConfirmItem>>(new Map());
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmResult, setConfirmResult] = useState<{
    brokerCode: string;
    imported: number;
    already: number;
    invalid: number;
    rows: Array<{ sourceId: number; status: string; tradeType: string | null; reason?: string }>;
  } | null>(null);

  /** 券商下拉 = 「已导入过流水的券商」 */
  useEffect(() => {
    api
      .get('/broker-import/batches')
      .then((res) => {
        if (isOkEnvelope(res.data)) {
          const codes = Array.from(
            new Set(
              ((res.data.data as { batches?: Array<{ broker_code: string }> }).batches ?? []).map(
                (b) => b.broker_code,
              ),
            ),
          );
          setBrokerOptions(codes);
        }
      })
      .catch(() => undefined);
  }, []);

  const loadReport = useCallback(async (bc: string) => {
    if (!bc) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/broker-reconcile/latest', { params: { brokerCode: bc } });
      if (isOkEnvelope(res.data)) setReport(res.data.data as Report);
      else setError(String(res.data?.message ?? '无对账报告'));
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDiff = useCallback(async (bc: string, cat: string, p: number) => {
    if (!bc) return;
    const res = await api.get('/broker-reconcile/diff', {
      params: { brokerCode: bc, category: cat, page: p, pageSize: 50 },
    });
    if (isOkEnvelope(res.data)) {
      setDiffRows((res.data.data as { rows: DiffRow[] }).rows);
      setDiffTotal((res.data as { data: unknown; pagination?: { total?: number } }).pagination?.total ?? 0);
    }
  }, []);

  useEffect(() => {
    void loadReport(brokerCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerCode]);

  useEffect(() => {
    if (brokerCode) void loadDiff(brokerCode, category, page);
  }, [brokerCode, category, page, loadDiff]);

  /** 触发一次对账（重算去重/回填/归因，幂等） */
  const runReconcile = async () => {
    setLoading(true);
    try {
      await api.post('/broker-reconcile/run', { brokerCode });
      await loadReport(brokerCode);
      setError('对账已刷新');
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  };

  /** 勾选/取消补录候选（unmatched 类的成交族才可补录） */
  const toggleSelect = (row: DiffRow, checked: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (checked)
        next.set(row.id, {
          sourceId: row.id,
          tradeType: 'buy',
          asset_code: row.asset_code,
          trade_date: row.trade_date,
          trade_time: row.trade_time,
        });
      else next.delete(row.id);
      return next;
    });
  };

  /** T151③：当前页可补录行（MISSING 且有标的与数量） */
  const confirmable = category === 'unmatched';
  const selectableRows = useMemo(
    () =>
      confirmable ? diffRows.filter((r) => r.match_status === 'MISSING' && r.quantity && r.asset_code) : [],
    [diffRows, confirmable],
  );
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.id));
  const someSelected = !allSelected && selectableRows.some((r) => selected.has(r.id));

  /** T151③：全选 / 取消全选（当前页） */
  const toggleSelectAll = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const r of selectableRows) {
        if (checked)
          next.set(r.id, {
            sourceId: r.id,
            tradeType: 'buy',
            asset_code: r.asset_code,
            trade_date: r.trade_date,
            trade_time: r.trade_time,
          });
        else next.delete(r.id);
      }
      return next;
    });
  };

  /** 确认补录（整体事务；失败全回滚，PRD §3.3.1） */
  const confirmSupplement = async () => {
    setConfirmBusy(true);
    setConfirmResult(null);
    try {
      const items = [...selected.values()].map((x) => ({ sourceId: x.sourceId, tradeType: x.tradeType }));
      const res = await api.post('/broker-reconcile/confirm', { brokerCode, items });
      if (isOkEnvelope(res.data)) {
        const r = res.data.data as typeof confirmResult;
        setConfirmResult(r);
        setSelected(new Map());
        // U12：补录后自动重跑对账并提示
        await loadReport(brokerCode);
        void loadDiff(brokerCode, category, page);
      } else {
        setConfirmResult(null);
        setError(String(res.data?.message ?? '补录失败'));
      }
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setConfirmBusy(false);
    }
  };

  /** 标记「已手工记录」（不写业务层，仅事实层 match_status=MATCHED） */
  const markManuallyRecorded = async (factId: number) => {
    try {
      const res = await api.post(`/broker-reconcile/diff/${factId}/match`, {});
      if (isOkEnvelope(res.data)) {
        void loadReport(brokerCode);
        void loadDiff(brokerCode, category, page);
      } else {
        setError(String(res.data?.message ?? '标记失败'));
      }
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const attrRows = useMemo(() => {
    if (!report) return [] as Array<{ key: string; label: string; value: number; highlight: boolean }>;
    return report.attribution.order.map((k) => ({
      key: k,
      label: ATTR_LABELS[k] ?? k,
      value: report.attribution[k as keyof Report['attribution']] as number,
      // 残差非 0 → 醒目置顶（order[0] 已置顶；红字强化）
      highlight: k === 'residual' && report.attribution.residual !== 0,
    }));
  }, [report]);

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>券商对账</h1>

      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: SPACING.gapRelaxed, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>券商：</span>
            <select
              style={{ marginLeft: 8 }}
              value={brokerCode}
              onChange={(e) => setParams({ brokerCode: e.target.value })}
            >
              <option value="">（选择）</option>
              {brokerOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button style={buttonStyle} onClick={() => void runReconcile()} disabled={!brokerCode || loading}>
            重新对账
          </button>
          <button
            style={{ ...buttonStyle, background: COLORS.brand, color: '#fff', border: 'none' }}
            onClick={() => navigate(`/broker/import?brokerCode=${encodeURIComponent(brokerCode)}`)}
          >
            导入文件
          </button>
          {loading && <span style={{ fontSize: TYPO.smallSize, color: COLORS.textMuted }}>处理中…</span>}
        </div>
        {report && (
          <div style={{ marginTop: 8, fontSize: TYPO.smallSize, color: COLORS.textMuted }}>
            覆盖区间 {report.coveredRange.from} ~ {report.coveredRange.to}
            {report.coverageNote ? `（${report.coverageNote}）` : ''} · 生成于{' '}
            {new Date(report.generatedAt).toLocaleString()}
          </div>
        )}
        {error && <p style={errorStyle}>{error}</p>}
      </div>

      {report && (
        <>
          {/* 摘要四宫格 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <SummaryCard label="事实行" value={report.matchSummary.factRows} />
            <SummaryCard label="已匹配" value={report.matchSummary.matched} tone="success" />
            <SummaryCard label="缺失（可补录）" value={report.matchSummary.missing} tone="warning" />
            <SummaryCard label="多余" value={report.matchSummary.extra} />
          </div>

          {/* 差额归因（残差置顶） */}
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <h2 style={subtitleStyle}>差额归因</h2>
            <table style={tableStyle}>
              <tbody>
                {attrRows.map((r) => (
                  <tr key={r.key} style={r.highlight ? { color: COLORS.danger, fontWeight: 600 } : undefined}>
                    <td style={tdStyle}>
                      {r.label}
                      {r.highlight ? ' ⚠' : ''}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 资金校验 + 回填 + 逆回购 + 三口径 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div style={cardStyle}>
              <h3 style={subtitleStyle}>资金校验（行内自洽）</h3>
              <div style={{ fontSize: TYPO.smallSize }}>
                适用 {report.fundCheck.applicable} · 通过 {report.fundCheck.passed} · 不适用{' '}
                {report.fundCheck.notApplicable}
              </div>
            </div>
            <div style={cardStyle}>
              <h3 style={subtitleStyle}>成交时间回填</h3>
              <div style={{ fontSize: TYPO.smallSize }}>
                命中 {report.timeBackfill.matched} · 低置信 {report.timeBackfill.lowConfidence} · 未匹配{' '}
                {report.timeBackfill.unmatched}
              </div>
            </div>
            <div style={cardStyle}>
              <h3 style={subtitleStyle}>逆回购（§7.1）</h3>
              <div style={{ fontSize: TYPO.smallSize }}>
                配对 {report.repoModel.pairs.length} 对 · 利息 {report.repoModel.totalInterest.toFixed(2)} 元
                · 年化 {report.repoModel.impliedAnnualRate}%
                <br />
                在途 {report.repoModel.unpairedOpens} · 数据不全 {report.repoModel.unpairedCloses}
              </div>
            </div>
            <div style={cardStyle}>
              <h3 style={subtitleStyle}>收益率（占位口径，完整见「收益」页）</h3>
              <div style={{ fontSize: TYPO.smallSize }}>
                风险 {report.returnSummary.risk} · 现金 {report.returnSummary.cash} · 总{' '}
                {report.returnSummary.total}
                <div style={{ color: COLORS.textMuted, marginTop: 4 }}>{report.returnSummary.note}</div>
              </div>
            </div>
          </div>

          {/* 差异明细 + 补录 */}
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <h2 style={subtitleStyle}>差异明细（{diffTotal}）</h2>
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setPage(1);
                }}
                style={{ fontSize: TYPO.smallSize }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {ATTR_LABELS[c] ?? c}
                  </option>
                ))}
              </select>
            </div>
            <table style={tableStyle}>
              <thead>
                <tr>
                  {confirmable && (
                    <th style={thStyle}>
                      补录
                      {/* T151③：全选当前页可补录行（全选/部分 → indeterminate） */}
                      <input
                        type="checkbox"
                        aria-label="全选本页可补录"
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someSelected;
                        }}
                        onChange={(e) => toggleSelectAll(e.target.checked)}
                        style={{ marginLeft: 6 }}
                      />
                    </th>
                  )}
                  <th style={thStyle}>id</th>
                  <th style={thStyle}>事件</th>
                  <th style={thStyle}>标的</th>
                  <th style={thStyle}>日期</th>
                  <th style={thStyle}>数量</th>
                  <th style={thStyle}>金额</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>排除原因</th>
                  <th style={thStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {diffRows.map((r) => (
                  <tr key={r.id}>
                    {confirmable && r.match_status === 'MISSING' ? (
                      <td style={tdStyle}>
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={(e) => toggleSelect(r, e.target.checked)}
                          disabled={!(r.quantity && r.asset_code)}
                        />
                      </td>
                    ) : confirmable ? (
                      <td style={tdStyle} />
                    ) : null}
                    <td style={tdStyle}>{r.id}</td>
                    <td style={tdStyle}>{r.raw_event_type ?? r.event_type}</td>
                    <td style={tdStyle}>{r.asset_code ?? '—'}</td>
                    <td style={tdStyle}>
                      {r.trade_date ?? '—'}
                      {r.trade_time ? ` ${r.trade_time}` : ''}
                      {r.trade_date && !r.trade_time && (
                        <span
                          title="无成交时间（留空不填假时间，INV-S2-36）"
                          style={{ color: COLORS.textMuted }}
                        >
                          {' '}
                          ⏱
                        </span>
                      )}
                    </td>
                    <td style={tdStyle}>{r.quantity ?? '—'}</td>
                    <td style={tdStyle}>{r.amount ?? r.cash_flow ?? '—'}</td>
                    <td style={tdStyle}>{r.match_status}</td>
                    <td style={tdStyle}>{r.exclude_reason ?? ''}</td>
                    <td style={tdStyle}>
                      {r.match_status === 'MISSING' && (
                        <button
                          style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                          onClick={() => void markManuallyRecorded(r.id)}
                        >
                          已手工记录
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {diffRows.length === 0 && (
                  <tr>
                    <td colSpan={10} style={{ ...tdStyle, color: COLORS.textMuted }}>
                      无
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {diffTotal > 50 && (
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  marginTop: 8,
                  alignItems: 'center',
                  fontSize: TYPO.smallSize,
                }}
              >
                <button style={buttonStyle} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  上一页
                </button>
                {page}/{Math.ceil(diffTotal / 50)}
                <button
                  style={buttonStyle}
                  disabled={page * 50 >= diffTotal}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </button>
              </div>
            )}

            {/* 补录对话框（PRD §3.3：勾选 + trade_type 可改 + 提示 + 批量结果） */}
            {selected.size > 0 && (
              <div style={{ ...cardStyle, marginTop: 12, border: `1px solid ${COLORS.brand}` }}>
                <h3 style={subtitleStyle}>补录：{selected.size} 笔</h3>
                <p style={{ ...warningBar, margin: '4px 0 8px' }}>
                  这将写入你的交易记录，可撤销（业务层软删，事实层保留）
                </p>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>事实行</th>
                      <th style={thStyle}>标的</th>
                      <th style={thStyle}>日期</th>
                      <th style={thStyle}>推导类型（可修正）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...selected.values()].map((x) => (
                      <tr key={x.sourceId}>
                        <td style={tdStyle}>#{x.sourceId}</td>
                        <td style={tdStyle}>{x.asset_code ?? '—'}</td>
                        <td style={tdStyle}>{x.trade_date ?? '—'}</td>
                        <td style={tdStyle}>
                          <select
                            value={x.tradeType}
                            onChange={(e) => {
                              const next = new Map(selected);
                              next.set(x.sourceId, { ...x, tradeType: e.target.value });
                              setSelected(next);
                            }}
                            style={{ fontSize: TYPO.smallSize }}
                          >
                            {CONFIRM_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: 10, display: 'flex', gap: 12 }}>
                  <button
                    style={{ ...buttonStyle, background: COLORS.brand, color: '#fff', border: 'none' }}
                    onClick={() => void confirmSupplement()}
                    disabled={confirmBusy}
                  >
                    全部补录（{selected.size} 笔）
                  </button>
                  <button style={buttonStyle} onClick={() => setSelected(new Map())} disabled={confirmBusy}>
                    取消
                  </button>
                </div>
              </div>
            )}

            {confirmResult && (
              <div style={{ ...cardStyle, marginTop: 12 }}>
                <h3 style={subtitleStyle}>补录结果</h3>
                <div style={{ fontSize: TYPO.smallSize }}>
                  成功 {confirmResult.imported} · 已存在 {confirmResult.already} · 不可补{' '}
                  {confirmResult.invalid}（整体事务，失败全回滚）
                </div>
                {confirmResult.rows
                  .filter((r) => r.status === 'invalid' || r.status === 'manual_sheet')
                  .slice(0, 5)
                  .map((r) => (
                    <div key={r.sourceId} style={{ color: COLORS.danger, fontSize: TYPO.captionSize }}>
                      #{r.sourceId}：{r.reason ?? r.status}
                    </div>
                  ))}
              </div>
            )}
          </div>
        </>
      )}

      {!report && !loading && brokerCode && (
        <div style={cardStyle}>
          <p style={{ color: COLORS.textMuted }}>暂无对账报告，点「重新对账」生成。</p>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'warning' }) {
  const color =
    tone === 'success' ? COLORS.success : tone === 'warning' ? COLORS.warning : COLORS.textPrimary;
  return (
    <div style={{ ...cardStyle, textAlign: 'center' }}>
      <div style={{ fontSize: TYPO.h1Size, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted }}>{label}</div>
    </div>
  );
}

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
const tdStyle: React.CSSProperties = {
  borderBottom: `1px solid ${COLORS.borderLight}`,
  padding: '4px 8px',
  verticalAlign: 'top',
};
const warningBar: React.CSSProperties = {
  background: COLORS.bgPillWarning,
  color: COLORS.textWarning,
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: TYPO.captionSize,
};
