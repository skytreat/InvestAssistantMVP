import { COLORS, TYPO } from '../theme/tokens';
import { formatIndicator, type ChartBar, type TradeMarker } from '../indicators/chartBars';
import { DEFAULT_MA_PERIODS } from '../indicators/chartParams';
import type { SubIndicatorKind } from './KlineChart';

/**
 * 十字光标悬浮窗（F-K6 / F-K8）
 *
 * PRD §5.2：「悬浮窗显示当日 **OHLCV + 指标值 + 信号标记**」；
 * F-K8 进一步要求信号 hover 出「**方向 + 强度 + 指标明细**」。
 *
 * ## 为什么自己画（而不用库的 tooltip）
 *
 * klinecharts 的内置 tooltip 只画**蜡烛 + 指标图例**，
 * **不认识「策略信号」** —— 信号明细（`metrics_json`）是后端产物，
 * 只能由本组件渲染。
 *
 * ⇒ 悬浮窗 = 库负责的十字光标位置 + **本组件负责的信息面板**（两者叠加）。
 *
 * ## 单独成组件的理由
 *
 * jsdom 无 Canvas ⇒ 图表本体在 jsdom 里测不了，
 * 但**这块信息面板是纯渲染** ⇒ 可独立单测（见 `tests/unit/kline-page.test.tsx`）。
 */

export interface KlineHoverPanelProps {
  /** 当前 hover 的 K 线（`null` = 不显示）*/
  bar: ChartBar | null;
  /** 是否显示 MA 指标行 */
  showMa: boolean;
  /** 当前副图类型（决定显示 MACD / RSI / KDJ 哪一行）*/
  subIndicator: SubIndicatorKind;
  /**
   * MA 四条线的**当前周期**（T71：周期可编辑 ⇒ 标签必须跟着变）
   *
   * 缺省用默认周期（5/10/20/60）。
   */
  maPeriods?: readonly number[];
}

/** 格式化成交量（万 / 亿）*/
export function formatVolume(value: number): string {
  if (!Number.isFinite(value)) return '--';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)} 万`;
  return String(value);
}

/** 信号方向 → 中文 */
export function signalDirectionText(direction: string): string {
  if (direction === 'buy') return '买入';
  if (direction === 'sell') return '卖出';
  return direction;
}

/** 交易标记展示类型 → 中文（T152） */
export function tradeMarkerTypeLabel(type: TradeMarker['marker_type']): string {
  switch (type) {
    case 'open':
      return '建仓';
    case 'add':
      return '加仓';
    case 'reduce':
      return '减仓';
    case 'close':
      return '清仓';
    default:
      return type;
  }
}

/** 指标明细（`metrics_json`）→ 可读文本 */
export function formatMetrics(metrics: Record<string, unknown> | null): string {
  if (!metrics) return '';
  return Object.entries(metrics)
    .map(([key, value]) => `${key}=${typeof value === 'number' ? formatIndicator(value, 2) : String(value)}`)
    .join('  ');
}

export default function KlineHoverPanel({
  bar,
  showMa,
  subIndicator,
  maPeriods = DEFAULT_MA_PERIODS,
}: KlineHoverPanelProps) {
  if (!bar) return null;

  const maValues = [bar.ma1, bar.ma2, bar.ma3, bar.ma4];

  return (
    <div
      data-testid="kline-hover-panel"
      style={{
        position: 'absolute',
        left: 8,
        top: 8,
        zIndex: 5,
        pointerEvents: 'none',
        padding: '6px 8px',
        borderRadius: 4,
        background: 'rgba(0, 0, 0, 0.55)',
        color: COLORS.chartText,
        fontSize: TYPO.captionSize,
        lineHeight: 1.6,
        maxWidth: '92%',
      }}
    >
      <div style={{ color: COLORS.cardBg, fontWeight: 600 }}>{bar.date}</div>
      <div>
        开 {formatIndicator(bar.open)} 高 {formatIndicator(bar.high)} 低 {formatIndicator(bar.low)} 收{' '}
        {formatIndicator(bar.close)}
        {bar.changePct !== null && bar.changePct !== undefined && (
          <span
            style={{
              marginLeft: 6,
              color: bar.changePct >= 0 ? COLORS.candleUp : COLORS.candleDown,
              fontWeight: 600,
            }}
          >
            {bar.changePct >= 0 ? '+' : ''}
            {bar.changePct.toFixed(2)}%
          </span>
        )}
      </div>
      <div>量 {formatVolume(bar.volume)}</div>
      {showMa && (
        <div>
          {maPeriods.map((period, i) => `MA${period} ${formatIndicator(maValues[i] ?? NaN)}`).join(' ')}
        </div>
      )}
      {subIndicator === 'macd' && (
        <div>
          DIF {formatIndicator(bar.dif, 4)} DEA {formatIndicator(bar.dea, 4)} MACD{' '}
          {formatIndicator(bar.macd, 4)}
        </div>
      )}
      {subIndicator === 'rsi' && <div>RSI {formatIndicator(bar.rsi)}</div>}
      {subIndicator === 'kdj' && (
        <div>
          K {formatIndicator(bar.k)} D {formatIndicator(bar.d)} J {formatIndicator(bar.j)}
        </div>
      )}
      {bar.signal && (
        <div data-testid="kline-hover-signal">
          <span style={{ color: bar.signal.direction === 'buy' ? COLORS.textSuccess : COLORS.danger }}>
            {bar.signal.direction === 'buy' ? '▲' : '▼'} {signalDirectionText(bar.signal.direction)}
          </span>
          {bar.signal.label ? ` · ${bar.signal.label}` : ''}
          {bar.signal.strength !== null && bar.signal.strength !== undefined
            ? ` · 强度 ${(bar.signal.strength * 100).toFixed(0)}%`
            : ''}
          {bar.signal.plugin_id ? ` · ${bar.signal.plugin_id}` : ''}
        </div>
      )}
      {bar.signal?.metrics && (
        <div data-testid="kline-hover-signal-metrics">指标 {formatMetrics(bar.signal.metrics)}</div>
      )}
      {bar.trades.length > 0 && (
        <div data-testid="kline-hover-trades">
          交易 {bar.trades.length} 笔：
          {bar.trades
            .map((trade) => {
              const label =
                trade.marker_type === 'open'
                  ? '建仓'
                  : trade.marker_type === 'add'
                    ? '加仓'
                    : trade.marker_type === 'reduce'
                      ? '减仓'
                      : '清仓';
              return `${label} ${trade.quantity} @ ${formatIndicator(trade.adj_price)}`;
            })
            .join('；')}
        </div>
      )}
    </div>
  );
}
