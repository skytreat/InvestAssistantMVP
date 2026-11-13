import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import ConfirmDialog from '../components/ConfirmDialog';
import Spinner from '../components/Spinner';
import AssetLink from '../components/AssetLink';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import {
  buttonDisabledStyle,
  buttonStyle,
  cardStyle,
  cardTitleStyle,
  errorStyle,
  inputStyle,
  pageContainerStyle,
  successStyle,
  tableStyle,
  thStyle,
  titleStyle,
} from '../theme/styles';

/**
 * 纸面账户页 `/paper`（PA-13 / PA-14）
 *
 * 交付边界（方案 §8.2）：
 * - **只读**：不提供出入金、手工成交、改持仓/改现金 —— 唯一的写操作是「手动切换阶段」；
 * - 固定提示：模拟成交，非真实交易；成交价 = 当日开盘价，账本在当日收盘后更新；
 * - 影子期：目标标的 / 权重 / 信号质量（不展示持仓与净值，二者影子期恒空）；
 * - 落账期：净值曲线、持仓、订单、未成交原因、闲置现金口径；
 * - 切换阶段是**冷启动**：确认文案必须写清「重置水位 / 清空持仓 / 影子订单不补记」；
 *   成功与失败都必须可见（失败不静默）。
 *
 * ⚠️ 只用已有后端契约：`GET /api/paper/accounts`、`GET /api/paper/accounts/:id/report`、
 * `GET /api/paper/accounts/:id/orders`、`POST /api/paper/accounts/:id/phase`。
 */

interface PaperAccountDto {
  id: number;
  name: string;
  strategyId: string;
  strategyVersion: string;
  strategyName: string;
  phase: 'shadow' | 'ledger';
  status: 'active' | 'paused' | 'closed';
  initialCash: number;
  cash: number;
  startDate: string | null;
  ledgerStartDate: string | null;
  lastDecisionDate: string | null;
  lastSettledDate: string | null;
  benchmarkAssetCode: string;
}

interface PaperOrderDto {
  id: number;
  decisionDate: string;
  tradeDate: string;
  assetCode: string;
  /** 标的中文名（行情层 `raw_symbol_name`；查不到 / 行情库不可用时为 null ⇒ 只显示代码）*/
  assetName?: string | null;
  intentKind: 'target' | 'liquidate';
  side: 'buy' | 'sell';
  targetWeight: number | null;
  intentNotional: number;
  status: 'shadow' | 'pending' | 'noop' | 'filled' | 'unfilled' | 'superseded';
  filledQty: number;
  fillPrice: number | null;
  fee: number;
  unfilledReason: string | null;
}

interface PaperPositionDto {
  assetCode: string;
  /** 标的中文名（装饰信息，取不到时为 null）*/
  assetName?: string | null;
  qty: number;
  avgCost: number;
  costBasis: number;
  closeableQty: number;
  lastPrice: number | null;
  lastPriceDate: string | null;
}

interface PaperEquityPoint {
  tradeDate: string;
  equity: number;
  cash: number;
  riskMv: number;
  cashMv: number;
  exposure: number;
  benchmarkClose: number | null;
  benchmarkStale: boolean;
}

interface PaperShadowReport {
  latestDecisionDate: string | null;
  latestTradeDate: string | null;
  latestTargets: PaperOrderDto[];
  days: { decisionDate: string; targetCount: number; buyIntentCount: number; sellIntentCount: number }[];
  stability: { comparedDays: number; identicalDays: number; changedDays: number };
  dataQuality: { checkedPairs: number; missingBarPairs: number; zeroVolumePairs: number };
  orderCounts: Record<string, number>;
}

interface PaperLedgerReport {
  equity: PaperEquityPoint[];
  positions: PaperPositionDto[];
  orderCounts: Record<string, number>;
  unfilledReasons: Record<string, number>;
  latest: {
    tradeDate: string;
    equity: number;
    cash: number;
    cashMv: number;
    exposure: number;
    cashRatio: number | null;
    cashLikeRatio: number | null;
    unfilledBuyIntentRatio: number | null;
  } | null;
}

