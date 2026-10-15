import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api/client';

interface KlineBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

interface Indicators {
  macd: { dif: number[]; dea: number[]; macd: number[] };
  rsi: number[];
  ma5: number[];
  ma10: number[];
  ma20: number[];
}

interface KlineApiResponse {
  success: boolean;
  data?: {
    symbol: string;
    fq: string;
    klines: KlineBar[];
    indicators: Indicators | null;
  };
  error?: string;
  message?: string;
}

/**
 * F5 K 线图页面（SDD 验收项）
 *
 * 纯 Canvas 绘制蜡烛图 + MA 均线 + MACD 副图 + RSI 副图
 * - 不引第三方 chart 库（SDD 验收明确 Canvas 绘制）
 * - 指标统一由后端 /api/kline 返回（AGENTS.md 约束：前端禁止 import @invest/core）
 * - A 股配色：红涨绿跌
 */

const CANVAS_WIDTH = 1000;
const MAIN_HEIGHT = 400;
const MACD_HEIGHT = 160;
const RSI_HEIGHT = 160;

// 放大 canvas 适配高清屏
function setupCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return ctx;
}

// ========== 主图：蜡烛图 + MA 均线 ==========
function drawMain(
  canvas: HTMLCanvasElement,
  klines: KlineBar[],
  indicators: Indicators,
) {
  const ctx = setupCanvas(canvas, CANVAS_WIDTH, MAIN_HEIGHT);
  const W = CANVAS_WIDTH;
  const H = MAIN_HEIGHT;
  const pad = { top: 20, right: 60, bottom: 30, left: 10 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = chartW / klines.length;

  // 背景
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

  // 找范围（MA 也纳入范围，避免均线被裁）
  const allValues: number[] = [];
  klines.forEach((k) => {
    allValues.push(k.high, k.low);
  });
  [indicators.ma5, indicators.ma10, indicators.ma20].forEach((ma) => {
    ma.forEach((v) => {
      if (!isNaN(v)) allValues.push(v);
    });
  });
  const max = Math.max(...allValues);
  const min = Math.min(...allValues);
  const range = max - min || 1;

  // 网格线
  ctx.strokeStyle = '#2d2d44';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = pad.top + (chartH / 5) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    // 右侧价格刻度
    const price = max - (range / 5) * i;
    ctx.fillStyle = '#888';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(price.toFixed(2), W - pad.right + 4, y + 4);
  }

  // 日期刻度（每 ~10 根显示一个）
  const dateStep = Math.max(1, Math.floor(klines.length / 8));
  ctx.fillStyle = '#888';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  klines.forEach((k, i) => {
    if (i % dateStep !== 0) return;
    const x = pad.left + i * barW + barW / 2;
    ctx.fillText(k.date.slice(5), x, H - pad.bottom + 16);
  });

  // 蜡烛
  klines.forEach((k, i) => {
    const x = pad.left + i * barW + barW / 2;
    const yHigh = pad.top + ((max - k.high) / range) * chartH;
    const yLow = pad.top + ((max - k.low) / range) * chartH;
    const yOpen = pad.top + ((max - k.open) / range) * chartH;
    const yClose = pad.top + ((max - k.close) / range) * chartH;
    const color = k.close >= k.open ? '#ef4444' : '#22c55e'; // A 股红涨绿跌

    // 影线
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();

    // 实体
    const top = Math.min(yOpen, yClose);
    const bot = Math.max(yOpen, yClose);
    const bodyH = Math.max(1, bot - top);
    ctx.fillStyle = color;
    ctx.fillRect(x - barW * 0.35, top, barW * 0.7, bodyH);
  });

  // MA 均线
  const drawMA = (ma: number[], color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    ma.forEach((v, i) => {
      if (isNaN(v)) return;
      const x = pad.left + i * barW + barW / 2;
      const y = pad.top + ((max - v) / range) * chartH;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  };
  drawMA(indicators.ma5, '#fbbf24');   // MA5 黄
  drawMA(indicators.ma10, '#60a5fa');  // MA10 蓝
  drawMA(indicators.ma20, '#c084fc');  // MA20 紫

  // 图例
  ctx.fillStyle = '#888';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`MA5`, pad.left + 4, pad.top - 6);
  ctx.fillStyle = '#fbbf24';
  ctx.fillText(`  ${indicators.ma5[indicators.ma5.length - 1]?.toFixed(2) ?? '--'}`, pad.left + 24, pad.top - 6);
  ctx.fillStyle = '#888';
  ctx.fillText('MA10', pad.left + 100, pad.top - 6);
  ctx.fillStyle = '#60a5fa';
  ctx.fillText(`  ${indicators.ma10[indicators.ma10.length - 1]?.toFixed(2) ?? '--'}`, pad.left + 130, pad.top - 6);
  ctx.fillStyle = '#888';
  ctx.fillText('MA20', pad.left + 210, pad.top - 6);
  ctx.fillStyle = '#c084fc';
  ctx.fillText(`  ${indicators.ma20[indicators.ma20.length - 1]?.toFixed(2) ?? '--'}`, pad.left + 240, pad.top - 6);
}

// ========== MACD 副图 ==========
function drawMACD(
  canvas: HTMLCanvasElement,
  klines: KlineBar[],
  indicators: Indicators,
) {
  const ctx = setupCanvas(canvas, CANVAS_WIDTH, MACD_HEIGHT);
  const W = CANVAS_WIDTH;
  const H = MACD_HEIGHT;
  const pad = { top: 10, right: 60, bottom: 12, left: 10 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = chartW / klines.length;

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

  const { dif, dea, macd } = indicators.macd;
  // MACD bar 是 2*(DIF-DEA)，可能正值也可能负值
  const all: number[] = [];
  dif.forEach((v) => !isNaN(v) && all.push(v));
  dea.forEach((v) => !isNaN(v) && all.push(v));
  macd.forEach((v) => !isNaN(v) && all.push(v));
  const maxAbs = Math.max(...all.map(Math.abs), 0.0001);

  const zeroY = pad.top + chartH / 2;

  // 零轴
  ctx.strokeStyle = '#444';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.left, zeroY);
  ctx.lineTo(W - pad.right, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // MACD bar
  macd.forEach((v, i) => {
    if (isNaN(v)) return;
    const x = pad.left + i * barW + barW / 2;
    const h = (v / maxAbs) * (chartH / 2 - 4);
    ctx.fillStyle = v >= 0 ? '#ef4444' : '#22c55e';
    ctx.fillRect(x - barW * 0.4, zeroY - h, barW * 0.8, Math.abs(h) || 1);
  });

  // DIF 线
  ctx.strokeStyle = '#60a5fa';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  let started = false;
  dif.forEach((v, i) => {
    if (isNaN(v)) return;
    const x = pad.left + i * barW + barW / 2;
    const y = zeroY - (v / maxAbs) * (chartH / 2 - 4);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  // DEA 线
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  started = false;
  dea.forEach((v, i) => {
    if (isNaN(v)) return;
    const x = pad.left + i * barW + barW / 2;
    const y = zeroY - (v / maxAbs) * (chartH / 2 - 4);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  // 图例
  ctx.fillStyle = '#aaa';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('MACD(12,26,9)', pad.left + 4, pad.top + 4);
  ctx.fillStyle = '#60a5fa';
  ctx.fillText(`DIF ${dif[dif.length - 1]?.toFixed(4) ?? '--'}`, pad.left + 100, pad.top + 4);
  ctx.fillStyle = '#f59e0b';
  ctx.fillText(`DEA ${dea[dea.length - 1]?.toFixed(4) ?? '--'}`, pad.left + 220, pad.top + 4);
}

// ========== RSI 副图 ==========
function drawRSI(
  canvas: HTMLCanvasElement,
  klines: KlineBar[],
  indicators: Indicators,
) {
  const ctx = setupCanvas(canvas, CANVAS_WIDTH, RSI_HEIGHT);
  const W = CANVAS_WIDTH;
  const H = RSI_HEIGHT;
  const pad = { top: 10, right: 60, bottom: 12, left: 10 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = chartW / klines.length;

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

  // 超买超卖线
  [30, 50, 70].forEach((level) => {
    const y = pad.top + ((100 - level) / 100) * chartH;
    ctx.strokeStyle = level === 50 ? '#555' : '#444';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(level), W - pad.right + 4, y + 4);
  });

  // RSI 线
  const rsi = indicators.rsi;
  ctx.strokeStyle = '#a78bfa';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  rsi.forEach((v, i) => {
    if (isNaN(v)) return;
    const x = pad.left + i * barW + barW / 2;
    const y = pad.top + ((100 - v) / 100) * chartH;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  ctx.lineWidth = 1;

  // 图例
  ctx.fillStyle = '#aaa';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('RSI(14)', pad.left + 4, pad.top + 4);
  const lastRSI = rsi[rsi.length - 1];
  ctx.fillStyle = '#a78bfa';
  ctx.fillText(`${isNaN(lastRSI) ? '--' : lastRSI.toFixed(2)}`, pad.left + 70, pad.top + 4);
}

// ========== React 组件 ==========
export default function Kline() {
  const [symbol, setSymbol] = useState('sh600000');
  const [fq, setFq] = useState<'qfq' | 'raw'>('qfq');
  const [days, setDays] = useState(120);
  const [klines, setKlines] = useState<KlineBar[]>([]);
  const [indicators, setIndicators] = useState<Indicators | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mainRef = useRef<HTMLCanvasElement>(null);
  const macdRef = useRef<HTMLCanvasElement>(null);
  const rsiRef = useRef<HTMLCanvasElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api.get<KlineApiResponse>(`/kline/${symbol}`, {
        params: { days, fq },
      });
      const body = res.data;
      if (body.success && body.data) {
        setKlines(body.data.klines);
        setIndicators(body.data.indicators);
      } else {
        setErr(body.message ?? body.error ?? '加载失败');
        setKlines([]);
        setIndicators(null);
      }
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? String(e);
      setErr('请求失败: ' + msg);
      setKlines([]);
      setIndicators(null);
    } finally {
      setLoading(false);
    }
  }, [symbol, days, fq]);

  useEffect(() => {
    if (klines.length > 0 && indicators && mainRef.current && macdRef.current && rsiRef.current) {
      drawMain(mainRef.current, klines, indicators);
      drawMACD(macdRef.current, klines, indicators);
      drawRSI(rsiRef.current, klines, indicators);
    }
  }, [klines, indicators]);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ margin: '0 0 16px 0' }}>K 线图（日线）</h2>

      {/* 控制栏 */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 14 }}>
          代码：
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="sh600000"
            style={{ padding: '4px 8px', marginLeft: 4, width: 120, border: '1px solid #d1d5db', borderRadius: 4 }}
          />
        </label>
        <label style={{ fontSize: 14 }}>
          复权：
          <select
            value={fq}
            onChange={(e) => setFq(e.target.value as 'qfq' | 'raw')}
            style={{ marginLeft: 4, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}
          >
            <option value="qfq">前复权</option>
            <option value="raw">不复权</option>
          </select>
        </label>
        <label style={{ fontSize: 14 }}>
          周期：
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{ marginLeft: 4, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}
          >
            <option value={60}>60 日</option>
            <option value={120}>120 日</option>
            <option value={250}>250 日</option>
            <option value={500}>500 日</option>
          </select>
        </label>
        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: '6px 20px',
            background: loading ? '#9ca3af' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? '加载中...' : '加载'}
        </button>
        {err && <span style={{ color: '#dc2626', fontSize: 13 }}>{err}</span>}
        {klines.length > 0 && (
          <span style={{ color: '#666', fontSize: 13 }}>
            {klines.length} 根 K 线 · {klines[0].date} ~ {klines[klines.length - 1].date}
          </span>
        )}
      </div>

      {/* 画布区域 */}
      <div style={{ display: 'inline-block' }}>
        <canvas
          ref={mainRef}
          style={{ border: '1px solid #333', display: 'block' }}
        />
        <div style={{ height: 6 }} />
        <canvas
          ref={macdRef}
          style={{ border: '1px solid #333', display: 'block' }}
        />
        <div style={{ height: 6 }} />
        <canvas
          ref={rsiRef}
          style={{ border: '1px solid #333', display: 'block' }}
        />
      </div>

      {klines.length === 0 && !loading && !err && (
        <div style={{ color: '#888', padding: 40, textAlign: 'center' }}>
          输入股票代码后点击「加载」获取 K 线数据
        </div>
      )}
    </div>
  );
}
