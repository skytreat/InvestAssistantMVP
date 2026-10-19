import React, { useEffect, useMemo, useState } from 'react';
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
  strategy_match: number | null;
  is_stop_loss: number | null;
  review_summary: string | null;
  remark: string | null;
  created_at: string;
}

interface ReviewStats {
  totalTrades: number;
  reviewedCount: number;
  closedCount: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitLossRatio: number | null;
  totalRealizedPnl: number;
}

const TRADE_TYPE_LABEL: Record<string, string> = {
  buy: '买入', add: '加仓', reduce: '减仓', clear: '清仓',
  dividend: '分红', bonus: '送股', transfer: '转增',
};

/** 双口径（Requirements §5.4） */
type Caliber = 'price' | 'actual';

const CALIBER_LABEL: Record<Caliber, string> = {
  price: '价格口径（不含分红送转）',
  actual: '实际口径（含分红现金流）',
};

/** 收益曲线周期（PRD R2 月度/季度/年度） */
type CurvePeriod = 'monthly' | 'quarterly' | 'yearly';

const PERIOD_LABEL: Record<CurvePeriod, string> = {
  monthly: '月度', quarterly: '季度', yearly: '年度',
};

const PERIOD_MONTHS: Record<CurvePeriod, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/** 历史快照（/api/asset-stat/history） */
interface HistoryPoint {
  trade_date: string;
  total_assets_price_yield: number;
  total_assets_actual_yield: number;
  total_profit_price: number;
  total_profit_actual: number;
}

/** 按周期取每期最后一个快照（收益率曲线终点用） */
function bucketByPeriod(rows: HistoryPoint[], period: CurvePeriod): HistoryPoint[] {
  const months = PERIOD_MONTHS[period];
  const bucket = new Map<string, HistoryPoint>();
  for (const r of rows) {
    const d = new Date(r.trade_date);
    if (Number.isNaN(d.getTime())) continue;
    const monthIndex = d.getFullYear() * 12 + d.getMonth();
    const key = String(Math.floor(monthIndex / months));
    const prev = bucket.get(key);
    // 按日期升序遍历，后来的覆盖先前的 → 每期留最后一天
    if (!prev || r.trade_date >= prev.trade_date) bucket.set(key, r);
  }
  return [...bucket.values()].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
}

