import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { extractErrorMessageOrErrorMessage } from '../api/errors';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import { titleStyle } from '../theme/styles';
import Spinner from '../components/Spinner';
import KlineParamPanel from '../components/KlineParamPanel';
import { MOBILE_TABBAR_HEIGHT, useIsMobile } from './_shared';
import {
  buildChartBars,
  parseMetricsJson,
  periodUnit,
  type ChartBar,
  type KlinePeriod,
  type RawBar,
  type SignalMarker,
} from '../indicators/chartBars';
import {
  DEFAULT_INDICATOR_PARAMS,
  cloneIndicatorParams,
  type IndicatorParams,
} from '../indicators/chartParams';
import type { SubIndicatorKind } from '../components/KlineChart';

/**
 * K 线页（T70 · 改接 `klinecharts@10.1.0` + 前端算指标；T71 · 指标参数实时生效）
 *
 * ## 本页负责的事
 *
 * 1. **取数**：`GET /api/quote/:symbol/kline?days=&fq=`（🔴 真实路由，见下方「两个必修 bug」）
 * 2. **算指标**（前端）：`buildChartBars` 把 MA/MACD/RSI/KDJ 算好并灌进每根 K 线
 * 3. **画图**：`KlineChart` 组件（`React.lazy` 按需加载，klinecharts 独立 chunk）
 *
 * ## 🔴 T71：指标参数实时生效（零网络请求）
 *
 * ```
 * 参数面板改参数 ──▶ setParams ──▶ useMemo 重算 bars（复用已加载的原始日线）
 *                                    └─▶ KlineChart 收到新 bars
 *                                         └─▶ overrideIndicator 重算指标 + 重绘（**不取数**）
 * ```
 *
 * ⇒ **取数只由「标的 / 复权 / 天数 / 周期」触发**；改参数**不发任何请求**
 *    （PRD §5.2「零网络请求」+ §6.3「重绘 ≤ 300ms」）。
 *
 * ## 🔴 两个必修 bug（T70 前 Wave 3 agent 实测发现）
 *
 * | # | 现象 | 根因 | 修法 |
 * |---|---|---|---|
 * | 1 | **K 线页必然「加载失败」** | 旧代码请求 `/kline/${symbol}` —— **该路由不存在**（真实路由是 `GET /api/quote/:symbol/kline`） | 本文件改为 `/quote/${symbol}/kline`（`api` 实例的 `baseURL` 是 `/api`）|
 * | 2 | 从「标的详情 Modal」的 `/kline?symbol=xxx` 跳过来**仍显示默认 sh600000** | 旧代码**不读 `?symbol=`** | 本文件用 `useSearchParams()` 消费 `?symbol=` |
 *
 * ## 🔴 T73：信号指标明细**随 K 线一起下发**（省一次网络往返）
 *
 * ```
 * GET /api/quote/:symbol/kline
 *   └─ data.signals[] 每项带 metrics_json（原始 JSON 字符串 | null）
 *        └─▶ parseMetricsJson ──▶ SignalMarker.metrics ──▶ hover 面板的「指标明细」行
 * ```
 *
 * ⚠️ **T70 时代**因为后端不下发 `metrics_json`，本页额外请求了一次
 *    `GET /api/signal?asset_code=&page_size=200` 来补明细 ⇒ **两次往返**。
 *    后端补齐下发后，本次补取**已删除**（本页**只发一次** K 线请求）。
 *
 * ## 复权口径（F-K1）
 *
 * 后端白名单是**四值** `qfq | bfq | hfq | raw`（`routes/kline.ts`），
 * 本页按 PRD §5.2「用户可切换不复权/前复权/后复权」暴露 **3 个选项**：
 *
 * | 选项 | 参数 | 后端视图（stock / etf）|
 * |---|---|---|
 * | 前复权 | `qfq` | `v_stock_qfq` / `v_etf_qfq` |
 * | 后复权 | `hfq` | `v_stock_hfq` / `v_etf_hfq` |
 * | 不复权 | `bfq` | `v_stock_bfq` / `v_etf_bfq` |
 *
 * ⚠️ 第四个白名单值 `raw`（`raw_kline_daily`）与 `bfq` 等价，**本页不用它** ——
 *    `bfq` 走 `v_*` 视图族，ETF/指数才能正确路由到 `v_etf_*`（F-K10 回归点）。
 */

/** 🔴 图表组件按需加载 —— klinecharts 单独成 chunk，首屏不下载（SDD §2.12.5）*/
const KlineChart = lazy(() => import('../components/KlineChart'));