interface PaperReport {
  account: PaperAccountDto;
  shadow: PaperShadowReport | null;
  ledger: PaperLedgerReport | null;
}

const PHASE_LABEL: Record<PaperAccountDto['phase'], string> = {
  shadow: '影子期',
  ledger: '落账期',
};

const STATUS_LABEL: Record<PaperAccountDto['status'], string> = {
  active: '运行中',
  paused: '已暂停',
  closed: '已关闭',
};

const ORDER_STATUS_LABEL: Record<PaperOrderDto['status'], string> = {
  shadow: '影子留痕',
  pending: '待成交',
  noop: '无需调整',
  filled: '已成交',
  unfilled: '未成交',
  superseded: '已被覆盖',
};

/** 金额展示（最多两位小数，千分位） */
function money(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(2)}%`;
}

/** 净值曲线（极简 SVG 折线，不引图表库；与 K 线图 Out-of-Scope 一致） */
function EquityChart({ points }: { points: PaperEquityPoint[] }) {
  if (points.length < 2) {
    return (
      <p style={{ color: COLORS.textMuted, fontSize: TYPO.smallSize }}>
        净值点不足（至少 2 个交易日才能绘制曲线）
      </p>
    );
  }
  const values = points.map((p) => p.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const W = 600;
  const H = 120;
  const pad = 8;
  const coords = points.map((p, i) => {
    const x = pad + (i * (W - pad * 2)) / (points.length - 1);
    const y = pad + (1 - (p.equity - min) / span) * (H - pad * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <div>
      <svg
        role="img"
        aria-label={`净值曲线：${first.tradeDate} 至 ${last.tradeDate}，共 ${points.length} 个交易日`}
        viewBox={`0 0 ${W} ${H}`}
        style={{
          width: '100%',
          height: 140,
          background: COLORS.headerBg,
          border: `1px solid ${COLORS.borderLight}`,
          borderRadius: 6,
        }}
      >
        <polyline fill="none" stroke={COLORS.brand} strokeWidth={1.5} points={coords.join(' ')} />
      </svg>
      <div style={{ fontSize: TYPO.captionSize, color: COLORS.textSecondary, marginTop: SPACING.gapTight }}>
        区间 {first.tradeDate} → {last.tradeDate}；净值 {money(min)} ~ {money(max)}
      </div>
    </div>
  );
}

export default function PaperAccount() {
  const [accounts, setAccounts] = useState<PaperAccountDto[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [report, setReport] = useState<PaperReport | null>(null);
  const [orders, setOrders] = useState<PaperOrderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchResult, setSwitchResult] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );

  const loadAccounts = async () => {
    try {
      const res = await api.get('/paper/accounts');
      if (!isOkEnvelope(res.data)) {
        setError(String(res.data?.message ?? '加载纸面账户失败'));
        return;
      }
      const list = (res.data.data ?? []) as PaperAccountDto[];
      setAccounts(list);
      setSelectedId((prev) => {
        if (prev !== null && list.some((a) => a.id === prev)) return prev;
        const active = list.find((a) => a.status === 'active');
        return active?.id ?? list[0]?.id ?? null;
      });
    } catch (e) {
      setError(extractErrorMessage(e, '加载纸面账户失败'));
    }
  };

  const loadDetail = async (accountId: number) => {
    try {
      const [reportRes, ordersRes] = await Promise.all([
        api.get(`/paper/accounts/${accountId}/report`),
        api.get(`/paper/accounts/${accountId}/orders`, { params: { limit: 30 } }),
      ]);
      if (isOkEnvelope(reportRes.data)) setReport(reportRes.data.data as PaperReport);
      else setError(String(reportRes.data?.message ?? '加载纸面账户报告失败'));
      if (isOkEnvelope(ordersRes.data)) setOrders((ordersRes.data.data ?? []) as PaperOrderDto[]);
    } catch (e) {
      setError(extractErrorMessage(e, '加载纸面账户报告失败'));
    }
  };

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await loadAccounts();
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (selectedId === null) {
      setReport(null);
      setOrders([]);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId]);

  const account = report?.account ?? accounts.find((a) => a.id === selectedId) ?? null;
  const canSwitch = account !== null && account.phase === 'shadow' && account.status === 'active';

  const handleSwitch = async () => {
    if (!account) return;
    setConfirmOpen(false);
    setSwitching(true);
    setSwitchResult(null);
    try {
      const res = await api.post(`/paper/accounts/${account.id}/phase`, { to: 'ledger', confirm: true });
      if (isOkEnvelope(res.data)) {
        const updated = res.data.data as PaperAccountDto;
        setSwitchResult({
          type: 'success',
          message: `已切换到落账期（落账起点 ${updated.ledgerStartDate ?? '—'}）。水位已重置，历史影子订单不补记。`,
        });
        await loadAccounts();
        await loadDetail(account.id);
      } else {
        setSwitchResult({ type: 'error', message: String(res.data?.message ?? '切换阶段失败') });
      }
    } catch (e) {
      setSwitchResult({ type: 'error', message: extractErrorMessage(e, '切换阶段失败') });
    } finally {
      setSwitching(false);
    }
  };

  const confirmMessage = account
    ? [
        '切换会立即冷启动：重置决策与结算水位（last_decision_date / last_settled_date 清空），清空持仓检查点，',
        `现金回到初始资金（¥${money(account.initialCash)}）。`,
        '历史影子订单会保留，但不会补记成交（不产生纸面持仓与净值）。',
        '该操作不可回退（阶段只允许单向 影子 → 落账）。',
      ].join('')
    : '';

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>纸面账户</h1>

      <div style={{ ...cardStyle, background: COLORS.bgDisclaimer }}>
        <strong style={{ color: COLORS.textDisclaimer }}>模拟成交，非真实交易；</strong>
        <span style={{ color: COLORS.textDisclaimer }}>
          成交价 = 当日开盘价，账本在当日收盘后更新。本页不提供出入金与手工成交。
        </span>
      </div>

      {error && <p style={errorStyle}>{error}</p>}
      {loading && <Spinner />}

      {!loading && accounts.length === 0 && (
        <div style={cardStyle}>
          <p style={{ margin: 0, color: COLORS.textSecondary }}>当前没有纸面账户。</p>
        </div>
      )}

      {account && (
        <>
          <div style={{ ...cardStyle }} data-testid="paper-account-summary">
            <div style={cardTitleStyle}>账户</div>
            {accounts.length > 1 && (
              <div style={{ marginBottom: SPACING.gapBase }}>
                <label>
                  <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>选择账户：</span>
                  <select
                    aria-label="选择账户"
                    style={{ ...inputStyle, minWidth: 200 }}
                    value={selectedId ?? ''}
                    onChange={(e) => setSelectedId(Number(e.target.value))}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}（{PHASE_LABEL[a.phase]} · {STATUS_LABEL[a.status]}）
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <dl style={metaStyle}>
              <Meta label="当前阶段" value={`${PHASE_LABEL[account.phase]}（${account.phase}）`} strong />
              <Meta label="账户状态" value={STATUS_LABEL[account.status]} />
              <Meta
                label="策略"
                value={`${account.strategyName}（${account.strategyId}@${account.strategyVersion}）`}
              />
              <Meta label="初始资金" value={`¥${money(account.initialCash)}`} />
              <Meta label="现金" value={`¥${money(account.cash)}`} />
              <Meta label="落账起点" value={account.ledgerStartDate ?? '—'} />
              <Meta label="最近决策日" value={account.lastDecisionDate ?? '—'} />
              <Meta label="最近结算日" value={account.lastSettledDate ?? '—'} />
              <Meta label="基准" value={account.benchmarkAssetCode} />
            </dl>

            {/*
              手动切换阶段（方案 §8.2「必须」）——
              只有「影子期 + 运行中」才给按钮；落账期显示单向不可回退的说明。
            */}
            <div
              style={{
                marginTop: SPACING.gapRelaxed,
                display: 'flex',
                alignItems: 'center',
                gap: SPACING.gapBase,
              }}
            >
              {canSwitch ? (
                <button
                  type="button"
                  style={switching ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                  disabled={switching}
                  onClick={() => setConfirmOpen(true)}
                >
                  切换到落账期
                </button>
              ) : (
                <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>
                  阶段只允许单向切换（影子 → 落账），当前阶段不可回退。
                </span>
              )}
              {switching && (
                <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>正在切换…</span>
              )}
            </div>

            {switchResult && (
              <p
                role={switchResult.type === 'error' ? 'alert' : 'status'}
                style={switchResult.type === 'error' ? errorStyle : successStyle}
              >
                {switchResult.message}
              </p>
            )}
          </div>

          {report?.shadow && (
            <div style={{ ...cardStyle }} data-testid="paper-shadow-section">
              <div style={cardTitleStyle}>影子期信号质量</div>
              <p style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary, marginTop: 0 }}>
                最近决策日 {report.shadow.latestDecisionDate ?? '—'} → 交易日{' '}
                {report.shadow.latestTradeDate ?? '—'}；相邻决策日目标一致{' '}
                {report.shadow.stability.identicalDays}/{report.shadow.stability.comparedDays} 次。
              </p>
              <p style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>
                数据完整性：检查 {report.shadow.dataQuality.checkedPairs} 对，缺 bar{' '}
                {report.shadow.dataQuality.missingBarPairs}，零成交量{' '}
                {report.shadow.dataQuality.zeroVolumePairs}。
              </p>
              <div style={{ ...subTitleStyle }}>最新目标清单</div>
              <OrderTable rows={report.shadow.latestTargets} />
            </div>
          )}

          {report?.ledger && (
            <div style={{ ...cardStyle }} data-testid="paper-ledger-section">
              <div style={cardTitleStyle}>落账期账本</div>
              {report.ledger.latest ? (
                <dl style={metaStyle}>
                  <Meta label="最新交易日" value={report.ledger.latest.tradeDate} />
                  <Meta label="净值" value={`¥${money(report.ledger.latest.equity)}`} strong />
                  <Meta label="现金" value={`¥${money(report.ledger.latest.cash)}`} />
                  <Meta label="现金类市值" value={`¥${money(report.ledger.latest.cashMv)}`} />
                  <Meta label="仓位" value={percent(report.ledger.latest.exposure)} />
                  <Meta label="现金比例" value={percent(report.ledger.latest.cashRatio)} />
                  <Meta label="未成交买入占比" value={percent(report.ledger.latest.unfilledBuyIntentRatio)} />
                </dl>
              ) : (
                <p style={{ color: COLORS.textSecondary, fontSize: TYPO.smallSize }}>尚无净值记录。</p>
              )}

              <div style={{ marginTop: SPACING.gapRelaxed }}>
                <div style={subTitleStyle}>净值曲线</div>
                <EquityChart points={report.ledger.equity} />
              </div>

              <div style={{ marginTop: SPACING.gapRelaxed }}>
                <div style={subTitleStyle}>持仓（{report.ledger.positions.length}）</div>
                <div style={{ overflowX: 'auto', minWidth: 0 }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>标的</th>
                        <th style={thStyle}>数量</th>
                        <th style={thStyle}>成本价</th>
                        <th style={thStyle}>成本额</th>
                        <th style={thStyle}>可卖数量</th>
                        <th style={thStyle}>最近价</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.ledger.positions.map((p) => (
                        <tr key={p.assetCode}>
                          <td style={tdStyle}>
                            <AssetLink assetCode={p.assetCode} assetName={p.assetName} variant="inline" />
                          </td>
                          <td style={tdStyle}>{money(p.qty)}</td>
                          <td style={tdStyle}>{p.avgCost.toFixed(4)}</td>
                          <td style={tdStyle}>{money(p.costBasis)}</td>
                          <td style={tdStyle}>{money(p.closeableQty)}</td>
                          <td style={tdStyle}>
                            {p.lastPrice === null ? '—' : p.lastPrice.toFixed(4)}
                            {p.lastPriceDate ? `（${p.lastPriceDate}）` : ''}
                          </td>
                        </tr>
                      ))}
                      {report.ledger.positions.length === 0 && (
                        <tr>
                          <td colSpan={6} style={{ ...tdStyle, color: COLORS.textMuted }}>
                            当前空仓
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ marginTop: SPACING.gapRelaxed }}>
                <div style={subTitleStyle}>
                  订单状态：
                  {Object.entries(report.ledger.orderCounts)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(' / ') || '—'}
                </div>
                <div style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>
                  未成交原因：
                  {Object.entries(report.ledger.unfilledReasons)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(' / ') || '—'}
                </div>
              </div>
            </div>
          )}

          {report?.ledger && (
            <div style={cardStyle} data-testid="paper-orders-section">
              <div style={cardTitleStyle}>订单（最近 {orders.length} 条）</div>
              <OrderTable rows={orders} />
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="切换到落账期？"
        message={confirmMessage}
        confirmText="确认切换"
        cancelText="取消"
        danger
        onConfirm={() => void handleSwitch()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function Meta({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: SPACING.gapBase, fontSize: TYPO.smallSize }}>
      <dt style={{ minWidth: 88, color: COLORS.textSecondary }}>{label}</dt>
      <dd style={{ margin: 0, color: COLORS.textPrimary, fontWeight: strong ? 600 : 400 }}>{value}</dd>
    </div>
  );
}

function OrderTable({ rows }: { rows: readonly PaperOrderDto[] }) {
  return (
    <div style={{ overflowX: 'auto', minWidth: 0 }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>决策日</th>
            <th style={thStyle}>交易日</th>
            <th style={thStyle}>标的</th>
            <th style={thStyle}>方向</th>
            <th style={thStyle}>状态</th>
            <th style={thStyle}>成交数量</th>
            <th style={thStyle}>成交价</th>
            <th style={thStyle}>费用</th>
            <th style={thStyle}>未成交原因</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td style={tdStyle}>{o.decisionDate}</td>
              <td style={tdStyle}>{o.tradeDate}</td>
              <td style={tdStyle}>
                {/* 标的列：**名称(代码)**，整格链接到该标的的 K 线图（`/kline?symbol=`）*/}
                <AssetLink assetCode={o.assetCode} assetName={o.assetName} variant="inline" />
              </td>
              <td style={tdStyle}>{o.side === 'buy' ? '买入' : '卖出'}</td>
              <td style={tdStyle}>{ORDER_STATUS_LABEL[o.status]}</td>
              <td style={tdStyle}>{o.filledQty === 0 ? '—' : money(o.filledQty)}</td>
              <td style={tdStyle}>{o.fillPrice === null ? '—' : o.fillPrice.toFixed(4)}</td>
              <td style={tdStyle}>{o.fee === 0 ? '—' : money(o.fee)}</td>
              <td style={tdStyle}>{o.unfilledReason ?? '—'}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} style={{ ...tdStyle, color: COLORS.textMuted }}>
                暂无记录
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const metaStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: SPACING.gapTight,
  margin: 0,
};

const subTitleStyle: React.CSSProperties = {
  fontSize: TYPO.smallSize,
  fontWeight: 600,
  color: COLORS.textSecondary,
  marginBottom: SPACING.gapTight,
};

const tdStyle: React.CSSProperties = {
  borderBottom: `1px solid ${COLORS.borderLight}`,
  padding: '4px 8px',
};
