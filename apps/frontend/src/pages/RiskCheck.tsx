import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { COLORS, TYPO } from '../theme/tokens';
import { cardStyle, errorStyle, pageContainerStyle, titleStyle } from './_shared';
import Spinner from '../components/Spinner';

/**
 * RiskCheck.tsx —— 组合风控体检页 `/portfolio/risk-check`（V3.8 T150 · PRD_v3 §5.3 / SDD_v3 §9.8）
 *
 * ① 单票最大占比 / 前十大集中度 / 可用现金比例 / 组合最大回撤（四指标卡片）
 * ② 集中度分母**排除现金类**（cashExcluded=true 断言）
 * ③ 行业分布（板块口径，标注「近似」）
 * ④ **只呈现不阻断**（无操作按钮，纯只读）
 */

interface RiskCheck {
  singleStockMaxWeight: number;
  top10Concentration: number;
  availableCashRatio: number;
  maxDrawdown: number;
  industryDistribution: Array<{ industry: string; weight: number }>;
  cashExcluded: boolean;
}

export default function RiskCheck() {
  const [data, setData] = useState<RiskCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .get('/portfolio/risk-check')
      .then((res) => {
        if (isOkEnvelope(res.data)) setData(res.data.data as RiskCheck);
        else setError(String(res.data?.message ?? '加载失败'));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>组合体检</h1>
      {loading && <Spinner />}
      {error && <p style={errorStyle}>{error}</p>}

      {data && (
        <>
          {/* 四指标卡片（只呈现不阻断，PRD §5.3） */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <MetricCard
              label="单票最大占比"
              value={`${data.singleStockMaxWeight}%`}
              warn={data.singleStockMaxWeight > 30}
            />
            <MetricCard
              label="前十大集中度"
              value={`${data.top10Concentration}%`}
              warn={data.top10Concentration > 70}
            />
            <MetricCard label="可用现金比例" value={`${data.availableCashRatio}%`} />
            <MetricCard label="组合最大回撤" value={`${data.maxDrawdown}%`} warn={data.maxDrawdown > 20} />
          </div>

          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <h2 style={{ fontSize: TYPO.cardTitleSize, fontWeight: 600, margin: '0 0 8px' }}>
              行业分布（板块口径，<strong>近似</strong>）
            </h2>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>行业/板块（代码前缀）</th>
                  <th style={thStyle}>占比</th>
                </tr>
              </thead>
              <tbody>
                {data.industryDistribution.map((r) => (
                  <tr key={r.industry}>
                    <td style={tdStyle}>{r.industry}</td>
                    <td style={tdStyle}>{r.weight}%</td>
                  </tr>
                ))}
                {data.industryDistribution.length === 0 && (
                  <tr>
                    <td colSpan={2} style={{ ...tdStyle, color: COLORS.textMuted }}>
                      无持仓
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted, margin: '8px 0 0' }}>
              {data.cashExcluded ? '集中度分母已排除现金类资产（SDD_v3 §2）。' : ''}
              行业映射基于标的代码前缀，为近似口径，非精确板块归属。
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function MetricCard({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ ...cardStyle, textAlign: 'center' }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: warn ? COLORS.danger : COLORS.textPrimary }}>
        {value}
      </div>
      <div style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted }}>{label}</div>
    </div>
  );
}

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
