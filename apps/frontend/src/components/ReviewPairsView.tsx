import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, TYPO } from '../theme/tokens';
import { cardStyle, errorStyle } from '../pages/_shared';
import Spinner from './Spinner';

/**
 * ReviewPairsView.tsx —— 交易对视图 tab（V3.8 T150 · PRD_v3 §5.1 / INV-S6-6~9）
 *
 * ① 开仓→平仓配对（一次开仓→平仓为一行）；加仓/减仓归并到原开仓
 * ② **未平仓单独分组**，不混入已平仓交易对（INV-S6-9）
 * ③ 列结构与用户手工表对齐（代码/开平日期/价格/数量/盈亏/持仓天数/买卖逻辑/情绪）
 * ④ 情绪状态为固定 5 档枚举（INV-S6-3），PATCH /api/review/pairs/:id 更新复盘字段（INV-S6-2）
 */

export interface PairRow {
  id: number;
  asset_code: string;
  open_trade_id: number;
  close_trade_id: number | null;
  open_date: string;
  close_date: string | null;
  open_price: number;
  close_price: number | null;
  open_quantity: number;
  closed_quantity: number;
  remaining_quantity: number;
  realized_pnl: number | null;
  holding_days: number | null;
  buy_reason: string | null;
  sell_reason: string | null;
  emotion_status: string | null;
  broker_code: string | null;
  status: 'closed' | 'open';
}

export const EMOTION_OPTIONS = ['极度兴奋', '兴奋', '平静', '焦虑', '恐慌'] as const;

export default function ReviewPairsView() {
  const [pairs, setPairs] = useState<PairRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get('/review/pairs')
      .then((res) => {
        if (isOkEnvelope(res.data)) setPairs(res.data.data as PairRow[]);
        else setError(String(res.data?.message ?? '加载失败'));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  /** 更新复盘字段（情绪状态 / 买卖逻辑，INV-S6-2 独立存取） */
  const updatePair = async (pair: PairRow, fields: Record<string, unknown>) => {
    setSaved(null);
    try {
      const res = await api.patch(`/review/pairs/${pair.id}`, fields);
      if (isOkEnvelope(res.data)) {
        setSaved(`#${pair.id} 已更新`);
        load();
      } else {
        setError(String(res.data?.message ?? '更新失败'));
      }
    } catch (e) {
      setError(extractErrorMessage(e, '更新失败'));
    }
  };

  if (loading) return <Spinner />;

  const closed = pairs.filter((p) => p.status === 'closed');
  const open = pairs.filter((p) => p.status === 'open');

  return (
    <div>
      {error && <p style={errorStyle}>{error}</p>}
      {saved && <p style={{ color: COLORS.success, fontSize: TYPO.smallSize, marginBottom: 8 }}>{saved}</p>}

      {/* ② 已平仓交易对（INV-S6-6 与逐笔流水并存） */}
      <div style={cardStyle}>
        <h3 style={subtitleStyle}>已平仓交易对（{closed.length}）</h3>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>标的</th>
              <th style={thStyle}>券商</th>
              <th style={thStyle}>开仓日</th>
              <th style={thStyle}>平仓日</th>
              <th style={thStyle}>开/平价</th>
              <th style={thStyle}>开仓量/平仓量</th>
              <th style={thStyle}>净盈亏</th>
              <th style={thStyle}>持仓天数</th>
              <th style={thStyle}>买入逻辑</th>
              <th style={thStyle}>卖出逻辑</th>
              <th style={thStyle}>情绪</th>
            </tr>
          </thead>
          <tbody>
            {closed.map((p) => (
              <tr key={p.id}>
                <td style={tdStyle}>
                  <code>{p.asset_code}</code>
                </td>
                <td style={tdStyle}>{p.broker_code ? p.broker_code : '手工'}</td>
                <td style={tdStyle}>{p.open_date}</td>
                <td style={tdStyle}>{p.close_date ?? '—'}</td>
                <td style={tdStyle}>
                  {p.open_price} / {p.close_price ?? '—'}
                </td>
                <td style={tdStyle}>
                  {p.open_quantity} / {p.closed_quantity}
                </td>
                <td
                  style={{
                    ...tdStyle,
                    color: (p.realized_pnl ?? 0) >= 0 ? COLORS.textSuccess : COLORS.danger,
                  }}
                >
                  {p.realized_pnl ?? '—'}
                </td>
                <td style={tdStyle}>{p.holding_days ?? '—'}</td>
                <td style={tdStyle}>{p.buy_reason ?? '—'}</td>
                <td style={tdStyle}>{p.sell_reason ?? '—'}</td>
                <td style={tdStyle}>
                  <select
                    aria-label={`#${p.id} 情绪状态`}
                    value={p.emotion_status ?? ''}
                    onChange={(e) => void updatePair(p, { emotion_status: e.target.value || null })}
                    style={{ fontSize: TYPO.captionSize }}
                  >
                    <option value="">（未选）</option>
                    {EMOTION_OPTIONS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
            {closed.length === 0 && (
              <tr>
                <td colSpan={11} style={{ ...tdStyle, color: COLORS.textMuted }}>
                  暂无
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ② 未平仓单独成组（INV-S6-9：不得混入已平仓） */}
      <div style={{ ...cardStyle, marginTop: 12 }}>
        <h3 style={subtitleStyle}>未平仓（{open.length}，单独成组）</h3>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>标的</th>
              <th style={thStyle}>券商</th>
              <th style={thStyle}>开仓日</th>
              <th style={thStyle}>开仓价</th>
              <th style={thStyle}>剩余数量</th>
              <th style={thStyle}>买入逻辑</th>
              <th style={thStyle}>情绪</th>
            </tr>
          </thead>
          <tbody>
            {open.map((p) => (
              <tr key={p.id}>
                <td style={tdStyle}>
                  <code>{p.asset_code}</code>
                </td>
                <td style={tdStyle}>{p.broker_code ? p.broker_code : '手工'}</td>
                <td style={tdStyle}>{p.open_date}</td>
                <td style={tdStyle}>{p.open_price}</td>
                <td style={tdStyle}>{p.remaining_quantity}</td>
                <td style={tdStyle}>{p.buy_reason ?? '—'}</td>
                <td style={tdStyle}>
                  <select
                    aria-label={`#${p.id} 情绪状态`}
                    value={p.emotion_status ?? ''}
                    onChange={(e) => void updatePair(p, { emotion_status: e.target.value || null })}
                    style={{ fontSize: TYPO.captionSize }}
                  >
                    <option value="">（未选）</option>
                    {EMOTION_OPTIONS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
            {open.length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...tdStyle, color: COLORS.textMuted }}>
                  暂无
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const subtitleStyle: React.CSSProperties = {
  fontSize: TYPO.cardTitleSize,
  fontWeight: 600,
  margin: '0 0 8px',
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: TYPO.smallSize,
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  borderBottom: `1px solid ${COLORS.borderLight}`,
  padding: '4px 8px',
  color: COLORS.textSecondary,
};
const tdStyle: React.CSSProperties = {
  borderBottom: `1px solid ${COLORS.borderLight}`,
  padding: '4px 8px',
  verticalAlign: 'top',
};