/** 默认标的 */
const DEFAULT_SYMBOL = 'sh600000';

/** 复权口径选项（后端白名单 qfq | bfq | hfq | raw 的其中三个）*/
const FQ_OPTIONS: ReadonlyArray<{ value: 'qfq' | 'hfq' | 'bfq'; label: string }> = [
  { value: 'qfq', label: '前复权' },
  { value: 'hfq', label: '后复权' },
  { value: 'bfq', label: '不复权' },
];

/** 时间范围（回溯天数）*/
const DAY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 60, label: '近60日' },
  { value: 120, label: '近120日' },
  { value: 250, label: '近1年' },
  { value: 500, label: '近500日' },
];

/** K 线周期（日 / 周 / 月）*/
const PERIOD_OPTIONS: ReadonlyArray<{ value: KlinePeriod; label: string }> = [
  { value: 'day', label: '日K' },
  { value: 'week', label: '周K' },
  { value: 'month', label: '月K' },
];

/** 副图类型（MACD / RSI / KDJ）*/
const SUB_OPTIONS: ReadonlyArray<{ value: SubIndicatorKind; label: string }> = [
  { value: 'macd', label: 'MACD' },
  { value: 'rsi', label: 'RSI' },
  { value: 'kdj', label: 'KDJ' },
];

/** 后端 K 线接口的响应体（envelope 内层）*/
interface KlineApiResponse {
  code?: number | string;
  success?: boolean;
  message?: string;
  data?: {
    symbol: string;
    fq: string;
    symbolClass?: string;
    klines?: RawBar[];
    signals?: Array<{
      trade_date: string;
      direction: string;
      label: string;
      strength: number | null;
      plugin_id: string;
      metrics_json?: string | null;
    }>;
  };
}

/**
 * 判断 envelope 是否成功
 *
 * ⚠️ `success` 是 T89a 的**过渡字段**（T89b 会删）。故优先看 `code === 0`，
 *    `code` 不存在时回落到 `success === true` —— 两种形态都能判对。
 */
function isOkEnvelope(body: { code?: number | string; success?: boolean }): boolean {
  if (typeof body.code === 'number') return body.code === 0;
  if (typeof body.code === 'string') return body.code === '0';
  return body.success === true;
}

/** 周/月 K 需要更多的日线才能聚合成足够的柱子 */
function fetchDaysFor(days: number, period: KlinePeriod): number {
  const factor = period === 'day' ? 1 : period === 'week' ? 5 : 21;
  return Math.min(500, Math.max(10, days * factor));
}

