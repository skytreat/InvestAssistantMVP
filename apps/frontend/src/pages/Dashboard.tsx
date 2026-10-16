import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useUserStore } from '../store/user';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  cardTitleStyle,
  tableStyle,
  thStyle,
  thTdStyle,
} from './_shared';

interface Position {
  asset_code: string;
  qty: number;
  avgCost: number;
  realizedPnL: number;
}

interface Signal {
  symbol: string;
  plugin: string;
  direction: string;
  label: string;
  trade_date: string;
}

interface SystemLog {
  created_at: string;
  type: string;
  level: string;
  message: string;
}

const DIRECTION_LABEL: Record<string, string> = {
  buy: '买入',
  sell: '卖出',
  hold: '持仓',
};

export default function Dashboard() {
  const { role } = useUserStore();

  const [positions, setPositions] = useState<Position[]>([]);
  const [posLoading, setPosLoading] = useState(false);
  const [posError, setPosError] = useState<string | null>(null);

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
        const res = await api.get('/positions');
        if (res.data.success) setPositions(res.data.data ?? []);
        else setPosError(res.data.error ?? '请求失败');
      } catch (err: any) {
        setPosError(err?.response?.data?.error ?? '网络错误');
      } finally {
        setPosLoading(false);
      }
    })();

    (async () => {
      setSigLoading(true);
      try {
        const res = await api.get('/signals', { params: { page_size: 5 } });
        if (res.data.success) setSignals(res.data.data ?? []);
        else setSigError(res.data.error ?? '请求失败');
      } catch (err: any) {
        setSigError(err?.response?.data?.error ?? '网络错误');
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
          else setLogError(res.data.error ?? '请求失败');
        } catch (err: any) {
          setLogError(err?.response?.data?.error ?? '网络错误');
        } finally {
          setLogLoading(false);
        }
      })();
    }
  }, [role]);

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>仪表盘</h1>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>持仓汇总</div>
        {posLoading && <div>加载中...</div>}
        {posError && <div style={{ color: '#dc2626' }}>{posError}</div>}
        {!posLoading && !posError && (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>股票代码</th>
                <th style={thStyle}>数量</th>
                <th style={thStyle}>均价</th>
                <th style={thStyle}>已实现盈亏</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 ? (
                <tr><td style={thTdStyle} colSpan={4}>暂无持仓</td></tr>
              ) : (
                positions.map((p, i) => (
                  <tr key={i}>
                    <td style={thTdStyle}>{p.asset_code}</td>
                    <td style={thTdStyle}>{p.qty}</td>
                    <td style={thTdStyle}>{p.avgCost.toFixed(4)}</td>
                    <td style={{ ...thTdStyle, color: p.realizedPnL >= 0 ? '#16a34a' : '#dc2626' }}>
                      {p.realizedPnL.toFixed(2)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>最新信号</div>
        {sigLoading && <div>加载中...</div>}
        {sigError && <div style={{ color: '#dc2626' }}>{sigError}</div>}
        {!sigLoading && !sigError && (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>股票代码</th>
                <th style={thStyle}>策略</th>
                <th style={thStyle}>方向</th>
                <th style={thStyle}>标签</th>
                <th style={thStyle}>日期</th>
              </tr>
            </thead>
            <tbody>
              {signals.length === 0 ? (
                <tr><td style={thTdStyle} colSpan={5}>暂无信号</td></tr>
              ) : (
                signals.map((s, i) => (
                  <tr key={i}>
                    <td style={thTdStyle}>{s.symbol}</td>
                    <td style={thTdStyle}>{s.plugin}</td>
                    <td style={thTdStyle}>
                      <span style={{
                        color: s.direction === 'buy' ? '#16a34a' : s.direction === 'sell' ? '#dc2626' : '#374151',
                        fontWeight: 600,
                      }}>
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
          {logError && <div style={{ color: '#dc2626' }}>{logError}</div>}
          {!logLoading && !logError && (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>时间</th>
                  <th style={thStyle}>类型</th>
                  <th style={thStyle}>级别</th>
                  <th style={thStyle}>消息</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr><td style={thTdStyle} colSpan={4}>暂无日志</td></tr>
                ) : (
                  logs.map((l, i) => (
                    <tr key={i}>
                      <td style={thTdStyle}>{l.created_at}</td>
                      <td style={thTdStyle}>{l.type}</td>
                      <td style={{
                        ...thTdStyle,
                        color: l.level === 'ERROR' ? '#dc2626' : l.level === 'WARN' ? '#d97706' : '#16a34a',
                      }}>
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
