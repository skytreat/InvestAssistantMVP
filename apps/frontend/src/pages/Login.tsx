import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { useUserStore } from '../store/user';
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

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useNavigate();
  const { token, login } = useUserStore();

  useEffect(() => {
    if (token) {
      navigate('/');
    }
  }, [token, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { username, password });
      if (res.data.success) {
        const newToken: string = res.data.data.token;
        const user = res.data.data.user;
        login(newToken, user.username, user.role);
        navigate('/');
      } else {
        setError(res.data.message ?? '登录失败');
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
            <label style={labelStyle}>用户名</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div style={formRowStyle}>
            <label style={labelStyle}>密码</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
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
