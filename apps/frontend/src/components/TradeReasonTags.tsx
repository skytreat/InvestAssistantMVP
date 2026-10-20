import React from 'react';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import type { TradeType } from './tradeTypes';

/**
 * 操作理由预设标签（T68 · F-T6）
 *
 * ## 依据
 *
 * - `docs/client/PRD.md` §5.4 行 241：
 *   「标签快捷填充 | 预设标签按钮（如「策略触发」「止损」「抄底」），**一键填入操作理由**」；
 * - `docs/audit/gap-list-2026-10-17.md` **F-T6**：
 *   现状「`trade_reason` 是纯文本框」，无快捷标签。
 *
 * ## 标签按交易类型动态出现 / 消失
 *
 * | 交易类型 | 标签 |
 * |---|---|
 * | 买入 / 加仓 | 策略触发 / 抄底 / 长期持有 |
 * | 减仓 / 清仓 | 策略触发 / 止损 |
 * | 分红 / 送股 / 转增（除权补充）| **无** —— 理由由系统固化，不允许用户改 |
 *
 * 「止损」只在卖出方向出现、「抄底」只在买入方向出现 —— 避免给出与交易方向矛盾的标签。
 */

/** 各交易类型的预设标签 */
export const TRADE_REASON_TAGS: Record<TradeType, string[]> = {
  buy: ['策略触发', '抄底', '长期持有'],
  add: ['策略触发', '抄底', '长期持有'],
  reduce: ['策略触发', '止损'],
  clear: ['策略触发', '止损'],
  dividend: [],
  bonus: [],
  transfer: [],
};

export interface TradeReasonTagsProps {
  /** 要显示的标签（由交易类型决定）*/
  tags: string[];
  /** 点击标签 → 填充操作理由 */
  onPick: (tag: string) => void;
}

export default function TradeReasonTags({ tags, onPick }: TradeReasonTagsProps) {
  if (tags.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="操作理由预设标签"
      data-testid="trade-reason-tags"
      style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.gapBase, marginTop: SPACING.gapTight }}
    >
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => onPick(tag)}
          data-testid={`reason-tag-${tag}`}
          style={{
            padding: `2px ${SPACING.gapBase}`,
            border: `1px solid ${COLORS.borderMedium}`,
            borderRadius: RADIUS.sm,
            background: COLORS.cardBg,
            color: COLORS.brandLink,
            fontSize: TYPO.captionSize,
            cursor: 'pointer',
            minHeight: 24,
          }}
        >
          {tag}
        </button>
      ))}
    </div>
  );
}
