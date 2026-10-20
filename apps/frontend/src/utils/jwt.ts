/**
 * JWT 载荷解码（T64 · PRD §5.9「Token 临近过期时前端轻量提示」）
 *
 * ⚠️ **只解码、不校验** —— 本文件**不验证签名**，也不做任何鉴权判断。
 * 解出来的 `exp` **只用于显示提示**（"登录凭证即将过期"），
 * 真正的鉴权由后端做（前端拿到的 token 能不能用，后端说了算）。
 *
 * ⚠️ **不要用这里的解析结果做安全决策** —— 用户可以随便伪造一个 payload。
 */

/** 剩余有效期低于该阈值（秒）时提示「即将过期」—— PRD §5.9「如剩余 1 天」 */
export const TOKEN_EXPIRY_WARN_SECONDS = 24 * 60 * 60;

/**
 * 解出 JWT 的 `exp`（**秒级** unix 时间戳）
 *
 * JWT 结构 = `header.payload.signature`，payload 是 **base64url** 编码的 JSON。
 * 解不出来（不是 JWT / base64 非法 / JSON 非法 / 没有 `exp`）→ 返回 `null`（调用方静默处理）。
 */
export function decodeJwtExp(token: string | null | undefined): number | null {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length < 2) return null;

  const payload = parts[1];
  if (!payload) return null;

  try {
    // base64url → base64：`-` → `+`、`_` → `/`，再补 `=` padding
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    // base64 解出来的是字节串，用 TextDecoder 按 UTF-8 还原（payload 里可能有中文）
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const exp = (parsed as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    return exp;
  } catch {
    // 解码失败 → 静默（不提示，也不抛错）
    return null;
  }
}

/**
 * token 是否「临近过期」
 *
 * 判定：剩余时间 **> 0 且 < 1 天**。
 * - 已过期（剩余 ≤ 0）→ 返回 `false`：过期由 401 → 刷新 / 会话过期流程处理，
 *   这里再提示「即将过期」是错的口径；
 * - 解不出 `exp` → 返回 `false`（静默）。
 *
 * @param nowMs 当前时间（毫秒）；默认 `Date.now()`
 */
export function isTokenExpiringSoon(token: string | null | undefined, nowMs: number = Date.now()): boolean {
  const exp = decodeJwtExp(token);
  if (exp === null) return false;

  const remainingSec = exp - Math.floor(nowMs / 1000);
  return remainingSec > 0 && remainingSec < TOKEN_EXPIRY_WARN_SECONDS;
}
