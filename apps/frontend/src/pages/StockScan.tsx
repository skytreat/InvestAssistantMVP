import { useState, useEffect } from 'react';
import { api } from '../api/client';
import {
  cardStyle,
  cardTitleStyle,
  formRowStyle,
  labelStyle,
  inputStyle,
  buttonStyle,
  tableStyle,
  thStyle,
  thTdStyle,
  titleStyle,
  pageContainerStyle,
  errorStyle,
} from './_shared';

interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  category: 'monitor' | 'filter';
  paramSchema?: Array<{
    key: string;
    label: string;
    type: string;
    default?: number | string | boolean;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
  }>;
}

interface ScanResult {
  symbol: string;
  score: number;
  signalType: 'BUY' | 'SELL' | 'HOLD' | 'ALERT';
  details?: string;
  pluginId: string;
}

const CATEGORY_LABEL: Record<string, string> = { monitor: '监控', filter: '过滤' };
const SIGNAL_LABEL: Record<string, string> = {
  BUY: '买入',
  SELL: '卖出',
  HOLD: '持仓',
  ALERT: '预警',
};

export default function StockScan() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [selectedPluginId, setSelectedPluginId] = useState<string>('');
  const [paramsJson, setParamsJson] = useState<string>('{}');
  const [minAmount, setMinAmount] = useState<number>(0);
  const [maxResults, setMaxResults] = useState<number>(100);

  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ScanResult[]>([]);
  const [totalCandidates, setTotalCandidates] = useState<number>(0);
  const [totalPass, setTotalPass] = useState<number>(0);
  const [tradeDate, setTradeDate] = useState<string>('');
  const [timeMs, setTimeMs] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string>('');
  /** G4：每行的加入状态：symbol → 'candidate' | 'watch' | 'loading' | 'error' */
  const [rowAction, setRowAction] = useState<Record<string, string>>({});
  const [rowMsg, setRowMsg] = useState<string>('');

  const markRow = (symbol: string, state: string) => setRowAction((prev) => ({ ...prev, [symbol]: state }));

  /** 加入候选池 */
  const addCandidate = async (symbol: string) => {
    markRow(symbol, 'loading');
    try {
      const res = await api.post('/candidate', { asset_code: symbol });
      if (res.data?.success) {
        markRow(symbol, 'candidate');
        setRowMsg(`${symbol} 已加入候选池`);
      } else if (res.status === 409) {
        markRow(symbol, 'candidate');
        setRowMsg(`${symbol} 已在候选池`);
      } else {
        markRow(symbol, 'error');
        setErrorMsg(res.data?.message ?? '加入候选失败');
      }
    } catch (err: any) {
      markRow(symbol, 'error');
      setErrorMsg('加入候选失败：' + (err?.response?.data?.message ?? String(err)));
    }
  };

  /** G4 候选迁移 → 自选：先入候选池，再 promote */
  const promoteToWatch = async (symbol: string) => {
    markRow(symbol, 'loading');
    try {
      const res = await api.post(`/candidate/${symbol}/promote`);
      if (res.data?.success) {
        markRow(symbol, 'watch');
        setRowMsg(`${symbol} 已加入自选`);
      } else {
        markRow(symbol, 'error');
        setErrorMsg(res.data?.message ?? '加入自选失败');
      }
    } catch (err: any) {
      markRow(symbol, 'error');
      setErrorMsg('加入自选失败：' + (err?.response?.data?.message ?? String(err)));
    }
  };

  useEffect(() => {
    api
      .get('/stockscan/plugins')
      .then((res) => {
        const list = (res.data?.data ?? []) as PluginInfo[];
        setPlugins(list);
        if (list.length > 0 && !selectedPluginId) {
          setSelectedPluginId(list[0].id);
          const defaultParams: Record<string, unknown> = {};
          for (const f of list[0].paramSchema ?? []) {
            if (f.key !== 'symbol' && f.default !== undefined) {
              defaultParams[f.key] = f.default;
            }
          }
          setParamsJson(JSON.stringify(defaultParams));
        }
      })
      .catch(() => setErrorMsg('加载插件列表失败'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePluginChange = (pluginId: string) => {
    setSelectedPluginId(pluginId);
    const p = plugins.find((x) => x.id === pluginId);
    if (p) {
      const defaultParams: Record<string, unknown> = {};
      for (const f of p.paramSchema ?? []) {
        if (f.key !== 'symbol' && f.default !== undefined) {
          defaultParams[f.key] = f.default;
        }
      }
      setParamsJson(JSON.stringify(defaultParams));
    }
  };

  const runScan = async () => {
    setErrorMsg('');
    setResults([]);
    setTimeMs(0);
    setTotalCandidates(0);
    setTotalPass(0);
    setTradeDate('');

    if (!selectedPluginId) {
      setErrorMsg('请先选择插件');
      return;
    }

    let params: Record<string, unknown> = {};
    try {
      const trimmed = paramsJson.trim();
      if (trimmed.length > 0) {
        params = JSON.parse(trimmed);
        if (typeof params !== 'object' || params === null || Array.isArray(params)) {
          setErrorMsg('参数必须是JSON对象');
          return;
        }
      }
    } catch {
      setErrorMsg('参数JSON解析失败');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post('/stockscan', {
        plugin_id: selectedPluginId,
        params,
        min_amount: minAmount,
        max_results: maxResults,
      });
      if (res.data?.success && res.data?.data) {
        setResults(res.data.data.results);
        setTotalCandidates(res.data.data.totalCandidates);
        setTotalPass(res.data.data.total);
        setTradeDate(res.data.data.tradeDate);
        setTimeMs(res.data.timeMs ?? 0);
      } else {
        setErrorMsg(res.data?.message ?? '选股失败');
      }
    } catch (err: any) {
      setErrorMsg('选股请求失败：' + (err?.response?.data?.message ?? String(err)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={pageContainerStyle}>
      <h2 style={titleStyle}>条件选股</h2>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>选股配置</div>

        <div style={formRowStyle}>
          <span style={labelStyle}>策略插件：</span>
          <select
            style={inputStyle}
            value={selectedPluginId}
            onChange={(e) => handlePluginChange(e.target.value)}
          >
            {plugins.length === 0 && <option value="">加载中...</option>}
            {plugins.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{CATEGORY_LABEL[p.category] ?? p.category}）
              </option>
            ))}
          </select>
          {(() => {
            const cur = plugins.find((x) => x.id === selectedPluginId);
            return cur?.description ? (
              <span style={{ color: '#6b7280', fontSize: 13 }}>{cur.description}</span>
            ) : null;
          })()}
        </div>

        <div style={formRowStyle}>
          <span style={labelStyle}>最低成交额（万）：</span>
          <input
            style={inputStyle}
            type="number"
            min={0}
            step={100}
            value={minAmount}
            onChange={(e) => setMinAmount(Math.max(0, Number(e.target.value)))}
          />
          <span style={{ color: '#6b7280', fontSize: 13 }}>
            用于过滤流动性过差的标的，单位：万元，默认0不过滤
          </span>
        </div>

        <div style={formRowStyle}>
          <span style={labelStyle}>返回上限：</span>
          <input
            style={inputStyle}
            type="number"
            min={1}
            max={500}
            value={maxResults}
            onChange={(e) => setMaxResults(Math.min(500, Math.max(1, Number(e.target.value))))}
          />
        </div>

        <div style={{ ...formRowStyle, alignItems: 'flex-start' }}>
          <span style={{ ...labelStyle, paddingTop: 6 }}>参数 JSON：</span>
          <textarea
            style={{ ...inputStyle, flex: 1, fontFamily: 'monospace' }}
            rows={3}
            value={paramsJson}
            onChange={(e) => setParamsJson(e.target.value)}
            placeholder='{"period": 14, "oversold": 30, "overbought": 70}'
          />
        </div>

        {selectedPluginId &&
          (() => {
            const cur = plugins.find((x) => x.id === selectedPluginId);
            const schema = cur?.paramSchema?.filter((f) => f.key !== 'symbol') ?? [];
            if (schema.length === 0) return null;
            return (
              <div style={{ ...formRowStyle, flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                <span style={labelStyle}>可用参数：</span>
                <div style={{ fontSize: 13, color: '#374151', marginLeft: 90 }}>
                  {schema.map((f) => (
                    <span key={f.key} style={{ marginRight: 12 }}>
                      <code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 }}>
                        {f.key}
                      </code>
                      : {f.label}（{f.type}
                      {f.min !== undefined && f.max !== undefined ? `, ${f.min}~${f.max}` : ''}
                      {f.default !== undefined ? `, 默认${String(f.default)}` : ''}
                      {f.unit ? ` ${f.unit}` : ''}）
                    </span>
                  ))}
                </div>
              </div>
            );
          })()}

        {errorMsg && <div style={errorStyle}>{errorMsg}</div>}

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button style={buttonStyle} onClick={runScan} disabled={loading || !selectedPluginId}>
            {loading ? '运行中...' : '开始选股'}
          </button>
          {timeMs > 0 && !loading && <span style={{ color: '#6b7280', fontSize: 13 }}>耗时 {timeMs}ms</span>}
        </div>
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>
          选股结果
          {totalCandidates > 0 && (
            <span style={{ color: '#6b7280', fontWeight: 400, marginLeft: 12 }}>
              交易日 {tradeDate} · 候选池 {totalCandidates} · 命中 {totalPass} · 返回 {results.length}
            </span>
          )}
        </div>

        {loading ? (
          <div style={{ color: '#6b7280', padding: 20, textAlign: 'center' }}>选股进行中...</div>
        ) : results.length === 0 ? (
          <div style={{ color: '#6b7280', padding: 20, textAlign: 'center' }}>暂无结果</div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>序号</th>
                <th style={thStyle}>股票代码</th>
                <th style={thStyle}>方向</th>
                <th style={thStyle}>强度</th>
                <th style={thStyle}>详情</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => {
                const st = rowAction[r.symbol];
                return (
                  <tr key={r.symbol}>
                    <td style={thTdStyle}>{i + 1}</td>
                    <td style={thTdStyle}>
                      <code>{r.symbol}</code>
                    </td>
                    <td style={thTdStyle}>
                      <span
                        style={{
                          color:
                            r.signalType === 'BUY'
                              ? '#16a34a'
                              : r.signalType === 'SELL'
                                ? '#dc2626'
                                : '#374151',
                          fontWeight: 600,
                        }}
                      >
                        {SIGNAL_LABEL[r.signalType] ?? r.signalType}
                      </span>
                    </td>
                    <td style={thTdStyle}>{(r.score * 100).toFixed(1)}%</td>
                    <td style={{ ...thTdStyle, color: '#6b7280' }}>{r.details ?? '-'}</td>
                    <td style={{ ...thTdStyle, whiteSpace: 'nowrap' }}>
                      <button
                        style={{ ...buttonStyle, fontSize: 12, padding: '3px 10px', marginRight: 6 }}
                        disabled={st === 'loading' || st === 'candidate'}
                        onClick={() => addCandidate(r.symbol)}
                      >
                        {st === 'candidate' ? '已候选' : '加候选'}
                      </button>
                      <button
                        style={{ ...buttonStyle, fontSize: 12, padding: '3px 10px', background: '#16a34a' }}
                        disabled={st === 'loading' || st === 'watch'}
                        onClick={() => promoteToWatch(r.symbol)}
                      >
                        {st === 'watch' ? '已自选' : '加自选'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {rowMsg && <div style={{ color: '#16a34a', marginTop: 8, fontSize: 13 }}>{rowMsg}</div>}
      </div>
    </div>
  );
}
