import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { COLORS, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle, errorStyle, pageContainerStyle, titleStyle } from './_shared';

/**
 * PortfolioReturn.tsx —— 收益页 `/portfolio/return`（V3.8 T147 · PRD_v3 §3.4.2）
 *
 * 三口径（SDD_v3 §7.3 / §9.5）：
 *   - 总收益大字（总收益率）
 *   - 风险 / 现金分项展开（「钱从哪来」分项可见）
 *   - 费用单独显示（含最低佣金影响）
 *   - 口径说明入口（caliberNote，**必须存在**）
 * 券商维度筛选：?brokerCode= 参数（GET /api/portfolio/return 支持）
 */

interface ReturnData {
  risk: { pnl: number; cost: number; rate: number; realized: number; dividend: number; fees: number };
  cash: { pnl: number; cost: number; rate: number; repoInterest: number; cashEtfChange: number };
  total: { pnl: number; cost: number; rate: number; assets: number; invested: number; fees: number };
  caliberNote: string;
}

export default function PortfolioReturn() {
  const [data, setData] = useState<ReturnData | null>(null);
  const [brokers, setBrokers] = useState<string[]>([]);
  const [brokerCode, setBrokerCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNote, setShowNote] = useState(false);

  useEffect(() => {
    api
      .get('/broker-import/batches')
      .then((res) => {
        if (isOkEnvelope(res.data)) {
          setBrokers(
            Array.from(
              new Set(
                ((res.data.data as { batches?: Array<{ broker_code: string }> }).batches ?? []).map(
                  (b) => b.broker_code,
                ),
              ),
            ),
          );
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get('/portfolio/return', { params: brokerCode ? { brokerCode } : undefined })
      .then((res) => {
        if (isOkEnvelope(res.data)) setData(res.data.data as ReturnData);
        else setError(String(res.data?.message ?? '加载失败'));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [brokerCode]);

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>收益</h1>

      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <label>
          <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>券商筛选：</span>
          <select
            value={brokerCode}
            onChange={(e) => setBrokerCode(e.target.value)}
            style={{ marginLeft: 8, fontSize: TYPO.smallSize }}
          >
            <option value="">全部</option>
            {brokers.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && <p style={{ color: COLORS.textMuted }}>加载中…</p>}
      {error && <p style={errorStyle}>{error}</p>}

      {data && data.total && data.risk && data.cash && (
        <>
          {/* 总收益大字（PRD §3.4.2：与券商口径一致的主数字） */}
          <div style={{ ...cardStyle, textAlign: 'center', marginBottom: 16 }}>
            <div
              style={{
                fontSize: 32,
                fontWeight: 700,
                color: data.total.rate >= 0 ? COLORS.success : COLORS.danger,
              }}
            >
              {data.total.rate >= 0 ? '+' : ''}
              {data.total.rate}%
            </div>
            <div style={{ fontSize: TYPO.smallSize, color: COLORS.textMuted }}>总收益率（含费用）</div>
            <div style={{ fontSize: TYPO.smallSize, marginTop: 8 }}>
              总资产 {data.total.assets} · 总投入 {data.total.invested} · 累计费用 {data.total.fees}
            </div>
          </div>

          {/* 分项展开：风险 / 现金（「钱从哪来」，不得只有一个总数） */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div style={cardStyle}>
              <h2 style={subtitleStyle}>风险资产</h2>
              <Row label="收益" value={data.risk.pnl} />
              <Row label="投入（成本）" value={data.risk.cost} />
              <Row label="收益率" value={`${data.risk.rate}%`} />
              <Row label="已实现盈亏" value={data.risk.realized} />
              <Row label="现金分红" value={data.risk.dividend} />
            </div>
            <div style={cardStyle}>
              <h2 style={subtitleStyle}>现金类</h2>
              <Row label="收益" value={data.cash.pnl} />
              <Row label="投入" value={data.cash.cost} />
              <Row label="收益率" value={`${data.cash.rate}%`} />
              <Row label="逆回购利息" value={data.cash.repoInterest} />
              <Row label="货币 ETF 市值变动" value={data.cash.cashEtfChange} />
            </div>
          </div>

          {/* 口径说明（必须存在，PRD §3.4.2 入口） */}
          <div style={cardStyle}>
            <button
              style={{
                ...buttonStyle,
                padding: 0,
                background: 'transparent',
                color: COLORS.brandLink,
                border: 'none',
                cursor: 'pointer',
              }}
              onClick={() => setShowNote((v) => !v)}
            >
              {showNote ? '隐藏口径说明' : '口径说明'}
            </button>
            {showNote && (
              <p style={{ margin: '8px 0 0', fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>
                {data.caliberNote}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{ display: 'flex', justifyContent: 'space-between', fontSize: TYPO.smallSize, padding: '2px 0' }}
    >
      <span style={{ color: COLORS.textMuted }}>{label}</span>
      <span style={{ color: COLORS.textPrimary }}>{value}</span>
    </div>
  );
}

const subtitleStyle: React.CSSProperties = {
  fontSize: TYPO.cardTitleSize,
  fontWeight: 600,
  margin: '0 0 8px',
};
