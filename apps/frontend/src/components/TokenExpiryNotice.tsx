import React from 'react';
import { useUserStore } from '../store/user';
import { isTokenExpiringSoon } from '../utils/jwt';
import { COLORS, TYPO } from '../theme/tokens';

/**
 * 登录凭证「即将过期」轻量提示（T64 · PRD §5.9）
 *
 * > Token 临近过期（如剩余 1 天）时前端轻量提示
 *
 * 口径：
 * - 判定 = JWT `exp` 距今 **不足 1 天**（`utils/jwt.ts` 的 `isTokenExpiringSoon`）；
 * - 解不出 `exp` / 不是 JWT → **不提示**（静默，不打扰用户）；
 * - 已过期（剩余 ≤ 0）→ 不提示（过期由 401 → 刷新 / 会话过期流程接管）。
 *
 * ⚠️ 本提示**只在渲染时算一次**（不跑定时器）——
 *   用户不切页面时提示不刷新是可接受的：真正决定会话生死的是后端 401，
 *   本条只是「轻量提示」（PRD 措辞），不值得为它常驻一个定时器。
 */
export default function TokenExpiryNotice() {
  const token = useUserStore((s) => s.token);

  if (!isTokenExpiringSoon(token)) return null;

  return (
    <div
      role="status"
      style={{
        background: COLORS.bgDisclaimer,
        color: COLORS.textDisclaimer,
        fontSize: TYPO.captionSize,
        textAlign: 'center',
        padding: '4px 12px',
        borderRadius: 4,
        margin: '4px 0',
      }}
    >
      登录凭证即将过期，请尽快重新登录
    </div>
  );
}
