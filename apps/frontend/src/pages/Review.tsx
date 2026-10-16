import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  cardTitleStyle,
  tableStyle,
  thStyle,
  thTdStyle,
  inputStyle,
  buttonStyle,
  errorStyle,
} from './_shared';

interface TradeRow {
  id: number;
  asset_code: string;
  trade_type: string;
  trade_date: string;
  quantity: number;
  price: number;
  fee: number;
  trade_reason: string | null;
  is_auto_import: number;
  system_followed: number | null;
  is_stop_loss: number | null;
  review_summary: string | null;
  remark: string | null;
  created_at: string;
}

interface ReviewStats {
  totalTrades: number;
  reviewedCount: number;
  winRate: number | null;
  avgWinRate: number | null;
}

const TRADE_TYPE_LABEL: Record<string, string> = {
  buy: '买入', sell: '卖出', reduce: '减仓', clear: '清仓',
  dividend: '分红', bonus: '送股', transfer: '转增',
};

export default function Review() {
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // 筛选
  const [tradeType, setTradeType] = useState('');
  const [systemFollowed, setSystemFollowed] = useState('');
  const [isStopLoss, setIsStopLoss] = useState('');

  // 编辑中的交易
  const [editingTrade, setEditingTrade] = useState<TradeRow | null>(null);
  const [editForm, setEditForm] = useState({ review_summary: '', strategy_match: '' as '' | '0' | '1', is_stop_loss: '' as '' | '0' | '1', remark: '' });

  const fetchStats = async () => {
    try {
      const res = await api.get('/review/stats');
      if (res.data.success) setStats(res.data.data);
    } catch { /* ignore */ }
  };

  const fetchTrades = async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, any> = { page: p, limit: 20 };
      if (tradeType) params.trade_type = tradeType;
      if (systemFollowed !== '') params.system_followed = systemFollowed;
      if (isStopLoss !== '') params.is_stop_loss = isStopLoss;
      const res = await api.get('/review/trades', { params });
      if (res.data.success) {
        setTrades(res.data.data ?? []);
        setTotalPages(res.data.pagination?.totalPages ?? 1);
        setTotal(res.data.pagination?.total ?? 0);
      }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchStats(); fetchTrades(1); }, []);

  const handleFilter = () => { fetchTrades(1); };

  const openEdit = (trade: TradeRow) => {
    setEditingTrade(trade);
    setEditForm({
      review_summary: trade.review_summary ?? '',
      strategy_match: trade.system_followed === 1 ? '1' : trade.system_followed === 0 ? '0' : '',
      is_stop_loss: trade.is_stop_loss === 1 ? '1' : trade.is_stop_loss === 0 ? '0' : '',
      remark: trade.remark ?? '',
    });
  };

  const saveEdit = async () => {
    if (!editingTrade) return;
    try {
      const payload: Record<string, any> = {};
      if (editForm.review_summary !== editingTrade.review_summary) payload.review_summary = editForm.review_summary || null;
      if (editForm.strategy_match !== '' && editForm.strategy_match !== String(editingTrade.system_followed ?? '')) {
        payload.system_followed = editForm.strategy_match === '1' ? 1 : 0;
      }
      if (editForm.is_stop_loss !== '' && editForm.is_stop_loss !== String(editingTrade.is_stop_loss ?? '')) {
        payload.is_stop_loss = editForm.is_stop_loss === '1' ? 1 : 0;
      }
      if (editForm.remark !== editingTrade.remark) payload.remark = editForm.remark || null;
      if (Object.keys(payload).length === 0) { setEditingTrade(null); return; }
      await api.patch(`/trades/${editingTrade.id}`, payload);
      setEditingTrade(null);
      fetchTrades(page);
      fetchStats();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? '保存失败');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确认软删除此交易？')) return;
    try {
      await api.delete(`/trades/${id}`);
      fetchTrades(page);
      fetchStats();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? '删除失败');
    }
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>交易复盘</h1>

      {/* 统计卡片 */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        {[
          { label: '总交易数', value: stats?.totalTrades ?? 0, color: '#1e40af' },
          { label: '已复盘', value: stats?.reviewedCount ?? 0, color: '#16a34a' },
          { label: '胜率', value: stats?.winRate != null ? `${stats.winRate}%` : '--', color: '#7c3aed' },
          { label: '平均胜率', value: stats?.avgWinRate != null ? `${stats.avgWinRate}x` : '--', color: '#dc2626' },
        ].map((card) => (
          <div key={card.label} style={{ ...cardStyle, flex: '1 1 140px', textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 'bold', color: card.color }}>{card.value}</div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>{card.label}</div>
          </div>
        ))}
      </div>

      {/* 筛选栏 */}
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 14 }}>交易类型：</label>
        <select style={inputStyle} value={tradeType} onChange={(e) => setTradeType(e.target.value)}>
          <option value="">全部</option>
          {['buy','sell','reduce','clear','dividend','bonus','transfer'].map((t) => (
            <option key={t} value={t}>{TRADE_TYPE_LABEL[t]}</option>
          ))}
        </select>
        <label style={{ fontSize: 14 }}>系统信号：</label>
        <select style={inputStyle} value={systemFollowed} onChange={(e) => setSystemFollowed(e.target.value)}>
          <option value="">全部</option>
          <option value="1">是</option>
          <option value="0">否</option>
        </select>
        <label style={{ fontSize: 14 }}>止损：</label>
        <select style={inputStyle} value={isStopLoss} onChange={(e) => setIsStopLoss(e.target.value)}>
          <option value="">全部</option>
          <option value="1">是</option>
          <option value="0">否</option>
        </select>
        <button style={buttonStyle} onClick={handleFilter}>筛选</button>
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      {/* 交易列表 */}
      <div style={cardStyle}>
        {loading ? (
          <div>加载中...</div>
        ) : trades.length === 0 ? (
          <div style={{ color: '#6b7280', padding: 20, textAlign: 'center' }}>暂无交易记录</div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>日期</th>
                <th style={thStyle}>标的</th>
                <th style={thStyle}>类型</th>
                <th style={thStyle}>数量</th>
                <th style={thStyle}>价格</th>
                <th style={thStyle}>操作理由</th>
                <th style={thStyle}>复盘</th>
                <th style={thStyle}>止损</th>
                <th style={thStyle}>来源</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td style={thTdStyle}>{t.trade_date}</td>
                  <td style={thTdStyle}><code>{t.asset_code}</code></td>
                  <td style={thTdStyle}>
                    <span style={{ color: t.trade_type === 'buy' ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                      {TRADE_TYPE_LABEL[t.trade_type] ?? t.trade_type}
                    </span>
                  </td>
                  <td style={thTdStyle}>{t.quantity}</td>
                  <td style={thTdStyle}>{t.price.toFixed(2)}</td>
                  <td style={thTdStyle}>{t.trade_reason ?? '-'}</td>
                  <td style={thTdStyle}>
                    {t.review_summary ? <span style={{ color: '#16a34a' }}>✓</span> : <span style={{ color: '#9ca3af' }}>—</span>}
                  </td>
                  <td style={thTdStyle}>
                    {t.is_stop_loss === 1 ? <span style={{ color: '#dc2626' }}>是</span> :
                     t.is_stop_loss === 0 ? <span style={{ color: '#16a34a' }}>否</span> :
                     <span style={{ color: '#9ca3af' }}>未标记</span>}
                  </td>
                  <td style={thTdStyle}>
                    {t.is_auto_import === 1 ? <span style={{ color: '#16a34a' }}>系统导入</span> :
                     t.system_followed === 1 ? <span style={{ color: '#3b82f6' }}>系统信号</span> :
                     <span style={{ color: '#6b7280' }}>手动</span>}
                  </td>
                  <td style={thTdStyle}>
                    <button style={{ ...buttonStyle, fontSize: 12, padding: '2px 8px', marginRight: 4 }} onClick={() => openEdit(t)}>编辑复盘</button>
                    <button style={{ ...buttonStyle, fontSize: 12, padding: '2px 8px', background: '#dc2626' }} onClick={() => handleDelete(t.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* 分页 */}
        {totalPages > 1 && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button style={buttonStyle} disabled={page <= 1} onClick={() => fetchTrades(page - 1)}>上一页</button>
            <span style={{ fontSize: 14 }}>第 {page} / {totalPages} 页，共 {total} 条</span>
            <button style={buttonStyle} disabled={page >= totalPages} onClick={() => fetchTrades(page + 1)}>下一页</button>
          </div>
        )}
      </div>

      {/* 编辑弹窗 */}
      {editingTrade && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div style={{ ...cardStyle, maxWidth: 480, width: '90%' }}>
            <div style={cardTitleStyle}>编辑复盘 — {editingTrade.asset_code} ({editingTrade.trade_date})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 13, color: '#374151' }}>复盘总结</label>
                <textarea style={{ ...inputStyle, width: '100%', marginTop: 4, minHeight: 60, resize: 'vertical' }}
                  value={editForm.review_summary} onChange={(e) => setEditForm(f => ({ ...f, review_summary: e.target.value }))} />
              </div>
              <div style={{ display: 'flex', gap: 16 }}>
                <div>
                  <label style={{ fontSize: 13, color: '#374151' }}>是否符合策略</label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    {([['', '未标记'], ['1', '是'], ['0', '否']] as [string, string][]).map(([v, l]) => (
                      <button key={v} style={{ ...inputStyle, background: editForm.strategy_match === v ? '#dbeafe' : '#fff', border: '1px solid #93c5fd' }}
                        onClick={() => setEditForm((f: any) => ({ ...f, strategy_match: v as any }))}>{l}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 13, color: '#374151' }}>是否止损</label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    {([['', '未标记'], ['1', '是'], ['0', '否']] as [string, string][]).map(([v, l]) => (
                      <button key={v} style={{ ...inputStyle, background: editForm.is_stop_loss === v ? '#fee2e2' : '#fff', border: '1px solid #fca5a5' }}
                        onClick={() => setEditForm((f: any) => ({ ...f, is_stop_loss: v as any }))}>{l}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <label style={{ fontSize: 13, color: '#374151' }}>备注</label>
                <input style={{ ...inputStyle, width: '100%', marginTop: 4 }}
                  value={editForm.remark} onChange={(e) => setEditForm(f => ({ ...f, remark: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button style={buttonStyle} onClick={saveEdit}>保存</button>
              <button style={{ ...buttonStyle, background: '#6b7280' }} onClick={() => setEditingTrade(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
