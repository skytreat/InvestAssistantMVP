import React from 'react';
import { COLORS, RADIUS, TYPO } from '../theme/tokens';

/**
 * 仓位占比进度条（T67 · 卡 3 · F-D3）
 *
 * 依据：
 * - PRD §5.3 行 230「仓位占比（**进度条**）」；
 * - gap-list 行 48「仓位占比**只有文字无进度条**」。
 *
 * ## 可访问性
 *
 * `role="progressbar"` + `aria-valuenow` / `aria-valuemin` / `aria-valuemax` + `aria-label`
 * —— axe 的 `progressbar-name` / `aria-progressbar-value` 两条规则都会检查这些属性，
 * 缺一个就是 critical 级违规（Wave 3 G3.4 门禁）。
 *
 * ## 降级
 *
 * `weight` 为 `null`（无行情）→ **不渲染进度条**，只显示 `--`
 * —— 渲染一条宽度未知的条会给出「占比为 0」的**误导性**结论。
 */
export interface WeightBarProps {
  /** 仓位占比（**0~1 的小数**）；`null` = 无行情 → 降级显示 `--` */
  weight: number | null;
  /** 可访问名（读屏播报用），如「sh600000 仓位占比」 */
  label: string;
}

/** 百分比文本（0~1 小数 → 两位小数的百分比）*/
function pctText(weight: number): string {
  return `${(weight * 100).toFixed(2)}%`;
}

/**
 * 进度条内层的宽度字符串
 *
 * ⚠️ **精确字符串**（不是近似值）：`weight = 0.6` → `'60%'`（不是 `'60.00%'`）。
 *    `toFixed(2)` 先消掉浮点尾巴（`0.6 * 100 = 60.00000000000001`），
 *    再 `Number(...)` 去掉无意义的小数零，最后拼 `%`。
 */
function widthStyle(weight: number): string {
  const pct = Math.min(100, Math.max(0, weight * 100));
  return `${Number(pct.toFixed(2))}%`;
}

export function WeightBar({ weight, label }: WeightBarProps) {
  const labelStyle: React.CSSProperties = {
    fontSize: TYPO.captionSize,
    color: COLORS.textSecondary,
  };

  if (weight === null || !Number.isFinite(weight)) {
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span style={labelStyle}>仓位占比</span>
        <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>--</span>
      </div>
    );
  }

  const pct = Math.min(100, Math.max(0, weight * 100));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span style={labelStyle}>仓位占比</span>
        <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>{pctText(weight)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 6,
          width: '100%',
          background: COLORS.borderSubtle,
          borderRadius: RADIUS.sm,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: widthStyle(weight),
            height: '100%',
            background: COLORS.brand,
            borderRadius: RADIUS.sm,
          }}
        />
      </div>
    </div>
  );
}

export default WeightBar;
