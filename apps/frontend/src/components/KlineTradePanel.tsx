import { COLORS, TYPO } from '../theme/tokens';
import { formatIndicator, type ChartBar, type TradeMarker } from '../indicators/chartBars';

export interface KlineTradePanelProps {
  /** 被点中的 K 线（没有交易时也不应渲染） */
  bar: ChartBar | null;
  onClose: () => void;
}

const MARKER_TYPE_LABELS: Record<TradeMarker['marker_type'], string> = {
  open: '建仓',
  add: '加仓',
  reduce: '减仓',
  close: '清仓',
};

export function tradeTypeLabel(markerType: TradeMarker['marker_type']): string {
  return MARKER_TYPE_LABELS[markerType] ?? markerType;
}

export default function KlineTradePanel({ bar, onClose }: KlineTradePanelProps) {
  if (!bar || bar.trades.length === 0) return null;

  return (
    <div
      data-testid="kline-trade-panel"
      role="dialog"
      aria-label={`交易明细 ${bar.date}`}
      style={{
        position: 'absolute',
        right: 8,
        top: 8,
        zIndex: 6,
        maxHeight: 240,
        overflowY: 'auto',
        minWidth: 260,
        maxWidth: '92%',
        padding: '8px 10px',
        borderRadius: 4,
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.borderLight}`,
        boxShadow: `0 6px 18px ${COLORS.shadowSoft}`,
        color: COLORS.textPrimary,
        fontSize: TYPO.smallSize,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontWeight: 600 }}>
          {bar.date} · {bar.trades.length} 笔交易
        </div>
        <button
          type="button"
          data-testid="kline-trade-panel-close"
          onClick={onClose}
          aria-label="关闭交易明细"
          style={{
            border: 'none',
            background: 'transparent',
            color: COLORS.textMuted,
            cursor: 'pointer',
            padding: 2,
            fontSize: TYPO.bodySize,
          }}
        >
          ×
        </button>
      </div>

      <div style={{ marginTop: 6, display: 'grid', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
        {bar.trades.map((trade) => (
          <div
            key={trade.id}
            data-testid={`kline-trade-item-${trade.id}`}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr auto auto',
              columnGap: 8,
              rowGap: 2,
              padding: '4px 6px',
              borderRadius: 4,
              background: COLORS.pageBg,
              border: `1px solid ${COLORS.borderLight}`,
            }}
          >
            <span
              style={{
                color:
                  trade.marker_type === 'open' || trade.marker_type === 'add'
                    ? COLORS.candleUp
                    : COLORS.candleDown,
                fontWeight: 600,
              }}
            >
              {tradeTypeLabel(trade.marker_type)}
            </span>
            <span style={{ color: COLORS.textSecondary }}>
              原始：{trade.trade_type}
              {trade.trade_time ? ` · ${trade.trade_time}` : ''}
            </span>
            <span style={{ color: COLORS.textSecondary }}>数量 {trade.quantity}</span>
            <span style={{ color: COLORS.textSecondary }}>
              复权价 {formatIndicator(trade.adj_price)}
              {trade.price !== trade.adj_price ? `（成交价 ${formatIndicator(trade.price)}）` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
