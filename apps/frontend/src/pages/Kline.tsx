import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useIsMobile, MOBILE_BREAKPOINT } from './_shared';

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
    signals?: Array<{ trade_date: string; direction: string; label: string; strength: number | null; plugin_id: string }>;
  };
  error?: string;
  message?: string;
}

/** F5 K 线图页面（SDD 验收项）*/

/** 桌面端画布基准宽度（实际渲染宽度跟随容器，G10b） */
const CANVAS_WIDTH = 1000;
const MOBILE_CANVAS_WIDTH = 360;
const MAIN_HEIGHT = 400;
const MACD_HEIGHT = 160;
const RSI_HEIGHT = 160;

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

function drawMain(canvas: HTMLCanvasElement, klines: KlineBar[], indicators: Indicators, signals: Array<{ trade_date: string; direction: string; label: string; plugin_id?: string }> | undefined, width: number) {
  const W = width;
  const H = MAIN_HEIGHT;
  const ctx = setupCanvas(canvas, W, H);
  const pad = { top: 20, right: 60, bottom: 30, left: 10 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = chartW / klines.length;

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

  const allValues: number[] = [];
  klines.forEach((k) => { allValues.push(k.high, k.low); });
  [indicators.ma5, indicators.ma10, indicators.ma20].forEach((ma) => {
    ma.forEach((v) => { if (!isNaN(v)) allValues.push(v); });
  });
  const max = Math.max(...allValues);
  const min = Math.min(...allValues);
  const range = max - min || 1;

  ctx.strokeStyle = '#2d2d44';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = pad.top + (chartH / 5) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    const price = max - (range / 5) * i;
    ctx.fillStyle = '#888';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(price.toFixed(2), W - pad.right + 4, y + 4);
  }

  const dateStep = Math.max(1, Math.floor(klines.length / 8));
  ctx.fillStyle = '#888';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  klines.forEach((k, i) => {
    if (i % dateStep !== 0) return;
    const x = pad.left + i * barW + barW / 2;
    ctx.fillText(k.date.slice(5), x, H - pad.bottom + 16);
  });

  klines.forEach((k, i) => {
    const x = pad.left + i * barW + barW / 2;
    const yHigh = pad.top + ((max - k.high) / range) * chartH;
    const yLow = pad.top + ((max - k.low) / range) * chartH;
    const yOpen = pad.top + ((max - k.open) / range) * chartH;
    const yClose = pad.top + ((max - k.close) / range) * chartH;
    const color = k.close >= k.open ? '#ef4444' : '#22c55e';

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();

    const top = Math.min(yOpen, yClose);
    const bot = Math.max(yOpen, yClose);
    const bodyH = Math.max(1, bot - top);
    ctx.fillStyle = color;
    ctx.fillRect(x - barW * 0.35, top, barW * 0.7, bodyH);
  });

  const drawMA = (ma: number[], color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    ma.forEach((v, i) => {
      if (isNaN(v)) return;
      const x = pad.left + i * barW + barW / 2;
      const y = pad.top + ((max - v) / range) * chartH;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else { ctx.lineTo(x, y); }
    });
    ctx.stroke();
  };
  drawMA(indicators.ma5, '#fbbf24');
  drawMA(indicators.ma10, '#60a5fa');
  drawMA(indicators.ma20, '#c084fc');

  const drawLegend = (label: string, value: string, x: number, y: number, color: string) => {
    ctx.fillStyle = '#888';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, x, y);
    ctx.fillStyle = color;
    ctx.fillText(value, x + 20, y);
  };
  drawLegend('MA5', indicators.ma5[indicators.ma5.length - 1]?.toFixed(2) ?? '--', pad.left + 4, pad.top - 6, '#fbbf24');
  drawLegend('MA10', indicators.ma10[indicators.ma10.length - 1]?.toFixed(2) ?? '--', pad.left + 100, pad.top - 6, '#60a5fa');
  drawLegend('MA20', indicators.ma20[indicators.ma20.length - 1]?.toFixed(2) ?? '--', pad.left + 210, pad.top - 6, '#c084fc');

  // 绘制策略信号标记（买入绿▲ / 卖出红▼）
  if (signals && signals.length > 0) {
    const dateIndex = new Map<string, number>();
    klines.forEach((k, i) => dateIndex.set(k.date, i));
    ctx.font = '14px sans-serif';
    for (const sig of signals) {
      const idx = dateIndex.get(sig.trade_date);
      if (idx === undefined) continue;
      const x = pad.left + idx * barW + barW / 2;
      const yHigh = pad.top + ((max - klines[idx].high) / range) * chartH;
      const color = sig.direction === 'buy' ? '#16a34a' : sig.direction === 'sell' ? '#dc2626' : '#374151';
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(sig.direction === 'buy' ? '▲' : sig.direction === 'sell' ? '▼' : '●', x, yHigh - 6);
      ctx.font = '9px sans-serif';
      ctx.fillStyle = '#aaa';
      ctx.fillText(sig.plugin_id ?? '', x, yHigh - 18);
      ctx.font = '14px sans-serif';
    }
  }
}

