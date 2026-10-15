import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useUserStore } from '../store/user';

const linkStyle: React.CSSProperties = {
  padding: '8px 12px',
  marginRight: 8,
  color: '#1e40af',
  textDecoration: 'none',
};

export function Navbar() {
  const { username, role, logout } = useUserStore();
  const navigate = useNavigate();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderBottom: '1px solid #e5e7eb',
        background: '#fff',
      }}
    >
      <span style={{ fontWeight: 'bold', fontSize: 20 }}>📈 InvestAssistant</span>
      <nav style={{ marginLeft: 24 }}>
        <Link to="/" style={linkStyle}>
          Dashboard
        </Link>
        <Link to="/trade" style={linkStyle}>
          交易录入
        </Link>
        <Link to="/signals" style={linkStyle}>
          策略信号
        </Link>
        <Link to="/stockscan" style={linkStyle}>
          条件选股
        </Link>
        {role === 'admin' && (
          <Link to="/admin" style={linkStyle}>
            管理员
          </Link>
        )}
      </nav>
      <span style={{ marginLeft: 'auto', color: '#666' }}>
        {username} ({role})
      </span>
      <button onClick={() => { logout(); navigate('/login'); }}>登出</button>
    </div>
  );
}

export const pageContainerStyle: React.CSSProperties = {
  padding: '24px',
  maxWidth: 1200,
  margin: '0 auto',
};

export const cardStyle: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: 16,
  marginBottom: 24,
  background: '#fff',
};

export const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 'bold',
  marginBottom: 16,
};

export const cardTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
  borderBottom: '1px solid #f3f4f6',
  paddingBottom: 8,
};

export const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 14,
};

export const thTdStyle: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  padding: '8px 12px',
  textAlign: 'left',
};

export const thStyle: React.CSSProperties = {
  ...thTdStyle,
  background: '#f9fafb',
  fontWeight: 600,
};

export const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  fontSize: 14,
};

export const buttonStyle: React.CSSProperties = {
  padding: '6px 16px',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
};

export const errorStyle: React.CSSProperties = {
  color: '#dc2626',
  fontSize: 14,
  marginTop: 8,
};

export const successStyle: React.CSSProperties = {
  color: '#16a34a',
  fontSize: 14,
  marginTop: 8,
};

export const formRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginBottom: 12,
};

export const labelStyle: React.CSSProperties = {
  minWidth: 90,
  color: '#374151',
  fontSize: 14,
};
