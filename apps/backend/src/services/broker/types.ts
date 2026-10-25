/**
 * T121（V3.1）解析器类型契约 —— SDD_v3 §3.1 / §3.5
 */
export type SemanticField =
  | 'tradeDate'
  | 'tradeTime'
  | 'settleDate'
  | 'symbol'
  | 'name'
  | 'direction'
  | 'price'
  | 'quantity'
  | 'amount'
  | 'cashFlow'
  | 'cashBalance'
  | 'balance'
  | 'feeTotal'
  | 'fee'
  | 'stampTax'
  | 'transferFee'
  | 'otherFee'
  | 'tradeId'
  | 'contractNo';

export interface BrokerFileInput {
  buffer: Buffer; // 原始字节
  filename: string; // 仅用于报错提示，**不得用于推断文件类型**
  declaredBroker?: string; // 用户可选声明，仅作提示，不得作为识别依据
}

export interface DetectedColumn {
  index: number;
  header: string; // 去包裹后的列名
  dropped: boolean; // 敏感列（丢弃，不落库）
  semantic: { field: SemanticField; confidence: 'high' | 'low' } | null; // 无匹配 = null
}

export interface ParsedRow {
  rowIndex: number; // 0 基，原始行号
  cells: string[]; // 去包裹后原始值；敏感列位置为空串（不回显）
}

export interface ParseWarning {
  code: string;
  message: string; // 只报行号/列名，不报原始值（§3.6）
  scope: 'file' | 'row' | 'column';
}

export interface ParseError {
  code: string;
  message: string; // 同上
}

export interface ColumnMappingSuggestion {
  byField: Partial<Record<SemanticField, { column: number; header: string; confidence: 'high' | 'low' }>>;
  unmapped: number[]; // 未映射到任何语义字段的列（含费用分项 —— 归 T122 模板）
  sensitiveDropped: number[]; // 被丢弃的敏感列号（只记号，不记值）
}

export interface BrokerFileParseResult {
  ok: boolean;
  fileKind: 'settlement' | 'trade' | 'unknown';
  encoding: 'utf-8' | 'utf-8-bom' | 'gb18030' | 'unknown';
  headerRowIndex: number; // 0 基，-1 = 未找到
  columns: DetectedColumn[];
  rows: ParsedRow[];
  mappingSuggestion: ColumnMappingSuggestion;
  warnings: ParseWarning[];
  errors: ParseError[];
}