export default function Kline() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSymbol = searchParams.get('symbol') ?? '';

  const [symbolInput, setSymbolInput] = useState(urlSymbol || DEFAULT_SYMBOL);
  const [symbol, setSymbol] = useState(urlSymbol || DEFAULT_SYMBOL);
  const [fq, setFq] = useState<'qfq' | 'hfq' | 'bfq'>('qfq');
  const [days, setDays] = useState(120);
  const [period, setPeriod] = useState<KlinePeriod>('day');
  const [showMa, setShowMa] = useState(true);
  const [subIndicator, setSubIndicator] = useState<SubIndicatorKind>('macd');
  /** 🔴 T71：指标参数（改参数 → 即时重绘，**零网络请求**）*/
  const [params, setParams] = useState<IndicatorParams>(() => cloneIndicatorParams(DEFAULT_INDICATOR_PARAMS));

  /** 移动端：图表更矮 + 底部给固定 TabBar 留出空间（旧实现遗留的老坑）*/
  const isMobile = useIsMobile();

  /** 后端下发的**原始日线**（指标由前端算 —— T71 改参数时基于它重算，不再取数）*/
  const [rawBars, setRawBars] = useState<RawBar[]>([]);
  /** 信号标记 */
  const [signals, setSignals] = useState<SignalMarker[]>([]);
  /** 取数次数（每次成功加载 +1）—— 参与数据指纹，保证新数据一定重新灌进图表 */
  const [loadSeq, setLoadSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /**
   * URL 里的 `?symbol=` 变化（从标的详情 Modal 跳进来）→ 同步到输入框与当前标的
   *
   * ⚠️ 这就是「必修 bug ②」的修复点：旧实现完全不读 query，
   *    导致 `/kline?symbol=sh600519` 仍然显示默认的 sh600000。
   */
  useEffect(() => {
    if (!urlSymbol) return;
    setSymbolInput(urlSymbol);
    setSymbol(urlSymbol);
  }, [urlSymbol]);

  /** 取数：K 线（**含信号指标明细** `metrics_json` —— T73 起随 K 线一并下发）*/
  const load = useCallback(
    async (target: string, fqParam: 'qfq' | 'hfq' | 'bfq', dayCount: number) => {
      if (!target) return;
      setLoading(true);
      setErr(null);
      try {
        const res = await api.get<KlineApiResponse>(`/quote/${target}/kline`, {
          params: { days: fetchDaysFor(dayCount, period), fq: fqParam },
        });
        const body = res.data;
        if (!isOkEnvelope(body) || !body.data) {
          setErr(body.message ?? '加载失败');
          setRawBars([]);
          setSignals([]);
          return;
        }

        const raw = Array.isArray(body.data.klines) ? body.data.klines : [];
        const klineSignals = Array.isArray(body.data.signals) ? body.data.signals : [];

        // 🔴 T73：信号指标明细（`metrics_json`）**由 K 线接口一并下发**
        //    ⇒ 不再单独请求 `/api/signal` 补取（省一次网络往返）。
        //
        //    ⚠️ 后端下发的是**原始 JSON 字符串**（`string | null`）；
        //       无指标时是**库的 NULL**（不是字符串 `'null'`）⇒ 交给 `parseMetricsJson` 统一处理
        //       （字符串 / 对象 / 脏数据都吃，解析失败一律降级为 `null`，不炸整页）。
        const signalMarkers: SignalMarker[] = klineSignals.map((s) => ({
          trade_date: s.trade_date,
          direction: s.direction,
          label: s.label,
          strength: s.strength ?? null,
          plugin_id: s.plugin_id,
          metrics: parseMetricsJson(s.metrics_json),
        }));

        // 🔴 T71：这里只存**原始日线 + 信号**，指标由前端按当前参数算
        //    （`bars` 是 `useMemo` 派生值 ⇒ 改参数不需要重新取数）
        setRawBars(raw);
        setSignals(signalMarkers);
        setLoadSeq((n) => n + 1);
      } catch (e) {
        setErr('请求失败: ' + extractErrorMessageOrErrorMessage(e));
        setRawBars([]);
        setSignals([]);
      } finally {
        setLoading(false);
      }
    },
    [period],
  );

  // 标的 / 复权 / 天数 / 周期变化 → 重新取数并重算指标
  useEffect(() => {
    void load(symbol, fq, days);
  }, [load, symbol, fq, days]);

  /**
   * 🔴 T71：指标 + 周期聚合的**派生值**
   *
   * 参数一变 → 这里重算 → 新的 `bars` 传给图表 → 图表只重算指标、**不取数**。
   */
  const bars = useMemo<ChartBar[]>(
    () => buildChartBars(rawBars, period, signals, params),
    [rawBars, period, signals, params],
  );

  /**
   * 原始数据指纹（T71）
   *
   * ⚠️ **只有它变了才重新取数**（`resetData`）；
   *    指标参数变了但它没变 ⇒ 图表**不碰数据加载器** ⇒ 零网络请求。
   */
  const dataSignature = useMemo(
    () => [symbol, fq, days, period, loadSeq, rawBars.length].join('|'),
    [symbol, fq, days, period, loadSeq, rawBars.length],
  );

  /** 提交输入框里的代码 */
  const applySymbol = useCallback(() => {
    const next = symbolInput.trim().toLowerCase();
    if (!next) return;
    setSymbol(next);
    // 把标的写回 URL —— 便于分享 / 刷新保持
    setSearchParams({ symbol: next }, { replace: true });
  }, [symbolInput, setSearchParams]);

  const rangeText = useMemo(() => {
    if (bars.length === 0) return '';
    return `${bars[0].date} ~ ${bars[bars.length - 1].date}`;
  }, [bars]);

  return (
    <div style={{ fontFamily: TYPO.fontFamily }}>
      {/*
        T76 ⑦（Wave 7 卡 5）：整页标题必须是 **`<h1>`** ——
        此前是 `<h2>`，真浏览器 axe 的 `page-has-heading-one`（moderate）会判本页无 h1。
        样式沿用全站统一的 `titleStyle`（`theme/styles.ts`，24px/700）。
      */}
      <h1 style={titleStyle}>K 线图</h1>

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
          T63：`<label htmlFor>` + 控件 `id` 的「兄弟」结构（便于读屏与自动化按标签定位）。
        */}
        <div>
          <label htmlFor="kline-input-symbol" style={{ fontSize: TYPO.bodySize }}>
            代码：
          </label>
          <input
            id="kline-input-symbol"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applySymbol();
            }}
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
            onChange={(e) => setFq(e.target.value as 'qfq' | 'hfq' | 'bfq')}
            style={{
              marginLeft: SPACING.gapTight,
              padding: '4px 8px',
              border: `1px solid ${COLORS.borderMedium}`,
              borderRadius: RADIUS.sm,
            }}
          >
            {FQ_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="kline-select-period" style={{ fontSize: TYPO.bodySize }}>
            K线周期：
          </label>
          <select
            id="kline-select-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value as KlinePeriod)}
            style={{
              marginLeft: SPACING.gapTight,
              padding: '4px 8px',
              border: `1px solid ${COLORS.borderMedium}`,
              borderRadius: RADIUS.sm,
            }}
          >
            {PERIOD_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="kline-select-days" style={{ fontSize: TYPO.bodySize }}>
            时间范围：
          </label>
          <select
            id="kline-select-days"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{
              marginLeft: SPACING.gapTight,
              padding: '4px 8px',
              border: `1px solid ${COLORS.borderMedium}`,
              borderRadius: RADIUS.sm,
            }}
          >
            {DAY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            id="kline-checkbox-ma"
            type="checkbox"
            checked={showMa}
            onChange={(e) => setShowMa(e.target.checked)}
          />
          <label htmlFor="kline-checkbox-ma" style={{ fontSize: TYPO.bodySize }}>
            {/* ⚠️ 标签里带**当前周期**（周期可编辑 —— T71），默认即 MA(5/10/20/60) */}
            显示 MA({params.ma.periods.join('/')})
          </label>
        </div>
        <button
          onClick={applySymbol}
          disabled={loading}
          aria-busy={loading}
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
        {err && (
          <span data-testid="kline-error" style={{ color: COLORS.danger, fontSize: TYPO.smallSize }}>
            {err}
          </span>
        )}
        {bars.length > 0 && (
          <span style={{ color: COLORS.textTertiary, fontSize: TYPO.smallSize }}>
            {bars.length} 根K线 · {rangeText}
            {rawBars.length !== bars.length ? `（原始日线 ${rawBars.length} 根）` : ''}
          </span>
        )}
      </div>

      {/* 🔴 T71：指标参数面板 —— 改参数即时重绘，**零网络请求** */}
      <KlineParamPanel
        params={params}
        unit={periodUnit(period)}
        barCount={bars.length}
        onChange={setParams}
        onReset={() => setParams(cloneIndicatorParams(DEFAULT_INDICATOR_PARAMS))}
      />

      {/* 副图 Tab（MACD / RSI / KDJ）—— 桌面端与移动端都可切换（F-K5）*/}
      <div
        role="tablist"
        aria-label="副图指标"
        style={{ display: 'flex', gap: SPACING.gapBase, marginBottom: SPACING.gapBase }}
      >
        {SUB_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            role="tab"
            aria-selected={subIndicator === opt.value}
            data-testid={`kline-sub-tab-${opt.value}`}
            onClick={() => setSubIndicator(opt.value)}
            style={{
              padding: '6px 16px',
              fontSize: TYPO.smallSize,
              border: `1px solid ${subIndicator === opt.value ? COLORS.brand : COLORS.borderMedium}`,
              borderRadius: RADIUS.sm,
              background: subIndicator === opt.value ? COLORS.brand : COLORS.cardBg,
              color: subIndicator === opt.value ? COLORS.cardBg : COLORS.textSecondary,
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {bars.length === 0 ? (
        loading ? (
          <Spinner label="加载 K 线..." />
        ) : (
          <div style={{ color: COLORS.textFaint, padding: 40, textAlign: 'center' }}>
            {err ? '暂无 K 线数据' : '输入股票代码后点击「加载」获取K线数据'}
          </div>
        )
      ) : (
        <Suspense fallback={<Spinner label="加载图表..." />}>
          <KlineChart
            symbol={symbol}
            period={period}
            bars={bars}
            dataSignature={dataSignature}
            params={params}
            showMa={showMa}
            subIndicator={subIndicator}
            height={isMobile ? 420 : 560}
            mainHeight={isMobile ? 250 : 380}
            subHeight={isMobile ? 110 : 140}
          />
        </Suspense>
      )}

      {/* 移动端底部 TabBar 是 `position: fixed` → 页面末尾留出它的高度，避免遮住图表 */}
      {isMobile && <div style={{ height: MOBILE_TABBAR_HEIGHT }} />}
    </div>
  );
}
