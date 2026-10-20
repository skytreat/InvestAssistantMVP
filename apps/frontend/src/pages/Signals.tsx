import React, { useState } from 'react';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { COLORS, TYPO } from '../theme/tokens';
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

const DIRECTION_LABEL: Record<string, string> = {
  buy: '买入',
  sell: '卖出',
  hold: '持仓',
};

/** 一行信号（列由后端动态给出，故用索引签名） */
interface SignalRow {
  [key: string]: unknown;
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
      const params: Record<string, unknown> = { page_size: 50 };
      if (tradeDate) params.trade_date = tradeDate;
      if (pluginId) params.plugin_id = pluginId;
      if (direction) params.direction = direction;

      const res = await api.get('/signal', { params });
      if (res.data.success) {
        setRows(res.data.data ?? []);
      } else {
        setError(res.data.message ?? '请求失败');
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const columns: string[] = rows.length > 0 ? Object.keys(rows[0]) : [];

  const COLUMN_LABELS: Record<string, string> = {
    id: 'ID',
    symbol: '股票代码',
    plugin_id: '策略',
    plugin_category: '类别',
    direction: '方向',
    label: '标签',
    strength: '强度',
    trade_date: '日期',
    created_at: '创建时间',
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>策略信号</h1>

      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: TYPO.bodySize, color: COLORS.textSecondary }}>交易日期</label>
        <input
          style={inputStyle}
          type="date"
          value={tradeDate}
          onChange={(e) => setTradeDate(e.target.value)}
        />

        <label style={{ fontSize: TYPO.bodySize, color: COLORS.textSecondary }}>策略名称</label>
        <input
          style={inputStyle}
          type="text"
          placeholder="可选"
          value={pluginId}
          onChange={(e) => setPluginId(e.target.value)}
        />

        <label style={{ fontSize: TYPO.bodySize, color: COLORS.textSecondary }}>方向</label>
        <select style={inputStyle} value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="">全部</option>
          <option value="hold">持仓</option>
          <option value="buy">买入</option>
          <option value="sell">卖出</option>
        </select>

        <button style={buttonStyle} onClick={handleQuery} disabled={loading}>
          {loading ? '查询中...' : '查询'}
        </button>
      </div>

      <div style={cardStyle}>
        {error && <div style={{ color: COLORS.danger, marginBottom: 12 }}>{error}</div>}
        {rows.length === 0 && !loading && !error && (
          <div style={{ color: COLORS.neutral }}>请点击查询按钮加载数据</div>
        )}
        {rows.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col} style={thStyle}>
                    {COLUMN_LABELS[col] ?? col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((col) => {
                    const val = row[col];
                    let display = String(val ?? '');
                    // 方向列做中文映射；只有字符串值参与查表
                    // （非字符串在原实现里同样查不到 → 保留原值，此处收窄不改变行为）
                    if (col === 'direction' && typeof val === 'string') {
                      display = DIRECTION_LABEL[val] ?? display;
                    }
                    return (
                      <td key={col} style={thTdStyle}>
                        {display}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
