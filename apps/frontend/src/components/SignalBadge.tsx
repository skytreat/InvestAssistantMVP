import React from 'react';
import { COLORS, TYPO } from '../theme/tokens';
import { DIRECTION_LABEL, isSignalStale, type PositionSignal } from './positionDomain';

/**
 * 持仓卡的策略信号标记（T67 · 卡 3 · ux_v2 建议 A）
 *
 * 依据 ux_v2 行 349-368：
 * - 「每张持仓卡片右侧（或名称下方）直接显示当前策略信号状态，用**极简图标**」；
 * - ▲ 买入（绿）/ ▼ 卖出（红）/ · 持有（灰）；
 * - 「无信号时显示 `·持有`（灰色小点）」；
 * - 「信号过期（超过 5 个交易日未更新）显示 `⚠信号过期`（橙色三角）」。
 *
 * ## 三态与「无信号」的区别（卡 3 风险与坑的裁决）
 *
 * ux_v2 行 355 说「无信号时显示 `·持有`」，而 `direction === 'hold'` 也是 `·`。
 * 本卡按卡 3 的裁决实现：**两者都显示「·持有」**（区分点是「有没有信号对象」——
 * 卡 7 的 Mini-Menu 只有存在 `signal` 时才有入口）。
 *
 * ⚠️ **「无信号」时不渲染信号徽章**（`data-testid="signal-badge"` 不出现），
 *    只留一个中性的「· 持有」占位文案 —— 用户能看出「没有信号」，
 *    而不会误以为「持有」是某个插件给出的结论。
 */
export interface SignalBadgeProps {
  /** 该标的的最新信号；`null` = 无信号 */
  signal: PositionSignal | null;
  /** 最新行情交易日（`summary.priceDate`）—— 信号过期判据（裁决 D-5）*/
  priceDate?: string | null;
}

/** 方向 → 图标（极简符号，ux_v2 行 351）*/
const DIRECTION_SYMBOL: Record<string, string> = {
  buy: '▲',
  sell: '▼',
  hold: '·',
};

/** 方向 → 颜色 */
function directionColor(direction: string): string {
  if (direction === 'buy') return COLORS.success;
  if (direction === 'sell') return COLORS.danger;
  return COLORS.textSecondary;
}

/**
 * 徽章上的方向文案
 *
 * ⚠️ `hold` 用「**持有**」（ux_v2 行 355 的「·持有」），
 *    而 `DIRECTION_LABEL.hold` 是「持仓」（信号表里的用词）—— 两者语义不同，故此处单点覆盖。
 */
function directionText(direction: string): string {
  if (direction === 'hold') return '持有';
  return DIRECTION_LABEL[direction] ?? '持有';
}

export function SignalBadge({ signal, priceDate }: SignalBadgeProps) {
  const mutedStyle: React.CSSProperties = {
    fontSize: TYPO.captionSize,
    color: COLORS.textSecondary,
  };

  // 无信号 → 只留中性占位，**不渲染信号徽章**
  if (!signal) {
    return (
      <span data-testid="signal-hold" style={{ ...mutedStyle, whiteSpace: 'nowrap' }}>
        · 持有
      </span>
    );
  }

  const stale = isSignalStale(signal, priceDate);

  if (stale) {
    return (
      <span
        data-testid="signal-badge"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
      >
        {/*
          ⚠ 图标用 `warning`（#d97706，对白底 3.2:1 —— **非文字元素**只需 3:1），
          文字用 `textDisclaimer`（#92400e，6.8:1 —— 小字需 4.5:1）。
          ⚠️ 不整段用 `warning`：那是 13px 小字，3.2:1 **不达 WCAG AA**，
          真浏览器 axe 的 `color-contrast` 会报（jsdom 测不到，见 tests/helpers/a11y.ts）。
        */}
        <span aria-hidden="true" style={{ color: COLORS.warning, fontSize: TYPO.bodySize }}>
          ⚠
        </span>
        <span style={{ color: COLORS.textDisclaimer, fontSize: TYPO.smallSize }}>信号过期</span>
        {/* 过期不等于作废：原信号仍可读，但明确标注它不是最新的 */}
        <span style={mutedStyle}>
          原信号：{directionText(signal.direction)} · {signal.plugin_id}
          {signal.label ? ` · ${signal.label}` : ''} · {signal.trade_date}
        </span>
      </span>
    );
  }

  return (
    <span
      data-testid="signal-badge"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
    >
      <span
        style={{
          color: directionColor(signal.direction),
          fontSize: TYPO.smallSize,
          fontWeight: TYPO.cardTitleWeight,
          whiteSpace: 'nowrap',
        }}
      >
        {DIRECTION_SYMBOL[signal.direction] ?? '·'} {directionText(signal.direction)}
      </span>
      <span style={mutedStyle}>{signal.plugin_id}</span>
      {signal.label ? <span style={mutedStyle}>{signal.label}</span> : null}
    </span>
  );
}

export default SignalBadge;
