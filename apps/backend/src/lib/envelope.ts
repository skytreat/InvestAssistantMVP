/**
 * 统一响应 envelope（T89a · SDD §4.2）
 *
 * 成功体：`{ code: 0, data, timestamp, success: true }`
 * 错误体：`{ code: <错误码字符串>, message, data: null, timestamp, success: false, error: <同 code> }`
 *
 * ⚠️ `success` 字段是**过渡期**产物：T89a 阶段保留它（前端 20 处 `if (res.data.success)` 依赖），
 *   T89b（Wave 8）会删掉它，前端届时改判 `code === 0`。
 *   `error` 字段同样保留 —— T89a ③ 统一其语义为**错误码**（此前混放中文），
 *   中文一律移入 `message`。
 *
 * `timestamp` 用 ISO 8601（带时区偏移），与 SDD §4.2 示例一致。
 */

/** 成功响应体 */
export interface OkEnvelope<T = unknown> {
  code: 0;
  data: T;
  timestamp: string;
  /** 过渡期字段，T89b 删除 */
  success: true;
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
  /** 过渡期字段，与 code 同值；T89b 删除 */
  success: false;
  /** 过渡期字段，与 code 同值；T89b 删除 */
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
  return { code: 0, data, timestamp: now(), success: true, ...(extra ?? {}) };
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
    success: false,
    error: code,
  };
}
