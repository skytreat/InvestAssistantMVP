import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle, errorStyle, pageContainerStyle, titleStyle } from './_shared';
import Spinner from '../components/Spinner';

/**
 * StrategyEffectiveness.tsx —— 策略有效性页 `/strategy/effectiveness`（V3.8 T150 · PRD_v3 §4.3）
 *
 * 交付：
 * ① 单信号后续表现 T+1/T+5/T+10（GET /api/strategy/signals/:id/outcome，真实后续行情）
 * ② 列表可按策略/标的筛选（GET /api/signal）
 *
 * ⚠️ 成本扣减与基准对比（INV-S5-*）在评估口径层（T135 后端）扩展，本页呈现 outcome 数据。
 */

interface SignalRow {
  id?: number;
  asset_code?: string;
  symbol?: string;
  plugin_id?: string;
  direction?: string;
  label?: string;
  trade_date?: string;
  adopted?: number;
  ignored?: number;
}

interface Outcome {
  signalId: number;
  asset_code: string;
  trade_date: string;
  direction: string;
  baseClose: number | null;
  t1: { date: string; close: number; changePct: number } | null;
  t5: { date: string; close: number; changePct: number } | null;
  t10: { date: string; close: number; changePct: number } | null;
}

export default function StrategyEffectiveness() {
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [outcomeFor, setOutcomeFor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pluginFilter, setPluginFilter] = useState('');
  const [assetFilter, setAssetFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    const params: Record<string, unknown> = { page: 1, page_size: 50 };
    if (pluginFilter.trim()) params.plugin_id = pluginFilter.trim();
    if (assetFilter.trim()) params.asset_code = assetFilter.trim();
    api
      .get('/signal', { params })
      .then((res) => {
        if (isOkEnvelope(res.data)) setSignals((res.data.data ?? []) as SignalRow[]);
        else setError(String(res.data?.message ?? '加载失败'));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [pluginFilter, assetFilter]);

  const loadOutcome = async (id: number) => {
    setOutcomeFor(id);
    setOutcome(null);
    setError(null);
    try {
      const res = await api.get(`/strategy/signals/${id}/outcome`);
      if (isOkEnvelope(res.data)) setOutcome(res.data.data as Outcome);
      else setError(String(res.data?.message ?? '加载失败'));
    } catch (e) {
      setError(extractErrorMessage(e, '加载失败'));
    }
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>策略有效性</h1>

      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label>
            <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>策略：</span>
            <input
              style={{ ...inputStyle, width: 160 }}
              value={pluginFilter}
              onChange={(e) => setPluginFilter(e.target.value)}
              placeholder="如 rsi_oversold"
            />
          </label>
          <label>
            <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>标的：</span>
            <input
              style={{ ...inputStyle, width: 160 }}
              value={assetFilter}
              onChange={(e) => setAssetFilter(e.target.value)}
              placeholder="如 sh600000"
            />
          </label>
        </div>
      </div>

      {error && <p style={errorStyle}>{error}</p>}
      {loading && <Spinner />}

      {!loading && (
        <>
          {/* 信号列表 + 后续表现入口 */}
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <h2 style={subtitleStyle}>信号（近 {signals.length} 条）</h2>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>id</th>
                  <th style={thStyle}>标的</th>
                  <th style={thStyle}>策略</th>
                  <th style={thStyle}>方向</th>
                  <th style={thStyle}>日期</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s, i) => (
                  <tr key={s.id ?? i}>
                    <td style={tdStyle}>{s.id}</td>
                    <td style={tdStyle}>{s.asset_code ?? s.symbol ?? '—'}</td>
                    <td style={tdStyle}>{s.plugin_id ?? '—'}</td>
                    <td style={tdStyle}>{s.direction ?? '—'}</td>
                    <td style={tdStyle}>{s.trade_date ?? '—'}</td>
                    <td style={tdStyle}>{s.adopted ? '已采纳' : s.ignored ? '已忽略' : '未标注'}</td>
                    <td style={tdStyle}>
                      {typeof s.id === 'number' && (
                        <button
                          style={{ ...buttonStyle, padding: '2px 8px', fontSize: TYPO.captionSize }}
                          onClick={() => void loadOutcome(s.id!)}
                        >
                          后续表现
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {signals.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ ...tdStyle, color: COLORS.textMuted }}>
                      无信号
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* T+1 / T+5 / T+10 后续表现（真实行情，非模拟成交） */}
          {outcomeFor !== null && (
            <div style={cardStyle}>
              <h2 style={subtitleStyle}>
                #{outcomeFor} 后续表现（{outcome ? outcome.asset_code : '加载中'}）
              </h2>
              {outcome ? (
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>基准收盘</th>
                      <th style={thStyle}>T+1</th>
                      <th style={thStyle}>T+5</th>
                      <th style={thStyle}>T+10</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={tdStyle}>{outcome.baseClose ?? '—'}</td>
                      {(['t1', 't5', 't10'] as const).map((k) => {
                        const cell = outcome[k];
                        return (
                          <td key={k} style={tdStyle}>
                            {cell ? `${cell.changePct}%（${cell.date}）` : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              ) : (
                <Spinner />
              )}
            </div>
          )}
        </>
      )}
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
const tdStyle: React.CSSProperties = { borderBottom: `1px solid ${COLORS.borderLight}`, padding: '4px 8px' };
const inputStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.borderMedium}`,
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: TYPO.smallSize,
  fontFamily: 'inherit',
};
