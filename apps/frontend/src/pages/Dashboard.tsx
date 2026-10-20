import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { useUserStore } from '../store/user';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  cardTitleStyle,
  tableStyle,
  thStyle,
  thTdStyle,
  buttonStyle,
} from './_shared';

/** 双口径口径说明（Requirements §5.4） */
type Caliber = 'price' | 'actual';

interface AssetStat {
  trade_date: string;
  total_assets_price_yield: number;
  total_assets_actual_yield: number;
  total_profit_price: number;
  total_profit_actual: number;
}

interface Position {
  asset_code: string;
  totalQuantity: number;
  totalCostBasis: number;
  avgCost: number;
  realizedPnL: number;
  currentPrice: number | null;
  priceDate: string | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedYield: number | null;
  weight: number | null;
}

interface PositionSummary {
  totalMarketValue: number;
  totalCostBasis: number;
  unrealizedPnl: number;
  realizedPnl: number;
  priceDate: string | null;
  positionCount: number;
}

interface Signal {
  asset_code: string;
  plugin_id: string;
  direction: string;
  label: string;
  trade_date: string;
}

interface SystemLog {
  created_at: string;
  log_type: string;
  level: string;
  message: string;
}

const DIRECTION_LABEL: Record<string, string> = {
  buy: '买入',
  sell: '卖出',
  hold: '持仓',
};

const LEVEL_COLOR: Record<string, string> = {
  ERROR: COLORS.danger,
  WARN: COLORS.warning,
  SKIP: COLORS.textMuted,
  SUCCESS: COLORS.success,
  INFO: COLORS.brand,
};

/** A 股 ETF 判定：sh51xxxx / sh56xxxx / sh58xxxx / sz15xxxx / sz16xxxx */
export function isEtf(code: string): boolean {
  return /^(sh5[168]|sz1[56])/.test(code);
}

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  return n.toFixed(digits);
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  return `${(n * 100).toFixed(2)}%`;
}

/**
 * 纯 CSS 环形图（G7c 资产组成饼图）
 *
 * MVP 不引第三方图表库：conic-gradient 直接画，股票 / ETF 两段配色。
 */
