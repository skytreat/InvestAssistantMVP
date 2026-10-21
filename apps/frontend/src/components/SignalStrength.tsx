import React from 'react';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';

/**
 * 信号强度（**进度条 + 星**）渲染（T72 ②）
 *
 * ## 字段口径（实测后端，不是猜的）
 *
 * - 后端表 `user_strategy_signal.strength` 是 **REAL 可空列**
 *   （`apps/backend/src/config/configStore.ts:120`）；
 * - `GET /api/signal` 是 `SELECT *`（`apps/backend/src/routes/signal.ts:73`）
 *   ⇒ **响应里一定带 `strength` 字段**，值域 **0~1**（插件引擎口径：
 *   `apps/backend/src/services/pluginEngine.ts:129`「0-1 信号强度」）；
 * - 内置插件（rsi / macd_cross / volume_spike …）**都会回传 strength**
 *   （`pluginEngine.ts:354/365/432/444/539/602`），
 *   但 `signalService.ts:114` 用 `s.strength ?? null` 落库
 *   ⇒ **历史数据 / 自定义插件可能为 null**。
 *
 * ⚠️ **字段不存在（null / undefined）时降级显示 `--`，且不渲染进度条** ——
 *    渲染一条宽度未知的条会给出「强度为 0」的**误导性**结论
 *    （与 `components/WeightBar.tsx` 的降级口径一致）。
 *
 * ## 为什么同时给星和进度条
 *
 * - **星**：一眼可读的相对强度（用户视角）；
 * - **进度条**：`role="progressbar"` + `aria-valuenow` —— axe 的
 *   `aria-progressbar-value` 规则会检查这些属性，缺一个即 critical 违规。
 *   它同时是**精确值**的载体（百分比文本）。
 */

/** 星的数量（5 星制）*/
const STAR_COUNT = 5;

export interface SignalStrengthProps {
  /** 信号强度（**0~1 的小数**）；`null` / `undefined` = 无强度数据 → 降级显示 `--` */
  value: number | null | undefined;
  /** 进度条的无障碍名（读屏播报用）*/
  label?: string;
}

/** 百分比文本（0~1 小数 → 整数百分比）*/
function pctText(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** 进度条内层宽度（精确字符串，避免浮点尾巴）*/
function widthStyle(value: number): string {
  const pct = Math.min(100, Math.max(0, value * 100));
  return `${Number(pct.toFixed(2))}%`;
}

export function SignalStrength({ value, label = '信号强度' }: SignalStrengthProps) {
  // 降级：字段缺失 / 非法 → 只显示占位符，**不渲染进度条**
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return (
      <span data-testid="signal-strength-empty" style={{ color: COLORS.textMuted, fontSize: TYPO.smallSize }}>
        --
      </span>
    );
  }

  const clamped = Math.min(1, Math.max(0, value));
  // 强度 > 0 至少给 1 颗星（0.02 的强度不该显示成「0 星」）
  const filled = Math.max(clamped > 0 ? 1 : 0, Math.round(clamped * STAR_COUNT));

  return (
    <span
      data-testid="signal-strength"
      style={{ display: 'inline-flex', alignItems: 'center', gap: SPACING.gapTight }}
    >
      {/* 星：颜色之外的第二重线索（纯装饰，读屏由百分比文本承担）；用正文色档保证浅底可读 */}
      <span
        aria-hidden="true"
        style={{ color: COLORS.textWarning, fontSize: TYPO.smallSize, letterSpacing: 1 }}
      >
        {'★'.repeat(filled)}
        {'☆'.repeat(STAR_COUNT - filled)}
      </span>
      <span
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(clamped * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          display: 'inline-block',
          width: 48,
          height: 6,
          background: COLORS.borderSubtle,
          borderRadius: RADIUS.sm,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            display: 'block',
            width: widthStyle(clamped),
            height: '100%',
            background: COLORS.brand,
          }}
        />
      </span>
      <span style={{ fontSize: TYPO.captionSize, color: COLORS.textSecondary }}>{pctText(clamped)}</span>
    </span>
  );
}
