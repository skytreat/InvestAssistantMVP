/**
 * `decisions.csv` 序列化（DAS-2 §6.1 / §6.2）。
 *
 * - UTF-8 无 BOM、LF 换行、逗号分隔、首行表头、列顺序固定
 * - 数值 `.17g`（float64 全精度），禁止四舍五入
 * - 布尔 `0` / `1`；空值为**空字段**（不是 `nan` / `None` / `NULL`）
 * - 行序由调用方保证（本模块不乱序）
 *
 * 第 26–33 列属于 L2。L1 阶段按契约占位：
 * `target_weight=0`（不允许空）、`action=NONE`（无组合状态），其余为空。
 */
import { formatG17 } from './format.js';
import type { L1DecisionRow } from './types.js';

export const DECISION_HEADER = [
  'trade_date',
  'symbol',
  'jq_code',
  'in_pool',
  'has_bar',
  'tradable_today',
  'hfq_factor',
  'close_raw',
  'prev_close_raw',
  'open_raw',
  'ma5',
  'ma10',
  'ma20',
  'ma60',
  'wsm_v2',
  'nday_return',
  'rsrs_z',
  'momentum_primary',
  'momentum_secondary',
  'benchmark_primary',
  'filter_pass',
  'reject_reason',
  'rank',
  'selected',
  'cooldown_until',
  'target_weight',
  'action',
  'action_reason',
  'blocked_reason',
  'days_since_entry',
  'position_qty',
  'unit_cost',
  'high_watermark',
] as const;

function boolCell(value: boolean): string {
  return value ? '1' : '0';
}

function numberCell(value: number | null): string {
  return value === null ? '' : formatG17(value);
}

function intCell(value: number | null): string {
  return value === null ? '' : String(value);
}

function rowToCells(row: L1DecisionRow): string[] {
  return [
    row.trade_date,
    row.symbol,
    row.jq_code,
    boolCell(row.in_pool),
    boolCell(row.has_bar),
    boolCell(row.tradable_today),
    numberCell(row.hfq_factor),
    numberCell(row.close_raw),
    numberCell(row.prev_close_raw),
    numberCell(row.open_raw),
    numberCell(row.ma5),
    numberCell(row.ma10),
    numberCell(row.ma20),
    numberCell(row.ma60),
    numberCell(row.wsm_v2),
    numberCell(row.nday_return),
    numberCell(row.rsrs_z),
    numberCell(row.momentum_primary),
    numberCell(row.momentum_secondary),
    numberCell(row.benchmark_primary),
    boolCell(row.filter_pass),
    row.reject_reason ?? '',
    intCell(row.rank),
    boolCell(row.selected),
    row.cooldown_until ?? '',
    // --- L2 占位（本层不产出组合状态）---
    '0',
    'NONE',
    '',
    '',
    '',
    '',
    '',
    '',
  ];
}

/** 生成完整 CSV 文本（末尾带一个 LF）。 */
export function serializeDecisionsCsv(rows: readonly L1DecisionRow[]): string {
  const lines = [DECISION_HEADER.join(',')];
  for (const row of rows) lines.push(rowToCells(row).join(','));
  return `${lines.join('\n')}\n`;
}