export function DonutChart({ stock, etf }: { stock: number; etf: number }) {
  const total = stock + etf;
  if (total <= 0) {
    return <div style={{ color: COLORS.textMuted, fontSize: TYPO.bodySize }}>暂无持仓资产</div>;
  }
  const stockPct = (stock / total) * 100;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.gapLoose, flexWrap: 'wrap' }}>
      <div
        style={{
          width: 120,
          height: 120,
          borderRadius: '50%',
          background: `conic-gradient(${COLORS.brand} 0% ${stockPct}%, ${COLORS.success} ${stockPct}% 100%)`,
        }}
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: SPACING.gapBase,
          fontSize: TYPO.bodySize,
        }}
      >
        <div>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              background: COLORS.brand,
              marginRight: 6,
            }}
          />
          股票 {fmt(stock)}（{stockPct.toFixed(1)}%）
        </div>
        <div>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              background: COLORS.success,
              marginRight: 6,
            }}
          />
          ETF {fmt(etf)}（{(100 - stockPct).toFixed(1)}%）
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { role } = useUserStore();

  const [positions, setPositions] = useState<Position[]>([]);
  const [posSummary, setPosSummary] = useState<PositionSummary | null>(null);
  const [posLoading, setPosLoading] = useState(false);
  const [posError, setPosError] = useState<string | null>(null);

  const [caliber, setCaliber] = useState<Caliber>('price');
  const [stat, setStat] = useState<AssetStat | null>(null);
  const [statLoading, setStatLoading] = useState(false);
  const [statError, setStatError] = useState<string | null>(null);

  const [signals, setSignals] = useState<Signal[]>([]);
  const [sigLoading, setSigLoading] = useState(false);
  const [sigError, setSigError] = useState<string | null>(null);

  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setPosLoading(true);
      try {
        const res = await api.get('/holding');
        if (res.data.success) {
          setPositions(res.data.data ?? []);
          setPosSummary(res.data.summary ?? null);
        } else setPosError(res.data.message ?? '请求失败');
      } catch (err) {
        setPosError(extractErrorMessage(err));
      } finally {
        setPosLoading(false);
      }
    })();

    (async () => {
      setStatLoading(true);
      try {
        const res = await api.get('/asset-stat/latest');
        if (res.data.success) setStat(res.data.data ?? null);
        else setStatError(res.data.message ?? '请求失败');
      } catch (err) {
        setStatError(extractErrorMessage(err));
      } finally {
        setStatLoading(false);
      }
    })();

    (async () => {
      setSigLoading(true);
      try {
        const res = await api.get('/signal', { params: { page_size: 5 } });
        if (res.data.success) setSignals(res.data.data ?? []);
        else setSigError(res.data.message ?? '请求失败');
      } catch (err) {
        setSigError(extractErrorMessage(err));
      } finally {
        setSigLoading(false);
      }
    })();

    if (role === 'admin') {
      (async () => {
        setLogLoading(true);
        try {
          const res = await api.get('/admin/system-log', { params: { page_size: 5 } });
          if (res.data.success) setLogs(res.data.data ?? []);
          else setLogError(res.data.message ?? '请求失败');
        } catch (err) {
          setLogError(extractErrorMessage(err));
        } finally {
          setLogLoading(false);
        }
      })();
    }
  }, [role]);

  // 资产组成：股票 vs ETF（按市值汇总）
  const allocation = useMemo(() => {
    let stock = 0;
    let etf = 0;
    for (const p of positions) {
      const mv = p.marketValue ?? 0;
      if (isEtf(p.asset_code)) etf += mv;
      else stock += mv;
    }
    return { stock, etf };
  }, [positions]);

  const activePositions = positions.filter((p) => p.totalQuantity > 0);

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>仪表盘</h1>

      {/* G7b 总资产卡（双口径切换，PRD §5.3） */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ ...cardTitleStyle, border: 'none', margin: 0, padding: 0, flex: 1 }}>总资产</div>
          <div
            style={{
              display: 'flex',
              border: `1px solid ${COLORS.borderMedium}`,
              borderRadius: RADIUS.sm,
              overflow: 'hidden',
            }}
          >
            {(
              [
                ['price', '价格口径'],
                ['actual', '实际口径'],
              ] as [Caliber, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setCaliber(k)}
                style={{
                  ...buttonStyle,
                  borderRadius: 0,
                  background: caliber === k ? COLORS.brand : COLORS.cardBg,
                  color: caliber === k ? COLORS.cardBg : COLORS.textSecondary,
                  border: 'none',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {statLoading && <div>加载中...</div>}
        {statError && <div style={{ color: COLORS.danger }}>{statError}</div>}
        {!statLoading &&
          !statError &&
          (stat ? (
            <>
              <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginTop: SPACING.gapBase }}>
                <div>
                  <div style={{ fontSize: 30, fontWeight: 'bold', color: COLORS.brandLink }}>
                    {fmt(posSummary?.totalCostBasis)}
                  </div>
                  <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral }}>总资产</div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 30,
                      fontWeight: 'bold',
                      color:
                        (caliber === 'price' ? stat.total_profit_price : stat.total_profit_actual) >= 0
                          ? COLORS.success
                          : COLORS.danger,
                    }}
                  >
                    {(caliber === 'price' ? stat.total_profit_price : stat.total_profit_actual) >= 0
                      ? '+'
                      : ''}
                    {fmt(caliber === 'price' ? stat.total_profit_price : stat.total_profit_actual)}
                  </div>
                  <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral }}>总盈亏</div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 30,
                      fontWeight: 'bold',
                      color:
                        (caliber === 'price'
                          ? stat.total_assets_price_yield
                          : stat.total_assets_actual_yield) >= 0
                          ? COLORS.success
                          : COLORS.danger,
                    }}
                  >
                    {fmtPct(
                      caliber === 'price' ? stat.total_assets_price_yield : stat.total_assets_actual_yield,
                    )}
                  </div>
                  <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral }}>总收益率</div>
                </div>
                <div>
                  <div style={{ fontSize: 30, fontWeight: 'bold', color: COLORS.accentPurple }}>
                    {fmt(posSummary?.realizedPnl)}
                  </div>
                  <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral }}>已实现盈亏</div>
                </div>
              </div>
              <div style={{ fontSize: 12, color: COLORS.neutral, marginTop: SPACING.gapBase }}>
                快照日期 {stat.trade_date}
                {posSummary?.priceDate && ` · 现价取自 ${posSummary.priceDate}`}
                {' · '}
                {caliber === 'price'
                  ? '价格口径：纯价格涨跌，不含分红送转'
                  : '实际口径：含分红等现金流，反映真实收益'}
              </div>
            </>
          ) : (
            <div style={{ color: COLORS.textMuted, padding: '12px 0' }}>
              暂无资产快照（每天 17:02 信号生成后自动写入）
            </div>
          ))}
      </div>

      {/* G7c 资产组成饼图 */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>资产组成</div>
        <DonutChart stock={allocation.stock} etf={allocation.etf} />
      </div>

      {/* 持仓卡片列表（T33 规格） */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>持仓明细（{activePositions.length} 只）</div>
        {posLoading && <div>加载中...</div>}
        {posError && <div style={{ color: COLORS.danger }}>{posError}</div>}
        {!posLoading &&
          !posError &&
          (activePositions.length === 0 ? (
            <div style={{ color: COLORS.neutral, padding: 20, textAlign: 'center' }}>暂无持仓</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle} aria-label="持仓明细">
                <thead>
                  <tr>
                    <th scope="col" style={thStyle}>
                      代码
                    </th>
                    <th scope="col" style={thStyle}>
                      现价
                    </th>
                    <th scope="col" style={thStyle}>
                      持仓
                    </th>
                    <th scope="col" style={thStyle}>
                      均价
                    </th>
                    <th scope="col" style={thStyle}>
                      市值
                    </th>
                    <th scope="col" style={thStyle}>
                      浮动盈亏
                    </th>
                    <th scope="col" style={thStyle}>
                      收益率
                    </th>
                    <th scope="col" style={thStyle}>
                      仓位占比
                    </th>
                    <th scope="col" style={thStyle}>
                      已实现
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {activePositions.map((p) => (
                    <tr key={p.asset_code}>
                      <td style={thTdStyle}>
                        <code>{p.asset_code}</code>
                        {isEtf(p.asset_code) && (
                          <span style={{ color: COLORS.success, fontSize: TYPO.captionSize, marginLeft: 4 }}>
                            ETF
                          </span>
                        )}
                      </td>
                      <td style={thTdStyle}>{fmt(p.currentPrice)}</td>
                      <td style={thTdStyle}>{p.totalQuantity}</td>
                      <td style={thTdStyle}>{fmt(p.avgCost, 4)}</td>
                      <td style={thTdStyle}>{fmt(p.marketValue)}</td>
                      <td
                        style={{
                          ...thTdStyle,
                          color: (p.unrealizedPnl ?? 0) >= 0 ? COLORS.success : COLORS.danger,
                        }}
                      >
                        {fmt(p.unrealizedPnl)}
                      </td>
                      <td
                        style={{
                          ...thTdStyle,
                          color: (p.unrealizedYield ?? 0) >= 0 ? COLORS.success : COLORS.danger,
                        }}
                      >
                        {fmtPct(p.unrealizedYield)}
                      </td>
                      <td style={thTdStyle}>{fmtPct(p.weight)}</td>
                      <td
                        style={{ ...thTdStyle, color: p.realizedPnL >= 0 ? COLORS.success : COLORS.danger }}
                      >
                        {fmt(p.realizedPnL)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>最新信号</div>
        {sigLoading && <div>加载中...</div>}
        {sigError && <div style={{ color: COLORS.danger }}>{sigError}</div>}
        {!sigLoading && !sigError && (
          <table style={tableStyle} aria-label="最新信号">
            <thead>
              <tr>
                <th scope="col" style={thStyle}>
                  代码
                </th>
                <th scope="col" style={thStyle}>
                  策略
                </th>
                <th scope="col" style={thStyle}>
                  方向
                </th>
                <th scope="col" style={thStyle}>
                  标签
                </th>
                <th scope="col" style={thStyle}>
                  日期
                </th>
              </tr>
            </thead>
            <tbody>
              {signals.length === 0 ? (
                <tr>
                  <td style={thTdStyle} colSpan={5}>
                    暂无信号
                  </td>
                </tr>
              ) : (
                signals.map((s, i) => (
                  <tr key={i}>
                    <td style={thTdStyle}>{s.asset_code}</td>
                    <td style={thTdStyle}>{s.plugin_id}</td>
                    <td style={thTdStyle}>
                      <span
                        style={{
                          color:
                            s.direction === 'buy'
                              ? COLORS.success
                              : s.direction === 'sell'
                                ? COLORS.danger
                                : COLORS.textSecondary,
                          fontWeight: TYPO.cardTitleWeight,
                        }}
                      >
                        {DIRECTION_LABEL[s.direction] ?? s.direction}
                      </span>
                    </td>
                    <td style={thTdStyle}>{s.label}</td>
                    <td style={thTdStyle}>{s.trade_date}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {role === 'admin' && (
        <div style={cardStyle}>
          <div style={cardTitleStyle}>最近日志</div>
          {logLoading && <div>加载中...</div>}
          {logError && <div style={{ color: COLORS.danger }}>{logError}</div>}
          {!logLoading && !logError && (
            <table style={tableStyle} aria-label="最近日志">
              <thead>
                <tr>
                  <th scope="col" style={thStyle}>
                    时间
                  </th>
                  <th scope="col" style={thStyle}>
                    类型
                  </th>
                  <th scope="col" style={thStyle}>
                    级别
                  </th>
                  <th scope="col" style={thStyle}>
                    消息
                  </th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td style={thTdStyle} colSpan={4}>
                      暂无日志
                    </td>
                  </tr>
                ) : (
                  logs.map((l, i) => (
                    <tr key={i}>
                      <td style={thTdStyle}>{l.created_at}</td>
                      <td style={thTdStyle}>{l.log_type}</td>
                      <td style={{ ...thTdStyle, color: LEVEL_COLOR[l.level] ?? COLORS.textSecondary }}>
                        {l.level}
                      </td>
                      <td style={thTdStyle}>{l.message}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
