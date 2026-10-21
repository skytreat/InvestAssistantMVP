import React from 'react';
import { COLORS, RADIUS, TYPO } from '../theme/tokens';
import { DIRECTION_LABEL } from './positionDomain';

/**
 * 策略信号页的 **方向 pill + 标签 tag**（T72 ②）
 *
 * ## 方向颜色的权威口径（**不自己发明**）
 *
 * 依据链（三层，逐层引用，不复述）：
 *
 * 1. **PRD §5.2「策略信号标记 | 买入绿▲/卖出红▼，鼠标悬停显示方向 + 强度 + 指标明细」**
 *    —— 方向与颜色的对应关系由 PRD 定义（买=绿、卖=红）。
 * 2. **`components/SignalBadge.tsx`（T67 Dashboard 持仓卡信号标记）** ——
 *    现网前端既有的方向配色口径：`buy → COLORS.success`（绿）、
 *    `sell → COLORS.danger`（红）、`hold → COLORS.textSecondary`（灰）。
 *    本组件与它**保持一致**（同一方向在两个页面不能一个绿一个紫）。
 * 3. **`theme/tokens.ts` 的 pill 色板**（T69 登记）——
 *    `bgPillSuccess/textPillSuccess/borderPillSuccess`（绿）、
 *    `bgPillDanger/textPillDanger/borderPillDanger`（红）、
 *    `bgPillNeutral/textPillNeutral/borderPillNeutral`（灰）。
 *
 * ⚠️ **PRD 没有规定「持仓（hold）」的颜色** —— 本组件按既有前端口径（SignalBadge）
 *    取**灰色**（中性 = 无操作），并在此登记说明，便于后续统一。
 *
 * ## 为什么是 pill 而不是彩色文字
 *
 * gap-list F-R2 实测旧实现「以 `<td>` 彩色文字呈现」→ 颜色是唯一的信息载体，
 * 色觉障碍用户无法区分。pill（底色 + 描边 + 圆角）配合 **▲/▼/· 符号**
 * 提供**第二重非颜色线索**（符号用 `aria-hidden` 标记，语义由旁边的中文标签承担）。
 */

/** 方向 → 配色（token 三元组，全部来自 `theme/tokens.ts`，**不写裸 hex**）*/
export const SIGNAL_DIRECTION_COLOR: Record<string, { bg: string; fg: string; border: string }> = {
  buy: { bg: COLORS.bgPillSuccess, fg: COLORS.textPillSuccess, border: COLORS.borderPillSuccess },
  sell: { bg: COLORS.bgPillDanger, fg: COLORS.textPillDanger, border: COLORS.borderPillDanger },
  hold: { bg: COLORS.bgPillNeutral, fg: COLORS.textPillNeutral, border: COLORS.borderPillNeutral },
};

/**
 * 方向 → 符号
 *
 * 与 `components/SignalBadge.tsx` 的 `DIRECTION_SYMBOL` 同款（▲ 买入 / ▼ 卖出 / · 持有）。
 * ⚠️ 这里的 `hold` 文案用信号表口径「持仓」（`DIRECTION_LABEL`），
 *    而 SignalBadge 用「持有」—— **两者语义不同，不要混用**。
 */
const DIRECTION_SYMBOL: Record<string, string> = {
  buy: '▲',
  sell: '▼',
  hold: '·',
};

/** pill 的公共样式（圆角 + 描边 + 不换行）*/
const pillStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: RADIUS.sm,
  fontSize: TYPO.captionSize,
  fontWeight: TYPO.cardTitleWeight,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
};

/**
 * 方向 pill
 *
 * @param direction 后端 `direction` 枚举（`buy` / `sell` / `hold`）
 */
export function SignalDirectionPill({ direction }: { direction: string }) {
  const color = SIGNAL_DIRECTION_COLOR[direction] ?? SIGNAL_DIRECTION_COLOR.hold;
  const label = DIRECTION_LABEL[direction] ?? direction;
  return (
    <span
      data-testid="signal-direction-pill"
      data-direction={direction}
      title={label}
      style={{
        ...pillStyle,
        background: color.bg,
        color: color.fg,
        border: `1px solid ${color.border}`,
      }}
    >
      {/* 符号只是颜色之外的辅助线索，对读屏隐藏（语义由后面的中文标签承担）*/}
      <span aria-hidden="true">{DIRECTION_SYMBOL[direction] ?? '·'}</span> {label}
    </span>
  );
}

/**
 * 标签 tag（信号的人读描述，如「放量突破」「RSI 超卖」）
 *
 * ⚠️ **用中性灰 pill**：标签本身**不含**方向语义（方向由方向 pill 承担），
 *    着色会让「标签颜色 = 方向」的错觉。
 */
export function SignalLabelTag({ label }: { label: string | null | undefined }) {
  if (!label) {
    return (
      <span data-testid="signal-label-empty" style={{ color: COLORS.textMuted }}>
        --
      </span>
    );
  }
  return (
    <span
      data-testid="signal-label-tag"
      style={{
        ...pillStyle,
        background: COLORS.bgPillNeutral,
        color: COLORS.textPillNeutral,
        border: `1px solid ${COLORS.borderPillNeutral}`,
      }}
    >
      {label}
    </span>
  );
}
