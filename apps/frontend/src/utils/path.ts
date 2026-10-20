/**
 * 站内路径校验（T64 · 登录后回原路径的**开放重定向防护**）
 *
 * 背景：登录成功后要跳回「过期前所在的页面」，这个目标路径来自
 * `location.state.from` —— 而 `location.state` 在同源 SPA 内可被页面脚本改写，
 * 若不校验就 `navigate(from)`，理论上能被诱导跳到外站（开放重定向）。
 *
 * 口径：**只接受以单个 `/` 开头的站内绝对路径**。
 * - `'/trade'` → 接受
 * - `'/trade?tab=1'` → 接受
 * - `'https://evil.com'` → 拒绝（不是站内绝对路径）
 * - `'//evil.com'` → 拒绝（协议相对 URL，浏览器会当成外站）
 * - `'/\\evil.com'` → 拒绝（反斜杠变体，浏览器同样会解析成外站）
 * - 含控制字符（换行 / 回车 / 制表）→ 拒绝（可被用来绕过前缀判断）
 */

/**
 * 把「来源路径」收敛成一个**安全的站内路径**
 *
 * @returns 合法站内路径；不合法时返回 `null`（调用方回落 `/`）
 */
export function safeInternalPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const path = value.trim();
  if (path === '') return null;
  // 必须是站内绝对路径
  if (!path.startsWith('/')) return null;
  // 协议相对 URL（//host）与反斜杠变体（/\host）都可能被浏览器解析成外站
  if (path.startsWith('//') || path.startsWith('/\\')) return null;
  // 含控制字符一律拒绝（换行/回车/制表可被用来绕过前缀判断）
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;

  return path;
}
