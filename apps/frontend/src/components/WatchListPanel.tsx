import React from 'react';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import { tableStyle, thStyle, thTdStyle } from '../theme/styles';
import ScrollableTable from './ScrollableTable';
import EmptyState from './EmptyState';

/**
 * WatchListPanel.tsx —— 候选池页的「自选列表」分区（T74 · 实施计划 T74 卡片）
 *
 * ## 为什么要这个分区
 *
 * 候选池与自选是**两个独立的关系类型**（Requirements §5.7 #1「独立于自选列表」），
 * 但 PRD S5 的迁移语义要求用户能**看见**「迁移 ≠ 加入自选」这件事：
 *
 * > 「MVP 迁移操作**只在候选记录上打标记，不会自动创建自选关联**（用户需手动从候选池加入自选）」
 *
 * ⇒ 页面上并排给出「候选池」与「自选」两块，用户一眼能确认：
 *   1. 迁移过的候选**仍留在候选池**里（带「已迁移」标记）；
 *   2. 自选列表**不会**因为迁移而多出一条（只有显式点【加入自选】才会）。
 *
 * ⚠️ 本分区是**只读**的：加入自选的动作在候选池表格的行操作里（【加入自选】按钮），
 *    避免同一份数据出现两个入口、两种口径。
 */

/** 自选列表条目（`GET /api/watch` 的行）*/
export interface WatchItem {
  id?: number;
  asset_code: string;
  /** 加入自选的时间（`created_at`，本地时间字符串）*/
  created_at?: string | null;
  /** 自选日期（`watch_date`，历史字段，可能为 null）*/
  watch_date?: string | null;
}

export interface WatchListPanelProps {
  /** 自选列表 */
  rows: WatchItem[];
  /** 加载中 */
  loading: boolean;
  /** 错误文案（非 null 时展示降级提示）*/
  error: string | null;
}

/** 只取日期部分（`created_at` 是 `YYYY-MM-DD HH:MM:SS` 的本地时间串）*/
function datePart(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const matched = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return matched ? matched[1] : null;
}

export default function WatchListPanel({ rows, loading, error }: WatchListPanelProps) {
  return (
    <div style={{ marginTop: SPACING.gapRelaxed }} data-testid="watch-list-panel">
      <div
        style={{
          fontSize: TYPO.cardTitleSize,
          fontWeight: TYPO.cardTitleWeight,
          marginBottom: SPACING.gapBase,
          color: COLORS.textPrimary,
        }}
      >
        自选列表
        <span style={{ color: COLORS.textMuted, fontSize: TYPO.smallSize, marginLeft: 8 }}>
          （共 {rows.length} 只）
        </span>
      </div>

      {error !== null && error !== '' && (
        <div style={{ color: COLORS.danger, fontSize: TYPO.smallSize, marginBottom: SPACING.gapBase }}>
          自选列表加载失败：{error}
        </div>
      )}

      {rows.length === 0 ? (
        <div data-testid="watch-empty">
          <EmptyState
            title={loading ? '加载中...' : '自选列表为空'}
            description={
              loading
                ? undefined
                : '候选池里的标的可以通过「加入自选」按钮显式加入；「迁移自选」只打标记，不会自动加入'
            }
          />
        </div>
      ) : (
        <ScrollableTable label="自选列表表">
          <table style={tableStyle} aria-label="自选列表">
            <thead>
              <tr>
                <th scope="col" style={thStyle}>
                  标的代码
                </th>
                <th scope="col" style={thStyle}>
                  加入日期
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={typeof row.id === 'number' ? row.id : `${row.asset_code}-${index}`}>
                  <td style={thTdStyle}>
                    <code>{row.asset_code}</code>
                  </td>
                  <td style={thTdStyle}>{datePart(row.created_at) ?? datePart(row.watch_date) ?? '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollableTable>
      )}
    </div>
  );
}
