/**
 * 统一 envelope 判定（T89b · SDD §4.2）
 *
 * 🔴 **后端已删除 `success` 字段**（T89b · Wave 8）——
 *    成功判定**唯一口径**是 **`code === 0`**。
 *    本文件把这条规则收敛到一处，避免 20+ 个调用点各写一遍判定、各写错一遍。
 *
 * ## 为什么单独成文件（而不是放进 `api/client.ts`）
 *
 * `api/client.ts` 是 **axios 实例 + 拦截器**的宿主，绝大多数前端测试用
 * `vi.mock('../../src/api/client', () => ({ api: { get: getMock } }))`
 * **整模块替换**。若把判定函数放在那里，被 mock 掉的模块里该函数就是 `undefined`
 * ⇒ 调用点直接 `TypeError` ⇒ 每加一个页面就要改一批 mock 工厂（漏一个就红）。
 *
 * ⇒ 本文件**零依赖、零副作用**（纯函数），既不被 mock 影响，
 *   又能被 `api/client.ts` 再导出（见该文件的 re-export）。
 */

/** 后端统一 envelope 的最小形状（只声明本仓读到的字段） */
export interface ApiEnvelopeBody {
  /** 成功为数字 `0`；失败为错误码字符串（SDD §4.3） */
  code?: number | string;
  /** 业务数据 */
  data?: unknown;
  /** 中文文案（错误体才有） */
  message?: string;
  /** ISO 8601 时间戳 */
  timestamp?: string;
  /** `code` 的同值副本（后端保留的兜底字段） */
  error?: string;
}

/**
 * 响应体是否**成功** —— 唯一口径：**`code === 0`**
 *
 * ⚠️ `code` 缺失 / 非 0 / 类型不对 ⇒ 一律判为**失败**
 *    （后端契约：成功必带 `code: 0`；缺 `code` 说明不是统一 envelope，不可当成功用）。
 *
 * ⚠️ 这是 T89b 之前 `res.data.success === true` 的**逐字等价物**：
 *    旧口径下 `success` 只有 `true` / `false` 两个取值，`success === true` ⇔ `code === 0`。
 */
export function isOkEnvelope(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  return (body as { code?: unknown }).code === 0;
}

/**
 * 响应体是否**显式失败**（`code` 存在且不为 `0`）
 *
 * ⚠️ 与 `isOkEnvelope` 的区别（**必须分清**）：
 *   - `isOkEnvelope`：`code` 不在就判失败（用于「取数据」的场景）；
 *   - `isFailedEnvelope`：`code` 不在**不算失败**（返回 `false`），
 *     只有「后端明确给了非 0 的 `code`」才判失败。
 *
 * 这是 T89b 之前 `body.success === false` 的**逐字等价物**
 * （旧字段缺失时 `success === false` 同样不成立）。
 */
export function isFailedEnvelope(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const code = (body as { code?: unknown }).code;
  return code !== undefined && code !== null && code !== 0;
}
