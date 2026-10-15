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

const TRADE_TYPES = ['buy', 'sell', 'reduce', 'clear', 'dividend', 'bonus', 'transfer'] as const;

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

export default function TradeInput() {
  const [assetCode, setAssetCode] = useState('');
  const [tradeType, setTradeType] = useState<string>('buy');
  const [tradeDate, setTradeDate] = useState<string>(todayStr());
  const [quantity, setQuantity] = useState<string>('');
  const [price, setPrice] = useState<string>('');
  const [fee, setFee] = useState<string>('0');

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
      quantity: Number(quantity),
      price: Number(price),
      fee: Number(fee) || 0,
    };

    try {
      const res = await api.post('/trades', payload);
      if (res.data.success) {
        setResult(res.data.data as TradeResult);
      } else {
        const errMsg = res.data.error ?? '请求失败';
        if (errMsg === 'HOLDING_INSUFFICIENT') {
          setError('持仓不足');
        } else {
          setError(errMsg);
        }
      }
    } catch (err: any) {
      const errMsg = err?.response?.data?.error ?? '网络错误';
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
            <label style={labelStyle}>asset_code</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="text"
              placeholder="如 sh600000"
              value={assetCode}
              onChange={(e) => setAssetCode(e.target.value)}
              required
            />
          </div>

          <div style={formRowStyle}>
            <label style={labelStyle}>trade_type</label>
            <select
              style={{ ...inputStyle, flex: 1 }}
              value={tradeType}
              onChange={(e) => setTradeType(e.target.value)}
            >
              {TRADE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div style={formRowStyle}>
            <label style={labelStyle}>trade_date</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="date"
              value={tradeDate}
              onChange={(e) => setTradeDate(e.target.value)}
              required
            />
          </div>

          <div style={formRowStyle}>
            <label style={labelStyle}>quantity</label>
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
            <label style={labelStyle}>price</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="number"
              step="0.01"
              min={0}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
          </div>

          <div style={formRowStyle}>
            <label style={labelStyle}>fee</label>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="number"
              step="0.01"
              min={0}
              value={fee}
              onChange={(e) => setFee(e.target.value)}
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
              提交成功！trade_id: {result.trade_id} | 最新持仓: qty={result.position.qty}, avgCost=
              {result.position.avgCost}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
