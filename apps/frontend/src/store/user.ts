import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UserState {
  /** access token（JWT）—— 放在 `Authorization: Bearer <token>` 头上 */
  token: string | null;
  /**
   * refresh token（T64）
   *
   * 后端 `POST /api/auth/login` 与 `POST /api/auth/refresh` 返回的会话里带
   * `refresh_token`（**下划线**，不是 camelCase），用于 access token 过期后换新的。
   *
   * ⚠️ 与 `token` 一样落 localStorage（zustand `persist`）—— 桌面单用户场景可接受，
   *    但**不要**把它打进日志或渲染到页面上（AGENTS.md「安全编码强制约束」）。
   */
  refreshToken: string | null;
  username: string | null;
  role: 'user' | 'admin' | null;
  /**
   * 登录成功：写入会话
   *
   * @param refreshToken 不传（`undefined`）时按 `null` 处理 —— 即**清掉**旧 refresh token
   */
  login: (token: string, username: string, role: 'user' | 'admin', refreshToken?: string | null) => void;
  /**
   * 仅更新 token 对（T64 · 刷新成功时用）
   *
   * 不动 `username` / `role` —— 刷新接口返回的会话里虽然也带 `user`，
   * 但用户资料在会话期内不会变，刷新时保持原值更稳（也避免刷新把角色改掉）。
   */
  setTokens: (token: string, refreshToken: string | null) => void;
  logout: () => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      token: null,
      refreshToken: null,
      username: null,
      role: null,
      login: (token, username, role, refreshToken = null) =>
        set({ token, username, role, refreshToken: refreshToken ?? null }),
      setTokens: (token, refreshToken) => set({ token, refreshToken }),
      logout: () => set({ token: null, refreshToken: null, username: null, role: null }),
    }),
    { name: 'invest-user' },
  ),
);
