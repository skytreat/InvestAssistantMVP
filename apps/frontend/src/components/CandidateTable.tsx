import React from 'react';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import {
  buttonStyle,
  dangerButtonStyle,
  tableStyle,
  thStyle,
  thTdStyle,
  truncatedTextStyle,
} from '../theme/styles';
import ScrollableTable from './ScrollableTable';
import EmptyState from './EmptyState';
import Spinner from './Spinner';
import { SignalDirectionPill, SignalLabelTag } from './SignalPills';
import { fmt, fmtPct } from './positionDomain';

/**
 * CandidateTable.tsx —— 候选池列表（T74 · 实施计划 T74 卡片「候选列表」交付物）
 *
 * ## 列的取舍（**逐条对着 T74 卡片 + PRD S3/S4/S5**）
 *
 * | 列 | 来源字段 | 口径 |
 * |---|---|---|
 * | 标的代码 | `asset_code` | 原样 |
 * | 名称 | `name` | `raw_symbol_name.name`；查不到 → `--`（实测覆盖率约 70%，缺失是常态）|
 * | 基准价 | `candidate_base_price` | **加入日**的前复权收盘价（Requirements §5.7 #2）|
 * | 现价 | `current_close` | 最新前复权收盘价；无行情 → `--` |
 * | 相对收益 | `relative_return` | (现价 − 基准价) / 基准价；缺任一端 → `--`（**不显示 0**）|
 * | 跟踪天数 | `tracked_days` | 加入日 → 今天（SDD §4.4:1426 契约字段）|
 * | 最新信号 | `signal` | 该标的**最新一条**信号；无信号 → `--` |
 *
 * ⚠️ **相对收益的配色口径**：正 = `COLORS.success`（绿）/ 负 = `COLORS.danger`（红），
 *    与 `components/PositionCard.tsx` 的盈亏配色**同款**（P&L 语义在全站一致）。
 *
 * ⚠️ **「迁移自选」与「加入自选」是两个不同的动作**（PRD S5）：
 *    - 【迁移自选】= `POST /api/candidate/:id/migrate` → **只打标记**，**不建** watch 关联；
 *    - 【加入自选】= `POST /api/watch` → **显式**新建自选关联（用户手动做的那一步）。
 *    ⇒ 两者文案刻意不同，且**迁移后 watch 列表里不会出现该标的**。
 */

/** 候选池条目（`GET /api/candidate` 的行）*/
export interface CandidateItem {
  id?: number;
  asset_code: string;
  /** 中文名（`raw_symbol_name.name`）；查不到 → null */
  name?: string | null;
  /** 加入理由 */
  candidate_reason?: string | null;
  /** 基准价（加入日前复权收盘价）*/
  candidate_base_price?: number | null;
  /** 最新前复权收盘价；无行情 → null */
  current_close?: number | null;
  /** 相对收益（0~1 的小数）；缺任一端 → null */
  relative_return?: number | null;
  /** 跟踪天数（加入日 → 今天）*/
  tracked_days?: number | null;
  /** 是否已迁移（1 = 已打迁移标记）*/
  migrated_from_candidate?: number | null;
  /** 迁移时的价格模式（'base' / 'current'）；未迁移 → null */
  migrated_price_mode?: string | null;
  created_at?: string | null;
  /** 该标的最新一条信号；无信号 → null */
  signal?: CandidateSignal | null;
}

/** 候选标的的最新一条信号（与 `services/todaySignals.ts` 的 `SignalRow` 同形）*/
export interface CandidateSignal {
  plugin_id: string;
  direction: string;
  label: string;
  trade_date: string;
}

/** 迁移价格模式（PRD S5：复用基准价 / 使用现价）*/
export type PriceMode = 'base' | 'current';

export interface CandidateTableProps {
  /** 候选列表 */
  rows: CandidateItem[];
  /** 已勾选的标的代码 */
  selected: readonly string[];
  /** 勾选/取消勾选单个标的 */
  onToggle: (assetCode: string) => void;
  /** 全选 / 取消全选 */
  onToggleAll: (checked: boolean) => void;
  /** 迁移到自选（只打标记）*/
  onMigrate: (assetCode: string) => void;
  /** 移除候选（软删）*/
  onRemove: (assetCode: string) => void;
  /** 显式加入自选（新建 watch 关联）*/
  onAddWatch: (assetCode: string) => void;
  /** 正在操作中的标的代码（null = 当前没有进行中的操作）*/
  pending: string | null;
  /** 已在自选列表里的标的代码（「加入自选」按钮据此置灰）*/
  watchCodes: readonly string[];
  /** 加载中 */
  loading: boolean;
  /** 错误文案（非 null 时展示错误态而不是表格）*/
  error: string | null;
  /** 重新加载 */
  onRetry: () => void;
}

/** 小号操作按钮（表格内的次要操作）*/
const actionButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  padding: '2px 8px',
  fontSize: TYPO.captionSize,
  borderRadius: RADIUS.sm,
};

/** 已迁移标记（迁移只打标记，不建 watch 关联 —— PRD S5）*/
function MigratedBadge({ priceMode }: { priceMode: string | null | undefined }) {
  const modeLabel = priceMode === 'current' ? '现价' : '基准价';
  return (
    <span
      data-testid="candidate-migrated-badge"
      style={{
        display: 'inline-block',
        marginLeft: 6,
        padding: '1px 6px',
        borderRadius: RADIUS.sm,
        background: COLORS.bgPillNeutral,
        color: COLORS.textPillNeutral,
        border: `1px solid ${COLORS.borderPillNeutral}`,
        fontSize: TYPO.captionSize,
        whiteSpace: 'nowrap',
      }}
    >
      已迁移·{modeLabel}
    </span>
  );
}

