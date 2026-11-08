/**
 * 纸面账户业务错误（S1 起统一口径）
 *
 * 约定：`status` 与方案 §10.3 对齐；路由层只做 `code → HTTP` 映射，不改写 `code`。
 * 禁止在这些错误里带累计净值/持仓之外的内部细节。
 */
export type PaperErrorCode =
  | 'USER_NOT_FOUND'
  | 'PARAM_INVALID'
  | 'STRATEGY_NOT_FOUND'
  | 'STRATEGY_VERSION_NOT_FOUND'
  | 'PAPER_ACCOUNT_NOT_FOUND'
  | 'PAPER_ACCOUNT_EXISTS'
  | 'PAPER_ACCOUNT_NOT_ACTIVE'
  | 'PAPER_CONFIRM_REQUIRED'
  | 'PAPER_PHASE_NOT_ALLOWED'
  | 'PAPER_PHASE_TRANSITION_INVALID'
  | 'PAPER_PENDING_EXISTS'
  | 'PAPER_ALREADY_SETTLED'
  | 'FEE_VALUE_INVALID'
  | 'FEE_RULE_UNSUPPORTED'
  | 'FEE_CONFIG_NOT_FOUND'
  | 'FEE_CONFIG_FORBIDDEN'
  | 'CALENDAR_UNAVAILABLE';

export class PaperError extends Error {
  readonly code: PaperErrorCode;
  readonly status: number;
  constructor(code: PaperErrorCode, status: number, message: string) {
    super(message);
    this.name = 'PaperError';
    this.code = code;
    this.status = status;
  }
}
