/**
 * 错误码 → 中文文案（T89a · 配套前端 `src/api/errorMessages.ts`）
 *
 * ⚠️ **错误码本身不是文案** —— 前端展示的一律是 `message`（G1.4b）。
 * 本表用于后端在**缺 message** 的调用点补默认文案，避免把裸码抛给用户。
 *
 * 主表 = SDD §4.3；扩展码 = SDD §4.3「扩展错误码」小节（与该表同步登记）。
 */
export const ERROR_MESSAGES: Record<string, string> = {
  // ── SDD §4.3 主表 ──
  PARAM_INVALID: '请求参数不合法',
  TRADE_REASON_REQUIRED: '请填写本次操作理由',
  HOLDING_INSUFFICIENT: '持仓不足，无法减仓或清仓',
  TRADE_DUPLICATE: '该标的在该时刻已有同类型交易',
  DUPLICATE_IMPORT: '除权数据已导入，已跳过',
  SYMBOL_NOT_FOUND: '标的不存在',
  UNAUTHORIZED: '登录已失效，请重新登录',
  FORBIDDEN: '无权限执行该操作',
  INTERNAL_ERROR: '服务内部错误',
  DB_UNAVAILABLE: '数据库不可用',
  EXTERNAL_SOURCE_UNAVAILABLE: '外部行情源暂不可用',

  // ── 扩展码（SDD §4.3 扩展小节）──
  PLUGIN_NOT_FOUND: '插件不存在',
  SEARCH_FAILED: '搜索失败',
  KLINE_QUERY_FAILED: 'K 线数据查询失败',
  RESTORE_FAILED: '备份恢复失败',
  CONFIRM_REQUIRED: '该操作需要显式确认',
  ADMIN_ALREADY_EXISTS: '系统已存在管理员账号',
  SEED_PASSWORD_REQUIRED: '请提供初始密码',
  REGISTRATION_CLOSED: '注册已关闭',
  DUPLICATE: '该标的已存在于该列表',
  NOT_FOUND: '资源不存在',
  INVALID_TOKEN: '登录已失效，请重新登录',
  NO_TOKEN: '缺少 Authorization: Bearer <jwt>',
  INVALID_SYMBOL: '标的不存在',
};

/** 取错误码的默认中文文案；未登记的码回落到「服务内部错误」 */
export function defaultMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? '服务内部错误';
}
