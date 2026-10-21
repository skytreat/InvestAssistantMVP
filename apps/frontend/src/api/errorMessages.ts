/**
 * 错误码 → 中文文案 + 操作建议（T89a / T64）
 *
 * ⚠️ **后端已在 `message` 里给出中文文案**（T89a ③：中文一律移入 `message`），
 *   前端**优先**显示 `res.data.message`；本表是**兜底**（message 缺失时按 code 查）。
 *
 * 用途：
 *   1. `message` 缺失 → 按 code 查本表，仍不给用户看裸码；
 *   2. 需要「操作建议」时（如引导重新登录 / 改参数）可按 code 查 `hint`。
 *
 * 主表 = SDD §4.3；扩展码 = SDD §4.3「扩展错误码」小节。
 *
 * 🔒 **与后端表严格同步（T64）**
 *
 * 后端表 = `apps/backend/src/lib/errorMessages.ts`（25 个码）。本表**必须**与它
 * **逐码对齐**（key 集合相同 + 同一码的 `message` 逐字相同）——
 * 后端是「缺 message 时的默认文案」来源，前端是「message 缺失时的兜底」来源，
 * 两边文案不一致就会出现「同一错误码在两个入口显示不同话术」。
 *
 * ⚠️ **后端表变更时必须同步本表**（`tests/unit/errorMessages.test.ts` 有一致性断言，
 *   断言用的是后端表的**快照常量**——快照过期时该用例会红，需人工更新）。
 *   后端保留的旧别名（`INVALID_TOKEN` / `NO_TOKEN` / `INVALID_SYMBOL`）在前端同样登记，
 *   避免用户看到裸码（G1.4b）。
 */
export interface ErrorMessage {
  /** 中文文案（面向用户） */
  message: string;
  /** 操作建议（可选，告知用户下一步该做什么） */
  hint?: string;
}

export const ERROR_MESSAGES: Record<string, ErrorMessage> = {
  // ── SDD §4.3 主表 ──
  PARAM_INVALID: { message: '请求参数不合法', hint: '请检查输入的字段格式与取值范围' },
  TRADE_REASON_REQUIRED: { message: '请填写本次操作理由', hint: '操作理由用于日后复盘，不能为空' },
  HOLDING_INSUFFICIENT: { message: '持仓不足，无法减仓或清仓', hint: '请先确认该时刻的实际持仓数量' },
  TRADE_DUPLICATE: { message: '该标的在该时刻已有同类型交易', hint: '如需分笔录入，请修改成交时间' },
  DUPLICATE_IMPORT: { message: '除权数据已导入，已跳过' },
  SYMBOL_NOT_FOUND: { message: '标的不存在', hint: '请确认代码格式为 sh600000 / sz000001' },
  USER_EXISTS: { message: '用户名已存在', hint: '请更换一个用户名后重试' },
  UNAUTHORIZED: {
    message: '登录已失效，请重新登录',
    // PRD §5.9「登录态过期提示」：过期后自动跳登录页并**保留当前页面路径**（登录后可返回原页面）
    hint: '会话已过期，正在跳转到登录页；登录后会自动返回原页面',
  },
  FORBIDDEN: { message: '无权限执行该操作', hint: '该功能仅管理员可用' },
  INTERNAL_ERROR: { message: '服务内部错误', hint: '稍后重试；若持续出现请联系管理员' },
  DB_UNAVAILABLE: { message: '数据库不可用', hint: '请检查后端服务与数据文件' },
  EXTERNAL_SOURCE_UNAVAILABLE: { message: '外部行情源暂不可用', hint: '本次校验已跳过，稍后会自动重试' },

  // ── 扩展码（SDD §4.3 扩展小节）──
  PLUGIN_NOT_FOUND: { message: '插件不存在' },
  SEARCH_FAILED: { message: '搜索失败' },
  KLINE_QUERY_FAILED: { message: 'K 线数据查询失败' },
  RESTORE_FAILED: { message: '备份恢复失败', hint: '请确认备份文件存在且未被占用' },
  CONFIRM_REQUIRED: { message: '该操作需要显式确认', hint: '请在请求体中传入 confirm: true' },
  ADMIN_ALREADY_EXISTS: { message: '系统已存在管理员账号' },
  SEED_PASSWORD_REQUIRED: { message: '请提供初始密码' },
  REGISTRATION_CLOSED: { message: '注册已关闭', hint: '请联系管理员开通账号' },
  DUPLICATE: { message: '该标的已存在于该列表' },
  NOT_FOUND: { message: '资源不存在' },

  // ── T64：后端保留的旧别名（后端表同款文案，前端一并登记避免裸码上屏）──
  INVALID_TOKEN: {
    message: '登录已失效，请重新登录',
    hint: '会话已过期，正在跳转到登录页；登录后会自动返回原页面',
  },
  NO_TOKEN: { message: '缺少 Authorization: Bearer <jwt>', hint: '请重新登录后再试' },
  INVALID_SYMBOL: { message: '标的不存在' },
};

/**
 * 从错误响应体里取出**面向用户**的文案。
 *
 * 优先用后端给的 `message`；没有则按 `code` 查表；再没有就返回兜底文案。
 * **任何情况下都不把裸错误码直接展示给用户**（G1.4b）。
 */
export function resolveErrorMessage(
  body: { message?: unknown; code?: unknown; error?: unknown } | undefined | null,
  fallback = '未知错误',
): string {
  const raw = body?.message;
  if (typeof raw === 'string' && raw.trim() !== '') return raw;

  const code = typeof body?.code === 'string' ? body.code : typeof body?.error === 'string' ? body.error : '';
  if (code) return ERROR_MESSAGES[code]?.message ?? fallback;

  return fallback;
}

/** 取错误码对应的「操作建议」（无则返回 undefined） */
export function resolveErrorHint(
  body: { code?: unknown; error?: unknown } | undefined | null,
): string | undefined {
  const code = typeof body?.code === 'string' ? body.code : typeof body?.error === 'string' ? body.error : '';
  return code ? ERROR_MESSAGES[code]?.hint : undefined;
}
