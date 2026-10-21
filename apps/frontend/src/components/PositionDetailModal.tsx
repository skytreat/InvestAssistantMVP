import React, { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle } from '../theme/styles';
import KlineMiniChart, { MINI_CHART_DEFAULT_DAYS } from './KlineMiniChart';
import ScrollableTable from './ScrollableTable';
import SignalBadge from './SignalBadge';
import { fmt, fmtPct, type Position, type TradeSide } from './positionDomain';

/**
 * 标的详情 Modal（T67 · Wave 3 卡 6 · ux_v2 建议 C）
 *
 * 依据 ux_v2 行 407-447：
 * - 「持仓卡片上的标的代码/名称**可点击**，点击后弹出一个**详情 Modal**（宽度约 800-900px）」；
 * - 内容 = **持仓概览 + 今日信号 + 最近交易 + K 线小图**（行 419-441）；
 * - 「Modal 里展示的是**压缩版 K 线**（只画 MA + 一个副图，时间范围默认 120 天）」（行 433-434）；
 * - 「底部有"进入完整 K 线页"链接 —— 深度研究时才跳转」（行 435）。
 *
 * ## 数据来源（**禁止 N+1**）
 *
 * | 区块 | 来源 | 请求数 |
 * |---|---|---|
 * | 持仓概览 / 今日信号 | **props 传入的 `position`**（父级已从 `GET /api/holding` 拿到）| **0**（复用父级数据，不重复请求）|
 * | 最近交易 | `GET /api/trade?asset_code=<code>&limit=5` | 1（**只查当前这一个标的**）|
 * | K 线小图 | `GET /api/quote/<code>/kline?days=120&fq=qfq` | 1（**只查当前这一个标的**）|
 *
 * ⇒ 打开一次弹窗固定 **2 个请求**，与持仓数量无关 —— 不是 N+1。
 * 持仓概览若自己再拉一次 `/api/holding`，那才是逐标的拉取的 N+1，故这里**只吃 props**。
 *
 * ## a11y
 *
 * - `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（标题含代码与名称）；
 * - **ESC 关闭**（`document` 的 `keydown`，与 `components/ConfirmDialog.tsx` 同款实现）；
 * - 点遮罩关闭。
 *
 * ⚠️ **焦点锁定 / 焦点回归不在本任务范围** —— 属 **T76 ⑤**（Wave 8 弹窗焦点管理）。
 *    届时需补：打开时把焦点移入弹窗、Tab 键在弹窗内循环、关闭后把焦点还给触发元素。
 *    本组件**刻意不做**这两件事，避免与 T76 重复实现 / 互相覆盖。
 */

/** 交易类型 → 中文（`user_trade_record.trade_type` 的 CHECK 白名单）*/
const TRADE_TYPE_LABEL: Record<string, string> = {
  buy: '买入',
  add: '加仓',
  reduce: '减仓',
  clear: '清仓',
  dividend: '分红',
  bonus: '送股',
  transfer: '转股',
};

/** `GET /api/trade` 返回的一行（`user_trade_record` 的列）*/
interface TradeRow {
  id: number;
  asset_code: string;
  trade_type: string;
  trade_date: string;
  trade_time: string;
  quantity: number;
  price: number;
  fee: number;
  trade_reason: string | null;
}

