import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { extractErrorMessageOrErrorMessage } from '../api/errors';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
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
    signals?: Array<{
      trade_date: string;
      direction: string;
      label: string;
      strength: number | null;
      plugin_id: string;
    }>;
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

function drawMain(
  canvas: HTMLCanvasElement,
  klines: KlineBar[],
  indicators: Indicators,
  signals: Array<{ trade_date: string; direction: string; label: string; plugin_id?: string }> | undefined,
  width: number,
) {
  const W = width;
  const H = MAIN_HEIGHT;
  const ctx = setupCanvas(canvas, W, H);
  const pad = { top: 20, right: 60, bottom: 30, left: 10 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = chartW / klines.length;

  ctx.fillStyle = COLORS.chartBg;
  ctx.fillRect(0, 0, W, H);

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

  ctx.strokeStyle = COLORS.chartGrid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = pad.top + (chartH / 5) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    const price = max - (range / 5) * i;
    ctx.fillStyle = COLORS.chartText;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(price.toFixed(2), W - pad.right + 4, y + 4);
  }

  const dateStep = Math.max(1, Math.floor(klines.length / 8));
  ctx.fillStyle = COLORS.chartText;
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
    const color = k.close >= k.open ? COLORS.candleUp : COLORS.candleDown;

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
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  };
  drawMA(indicators.ma5, COLORS.ma5);
  drawMA(indicators.ma10, COLORS.ma10);
  drawMA(indicators.ma20, COLORS.ma20);

  const drawLegend = (label: string, value: string, x: number, y: number, color: string) => {
    ctx.fillStyle = COLORS.chartText;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, x, y);
    ctx.fillStyle = color;
    ctx.fillText(value, x + 20, y);
  };
  drawLegend(
    'MA5',
    indicators.ma5[indicators.ma5.length - 1]?.toFixed(2) ?? '--',
    pad.left + 4,
    pad.top - 6,
    COLORS.ma5,
  );
  drawLegend(
    'MA10',
    indicators.ma10[indicators.ma10.length - 1]?.toFixed(2) ?? '--',
    pad.left + 100,
    pad.top - 6,
    COLORS.ma10,
  );
  drawLegend(
    'MA20',
    indicators.ma20[indicators.ma20.length - 1]?.toFixed(2) ?? '--',
    pad.left + 210,
    pad.top - 6,
    COLORS.ma20,
  );

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
      const color =
        sig.direction === 'buy'
          ? COLORS.success
          : sig.direction === 'sell'
            ? COLORS.danger
            : COLORS.textSecondary;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(sig.direction === 'buy' ? '▲' : sig.direction === 'sell' ? '▼' : '●', x, yHigh - 6);
      ctx.font = '9px sans-serif';
      ctx.fillStyle = COLORS.chartLabel;
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

  ctx.fillStyle = COLORS.chartBg;
  ctx.fillRect(0, 0, W, H);

  const { dif, dea, macd } = indicators.macd;
  const all: number[] = [];
  dif.forEach((v) => !isNaN(v) && all.push(v));
  dea.forEach((v) => !isNaN(v) && all.push(v));
  macd.forEach((v) => !isNaN(v) && all.push(v));
  const maxAbs = Math.max(...all.map(Math.abs), 0.0001);
  const zeroY = pad.top + chartH / 2;

  ctx.strokeStyle = COLORS.chartAxis;
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
    ctx.fillStyle = v >= 0 ? COLORS.macdBarPos : COLORS.macdBarNeg;
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
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  };
  drawLine(dif, COLORS.difLine);
  drawLine(dea, COLORS.deaLine);

  ctx.fillStyle = COLORS.chartLabel;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('MACD(12,26,9)', pad.left + 4, pad.top + 4);
  ctx.fillStyle = COLORS.difLine;
  ctx.fillText(`DIF ${dif[dif.length - 1]?.toFixed(4) ?? '--'}`, pad.left + 100, pad.top + 4);
  ctx.fillStyle = COLORS.deaLine;
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

  ctx.fillStyle = COLORS.chartBg;
  ctx.fillRect(0, 0, W, H);

  [30, 50, 70].forEach((level) => {
    const y = pad.top + ((100 - level) / 100) * chartH;
    ctx.strokeStyle = level === 50 ? COLORS.chartAxisStrong : COLORS.chartAxis;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.textTertiary;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(level), W - pad.right + 4, y + 4);
  });

  const rsi = indicators.rsi;
  ctx.strokeStyle = COLORS.rsiLine;
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

  ctx.fillStyle = COLORS.chartLabel;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('RSI(14)', pad.left + 4, pad.top + 4);
  const lastRSI = rsi[rsi.length - 1];
  ctx.fillStyle = COLORS.rsiLine;
  ctx.fillText(`${isNaN(lastRSI) ? '--' : lastRSI.toFixed(2)}`, pad.left + 70, pad.top + 4);
}

