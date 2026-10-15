import React, { useState } from 'react';
import { api } from '../api/client';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  inputStyle,
  buttonStyle,
  tableStyle,
  thStyle,
  thTdStyle,
} from './_shared';

function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

interface SignalRow {
  [key: string]: any;
}

export default function Signals() {
  const [tradeDate, setTradeDate] = useState<string>(todayStr());
  const [pluginId, setPluginId] = useState<string>('');
  const [direction, setDirection] = useState<string>('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<SignalRow[]>([]);

  const handleQuery = async () => {
    setError(null);
    setLoading(true);
    try {
      const params: Record<string, any> = { page_size: 50 };
      if (tradeDate) params.trade_date = tradeDate;
      if (pluginId) params.plugin_id = pluginId;
      if (direction) params.direction = direction;

      const res = await api.get('/signals', { params });
      if (res.data.success) {
        setRows(res.data.data ?? []);
      } else {
        setError(res.data.error ?? '请求失败');
      }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? '网络错误');
    } finally {
      setLoading(false);
    }
  };

  // 从第一行提取列名（如果有数据）
  const columns: string[] =
    rows.length > 0 ? Object.keys(rows[0]) : [];

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>策略信号</h1>

      {/* 筛选栏 */}
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 14, color: '#374151' }}>trade_date</label>
        <input
          style={inputStyle}
          type="date"
          value={tradeDate}
          onChange={(e) => setTradeDate(e.target.value)}
        />

        <label style={{ fontSize: 14, color: '#374151' }}>plugin_id</label>
        <input
          style={inputStyle}
          type="text"
          placeholder="可选"
          value={pluginId}
          onChange={(e) => setPluginId(e.target.value)}
        />

        <label style={{ fontSize: 14, color: '#374151' }}>direction</label>
        <select
          style={inputStyle}
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
        >
          <option value="">全部</option>
          <option value="hold">hold</option>
          <option value="buy">buy</option>
          <option value="sell">sell</option>
        </select>

        <button style={buttonStyle} onClick={handleQuery} disabled={loading}>
          {loading ? '查询中...' : '查询'}
        </button>
      </div>

      {/* 结果表格 */}
      <div style={cardStyle}>
        {error && <div style={{ color: '#dc2626', marginBottom: 12 }}>{error}</div>}
        {rows.length === 0 && !loading && !error && (
          <div style={{ color: '#6b7280' }}>请点击查询按钮加载数据</div>
        )}
        {rows.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col} style={thStyle}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((col) => (
                    <td key={col} style={thTdStyle}>
                      {String(row[col] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
