import React from 'react';
import { ERROR_MESSAGES } from '../api/errorMessages';
import { COLORS, TYPO } from '../theme/tokens';

/**
 * 会话过期提示条（T64 · PRD §5.9「登录态过期提示」）
 *
 * ⚠️ **不是 `alert()`** —— PRD 要求「自动跳转登录页 + 提示条」，弹窗会打断操作。
 *
 * 落位：由 `App.tsx` 在 **`<Routes>` 之外**渲染 → 跳到登录页后**提示条仍在**，
 * 用户在登录页也能看到「为什么被踢回来」。
 *
 * 文案：**直接取错误码表里 `UNAUTHORIZED` 的文案 + hint**，
 * 保证「同一错误码在页面提示条与接口错误里说的是同一句话」。
 */
export default function SessionExpiredBanner({ from }: { from: string | null }) {
  if (!from) return null;

  const info = ERROR_MESSAGES.UNAUTHORIZED;

  return (
    <div
      role="alert"
      style={{
        background: COLORS.bgDisclaimer,
        color: COLORS.textDisclaimer,
        fontSize: TYPO.bodySize,
        textAlign: 'center',
        padding: '8px 12px',
        borderRadius: 4,
        marginBottom: 8,
      }}
    >
      {info.message}
      {info.hint ? ` —— ${info.hint}` : null}
    </div>
  );
}
