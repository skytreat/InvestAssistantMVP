import React from 'react';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import type { SortDirection, SortKey, TypeFilter } from './positionDomain';

/**
 * 持仓列表的排序 / 过滤工具条（T67 · 卡 3 · F-D5）
 *
 * 依据 PRD §5.3 行 232：「按**盈亏金额/收益率/仓位占比**排序；按**标的类型/行业**过滤」。
 *
 * ## 行业筛选为什么是禁用的（裁决 D-4）
 *
 * PRD 要求按行业过滤，但 `raw_tdx_blocks_member` / `raw_tdx_blocks_info`
 * **实测均为 0 行**（2026-10-20）⇒ `industry` 字段**恒为 `null`**。
 *
 * ⇒ 控件 `disabled` + 旁边明示「行业数据源暂不可用」——
 *   **不许静默失效**（用户会以为「筛了但没结果」）。
 *   数据源恢复后，只要持仓里出现非空 `industry`，控件会自动启用。
 */
export interface PositionToolbarProps {
  /** 当前排序依据 */
  sortKey: SortKey;
  /** 当前排序方向 */
  sortDirection: SortDirection;
  /** 切换排序依据 */
  onSortKeyChange: (key: SortKey) => void;
  /** 切换排序方向（降序 ⇄ 升序） */
  onSortDirectionToggle: () => void;
  /** 当前标的类型过滤（**与饼图下钻共用同一个 state** —— 单一真相源）*/
  typeFilter: TypeFilter;
  /** 切换标的类型过滤 */
  onTypeFilterChange: (filter: TypeFilter) => void;
  /** 行业数据源是否可用（当前恒为 false，见上方说明）*/
  industryAvailable: boolean;
}

/** 排序依据的三个档位（PRD §5.3 行 232）*/
const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'pnl', label: '按盈亏金额' },
  { key: 'yield', label: '按收益率' },
  { key: 'weight', label: '按仓位占比' },
];

/** 标的类型过滤的三个档位 */
const TYPE_OPTIONS: ReadonlyArray<{ key: TypeFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'stock', label: '股票' },
  { key: 'etf', label: 'ETF' },
];

export function PositionToolbar({
  sortKey,
  sortDirection,
  onSortKeyChange,
  onSortDirectionToggle,
  typeFilter,
  onTypeFilterChange,
  industryAvailable,
}: PositionToolbarProps) {
  const typeSelectId = React.useId();
  const industrySelectId = React.useId();

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px',
    fontSize: TYPO.smallSize,
    fontFamily: TYPO.fontFamily,
    borderRadius: RADIUS.sm,
    border: `1px solid ${active ? COLORS.borderSelectedPrimary : COLORS.borderMedium}`,
    background: active ? COLORS.bgSelectedPrimary : COLORS.cardBg,
    color: COLORS.textPrimary,
    fontWeight: active ? 700 : 400,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });

  const selectStyle: React.CSSProperties = {
    ...toggleStyle(false),
    cursor: 'pointer',
    minWidth: 84,
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: TYPO.captionSize,
    color: COLORS.textSecondary,
    marginBottom: 2,
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: SPACING.gapRelaxed,
        flexWrap: 'wrap',
        marginBottom: SPACING.gapRelaxed,
      }}
    >
      {/* ── 排序依据 + 排序方向 ── */}
      <div role="group" aria-label="持仓排序" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            aria-pressed={sortKey === opt.key}
            onClick={() => onSortKeyChange(opt.key)}
            style={toggleStyle(sortKey === opt.key)}
          >
            {opt.label}
          </button>
        ))}
        <button type="button" onClick={onSortDirectionToggle} title="切换排序方向" style={toggleStyle(false)}>
          {sortDirection === 'desc' ? '降序' : '升序'}
        </button>
      </div>

      {/* ── 标的类型过滤 ── */}
      <div>
        <label htmlFor={typeSelectId} style={labelStyle}>
          标的类型
        </label>
        <select
          id={typeSelectId}
          value={typeFilter}
          onChange={(e) => onTypeFilterChange(e.target.value as TypeFilter)}
          style={selectStyle}
        >
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* ── 行业过滤（数据源不可用 → 禁用 + 显式说明） ── */}
      <div>
        <label htmlFor={industrySelectId} style={labelStyle}>
          行业
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.gapBase, flexWrap: 'wrap' }}>
          <select
            id={industrySelectId}
            disabled={!industryAvailable}
            style={{ ...selectStyle, cursor: industryAvailable ? 'pointer' : 'not-allowed' }}
          >
            <option value="all">全部</option>
          </select>
          {!industryAvailable && (
            /*
             * ⚠️ 用 `textDisclaimer`（#92400e，6.8:1）而不是 `warning`（#d97706，3.2:1）——
             *    这是 11px 小字，3.2:1 **不达 WCAG AA 的 4.5:1**；
             *    真浏览器 axe 的 `color-contrast` 会报（jsdom 测不到那条规则）。
             */
            <span style={{ fontSize: TYPO.captionSize, color: COLORS.textDisclaimer }}>
              行业数据源暂不可用
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default PositionToolbar;