/** `GET /api/trade` 的响应体（envelope）*/
interface TradeListEnvelope {
  success?: boolean;
  code?: number;
  message?: string;
  data?: TradeRow[];
  pagination?: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * 默认的「进入完整 K 线页」链接
 *
 * ⚠️ **口径说明（实测，勿猜）**：
 * - `App.tsx` 里 K 线的路由是 **`/kline`**（**没有** `/kline/:symbol` 路径参数）；
 * - `pages/Kline.tsx` 里 `symbol` 是 `useState('sh600000')` + 一个输入框，
 *   **当前不读任何 query 参数**（全仓 `useSearchParams` 零引用）。
 *
 * ⇒ `/kline?symbol=xxx` **能落到 K 线页**（路由匹配，query 当前被忽略）；
 *   而 `/kline/xxx` 会命中 `App.tsx` 的 `*` → **404 页**。
 * 故默认用 **query 形态**。
 * ⚠️ 待办：Wave 5 / T70 重写 K 线页时应让它消费 `?symbol=`（或改路径参数）；
 *    本组件留 `klineHref` prop，届时由调用方覆盖即可，不必再改本组件。
 */
export function defaultKlineHref(assetCode: string): string {
  return `/kline?symbol=${encodeURIComponent(assetCode)}`;
}

export interface PositionDetailModalProps {
  /** 是否打开；`false` 时**不渲染任何 DOM** */
  open: boolean;
  /** 持仓数据（父级从 `GET /api/holding` 拿到的**那一条**）；`null` → 区块显示占位 */
  position: Position | null;
  /** 关闭（ESC / 关闭按钮 / 点遮罩 / 点「进入完整 K 线页」）*/
  onCancel: () => void;
  /** 交易回调（接 卡 4 的 `TradeFormModal`，预填代码）；**未接入时按钮为 disabled 占位** */
  onTrade?: (assetCode: string, side: TradeSide) => void;
  /** K 线小图默认天数（默认 120，ux_v2 行 434）*/
  days?: number;
  /** K 线小图复权口径（默认 `qfq`）*/
  fq?: 'qfq' | 'raw';
  /** 「进入完整 K 线页」的 href 生成器（默认 `/kline?symbol=<code>`）*/
  klineHref?: (assetCode: string) => string;
}

export function PositionDetailModal({
  open,
  position,
  onCancel,
  onTrade,
  days = MINI_CHART_DEFAULT_DAYS,
  fq = 'qfq',
  klineHref = defaultKlineHref,
}: PositionDetailModalProps) {
  const titleId = useId();
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [tradesError, setTradesError] = useState<string | null>(null);

  const code = position?.asset_code ?? null;

  // ESC 关闭：只在 open 时挂监听，卸载时摘掉（与 ConfirmDialog 同款）
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 只处理本弹窗，避免同时打开的多层弹窗一起被 ESC 关掉
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  // 最近交易：**只查当前这一个标的**（不是逐标的循环 → 无 N+1）
  useEffect(() => {
    if (!open || !code) return;
    let cancelled = false;
    setTradesLoading(true);
    setTradesError(null);
    api
      .get<TradeListEnvelope>('/trade', { params: { asset_code: code, limit: 5 } })
      .then((res) => {
        if (cancelled) return;
        const body = res.data;
        if (typeof body.code === 'number' ? body.code === 0 : body.success === true) {
          setTrades(Array.isArray(body.data) ? body.data : []);
        } else {
          setTradesError(body.message ?? '交易记录加载失败');
          setTrades([]);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTradesError('交易记录加载失败：' + extractErrorMessage(err, '请求失败'));
        setTrades([]);
      })
      .finally(() => {
        if (!cancelled) setTradesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, code]);

  if (!open) return null;

  // 标题含**代码与名称**（`name` 缺失时只显示代码 —— 卡 3 A10 的同款回退）
  const title = code ? (position?.name ? `${code} ${position.name}` : code) : '标的详情';

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: TYPO.cardTitleSize,
    fontWeight: TYPO.cardTitleWeight,
    color: COLORS.textPrimary,
    marginBottom: SPACING.gapBase,
    borderBottom: `1px solid ${COLORS.borderSubtle}`,
    paddingBottom: SPACING.gapTight,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: TYPO.captionSize,
    color: COLORS.textSecondary,
  };

  const valueStyle: React.CSSProperties = {
    fontSize: TYPO.bodySize,
    color: COLORS.textPrimary,
    fontWeight: TYPO.cardTitleWeight,
  };

  const pnl = position?.unrealizedPnl ?? null;
  const pnlColor = (pnl ?? 0) >= 0 ? COLORS.textSuccess : COLORS.danger;
  const yieldValue = position?.unrealizedYield ?? null;
  const yieldColor = (yieldValue ?? 0) >= 0 ? COLORS.textSuccess : COLORS.danger;

  const tradeButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background: COLORS.cardBg,
    color: COLORS.textPrimary,
    border: `1px solid ${COLORS.borderMedium}`,
    cursor: onTrade ? 'pointer' : 'not-allowed',
    opacity: onTrade ? 1 : 0.6,
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: COLORS.maskOverlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.gapRelaxed,
        zIndex: 400,
      }}
      onClick={(e) => {
        // 只有点在**遮罩本身**上才关闭（点在弹窗内容里不关）
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="position-detail-modal"
        style={{
          ...cardStyle,
          // ux_v2 行 411：宽度约 800-900px；窄屏必须 `width:100%` + `maxWidth`（否则 375px 横向溢出）
          width: '100%',
          maxWidth: 880,
          maxHeight: '90vh',
          overflowY: 'auto',
          marginBottom: 0,
        }}
      >
        {/* ── 标题行 ── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: SPACING.gapBase,
            marginBottom: SPACING.gapBase,
          }}
        >
          <div id={titleId} style={{ ...sectionTitleStyle, borderBottom: 'none', marginBottom: 0 }}>
            标的详情 · {title}
          </div>
          <button
            type="button"
            aria-label="关闭标的详情"
            onClick={onCancel}
            style={{
              background: 'transparent',
              border: `1px solid ${COLORS.borderMedium}`,
              borderRadius: RADIUS.sm,
              color: COLORS.textSecondary,
              cursor: 'pointer',
              fontSize: TYPO.smallSize,
              padding: '4px 10px',
            }}
          >
            关闭
          </button>
        </div>

        {/* ── ① 持仓概览 ── */}
        <section data-testid="position-detail-overview" style={{ marginBottom: SPACING.gapRelaxed }}>
          <div style={sectionTitleStyle}>持仓概览</div>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
              gap: SPACING.gapBase,
              margin: 0,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <dt style={labelStyle}>持仓数量</dt>
              <dd style={{ ...valueStyle, margin: 0 }}>{position ? position.totalQuantity : '--'}</dd>
            </div>
            <div style={{ minWidth: 0 }}>
              <dt style={labelStyle}>移动加权成本</dt>
              <dd style={{ ...valueStyle, margin: 0 }}>{fmt(position?.avgCost, 4)}</dd>
            </div>
            <div style={{ minWidth: 0 }}>
              <dt style={labelStyle}>现价</dt>
              <dd style={{ ...valueStyle, margin: 0 }}>{fmt(position?.currentPrice)}</dd>
            </div>
            <div style={{ minWidth: 0 }}>
              <dt style={labelStyle}>浮动盈亏</dt>
              <dd style={{ ...valueStyle, margin: 0, color: pnlColor }}>{fmt(pnl)}</dd>
            </div>
            <div style={{ minWidth: 0 }}>
              <dt style={labelStyle}>浮动收益率</dt>
              <dd style={{ ...valueStyle, margin: 0, color: yieldColor }}>{fmtPct(yieldValue)}</dd>
            </div>
            <div style={{ minWidth: 0 }}>
              <dt style={labelStyle}>仓位占比</dt>
              <dd style={{ ...valueStyle, margin: 0 }}>{fmtPct(position?.weight)}</dd>
            </div>
          </dl>
        </section>

        {/* ── ② 今日信号 ── */}
        <section data-testid="position-detail-signal" style={{ marginBottom: SPACING.gapRelaxed }}>
          <div style={sectionTitleStyle}>今日信号</div>
          {position?.signal ? (
            <div style={{ display: 'flex', gap: SPACING.gapBase, flexWrap: 'wrap', alignItems: 'center' }}>
              <SignalBadge signal={position.signal} priceDate={position.priceDate} />
              <span style={labelStyle}>交易日 {position.signal.trade_date}</span>
            </div>
          ) : (
            <div data-testid="position-detail-signal-empty" style={{ ...labelStyle, color: COLORS.neutral }}>
              今日无策略信号
            </div>
          )}
        </section>

        {/* ── ③ 最近交易 ── */}
        <section data-testid="position-detail-trades" style={{ marginBottom: SPACING.gapRelaxed }}>
          <div style={sectionTitleStyle}>最近交易</div>
          {tradesLoading && <div style={labelStyle}>加载中...</div>}
          {!tradesLoading && tradesError && (
            <div style={{ ...labelStyle, color: COLORS.danger }}>{tradesError}</div>
          )}
          {!tradesLoading && !tradesError && trades.length === 0 && (
            <div data-testid="position-detail-trades-empty" style={{ ...labelStyle, color: COLORS.neutral }}>
              暂无交易记录
            </div>
          )}
          {!tradesLoading && !tradesError && trades.length > 0 && (
            /*
             * ⚠️ 外层**可横向滚动容器** —— 5 列表格在 375px 窄屏下内容宽度可能超过容器，
             *    没有这层包裹就会把弹窗撑宽 → 页面级横向溢出（G3.5）。
             *    加了它：表格在**自己内部**横向滚动，弹窗宽度不变。
             *
             * ⚠️ 容器**必须键盘可达**（axe `scrollable-region-focusable`，serious 级）：
             *    `ScrollableTable` 统一带 `role="region"` + `aria-label` + `tabIndex={0}`，
             *    裸写 `overflowX:'auto'` 会被判违规（键盘用户无法滚动该区域）。
             */
            <ScrollableTable label="最近交易表">
              <table
                style={{ width: '100%', borderCollapse: 'collapse', fontSize: TYPO.smallSize }}
                aria-label="最近交易"
              >
                <thead>
                  <tr>
                    <th scope="col" style={{ textAlign: 'left', color: COLORS.textSecondary }}>
                      日期
                    </th>
                    <th scope="col" style={{ textAlign: 'left', color: COLORS.textSecondary }}>
                      类型
                    </th>
                    <th scope="col" style={{ textAlign: 'right', color: COLORS.textSecondary }}>
                      数量
                    </th>
                    <th scope="col" style={{ textAlign: 'right', color: COLORS.textSecondary }}>
                      价格
                    </th>
                    <th scope="col" style={{ textAlign: 'left', color: COLORS.textSecondary }}>
                      原因
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} data-testid="position-detail-trade-row">
                      <td style={{ padding: '4px 6px' }}>{t.trade_date}</td>
                      <td style={{ padding: '4px 6px' }}>{TRADE_TYPE_LABEL[t.trade_type] ?? t.trade_type}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right' }}>{t.quantity}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right' }}>{fmt(t.price)}</td>
                      <td style={{ padding: '4px 6px', color: COLORS.textSecondary }}>
                        {t.trade_reason ?? '--'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollableTable>
          )}
        </section>

        {/* ── ④ K 线小图 ── */}
        <section data-testid="position-detail-kline" style={{ marginBottom: SPACING.gapRelaxed }}>
          <div style={sectionTitleStyle}>K 线小图（近 {days} 天）</div>
          {code ? (
            <KlineMiniChart symbol={code} days={days} fq={fq} />
          ) : (
            <div style={{ ...labelStyle, color: COLORS.neutral }}>暂无标的</div>
          )}
        </section>

        {/* ── 底部：进入完整 K 线页 + 交易快捷入口 ── */}
        <footer
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: SPACING.gapBase,
            flexWrap: 'wrap',
            borderTop: `1px solid ${COLORS.borderSubtle}`,
            paddingTop: SPACING.gapBase,
          }}
        >
          {code ? (
            <Link
              to={klineHref(code)}
              data-testid="position-detail-kline-link"
              onClick={() => onCancel()}
              style={{
                color: COLORS.brandLink,
                textDecoration: 'underline',
                fontSize: TYPO.bodySize,
                cursor: 'pointer',
              }}
            >
              进入完整 K 线页 →
            </Link>
          ) : (
            <span style={labelStyle}>进入完整 K 线页 →</span>
          )}
          <div style={{ display: 'flex', gap: SPACING.gapBase }}>
            <button
              type="button"
              disabled={!onTrade || !code}
              onClick={() => code && onTrade?.(code, 'buy')}
              style={tradeButtonStyle}
            >
              买入
            </button>
            <button
              type="button"
              disabled={!onTrade || !code}
              onClick={() => code && onTrade?.(code, 'sell')}
              style={tradeButtonStyle}
            >
              卖出
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default PositionDetailModal;