/** 纯 SVG 收益曲线（不引第三方图表库） */
function YieldCurve({ points, caliber }: { points: HistoryPoint[]; caliber: Caliber }) {
  if (points.length === 0) {
    return <div style={{ color: '#9ca3af', fontSize: 13 }}>暂无历史快照（每天 17:02 自动写入）</div>;
  }
  const W = 640;
  const H = 180;
  const PAD = { top: 12, right: 44, bottom: 24, left: 8 };

  const values = points.map((p) =>
    (caliber === 'price' ? p.total_assets_price_yield : p.total_assets_actual_yield) * 100);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = (max - min) || 1;
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const x = (i: number) => PAD.left + (points.length === 1 ? chartW / 2 : (i / (points.length - 1)) * chartW);
  const y = (v: number) => PAD.top + ((max - v) / range) * chartH;

  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zeroY = y(0);
  const last = values[values.length - 1];
  const color = last >= 0 ? '#16a34a' : '#dc2626';

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, height: 'auto' }}>
        <rect x={0} y={0} width={W} height={H} fill="#f9fafb" rx={4} />
        {/* 零轴 */}
        <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY}
              stroke="#9ca3af" strokeWidth={1} strokeDasharray="4 4" />
        {/* 面积 */}
        <path d={`${path} L${x(values.length - 1)},${zeroY} L${x(0)},${zeroY} Z`}
              fill={color} fillOpacity={0.12} />
        {/* 折线 */}
        <path d={path} fill="none" stroke={color} strokeWidth={2} />
        {/* 端点 */}
        <circle cx={x(values.length - 1)} cy={y(last)} r={3.5} fill={color} />
        {/* y 轴刻度 */}
        <text x={W - PAD.right + 6} y={PAD.top + 10} fontSize={10} fill="#6b7280">{max.toFixed(1)}%</text>
        <text x={W - PAD.right + 6} y={zeroY + 4} fontSize={10} fill="#6b7280">0%</text>
        <text x={W - PAD.right + 6} y={H - PAD.bottom} fontSize={10} fill="#6b7280">{min.toFixed(1)}%</text>
        {/* x 轴首尾日期 */}
        <text x={PAD.left} y={H - 6} fontSize={10} fill="#6b7280">{points[0].trade_date}</text>
        <text x={W - PAD.right} y={H - 6} fontSize={10} fill="#6b7280" textAnchor="end">
          {points[points.length - 1].trade_date}
        </text>
      </svg>
      <div style={{ fontSize: 13, marginTop: 4, color }}>
        期末收益率 {last.toFixed(2)}%（{CALIBER_LABEL[caliber]}）
      </div>
    </div>
  );
}

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
  const [strategyMatch, setStrategyMatch] = useState('');
  const [isStopLoss, setIsStopLoss] = useState('');

  // 编辑中的交易
  const [editingTrade, setEditingTrade] = useState<TradeRow | null>(null);
  const [editForm, setEditForm] = useState({ review_summary: '', strategy_match: '' as '' | '0' | '1', is_stop_loss: '' as '' | '0' | '1', remark: '' });

  // T38 ① 双口径切换 + R2/R4 收益曲线
  const [caliber, setCaliber] = useState<Caliber>('price');
  const [curvePeriod, setCurvePeriod] = useState<CurvePeriod>('monthly');
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchStats = async () => {
    try {
      const res = await api.get('/review/yield');
      if (res.data.success) setStats(res.data.data);
    } catch { /* ignore */ }
  };

  const fetchHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await api.get('/asset-stat/history', { params: { days: 365 } });
      if (res.data.success) setHistory(res.data.data ?? []);
    } catch { /* ignore */ }
    finally { setHistoryLoading(false); }
  };

  const curvePoints = useMemo(() => bucketByPeriod(history, curvePeriod), [history, curvePeriod]);

  const fetchTrades = async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, any> = { page: p, limit: 20 };
      if (tradeType) params.trade_type = tradeType;
      if (systemFollowed !== '') params.system_followed = systemFollowed;
      if (strategyMatch !== '') params.strategy_match = strategyMatch;
      if (isStopLoss !== '') params.is_stop_loss = isStopLoss;
      const res = await api.get('/review/trades', { params });
      if (res.data.success) {
        setTrades(res.data.data ?? []);
        setTotalPages(res.data.pagination?.totalPages ?? 1);
        setTotal(res.data.pagination?.total ?? 0);
      }
    } catch (err: any) {
      setError(err?.response?.data?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchStats(); fetchTrades(1); fetchHistory(); }, []);

  const handleFilter = () => { fetchTrades(1); };

  const openEdit = (trade: TradeRow) => {
    setEditingTrade(trade);
    setEditForm({
      review_summary: trade.review_summary ?? '',
      strategy_match: trade.strategy_match === 1 ? '1' : trade.strategy_match === 0 ? '0' : '',
      is_stop_loss: trade.is_stop_loss === 1 ? '1' : trade.is_stop_loss === 0 ? '0' : '',
      remark: trade.remark ?? '',
    });
  };

  const saveEdit = async () => {
    if (!editingTrade) return;
    try {
      const payload: Record<string, any> = {};
      if (editForm.review_summary !== editingTrade.review_summary) payload.review_summary = editForm.review_summary || null;
      if (editForm.strategy_match !== '' && editForm.strategy_match !== String(editingTrade.strategy_match ?? '')) {
        payload.strategy_match = editForm.strategy_match === '1' ? 1 : 0;
      }
      if (editForm.is_stop_loss !== '' && editForm.is_stop_loss !== String(editingTrade.is_stop_loss ?? '')) {
        payload.is_stop_loss = editForm.is_stop_loss === '1' ? 1 : 0;
      }
      if (editForm.remark !== editingTrade.remark) payload.remark = editForm.remark || null;
      if (Object.keys(payload).length === 0) { setEditingTrade(null); return; }
      await api.patch(`/trade/${editingTrade.id}`, payload);
      setEditingTrade(null);
      fetchTrades(page);
      fetchStats();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? '保存失败');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确认软删除此交易？')) return;
    try {
      await api.post(`/trade/${id}/soft-delete`);
      fetchTrades(page);
      fetchStats();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? '删除失败');
    }
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>交易复盘</h1>

      {/* T38 ① 顶部双口径 Tab（PRD §5.5 / Requirements §5.4） */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {([['price', '价格口径'], ['actual', '实际口径']] as [Caliber, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setCaliber(k)} style={{
            ...buttonStyle,
            background: caliber === k ? '#2563eb' : '#fff',
            color: caliber === k ? '#fff' : '#374151',
            border: '1px solid #d1d5db',
          }}>
            {label}
          </button>
        ))}
        <span style={{ fontSize: 13, color: '#6b7280', alignSelf: 'center' }}>{CALIBER_LABEL[caliber]}</span>
      </div>

      {/* R2/R4 收益曲线（月度/季度/年度） */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ ...cardTitleStyle, border: 'none', margin: 0, padding: 0, flex: 1 }}>收益曲线</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {([['monthly', '月度'], ['quarterly', '季度'], ['yearly', '年度']] as [CurvePeriod, string][]).map(([k, label]) => (
              <button key={k} onClick={() => setCurvePeriod(k)} style={{
                padding: '3px 12px', fontSize: 13, cursor: 'pointer',
                border: `1px solid ${curvePeriod === k ? '#2563eb' : '#d1d5db'}`,
                borderRadius: 4,
                background: curvePeriod === k ? '#2563eb' : '#fff',
                color: curvePeriod === k ? '#fff' : '#374151',
              }}>{label}</button>
            ))}
          </div>
        </div>
        {historyLoading ? <div style={{ fontSize: 13, color: '#6b7280' }}>加载中...</div> : (
          <YieldCurve points={curvePoints} caliber={caliber} />
        )}
      </div>

      {/* 统计卡片 */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        {[
          { label: '总交易数', value: String(stats?.totalTrades ?? 0), color: '#1e40af' },
          { label: '已复盘', value: String(stats?.reviewedCount ?? 0), color: '#16a34a' },
          { label: '胜率', value: stats?.winRate != null ? `${stats.winRate}%` : '--', color: '#7c3aed' },
          { label: '盈亏比', value: stats?.profitLossRatio != null ? `${stats.profitLossRatio}` : '--', color: '#dc2626' },
          {
            label: '已实现盈亏',
            value: stats ? `${stats.totalRealizedPnl >= 0 ? '+' : ''}${stats.totalRealizedPnl.toFixed(2)}` : '--',
            color: (stats?.totalRealizedPnl ?? 0) >= 0 ? '#16a34a' : '#dc2626',
          },
        ].map((card) => (
          <div key={card.label} style={{ ...cardStyle, flex: '1 1 140px', textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 'bold', color: card.color }}>{card.value}</div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>{card.label}</div>
          </div>
        ))}
      </div>
      {stats && (
        <div style={{ fontSize: 13, color: '#6b7280', marginTop: -12, marginBottom: 20 }}>
          平仓 {stats.closedCount} 笔（盈利 {stats.winCount} / 亏损 {stats.lossCount}）
          {stats.avgWin != null && ` · 平均盈利 ${stats.avgWin.toFixed(2)}`}
          {stats.avgLoss != null && ` · 平均亏损 ${stats.avgLoss.toFixed(2)}`}
        </div>
      )}

      {/* 筛选栏 */}
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 14 }}>交易类型：</label>
        <select style={inputStyle} value={tradeType} onChange={(e) => setTradeType(e.target.value)}>
          <option value="">全部</option>
          {['buy','add','reduce','clear','dividend','bonus','transfer'].map((t) => (
            <option key={t} value={t}>{TRADE_TYPE_LABEL[t]}</option>
          ))}
        </select>
        <label style={{ fontSize: 14 }}>系统信号：</label>
        <select style={inputStyle} value={systemFollowed} onChange={(e) => setSystemFollowed(e.target.value)}>
          <option value="">全部</option>
          <option value="1">是</option>
          <option value="0">否</option>
        </select>
        <label style={{ fontSize: 14 }}>符合策略：</label>
        <select style={inputStyle} value={strategyMatch} onChange={(e) => setStrategyMatch(e.target.value)}>
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
                <th style={thStyle}>符合策略</th>
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
                    {t.strategy_match === 1 ? <span style={{ color: '#16a34a' }}>是</span> :
                     t.strategy_match === 0 ? <span style={{ color: '#dc2626' }}>否</span> :
                     <span style={{ color: '#9ca3af' }}>未标记</span>}
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
