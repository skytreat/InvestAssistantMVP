/**
 * 前端错误对象窄化工具（T66 · 清理 `any`）
 *
 * 背景：各页面原先写 `catch (err: any)` + `err?.response?.data?.message ?? '网络错误'`，
 * `any` 既有 lint 问题，也把「后端错误体长什么样」的知识散落在 9 个页面里。
 * 本文件把取值逻辑收敛到一处，且保证**与原表达式逐字等价**。
 *
 * ⚠️ 与 `api/errorMessages.ts` 的分工（两个文件职责不同，不要混用）：
 * - `errorMessages.ts`：**错误码 → 中文文案**的查表（T89a，后端已给 `message` 时用它兜底）
 * - 本文件：**错误对象 → 文案**的取值窄化（不查表）
 *
 * 🔒 **等价性约定**（本文件所有导出函数都遵守）：
 * 1. `??` 只对 `null` / `undefined` 生效 —— `message` 为空串 `''` 时**原样返回空串**，
 *    不退回兜底文案（这是与「`||` 兜底」的关键差异，改写时勿退化）；
 * 2. `message` 缺失（null / undefined）时才退到调用方给的兜底文案；
 * 3. `message` 为**非字符串**时**原样返回**（不转字符串）—— 详见 `asMessage()` 的说明。
 */

/** 后端统一 envelope 的错误体（本工具只取 `message` 字段） */
interface ErrorBodyLike {
  message?: unknown;
}

/** axios 错误对象的最外层结构（只声明本工具会读到的字段） */
interface HttpErrorLike {
  response?: {
    data?: ErrorBodyLike;
  };
  message?: unknown;
}

/**
 * 读取后端错误体里的 `message`。
 *
 * **等价于 `err?.response?.data?.message`**：
 * - `err` 为 `null` / `undefined` → `undefined`
 * - `err.response` 缺失 / 为 `null` → `undefined`
 * - `err.response.data` 缺失 / 为 `null` → `undefined`
 * - 其余 → `data.message` 原样返回（**可能是非字符串**，故返回类型为 `unknown`）
 */
export function readErrorMessage(err: unknown): unknown {
  if (err === null || err === undefined) return undefined;

  const response = (err as HttpErrorLike).response;
  if (response === null || response === undefined) return undefined;

  const data = response.data;
  if (data === null || data === undefined) return undefined;

  return data.message;
}

/**
 * 把后端 `message` 原样返回（**不做 String() 转换**）。
 *
 * 后端 `message` 的契约是字符串（SDD §4.3：中文文案一律放在 `message`）。
 * 但这里**故意不转换**，是为了与原表达式
 * `err?.response?.data?.message ?? fallback` 的运行时行为**完全一致**：
 * - `message` 为 `false` 时：原实现把 `false` 交给 `setError`，
 *   页面上的 `{error && <div>}` 因 `false` 为假值而**不显示错误提示**；
 *   若在此处转成字符串 `"false"`，错误提示反而会显示出来 —— 那是**行为变更**，故不能转；
 * - `message` 为对象时：原实现会让 React 抛 "Objects are not valid as a React child"，
 *   原样返回 → **失败模式也保持一致**。
 *
 * 代价：返回类型标注为 `string`，运行时却可能是非字符串 —— 这与清理前的 `any` 实现
 * **同样的不精确**，不引入新的类型风险：所有调用方都只做「真值判断 + 渲染」
 * （各页面的 `{error && <div style={errorStyle}>{error}</div>}`）。
 */
function asMessage(message: unknown): string {
  return message as string;
}

/**
 * 取后端返回的中文文案。
 *
 * **等价于 `err?.response?.data?.message ?? fallback`**：
 * - `message` 为 `null` / `undefined` → `fallback`
 * - `message` 为 `''`（空串）→ `''`（**不**退回 fallback，与 `??` 语义一致）
 * - `message` 为其它值 → 原样返回（见 `asMessage()`）
 */
export function extractErrorMessage(err: unknown, fallback = '网络错误'): string {
  const message = readErrorMessage(err);
  if (message === null || message === undefined) return fallback;
  return asMessage(message);
}

/**
 * 取后端文案，没有则退到错误对象自身的字符串形式。
 *
 * **等价于 `err?.response?.data?.message ?? String(err)`**
 * （用于「前缀 + 错误描述」的场景，如 `'加入候选失败：' + ...`）。
 */
export function extractErrorMessageOrString(err: unknown): string {
  const message = readErrorMessage(err);
  if (message === null || message === undefined) return String(err);
  return asMessage(message);
}

/**
 * 取后端文案，没有则退到 `Error.message`，再没有才退到 `String(err)`。
 *
 * **等价于 `err?.response?.data?.message ?? err?.message ?? String(err)`**
 * （K 线页的三级兜底：后端文案 → JS 异常信息 → 错误对象的字符串形式）。
 */
export function extractErrorMessageOrErrorMessage(err: unknown): string {
  const message = readErrorMessage(err);
  if (message !== null && message !== undefined) return asMessage(message);

  const errorMessage = err === null || err === undefined ? undefined : (err as HttpErrorLike).message;
  if (errorMessage !== null && errorMessage !== undefined) return asMessage(errorMessage);

  return String(err);
}
