import React, { useState } from 'react';
import { api } from '../api/client';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  inputStyle,
  buttonStyle,
  errorStyle,
  successStyle,
  formRowStyle,
  labelStyle,
} from './_shared';

const TRADE_TYPES: { value: string; label: string }[] = [
  { value: 'buy', label: '买入' },
  { value: 'add', label: '加仓' },
  { value: 'reduce', label: '减仓' },
  { value: 'clear', label: '清仓' },
  { value: 'dividend', label: '分红' },
  { value: 'bonus', label: '送股' },
  { value: 'transfer', label: '转托管' },
];

/** T87：成交时间（秒级 HH:mm:ss），默认当前时间 */
function nowTimeStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

interface TradeResult {
  trade_id: number;
  position: {
    qty: number;
    avgCost: number;
  };
}

interface SymbolOption {
  symbol: string;
  name: string;
}

/** 自动补全输入框：输入代码/名称后弹出匹配列表，点击选择后自动补全前缀 */
function SymbolAutocomplete({ value, onChange }: { value: string; onChange: (val: string) => void }) {
  const [options, setOptions] = useState<SymbolOption[]>([]);
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);

  const query = value.trim();

  const fetchOptions = async (q: string) => {
    if (q.length < 2) {
      setOptions([]);
      setOpen(false);
      return;
    }
    try {
      const res = await api.get('/symbols/search', { params: { q } });
      setOptions((res.data?.data ?? []) as SymbolOption[]);
      setOpen(true);
      setHighlightIdx(-1);
    } catch {
      /* ignore */
    }
  };

  const handleChange = (v: string) => {
    onChange(v);
    fetchOptions(v);
  };

  const handleSelect = (opt: SymbolOption) => {
    // 自动补全前缀：如果当前值没有前缀，从 option.symbol 取
    const sym = opt.symbol;
    onChange(sym);
    setOpen(false);
    setOptions([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && highlightIdx >= 0) {
      e.preventDefault();
      handleSelect(options[highlightIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  // 判断当前输入是否已有合法前缀
  const hasPrefix = /^[a-z]{2}/.test(value);
  const displayName = hasPrefix ? value : value;

  return (
    <div style={{ position: 'relative', flex: 1 }}>
      <input
        style={{ ...inputStyle, flex: 1, width: '100%' }}
        type="text"
        placeholder="输入代码或名称，如 600000 或 浦发"
        value={displayName}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (options.length > 0) setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        required
      />
      {open && options.length > 0 && (
        <ul
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            margin: 0,
            padding: 0,
            listStyle: 'none',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            marginTop: 2,
            background: '#fff',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            zIndex: 100,
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {options.map((opt, idx) => (
            <li
              key={opt.symbol}
              onClick={() => handleSelect(opt)}
              onMouseEnter={() => setHighlightIdx(idx)}
              style={{
                padding: '6px 10px',
                cursor: 'pointer',
                fontSize: 14,
                background: idx === highlightIdx ? '#eff6ff' : '#fff',
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontFamily: 'monospace', color: '#1e40af' }}>{opt.symbol}</span>
              <span style={{ color: '#6b7280' }}>{opt.name}</span>
            </li>
          ))}
        </ul>
      )}
      {open && options.length === 0 && query.length >= 2 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            padding: '8px 10px',
            fontSize: 13,
            color: '#6b7280',
            background: '#fff',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            marginTop: 2,
            zIndex: 100,
          }}
        >
          无匹配标的
        </div>
      )}
    </div>
  );
}

export default function TradeInput() {
  const [assetCode, setAssetCode] = useState('');
  const [tradeType, setTradeType] = useState<string>('buy');
  const [tradeDate, setTradeDate] = useState<string>(todayStr());
  const [tradeTime, setTradeTime] = useState<string>(nowTimeStr());
  const [quantity, setQuantity] = useState<string>('');
  const [price, setPrice] = useState<string>('');
  const [fee, setFee] = useState<string>('0');
  const [tradeReason, setTradeReason] = useState<string>('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TradeResult | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);

    const payload = {
      asset_code: assetCode,
      trade_type: tradeType,
      trade_date: tradeDate,
      trade_time: tradeTime,
      quantity: Number(quantity),
      price: Number(price),
      fee: Number(fee) || 0,
      trade_reason: tradeReason.trim() || undefined,
    };

    try {
      const res = await api.post('/trade', payload);
      if (res.data.success) {
        setResult(res.data.data as TradeResult);
      } else {
        const errMsg = res.data.message ?? '请求失败';
        if (errMsg === 'HOLDING_INSUFFICIENT') {
          setError('持仓不足');
        } else {
          setError(errMsg);
        }
      }
    } catch (err: any) {
      const errMsg = err?.response?.data?.message ?? '网络错误';
      if (errMsg === 'HOLDING_INSUFFICIENT') {
        setError('持仓不足');
      } else {
        setError(errMsg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>交易录入</h1>
      <div style={{ ...cardStyle, maxWidth: 600 }}>
        <form onSubmit={handleSubmit}>
          <div style={formRowStyle}>
            <label style={labelStyle}>股票代码</label>
            <SymbolAutocomplete value={assetCode} onChange={setAssetCode} />
          </div>

          <div style={formRowStyle}>
            <label style={labelStyle}>交易类型</label>
            <select
              style={{ ...inputStyle, flex: 1 }}
              value={tradeType}
              onChange={(e) => setTradeType(e.target.value)}
            >
              {TRADE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div style={formRowStyle}>
            <label style={labelStyle}>交易日期</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="date"
              value={tradeDate}
              onChange={(e) => setTradeDate(e.target.value)}
              required
            />
          </div>

          <div style={formRowStyle}>
            <label style={labelStyle}>成交时间</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="time"
              step="1"
              value={tradeTime}
              onChange={(e) => setTradeTime(e.target.value)}
              required
            />
          </div>
          {/* T87：同日同标的同类型可分笔录入，唯一键含成交时间；提交前请确认成交时间无误 */}

          <div style={formRowStyle}>
            <label style={labelStyle}>数量</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
          </div>

          <div style={formRowStyle}>
            <label style={labelStyle}>价格</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="number"
              step="0.0001"
              min={0}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
          </div>

          <div style={formRowStyle}>
            <label style={labelStyle}>手续费</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="number"
              step="0.0001"
              min={0}
              value={fee}
              onChange={(e) => setFee(e.target.value)}
            />
          </div>

          <div style={formRowStyle}>
            <label style={labelStyle}>trade_reason</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="text"
              placeholder="如 MACD 金叉买入 / 止损卖出"
              value={tradeReason}
              onChange={(e) => setTradeReason(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
            <button type="submit" style={buttonStyle} disabled={loading}>
              {loading ? '提交中...' : '提交交易'}
            </button>
          </div>

          {error && <div style={errorStyle}>{error}</div>}
          {result && (
            <div style={successStyle}>
              提交成功！交易编号: {result.trade_id} &nbsp;|&nbsp; 最新持仓: 数量={result.position.qty}, 均价=
              {result.position.avgCost.toFixed(4)}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
