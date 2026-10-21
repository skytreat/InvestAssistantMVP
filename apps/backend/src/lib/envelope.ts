/**
 * 统一响应 envelope（T89a · SDD §4.2；T89b 删 `success`）
 *
 * 成功体：`{ code: 0, data, timestamp }`
 * 错误体：`{ code: <错误码字符串>, message, data: null, timestamp, error: <同 code> }`
 *
 * 🔴 **`success` 字段已删除（T89b · Wave 8）**
 *   T89a 阶段它是过渡产物（前端 20 处 `if (res.data.success)` 依赖它），
 *   现在前端统一按 **`code === 0`** 判定成功 —— 与 SDD §4.2 的 `{code, data, timestamp}` 逐字对齐。
 *   ⇒ 后端**任何**响应体都不得再出现 `success` 键（契约测试逐路由强制断言）。
 *
 * ⚠️ `error` 字段**保留**：它是 `code` 的同值副本，供前端「`code` 缺失时按 `error` 兜底」的
 *   回落链使用（`apps/frontend/src/api/errorMessages.ts` / `api/errors.ts` 的 `readErrorCode`）。
 *
 * `timestamp` 用 ISO 8601（带时区偏移），与 SDD §4.2 示例一致。
 */

/** 成功响应体 */
export interface OkEnvelope<T = unknown> {
  code: 0;
  data: T;
  timestamp: string;
  /** 额外的顶层字段（pagination / timeMs 等） */
  [key: string]: unknown;
}

/** 错误响应体 */
export interface FailEnvelope {
  /** 错误码（SDD §4.3） */
  code: string;
  /** 中文文案（面向用户） */
  message: string;
  data: null;
  timestamp: string;
  /** `code` 的同值副本（前端 `code` 缺失时的回落来源） */
  error: string;
}

/** 生成 ISO 8601 时间戳 */
function now(): string {
  return new Date().toISOString();
}

/**
 * 成功响应体
 *
 * @param data 业务数据（放在 `data` 字段）
 */
export function ok<T>(data: T, extra?: Record<string, unknown>): OkEnvelope<T> & Record<string, unknown> {
  return { code: 0, data, timestamp: now(), ...(extra ?? {}) };
}

/**
 * 错误响应体
 *
 * @param status HTTP 状态码（同时由调用方 `reply.code(status)` 设置）
 * @param code   错误码（SDD §4.3）
 * @param message 中文文案（**面向用户**，不要放错误码）
 */
export function fail(status: number, code: string, message: string): FailEnvelope {
  void status; // 状态码由调用方 reply.code() 设置；此处保留参数以便调用点显式声明语义
  return {
    code,
    message,
    data: null,
    timestamp: now(),
    error: code,
  };
}