function drawMACD(canvas: HTMLCanvasElement, _klines: KlineBar[], indicators: Indicators, width: number) {
  const W = width;
  const H = MACD_HEIGHT;
  const ctx = setupCanvas(canvas, W, H);
  const pad = { top: 10, right: 60, bottom: 12, left: 10 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = chartW / _klines.length;

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

  const { dif, dea, macd } = indicators.macd;
  const all: number[] = [];
  dif.forEach((v) => !isNaN(v) && all.push(v));
  dea.forEach((v) => !isNaN(v) && all.push(v));
  macd.forEach((v) => !isNaN(v) && all.push(v));
  const maxAbs = Math.max(...all.map(Math.abs), 0.0001);
  const zeroY = pad.top + chartH / 2;

  ctx.strokeStyle = '#444';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.left, zeroY);
  ctx.lineTo(W - pad.right, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  macd.forEach((v, i) => {
    if (isNaN(v)) return;
    const x = pad.left + i * barW + barW / 2;
    const h = (v / maxAbs) * (chartH / 2 - 4);
    ctx.fillStyle = v >= 0 ? '#ef4444' : '#22c55e';
    ctx.fillRect(x - barW * 0.4, zeroY - h, barW * 0.8, Math.abs(h) || 1);
  });

  const drawLine = (vals: number[], color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    vals.forEach((v, i) => {
      if (isNaN(v)) return;
      const x = pad.left + i * barW + barW / 2;
      const y = zeroY - (v / maxAbs) * (chartH / 2 - 4);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else { ctx.lineTo(x, y); }
    });
    ctx.stroke();
  };
  drawLine(dif, '#60a5fa');
  drawLine(dea, '#f59e0b');

  ctx.fillStyle = '#aaa';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('MACD(12,26,9)', pad.left + 4, pad.top + 4);
  ctx.fillStyle = '#60a5fa';
  ctx.fillText(`DIF ${dif[dif.length - 1]?.toFixed(4) ?? '--'}`, pad.left + 100, pad.top + 4);
  ctx.fillStyle = '#f59e0b';
  ctx.fillText(`DEA ${dea[dea.length - 1]?.toFixed(4) ?? '--'}`, pad.left + 220, pad.top + 4);
}

function drawRSI(canvas: HTMLCanvasElement, _klines: KlineBar[], indicators: Indicators, width: number) {
  const W = width;
  const H = RSI_HEIGHT;
  const ctx = setupCanvas(canvas, W, H);
  const pad = { top: 10, right: 60, bottom: 12, left: 10 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = chartW / _klines.length;

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

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

  const rsi = indicators.rsi;
  ctx.strokeStyle = '#a78bfa';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  rsi.forEach((v, i) => {
    if (isNaN(v)) return;
    const x = pad.left + i * barW + barW / 2;
    const y = pad.top + ((100 - v) / 100) * chartH;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else { ctx.lineTo(x, y); }
  });
  ctx.stroke();
  ctx.lineWidth = 1;

  ctx.fillStyle = '#aaa';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('RSI(14)', pad.left + 4, pad.top + 4);
  const lastRSI = rsi[rsi.length - 1];
  ctx.fillStyle = '#a78bfa';
  ctx.fillText(`${isNaN(lastRSI) ? '--' : lastRSI.toFixed(2)}`, pad.left + 70, pad.top + 4);
}

export default function Kline() {
  const [symbol, setSymbol] = useState('sh600000');
  const [fq, setFq] = useState<'qfq' | 'raw'>('qfq');
  const [days, setDays] = useState(120);
  const [klines, setKlines] = useState<KlineBar[]>([]);
  const [indicators, setIndicators] = useState<Indicators | null>(null);
  const [signals, setSignals] = useState<Array<{ trade_date: string; direction: string; label: string; strength: number | null; plugin_id: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /** G10b 移动端副图 Tab 切换（桌面端两个副图并排，不用这个） */
  const [subTab, setSubTab] = useState<'macd' | 'rsi'>('macd');
  const isMobile = useIsMobile();

  const mainRef = useRef<HTMLCanvasElement>(null);
  const macdRef = useRef<HTMLCanvasElement>(null);
  const rsiRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  /** 画布宽度跟随容器，避免移动端横向溢出（G10b） */
  const canvasWidth = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return isMobile ? MOBILE_CANVAS_WIDTH : CANVAS_WIDTH;
    const w = el.clientWidth;
    if (w <= 0) return isMobile ? MOBILE_CANVAS_WIDTH : CANVAS_WIDTH;
    return Math.floor(Math.min(w, CANVAS_WIDTH));
  }, [isMobile]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api.get<KlineApiResponse>(`/kline/${symbol}`, { params: { days, fq } });
      const body = res.data;
      if (body.success && body.data) {
        setKlines(body.data.klines);
        setIndicators(body.data.indicators);
        setSignals(body.data.signals ?? []);
      } else {
        setErr(body.message ?? '加载失败');
        setKlines([]);
        setIndicators(null);
      }
    } catch (e: any) {
      setErr('请求失败: ' + (e?.response?.data?.message ?? e?.message ?? String(e)));
      setKlines([]);
      setIndicators(null);
    } finally {
      setLoading(false);
    }
  }, [symbol, days, fq]);

  const redraw = useCallback(() => {
    if (klines.length === 0 || !indicators) return;
    const w = canvasWidth();
    if (mainRef.current) drawMain(mainRef.current, klines, indicators, signals, w);
    // 移动端只画当前 Tab 的副图，桌面端两个都画
    if (macdRef.current && (!isMobile || subTab === 'macd')) drawMACD(macdRef.current, klines, indicators, w);
    if (rsiRef.current && (!isMobile || subTab === 'rsi')) drawRSI(rsiRef.current, klines, indicators, w);
  }, [klines, indicators, signals, canvasWidth, isMobile, subTab]);

  useEffect(() => { redraw(); }, [redraw]);

  // 窗口尺寸变化（旋转屏幕 / 拖窗口）重画
  useEffect(() => {
    const onResize = () => redraw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [redraw]);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ margin: '0 0 16px 0' }}>K 线图（日线）</h2>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 14 }}>
          代码：
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="如 sh600000"
            style={{ padding: '4px 8px', marginLeft: 4, width: 120, border: '1px solid #d1d5db', borderRadius: 4 }}
          />
        </label>
        <label style={{ fontSize: 14 }}>
          复权方式：
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
            <option value={60}>近60日</option>
            <option value={120}>近120日</option>
            <option value={250}>近1年</option>
            <option value={500}>近500日</option>
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
            {klines.length} 根K线 · {klines[0].date} ~ {klines[klines.length - 1].date}
          </span>
        )}
      </div>

      {/* G10b 移动端副图 Tab 切换（PRD §5.8#6 手机端布局） */}
      {isMobile && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          {([['macd', 'MACD'], ['rsi', 'RSI']] as ['macd' | 'rsi', string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSubTab(k)}
              style={{
                flex: 1,
                padding: '6px 0',
                fontSize: 13,
                border: `1px solid ${subTab === k ? '#2563eb' : '#d1d5db'}`,
                borderRadius: 4,
                background: subTab === k ? '#2563eb' : '#fff',
                color: subTab === k ? '#fff' : '#374151',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div ref={wrapRef} style={{ width: '100%', overflow: 'hidden' }}>
        <canvas ref={mainRef} style={{ border: '1px solid #333', display: 'block', maxWidth: '100%' }} />
        <div style={{ height: 6 }} />
        {(!isMobile || subTab === 'macd') && (
          <canvas ref={macdRef} style={{ border: '1px solid #333', display: 'block', maxWidth: '100%' }} />
        )}
        <div style={{ height: 6 }} />
        {(!isMobile || subTab === 'rsi') && (
          <canvas ref={rsiRef} style={{ border: '1px solid #333', display: 'block', maxWidth: '100%' }} />
        )}
        <div style={{ height: MOBILE_BREAKPOINT > 0 && isMobile ? 80 : 0 }} />
      </div>

      {klines.length === 0 && !loading && !err && (
        <div style={{ color: '#888', padding: 40, textAlign: 'center' }}>
          输入股票代码后点击「加载」获取K线数据
        </div>
      )}
    </div>
  );
}