export default function CandidateTable({
  rows,
  selected,
  onToggle,
  onToggleAll,
  onMigrate,
  onRemove,
  onAddWatch,
  pending,
  watchCodes,
  loading,
  error,
  onRetry,
}: CandidateTableProps) {
  if (error !== null && error !== '') {
    return (
      <div data-testid="candidate-error" style={{ padding: SPACING.gapBase }}>
        <div style={{ color: COLORS.danger, fontSize: TYPO.bodySize }}>{error}</div>
        <button style={{ ...buttonStyle, marginTop: SPACING.gapBase }} onClick={onRetry}>
          重新加载
        </button>
      </div>
    );
  }

  if (loading && rows.length === 0) {
    return (
      <div data-testid="candidate-loading" style={{ padding: SPACING.gapBase }}>
        <Spinner label="加载中..." />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div data-testid="candidate-empty" style={{ padding: SPACING.gapBase }}>
        <EmptyState
          title="候选池为空"
          description="可在「条件选股」页把选股结果一键加入候选池，加入后基准价会固化为当日前复权收盘价"
        />
      </div>
    );
  }

  const allSelected = rows.length > 0 && selected.length === rows.length;

  return (
    <ScrollableTable label="候选池列表表">
      <table style={tableStyle} aria-label="候选池列表">
        <thead>
          <tr>
            <th scope="col" style={thStyle}>
              <input
                type="checkbox"
                aria-label="全选候选"
                checked={allSelected}
                onChange={(e) => onToggleAll(e.target.checked)}
              />
            </th>
            <th scope="col" style={thStyle}>
              标的代码
            </th>
            <th scope="col" style={thStyle}>
              名称
            </th>
            <th scope="col" style={thStyle}>
              基准价
            </th>
            <th scope="col" style={thStyle}>
              现价
            </th>
            <th scope="col" style={thStyle}>
              相对收益
            </th>
            <th scope="col" style={thStyle}>
              跟踪天数
            </th>
            <th scope="col" style={thStyle}>
              最新信号
            </th>
            <th scope="col" style={thStyle}>
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const code = row.asset_code;
            const isSelected = selected.includes(code);
            const busy = pending === code;
            const inWatch = watchCodes.includes(code);
            const ret = typeof row.relative_return === 'number' ? row.relative_return : null;
            const retColor = ret === null ? COLORS.textMuted : ret >= 0 ? COLORS.success : COLORS.danger;

            return (
              <tr key={typeof row.id === 'number' ? row.id : `${code}-${index}`}>
                <td style={thTdStyle}>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${code}`}
                    checked={isSelected}
                    onChange={() => onToggle(code)}
                  />
                </td>
                <td style={thTdStyle}>
                  <code>{code}</code>
                  {Number(row.migrated_from_candidate) === 1 && (
                    <MigratedBadge priceMode={row.migrated_price_mode} />
                  )}
                </td>
                <td style={thTdStyle}>
                  {/* 名称查不到时回退显示代码（`raw_symbol_name` 覆盖率约 70%，缺失是常态）*/}
                  <span
                    style={truncatedTextStyle}
                    title={row.candidate_reason ? `加入理由：${row.candidate_reason}` : undefined}
                  >
                    {row.name ? row.name : '--'}
                  </span>
                </td>
                <td style={thTdStyle}>{fmt(row.candidate_base_price)}</td>
                <td style={thTdStyle}>{fmt(row.current_close)}</td>
                <td style={thTdStyle}>
                  <span data-testid="candidate-relative-return" style={{ color: retColor }}>
                    {fmtPct(ret)}
                  </span>
                </td>
                <td style={thTdStyle}>
                  {typeof row.tracked_days === 'number' ? `${row.tracked_days} 天` : '--'}
                </td>
                <td style={thTdStyle}>
                  {row.signal ? (
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <SignalDirectionPill direction={row.signal.direction} />
                      <SignalLabelTag label={row.signal.label} />
                    </span>
                  ) : (
                    <span style={{ color: COLORS.textMuted }}>--</span>
                  )}
                </td>
                <td style={thTdStyle}>
                  <div style={{ display: 'flex', gap: SPACING.gapTight, flexWrap: 'wrap' }}>
                    <button
                      style={actionButtonStyle}
                      aria-label={`迁移自选：${code}`}
                      disabled={busy}
                      onClick={() => onMigrate(code)}
                    >
                      迁移自选
                    </button>
                    <button
                      style={{ ...actionButtonStyle, ...dangerButtonStyle }}
                      aria-label={`移除候选：${code}`}
                      disabled={busy}
                      onClick={() => onRemove(code)}
                    >
                      移除
                    </button>
                    <button
                      style={actionButtonStyle}
                      aria-label={`加入自选：${code}`}
                      disabled={busy || inWatch}
                      title={inWatch ? '已在自选列表' : '显式加入自选（与「迁移自选」不同）'}
                      onClick={() => onAddWatch(code)}
                    >
                      {inWatch ? '已在自选' : '加入自选'}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollableTable>
  );
}
