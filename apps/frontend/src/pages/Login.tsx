import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { SPACING } from '../theme/tokens';
import { useUserStore } from '../store/user';
import { safeInternalPath } from '../utils/path';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  inputStyle,
  buttonStyle,
  errorStyle,
  formRowStyle,
  labelStyle,
} from './_shared';

/** 后端 `POST /api/auth/login` 返回的会话体（`ok(session)` 的 `data` 字段） */
interface SessionPayload {
  token?: string;
  /** ⚠️ 下划线（不是 camelCase）—— 后端契约 */
  refresh_token?: string;
  refresh_token_expires_at?: number;
  user?: { id?: number; username?: string; role?: 'user' | 'admin' };
}

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useNavigate();
  const location = useLocation();
  const { token, login } = useUserStore();

  /**
   * 登录成功后要去的页面（T64 · PRD §5.9「保留当前页面路径」）
   *
   * `location.state.from` 由「会话过期跳转」写入（`App.tsx` 的 `<Navigate state={{ from }}>`）。
   * ⚠️ `state` 可被同源脚本改写 → 必须经 `safeInternalPath` 过滤（开放重定向防护），
   *    非法值一律回落 `/`。
   */
  const target = safeInternalPath((location.state as { from?: unknown } | null)?.from) ?? '/';

  useEffect(() => {
    // 已登录又跑到 /login → 直接回目标页（与登录成功后的落点一致，避免两条跳转打架）
    if (token) {
      navigate(target, { replace: true });
    }
  }, [token, navigate, target]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { username, password });
      // 兼容两种 envelope 判定：当前后端的 `success` 与 T89b 之后的 `code === 0`
      const succeeded = res.data?.success === true || res.data?.code === 0;
      const session = (res.data?.data ?? null) as SessionPayload | null;
      if (succeeded && session?.token) {
        login(
          session.token,
          session.user?.username ?? username,
          session.user?.role ?? 'user',
          session.refresh_token ?? null,
        );
        navigate(target, { replace: true });
      } else {
        setError(res.data?.message ?? '登录失败');
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>登录</h1>
      <div style={{ ...cardStyle, maxWidth: 400 }}>
        <form onSubmit={handleSubmit}>
          <div style={formRowStyle}>
            <label htmlFor="login-input-username" style={labelStyle}>
              用户名
            </label>
            <input
              id="login-input-username"
              style={{ ...inputStyle, flex: 1 }}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div style={formRowStyle}>
            <label htmlFor="login-input-password" style={labelStyle}>
              密码
            </label>
            <input
              id="login-input-password"
              style={{ ...inputStyle, flex: 1 }}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: SPACING.gapRelaxed }}>
            <button type="submit" style={buttonStyle} disabled={loading}>
              {loading ? '登录中...' : '登录'}
            </button>
          </div>
          {error && <div style={errorStyle}>{error}</div>}
        </form>
      </div>
    </div>
  );
}
