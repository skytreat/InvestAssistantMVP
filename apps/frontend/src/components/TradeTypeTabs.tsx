import React from 'react';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import { TRADE_TYPE_HINT, TRADE_TYPE_LABEL, type TradeType } from './tradeTypes';

/**
 * 交易类型 Tab 组（T68 · F-T1）
 *
 * ## 依据
 *
 * - `docs/client/PRD.md` §5.4 行 238：
 *   「交易类型选择 | **顶部 Tab 切换：买入 / 加仓 / 减仓 / 清仓 / 除权补充**」；
 * - `docs/audit/gap-list-2026-10-17.md` **F-T1**：
 *   现状是 `<select>` 下拉（F-T1 的证据行 `TradeInput.tsx:249-262`），与 PRD 不符；
 * - `docs/client/Requirements_simplified.md` §5.1：7 种类型
 *   （买入 / 加仓 / 减仓 / 清仓 + **分红 / 送股 / 转增**）。
 *
 * ## 结构（5 个主 Tab + 1 个次级入口）
 *
 * ```
 * [买入] [加仓] [减仓] [清仓] [除权补充 ▾]      ← 顶部 Tab 行（PRD §5.4 的 5 项）
 *                    └─ 展开后 ↓
 *              [分红] [送股] [转增]              ← 次级面板（3 种除权补充类型）
 * ```
 *
 * - **主 Tab**：`buy` / `add` / `reduce` / `clear`（4 项，用户主动交易）；
 * - **次级入口**「除权补充」：点击展开 `dividend` / `bonus` / `transfer`（3 项），
 *   选中后「除权补充」本身呈激活态（aria-selected=true）——
 *   这正是 PRD §5.4 说的「除权补充」是一个 Tab、而业务上又有 3 个细分类型。
 *
 * ## 中文标签的单一真相源
 *
 * 标签一律取自 `components/tradeTypes.ts`（**不本地另写一份**）——
 * 该模块是 7 种类型中文名的唯一来源（此前散落 4 个文件且互相矛盾）。
 */

export interface TradeTypeTabsProps {
  /** 当前选中的交易类型 */
  value: TradeType;
  /** 切换交易类型 */
  onChange: (type: TradeType) => void;
  /** 「除权补充」次级面板是否展开 */
  exDividendOpen: boolean;
  /** 展开 / 收起「除权补充」次级面板 */
  onToggleExDividend: () => void;
}

/** 主 Tab（PRD §5.4：买入 / 加仓 / 减仓 / 清仓）*/
export const MAIN_TRADE_TABS: TradeType[] = ['buy', 'add', 'reduce', 'clear'];

/** 「除权补充」次级面板里的 3 个细分类型（Requirements §5.1：分红 / 送股 / 转增）*/
export const EX_DIVIDEND_TRADE_TABS: TradeType[] = ['dividend', 'bonus', 'transfer'];

/** Tab 按钮的基础样式 */
const tabBaseStyle: React.CSSProperties = {
  padding: `${SPACING.gapTight} ${SPACING.gapRelaxed}`,
  border: `1px solid ${COLORS.borderMedium}`,
  borderRadius: RADIUS.sm,
  fontSize: TYPO.bodySize,
  cursor: 'pointer',
  background: COLORS.cardBg,
  color: COLORS.textSecondary,
  minHeight: 32,
};

/** 激活态 */
const tabActiveStyle: React.CSSProperties = {
  ...tabBaseStyle,
  border: `1px solid ${COLORS.brand}`,
  background: COLORS.brand,
  color: COLORS.cardBg,
  fontWeight: 600,
};

/** 次级入口（除权补充）的常态 —— 描边，弱于主 Tab */
const tabSecondaryStyle: React.CSSProperties = {
  ...tabBaseStyle,
  border: `1px solid ${COLORS.brand}`,
  color: COLORS.brand,
};

export default function TradeTypeTabs({
  value,
  onChange,
  exDividendOpen,
  onToggleExDividend,
}: TradeTypeTabsProps) {
  const isExType = EX_DIVIDEND_TRADE_TABS.includes(value);

  return (
    <div style={{ marginBottom: SPACING.gapRelaxed }}>
      <div
        role="tablist"
        aria-label="交易类型"
        style={{ display: 'flex', gap: SPACING.gapBase, flexWrap: 'wrap' }}
      >
        {MAIN_TRADE_TABS.map((type) => (
          <button
            key={type}
            type="button"
            role="tab"
            aria-selected={value === type}
            title={TRADE_TYPE_HINT[type]}
            data-testid={`trade-tab-${type}`}
            onClick={() => onChange(type)}
            style={value === type ? tabActiveStyle : tabBaseStyle}
          >
            {TRADE_TYPE_LABEL[type]}
          </button>
        ))}

        {/* 次级入口：展开分红 / 送股 / 转增 */}
        <button
          type="button"
          role="tab"
          aria-selected={isExType}
          aria-expanded={exDividendOpen}
          title="分红 / 送股 / 转增（系统自动导入为主，可人工补充）"
          data-testid="trade-tab-exdividend"
          onClick={onToggleExDividend}
          style={isExType ? tabActiveStyle : tabSecondaryStyle}
        >
          除权补充{exDividendOpen ? ' ▾' : ' ▸'}
        </button>
      </div>

      {exDividendOpen && (
        <div
          role="group"
          aria-label="除权补充类型"
          data-testid="trade-exdividend-panel"
          style={{
            display: 'flex',
            gap: SPACING.gapBase,
            flexWrap: 'wrap',
            marginTop: SPACING.gapBase,
            padding: SPACING.gapBase,
            border: `1px solid ${COLORS.borderLight}`,
            borderRadius: RADIUS.sm,
            background: COLORS.headerBg,
          }}
        >
          {EX_DIVIDEND_TRADE_TABS.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={value === type}
              title={TRADE_TYPE_HINT[type]}
              data-testid={`trade-tab-${type}`}
              onClick={() => onChange(type)}
              style={value === type ? tabActiveStyle : tabBaseStyle}
            >
              {TRADE_TYPE_LABEL[type]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