export default function Kline() {
  const [symbol, setSymbol] = useState('sh600000');
  const [fq, setFq] = useState<'qfq' | 'raw'>('qfq');
  const [days, setDays] = useState(120);
  const [klines, setKlines] = useState<KlineBar[]>([]);
  const [indicators, setIndicators] = useState<Indicators | null>(null);
  const [signals, setSignals] = useState<
    Array<{
      trade_date: string;
      direction: string;
      label: string;
      strength: number | null;
      plugin_id: string;
    }>
  >([]);
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
    } catch (e) {
      setErr('请求失败: ' + extractErrorMessageOrErrorMessage(e));
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

  useEffect(() => {
    redraw();
  }, [redraw]);

  // 窗口尺寸变化（旋转屏幕 / 拖窗口）重画
  useEffect(() => {
    const onResize = () => redraw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [redraw]);

  return (
    <div style={{ fontFamily: TYPO.fontFamily }}>
      <h2 style={{ margin: '0 0 16px 0' }}>K 线图（日线）</h2>

      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          marginBottom: SPACING.gapRelaxed,
          flexWrap: 'wrap',
        }}
      >
        {/*
          T63：原先 `<label>` 是**包住式**（label 内嵌 input/select）。
          此处统一改为「兄弟」结构 —— `<label htmlFor>` + 控件 `id`，
          便于读屏软件与自动化测试按「标签文本」定位控件。
          ⚠️ 每一对「标签 + 控件」仍包在一个 `<div>` 里 → 与改前一样各自是一个 flex item，
          故 **flex gap 造成的间距变化为零**，视觉与改前完全一致。
        */}
        <div>
          <label htmlFor="kline-input-symbol" style={{ fontSize: TYPO.bodySize }}>
            代码：
          </label>
          <input
            id="kline-input-symbol"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="如 sh600000"
            style={{
              padding: '4px 8px',
              marginLeft: SPACING.gapTight,
              width: 120,
              border: `1px solid ${COLORS.borderMedium}`,
              borderRadius: RADIUS.sm,
            }}
          />
        </div>
        <div>
          <label htmlFor="kline-select-fq" style={{ fontSize: TYPO.bodySize }}>
            复权方式：
          </label>
          <select
            id="kline-select-fq"
            value={fq}
            onChange={(e) => setFq(e.target.value as 'qfq' | 'raw')}
            style={{
              marginLeft: SPACING.gapTight,
              padding: '4px 8px',
              border: `1px solid ${COLORS.borderMedium}`,
              borderRadius: RADIUS.sm,
            }}
          >
            <option value="qfq">前复权</option>
            <option value="raw">不复权</option>
          </select>
        </div>
        <div>
          <label htmlFor="kline-select-period" style={{ fontSize: TYPO.bodySize }}>
            周期：
          </label>
          <select
            id="kline-select-period"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{
              marginLeft: SPACING.gapTight,
              padding: '4px 8px',
              border: `1px solid ${COLORS.borderMedium}`,
              borderRadius: RADIUS.sm,
            }}
          >
            <option value={60}>近60日</option>
            <option value={120}>近120日</option>
            <option value={250}>近1年</option>
            <option value={500}>近500日</option>
          </select>
        </div>
        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: '6px 20px',
            background: loading ? COLORS.textMuted : COLORS.brand,
            color: COLORS.cardBg,
            border: 'none',
            borderRadius: RADIUS.sm,
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? '加载中...' : '加载'}
        </button>
        {err && <span style={{ color: COLORS.danger, fontSize: TYPO.smallSize }}>{err}</span>}
        {klines.length > 0 && (
          <span style={{ color: COLORS.textTertiary, fontSize: TYPO.smallSize }}>
            {klines.length} 根K线 · {klines[0].date} ~ {klines[klines.length - 1].date}
          </span>
        )}
      </div>

      {/* G10b 移动端副图 Tab 切换（PRD §5.8#6 手机端布局） */}
      {isMobile && (
        <div style={{ display: 'flex', gap: SPACING.gapBase, marginBottom: SPACING.gapBase }}>
          {(
            [
              ['macd', 'MACD'],
              ['rsi', 'RSI'],
            ] as ['macd' | 'rsi', string][]
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSubTab(k)}
              style={{
                flex: 1,
                padding: '6px 0',
                fontSize: TYPO.smallSize,
                border: `1px solid ${subTab === k ? COLORS.brand : COLORS.borderMedium}`,
                borderRadius: RADIUS.sm,
                background: subTab === k ? COLORS.brand : COLORS.cardBg,
                color: subTab === k ? COLORS.cardBg : COLORS.textSecondary,
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div ref={wrapRef} style={{ width: '100%', overflow: 'hidden' }}>
        <canvas
          ref={mainRef}
          style={{ border: `1px solid ${COLORS.chartBorder}`, display: 'block', maxWidth: '100%' }}
        />
        <div style={{ height: 6 }} />
        {(!isMobile || subTab === 'macd') && (
          <canvas
            ref={macdRef}
            style={{ border: `1px solid ${COLORS.chartBorder}`, display: 'block', maxWidth: '100%' }}
          />
        )}
        <div style={{ height: 6 }} />
        {(!isMobile || subTab === 'rsi') && (
          <canvas
            ref={rsiRef}
            style={{ border: `1px solid ${COLORS.chartBorder}`, display: 'block', maxWidth: '100%' }}
          />
        )}
        <div style={{ height: MOBILE_BREAKPOINT > 0 && isMobile ? 80 : 0 }} />
      </div>

      {klines.length === 0 && !loading && !err && (
        <div style={{ color: COLORS.textFaint, padding: 40, textAlign: 'center' }}>
          输入股票代码后点击「加载」获取K线数据
        </div>
      )}
    </div>
  );
}
