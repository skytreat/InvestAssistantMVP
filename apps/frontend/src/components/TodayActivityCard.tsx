import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { isFailedEnvelope } from '../api/envelope';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import EmptyState from './EmptyState';
import Spinner from './Spinner';
import { type Position } from './positionDomain';

/**
 * 今日动态概览卡（T67 · 卡 5 · ux_v2 建议 D · **G3.3 的唯一覆盖**）
 *
 * 依据 ux_v2 行 474-495 建议 D：「插在资产汇总卡和持仓卡之间，一条**窄条时间线**
 * （高度约 100px），信息密度高但不占用太多垂直空间」，含 **5 个数据块**：
 *
 * | 块 | 内容 | 数据源 |
 * |---|---|---|
 * | ① | 总资产变化（对比昨收） | `GET /api/holding` 的 `prevClose` / `currentPrice` |
 * | ② | 今日信号 ▲▼· 统计 | `GET /api/signal/stats`（降级时用 `GET /api/signal` 列表计数）|
 * | ③ | 今日成交前 1-2 条 | `GET /api/trade?start_date&end_date&limit=2` |
 * | ④ | 今日除权导入 | `GET /api/ex-dividend/imports?date=` |
 * | ⑤ | 重点关注（持仓 + 候选有信号） | `GET /api/holding` 的 `signal` + `GET /api/candidate` + `GET /api/signal` |
 *
 * ## 🔴 G3.3：5 个块**各自**非空或有降级文案
 *
 * 门槛原文：「今日动态概览卡 5 个数据块各自非空或有降级文案」。
 * ⇒ 每个块都有**独立**的降级分支（接口失败 / 无数据各一条文案），
 *    **绝不允许出现空白块**（空白的块 = 用户无法分辨「没数据」与「坏了」）。
 *    所有降级文案集中在文件头的常量区，便于逐字核对。
 *
 * ## 为什么组件**自己**拉数据（而不是接 props）
 *
 * 批次 5 的接线要求是「只插一行」，本组件自取数据 ⇒ 接线 = `<TodayActivityCard />`。
 * 代价是组件内多一次「先拿持仓、再按行情日拉其余端点」的**瀑布**（见下），
 * 但换来的是：块 ⑤ 的持仓部分**复用同一次** `/api/holding` 响应（**0 额外请求**）。
 *
 * ## 日期锚点（裁决 D-6）
 *
 * 「今天」= `/api/holding` 的 `summary.priceDate`（**最新行情交易日**），
 * `priceDate` 为 `null` 时回退到**本地自然日**。
 * ⇒ 其余 4 个端点都在**持仓请求结算之后**才发（瀑布），因为它们都要用这个日期。
 * 卡头会显示这个日期，让用户知道「这是哪一天」。
 *
 * ⚠️ **不写任何调度时刻**：ux_v2 问题 3-1-4 的「收盘后 17:02 自动运行信号生成」
 *    归 **T79 ③**（裁决 D-14），本卡只做「接口失败」类降级文案。
 */

/* ------------------------------------------------------------------ *
 * 降级文案（逐字，勿改 —— G3.3 的判据全在这张表里）
 * ------------------------------------------------------------------ */

/** ① 总资产变化：全部持仓都没有昨收（或现价）*/
const DEGRADE_NO_PREV_CLOSE = '无昨收数据，暂无法对比今日变化';
/** ① 总资产变化：一个持仓都没有 */
const DEGRADE_NO_POSITION = '暂无持仓，暂无法对比今日变化';
/** ① 总资产变化：持仓接口失败 */
const DEGRADE_HOLDING_ERROR = '持仓数据暂不可用，暂无法对比今日变化';
/** ② 今日信号：统计接口与列表接口都不可用 */
const DEGRADE_SIGNAL_ERROR = '今日信号暂不可用';
/** ② 今日信号：今天确实没有信号（**不是**接口失败）*/
const EMPTY_SIGNAL = '今日暂无策略信号';
/** ③ 今日成交：接口失败 */
const DEGRADE_TRADE_ERROR = '今日成交暂不可用';
/** ③ 今日成交：今天没有成交记录 */
const EMPTY_TRADE = '今日暂无成交';
/** ④ 今日除权导入：接口失败 */
const DEGRADE_DIVIDEND_ERROR = '除权导入记录暂不可用';
/** ④ 今日除权导入：今天没有导入记录 */
const EMPTY_DIVIDEND = '今日无除权导入记录';
/** ⑤ 重点关注：持仓部分不可用 */
const DEGRADE_HOLDING_SIGNAL_ERROR = '持仓信号暂不可用';
/** ⑤ 重点关注：候选部分不可用 */
const DEGRADE_CANDIDATE_ERROR = '候选信号暂不可用';
/** ⑤ 重点关注：两边都没有信号 */
const EMPTY_FOCUS = '今日暂无重点关注标的';

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 后端统一 envelope 的最小形状（只声明本组件读到的字段）*/
interface ApiEnvelopeBase {
  /** 🔴 T89b：成功判定唯一口径 `code === 0`（后端已删 `success` 字段） */
  code?: number | string;
  message?: string;
}

/** 通用成功体 */
interface ApiEnvelope<T> extends ApiEnvelopeBase {
  data?: T;
}

/** `GET /api/holding` 的响应（`summary` 是**顶层**字段，T89a 口径）*/
interface HoldingEnvelope extends ApiEnvelopeBase {
  data?: Position[];
  summary?: {
    priceDate?: string | null;
  } | null;
}

/** `GET /api/signal` 的响应（`pagination` 是**顶层**字段）*/
interface SignalListEnvelope extends ApiEnvelopeBase {
  data?: SignalRow[];
  pagination?: { total?: number } | null;
}

/** 今日信号统计（`GET /api/signal/stats`）*/
interface TodaySignalStats {
  total: number;
  up: number;
  down: number;
  hold: number;
}

/** 一条策略信号（`GET /api/signal` 的行）*/
interface SignalRow {
  asset_code: string;
  plugin_id: string;
  direction: string;
  label: string;
  trade_date: string;
}

/** 一条成交记录（`GET /api/trade` 的行，只取本卡要展示的字段）*/
interface TradeRow {
  asset_code: string;
  trade_type: string;
  quantity: number;
  price?: number;
  /** 1 = 系统自动导入（分红/送股）—— 与块 ④ 的内容重合，故**标注**而非过滤（见文件尾「口径判断」）*/
  is_auto_import?: number;
}

/** `GET /api/ex-dividend/imports` 的响应 */
interface DividendImports {
  from?: string;
  to?: string;
  items?: DividendImportItem[];
  summary?: { total?: number; dividendCount?: number; bonusCount?: number } | null;
}

/** 一条除权导入记录 */
interface DividendImportItem {
  asset_code: string;
  trade_type: string;
  trade_date?: string;
  quantity?: number;
  price?: number;
}

/** 候选池条目（`GET /api/candidate` 的行，只取 `asset_code`）*/
interface CandidateRow {
  asset_code: string;
}

/** 单个数据源的加载状态 */
type LoadStatus = 'loading' | 'ready' | 'error';

/* ------------------------------------------------------------------ *
 * 常量与纯函数
 * ------------------------------------------------------------------ */

/** 方向符号（与 `SignalBadge` 同口径：buy=▲ / sell=▼ / hold=·）*/
const DIRECTION_SYMBOL: Record<string, string> = { buy: '▲', sell: '▼', hold: '·' };

/** 方向中文（`hold` 在这里是「持有」，与 `SignalBadge` 同口径）*/
const DIRECTION_TEXT: Record<string, string> = { buy: '买入', sell: '卖出', hold: '持有' };

/** 交易类型中文（与 `Review.tsx` 的映射同口径；组件层不复用页面层常量）*/
const TRADE_TYPE_LABEL: Record<string, string> = {
  buy: '买入',
  add: '加仓',
  reduce: '减仓',
  clear: '清仓',
  dividend: '分红',
  bonus: '送股',
  transfer: '转增',
};

/** 除权导入类型中文（`dividend` / `bonus`）*/
const DIVIDEND_TYPE_LABEL: Record<string, string> = { dividend: '分红', bonus: '送股' };

/** 中文星期 */
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

/** 单个块最多列出的条目数（窄条不能无限长）*/
const MAX_ITEMS_PER_GROUP = 3;

/**
 * 本地自然日（YYYY-MM-DD）
 *
 * ⚠️ **不能用 `toISOString()`** —— 那是 UTC，东八区凌晨 8 点前会退到前一天。
 */
function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `YYYY-MM-DD` → 中文星期（如 `2026-10-20` → `周二`）*/
function weekdayOf(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return `周${WEEKDAY_CN[d.getDay()]}`;
}

/**
 * 带符号的金额（`+50.00` / `-12.50`；`-0` 归到正号，避免出现 `-0.00`）
 *
 * ⚠️ **非有限数一律渲染 `--`** —— A3 明确要求「不出现 `NaN`」。
 *    正常口径下 `assetChange.delta` 恒为有限数（见下方 `isComparable` 的过滤），
 *    这里再加一道兜底，避免上游数据异常时把 `NaN` 直接甩到用户脸上。
 */
function signed(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '--';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
}

/** 带符号的百分比（入参是 0~1 的小数）*/
function signedPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '--';
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
}

/** 方向 → 颜色（涨绿跌灰，与 `SignalBadge` 同口径；绿走正文色档 `textSuccess`）*/
function directionColor(direction: string): string {
  if (direction === 'buy') return COLORS.textSuccess;
  if (direction === 'sell') return COLORS.danger;
  return COLORS.textSecondary;
}

/**
 * 取后端 envelope
 *
 * ⚠️ 后端**显式给了非 0 的 `code`** 时**抛错** —— 与 `Dashboard.tsx` 的判定口径一致
 *    （同一套 envelope，判定必须一致，否则「业务失败」会被当成「空数据」）。
 *    ⚠️ 用 `isFailedEnvelope`（而非 `isOkEnvelope`）—— 前者只在「后端明确给了非 0 的 code」
 *    时才判失败，缺 `code` 的响应体仍按原样放行（与 T89b 之前的 `success === false` 逐字等价）。
 */
async function fetchEnvelope<E extends ApiEnvelopeBase>(
  url: string,
  params?: Record<string, unknown>,
): Promise<E> {
  const res = params ? await api.get<E>(url, { params }) : await api.get<E>(url);
  const body = res.data;
  if (isFailedEnvelope(body)) throw new Error(body?.message ?? '请求失败');
  return body;
}

/**
 * 取出数组型数据（**防御**：响应体形状与契约不符时退化成空数组）
 *
 * ⚠️ 不做这层防御的后果：某个 mock / 上游返回了对象而非数组时，
 *    `.filter` / `.map` 会直接抛 TypeError，把整个卡炸掉 ——
 *    而 G3.3 要求「任何单点异常都不许拖垮整卡」。
 */
function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 是不是合法的今日信号统计对象
 *
 * ⚠️ 同上：统计端点返回的**必须是对象**；若拿到数组 / 缺字段（契约漂移或 mock 写错），
 *    一律当作「没有统计」→ 降级到列表计数，**绝不能**把 `undefined` 渲染到页面上。
 */
function isTodaySignalStats(value: unknown): value is TodaySignalStats {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.total === 'number' &&
    typeof o.up === 'number' &&
    typeof o.down === 'number' &&
    typeof o.hold === 'number'
  );
}

/** 可参与「对比昨收」计算的持仓（昨收 / 现价 / 数量都必须是**有限数**）*/
type ComparablePosition = Position & { prevClose: number; currentPrice: number };

/**
 * 该持仓能否参与块 ① 的「对比昨收」计算
 *
 * ⚠️ 用 `Number.isFinite` 而不是「非 null」：字段**缺失**（`undefined`）与
 *    **脏数据**（`NaN` / `Infinity`）都会让乘法产出 `NaN` —— A3 明令「不许出现 NaN」。
 */
function isComparable(p: Position): p is ComparablePosition {
  return (
    typeof p.prevClose === 'number' &&
    Number.isFinite(p.prevClose) &&
    typeof p.currentPrice === 'number' &&
    Number.isFinite(p.currentPrice) &&
    typeof p.totalQuantity === 'number' &&
    Number.isFinite(p.totalQuantity)
  );
}

/* ------------------------------------------------------------------ *
 * 组件
 * ------------------------------------------------------------------ */

export interface TodayActivityCardProps {
  /**
   * 日期锚点覆盖（可选）
   *
   * ⚠️ 默认口径 = `/api/holding` 的 `summary.priceDate`（最新行情交易日），
   *    `priceDate` 为 `null` 时回退到**本地自然日**（裁决 D-6）。
   *    批次 5 接线时**不需要**传本 prop（`<TodayActivityCard />` 即可）。
   */
  tradeDate?: string | null;
}

/** 一个数据块的容器（`<section>` + 可访问名 = 块标题）*/
function Block({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={title}
      data-testid={id}
      style={{
        minWidth: 0,
        overflowWrap: 'anywhere',
        display: 'flex',
        flexDirection: 'column',
        gap: SPACING.gapTight,
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: TYPO.smallSize,
          fontWeight: TYPO.cardTitleWeight,
          color: COLORS.textSecondary,
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 块内的降级提示（错误态用醒目色，与空态区分开）*/
function DegradeText({ text }: { text: string }) {
  return (
    <div style={{ fontSize: TYPO.smallSize, color: COLORS.danger, overflowWrap: 'anywhere' }}>{text}</div>
  );
}

/** 块内的补充说明（中性色小字）*/
function NoteText({ text }: { text: string }) {
  return (
    <div style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted, overflowWrap: 'anywhere' }}>
      {text}
    </div>
  );
}

/** 「重点关注」里的一条（持仓 / 候选）*/
function FocusItem({
  source,
  code,
  direction,
  label,
}: {
  source: string;
  code: string;
  direction: string;
  label?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'baseline',
        flexWrap: 'wrap',
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted }}>{source}</span>
      <code style={{ fontFamily: TYPO.monoFamily, fontSize: TYPO.smallSize }}>{code}</code>
      <span style={{ fontSize: TYPO.smallSize, color: directionColor(direction) }}>
        {DIRECTION_SYMBOL[direction] ?? '·'} {DIRECTION_TEXT[direction] ?? '持有'}
      </span>
      {label ? <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>{label}</span> : null}
    </div>
  );
}

export default function TodayActivityCard({ tradeDate: tradeDateProp }: TodayActivityCardProps) {
  /** 日期锚点（null = 还没定下来）*/
  const [anchorDate, setAnchorDate] = useState<string | null>(tradeDateProp ?? null);
  /** 持仓接口返回的行情交易日（`summary.priceDate`）*/
  const [priceDate, setPriceDate] = useState<string | null>(null);

  const [holdingStatus, setHoldingStatus] = useState<LoadStatus>('loading');
  const [positions, setPositions] = useState<Position[]>([]);

  const [statsStatus, setStatsStatus] = useState<LoadStatus>('loading');
  const [stats, setStats] = useState<TodaySignalStats | null>(null);

  const [signalListStatus, setSignalListStatus] = useState<LoadStatus>('loading');
  const [signalRows, setSignalRows] = useState<SignalRow[]>([]);
  const [signalTotal, setSignalTotal] = useState<number | null>(null);

  const [tradeStatus, setTradeStatus] = useState<LoadStatus>('loading');
  const [trades, setTrades] = useState<TradeRow[]>([]);

  const [dividendStatus, setDividendStatus] = useState<LoadStatus>('loading');
  const [dividends, setDividends] = useState<DividendImports | null>(null);

  const [candidateStatus, setCandidateStatus] = useState<LoadStatus>('loading');
  const [candidateCodes, setCandidateCodes] = useState<string[]>([]);

  /* ── ① 持仓（同时定下日期锚点）───────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await fetchEnvelope<HoldingEnvelope>('/holding');
        if (cancelled) return;
        setPositions(asArray(body?.data));
        setPriceDate(body?.summary?.priceDate ?? null);
        setHoldingStatus('ready');
      } catch {
        if (cancelled) return;
        setHoldingStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ── 日期锚点：prop > summary.priceDate > 本地自然日（裁决 D-6）── */
  useEffect(() => {
    if (holdingStatus === 'loading') return;
    setAnchorDate((cur) => cur ?? tradeDateProp ?? priceDate ?? localToday());
  }, [holdingStatus, priceDate, tradeDateProp]);

  /* ── prop 变更时跟随（批次 5 接线不需要传本 prop）─────────── */
  useEffect(() => {
    if (tradeDateProp) setAnchorDate(tradeDateProp);
  }, [tradeDateProp]);

  /* ── ②~⑤ 其余 4 个端点：等日期锚点定下来再发（带日期参数）── */
  useEffect(() => {
    if (!anchorDate) return;
    const date = anchorDate;
    let cancelled = false;

    /* 块 ②：今日信号统计（服务端精确口径，1 次 GROUP BY）*/
    (async () => {
      try {
        const body = await fetchEnvelope<ApiEnvelope<TodaySignalStats>>('/signal/stats', {
          trade_date: date,
        });
        if (cancelled) return;
        // ⚠️ 形状不对（数组 / 缺字段）→ 当作「没有统计」→ 降级到列表计数
        setStats(isTodaySignalStats(body?.data) ? body.data : null);
        setStatsStatus('ready');
      } catch {
        if (cancelled) return;
        setStatsStatus('error');
      }
    })();

    /* 块 ② 降级路径 + 块 ⑤ 候选交集：今日信号列表 */
    (async () => {
      try {
        const body = await fetchEnvelope<SignalListEnvelope>('/signal', {
          trade_date: date,
          page_size: 200,
        });
        if (cancelled) return;
        setSignalRows(asArray(body?.data));
        setSignalTotal(typeof body?.pagination?.total === 'number' ? body.pagination.total : null);
        setSignalListStatus('ready');
      } catch {
        if (cancelled) return;
        setSignalListStatus('error');
      }
    })();

    /* 块 ③：今日成交（前 2 条）*/
    (async () => {
      try {
        const body = await fetchEnvelope<ApiEnvelope<TradeRow[]>>('/trade', {
          start_date: date,
          end_date: date,
          limit: 2,
        });
        if (cancelled) return;
        setTrades(asArray(body?.data));
        setTradeStatus('ready');
      } catch {
        if (cancelled) return;
        setTradeStatus('error');
      }
    })();

    /* 块 ④：今日除权导入 */
    (async () => {
      try {
        const body = await fetchEnvelope<ApiEnvelope<DividendImports>>('/ex-dividend/imports', {
          date,
        });
        if (cancelled) return;
        setDividends(body?.data ?? null);
        setDividendStatus('ready');
      } catch {
        if (cancelled) return;
        setDividendStatus('error');
      }
    })();

    /* 块 ⑤：候选池代码集合 */
    (async () => {
      try {
        const body = await fetchEnvelope<ApiEnvelope<CandidateRow[]>>('/candidate');
        if (cancelled) return;
        setCandidateCodes(asArray(body?.data).map((c) => c.asset_code));
        setCandidateStatus('ready');
      } catch {
        if (cancelled) return;
        setCandidateStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [anchorDate]);

  /* ── 派生数据 ──────────────────────────────────────────────── */

  /**
   * 块 ① 的口径：Σ(现价×数量) − Σ(昨收×数量)，基数 = Σ(昨收×数量)
   *
   * ⚠️ **缺昨收（或缺现价）的持仓一律排除**，并在块内说明排除了几只 ——
   *    把缺行情的标的按 0 计入会让「今日变化」凭空偏大/偏小。
   *
   * ⚠️ **排除条件用「有限数」而不是「非 null」**（A3：不许出现 `NaN`）：
   *    上游若给出 `undefined` / `NaN` / `Infinity`（字段缺失或脏数据），
   *    「非 null」判断会让 `undefined × 数量` 变成 `NaN` 并一路渲染到页面。
   */
  const assetChange = (() => {
    if (holdingStatus !== 'ready') return null;
    const comparable = positions.filter(isComparable);
    let base = 0;
    let current = 0;
    for (const p of comparable) {
      base += p.prevClose * p.totalQuantity;
      current += p.currentPrice * p.totalQuantity;
    }
    return {
      count: comparable.length,
      excluded: positions.length - comparable.length,
      delta: current - base,
      pct: base > 0 ? (current - base) / base : null,
    };
  })();

  /**
   * 块 ② 的计数：**优先服务端精确统计**（`/api/signal/stats`，1 次 GROUP BY），
   * 失败时降级为**列表计数**（`/api/signal` 前 200 条，可能被截断）。
   *
   * ⚠️ `source` 用于区分「数字是完整的」与「数字只覆盖前 200 条」——
   *    截断提示的**措辞**必须与数字的实际来源一致（说反了就是面向用户的错误文案）。
   */
  const signalCounts = (() => {
    if (statsStatus === 'ready' && stats) {
      return {
        source: 'stats' as const,
        up: stats.up,
        down: stats.down,
        hold: stats.hold,
        total: stats.total,
        /** 列表被截断的条数（统计口径下**数字本身没被截断**，但候选交集用了列表）*/
        listTruncated: signalTotal !== null && signalTotal > signalRows.length ? signalRows.length : 0,
      };
    }
    if (signalListStatus === 'ready') {
      let up = 0;
      let down = 0;
      let hold = 0;
      for (const row of signalRows) {
        if (row.direction === 'buy') up += 1;
        else if (row.direction === 'sell') down += 1;
        else hold += 1;
      }
      const total = signalTotal ?? signalRows.length;
      return {
        source: 'list' as const,
        up,
        down,
        hold,
        total,
        listTruncated: signalTotal !== null && signalTotal > signalRows.length ? signalRows.length : 0,
      };
    }
    return null;
  })();

  /**
   * 块 ⑤：持仓有信号（来自 `/api/holding` 的 `signal` 字段，**0 额外请求**）
   *
   * ⚠️ 用 `Boolean(p.signal)` 而不是 `p.signal !== null` ——
   *    上游**字段缺失**（`undefined`，如未升级的后端）时，`!== null` 判定为 true，
   *    会把**每一只**持仓都误报成「有信号」（且方向显示成「· 持有」）。
   */
  const focusHoldings = holdingStatus === 'ready' ? positions.filter((p) => Boolean(p.signal)) : [];

  /** 块 ⑤：候选有信号（信号列表 ∩ 候选池代码集合）*/
  const focusCandidates = (() => {
    if (candidateStatus !== 'ready' || signalListStatus !== 'ready') return [];
    const codes = new Set(candidateCodes);
    return signalRows.filter((row) => codes.has(row.asset_code));
  })();

  /* ── 渲染 ──────────────────────────────────────────────────── */

  const holdingFailed = holdingStatus === 'error';
  /** 候选部分要**两个**端点都成功才算可用（候选池 ∩ 信号列表）*/
  const candidateFailed = candidateStatus === 'error' || signalListStatus === 'error';
  const candidatePending =
    candidateStatus === 'loading' || (candidateStatus === 'ready' && signalListStatus === 'loading');

  const dividendItems = asArray(dividends?.items);
  const dividendTotal = dividends?.summary?.total ?? 0;

  return (
    <section
      aria-label="今日动态"
      data-testid="today-activity-card"
      style={{
        border: `1px solid ${COLORS.borderLight}`,
        borderRadius: RADIUS.md,
        background: COLORS.cardBg,
        padding: SPACING.cardPadding,
        marginBottom: SPACING.cardMarginBottom,
        display: 'flex',
        flexDirection: 'column',
        gap: SPACING.gapBase,
        minWidth: 0,
      }}
    >
      {/* ── 卡头：日期 + 中文星期 ── */}
      <h2
        style={{
          margin: 0,
          fontSize: TYPO.cardTitleSize,
          fontWeight: TYPO.cardTitleWeight,
          color: COLORS.textPrimary,
          display: 'flex',
          alignItems: 'baseline',
          gap: SPACING.gapBase,
          flexWrap: 'wrap',
        }}
      >
        今日动态
        {anchorDate ? (
          <span
            data-testid="today-activity-date"
            style={{ fontSize: TYPO.smallSize, fontWeight: 400, color: COLORS.textSecondary }}
          >
            （{anchorDate} {weekdayOf(anchorDate)}）
          </span>
        ) : null}
      </h2>

      {/* ── 5 个数据块（窄条时间线：一行多列，窄屏折行）── */}
      <div
        style={{
          display: 'grid',
          // `min(190px, 100%)` 把轨道宽度封顶在容器宽度 → 375px 窄屏不会横向溢出（G3.5）
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px, 100%), 1fr))',
          gap: SPACING.gapRelaxed,
          alignItems: 'start',
        }}
      >
        {/* ① 总资产变化（对比昨收） */}
        <Block id="today-block-asset-change" title="总资产变化">
          {holdingStatus === 'loading' && <Spinner inline label="加载中..." />}
          {holdingFailed && <DegradeText text={DEGRADE_HOLDING_ERROR} />}
          {holdingStatus === 'ready' && assetChange && assetChange.count === 0 && (
            <>
              <EmptyState title={positions.length === 0 ? DEGRADE_NO_POSITION : DEGRADE_NO_PREV_CLOSE} />
              {assetChange.excluded > 0 && (
                <NoteText text={`（已排除 ${assetChange.excluded} 只无昨收或现价数据的持仓）`} />
              )}
            </>
          )}
          {holdingStatus === 'ready' && assetChange && assetChange.count > 0 && (
            <>
              <div
                style={{ display: 'flex', alignItems: 'baseline', gap: SPACING.gapBase, flexWrap: 'wrap' }}
              >
                <span
                  style={{
                    fontSize: TYPO.bodySize,
                    fontWeight: TYPO.cardTitleWeight,
                    color: assetChange.delta >= 0 ? COLORS.textSuccess : COLORS.danger,
                  }}
                >
                  {signed(assetChange.delta)}
                </span>
                <span
                  style={{
                    fontSize: TYPO.smallSize,
                    color: assetChange.delta >= 0 ? COLORS.textSuccess : COLORS.danger,
                  }}
                >
                  （{signedPct(assetChange.pct)}）
                </span>
              </div>
              <NoteText text={`对比昨收${priceDate ? `（${priceDate}）` : ''}`} />
              {assetChange.excluded > 0 && (
                <NoteText text={`（已排除 ${assetChange.excluded} 只无昨收或现价数据的持仓）`} />
              )}
            </>
          )}
        </Block>

        {/* ② 今日信号 ▲▼· 统计 */}
        <Block id="today-block-signals" title="今日信号">
          {statsStatus === 'loading' ? (
            <Spinner inline label="加载中..." />
          ) : signalCounts !== null ? (
            <>
              <div style={{ display: 'flex', gap: SPACING.gapBase, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: TYPO.bodySize,
                    color: COLORS.textSuccess,
                    fontWeight: TYPO.cardTitleWeight,
                  }}
                >
                  ▲{signalCounts.up}
                </span>
                <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>买入</span>
                <span
                  style={{ fontSize: TYPO.bodySize, color: COLORS.danger, fontWeight: TYPO.cardTitleWeight }}
                >
                  ▼{signalCounts.down}
                </span>
                <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>卖出</span>
                <span
                  style={{
                    fontSize: TYPO.bodySize,
                    color: COLORS.textSecondary,
                    fontWeight: TYPO.cardTitleWeight,
                  }}
                >
                  ·{signalCounts.hold}
                </span>
                <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>持有</span>
              </div>
              <NoteText text={`共 ${signalCounts.total} 条`} />
              {/* 截断提示：**措辞必须与数字来源一致**（说反了就是面向用户的错误文案） */}
              {signalCounts.source === 'list' && signalCounts.listTruncated > 0 && (
                <NoteText text={`（仅显示前 ${signalCounts.listTruncated} 条）`} />
              )}
              {signalCounts.source === 'stats' && signalCounts.listTruncated > 0 && (
                <NoteText
                  text={`（共 ${signalCounts.total} 条已全部计入；候选交集仅显示前 ${signalCounts.listTruncated} 条）`}
                />
              )}
              {signalCounts.total === 0 && <NoteText text={EMPTY_SIGNAL} />}
            </>
          ) : signalListStatus === 'loading' ? (
            <Spinner inline label="加载中..." />
          ) : (
            <DegradeText text={DEGRADE_SIGNAL_ERROR} />
          )}
        </Block>

        {/* ③ 今日成交（前 1-2 条） */}
        <Block id="today-block-trades" title="今日成交">
          {tradeStatus === 'loading' && <Spinner inline label="加载中..." />}
          {tradeStatus === 'error' && <DegradeText text={DEGRADE_TRADE_ERROR} />}
          {tradeStatus === 'ready' && trades.length === 0 && <EmptyState title={EMPTY_TRADE} />}
          {tradeStatus === 'ready' && trades.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {trades.map((t, i) => (
                <div
                  key={`${t.asset_code}-${t.trade_type}-${i}`}
                  style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}
                >
                  <code style={{ fontFamily: TYPO.monoFamily, fontSize: TYPO.smallSize }}>
                    {t.asset_code}
                  </code>
                  <span style={{ fontSize: TYPO.smallSize, color: COLORS.textPrimary }}>
                    {TRADE_TYPE_LABEL[t.trade_type] ?? t.trade_type}
                  </span>
                  <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>{t.quantity}</span>
                  {t.is_auto_import === 1 ? (
                    <span style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted }}>自动导入</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Block>

        {/* ④ 今日除权导入 */}
        <Block id="today-block-dividends" title="今日除权导入">
          {dividendStatus === 'loading' && <Spinner inline label="加载中..." />}
          {dividendStatus === 'error' && <DegradeText text={DEGRADE_DIVIDEND_ERROR} />}
          {/* A7 的判据是 **`items` 是否为空**（不是 `summary.total`）——
              明细为空 → 空态文案；明细非空 → 一定渲染 `summary.total` 的数字 */}
          {dividendStatus === 'ready' && dividendItems.length === 0 && <EmptyState title={EMPTY_DIVIDEND} />}
          {dividendStatus === 'ready' && dividendItems.length > 0 && (
            <>
              <div style={{ fontSize: TYPO.bodySize, color: COLORS.textPrimary }}>共 {dividendTotal} 条</div>
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'baseline',
                  flexWrap: 'wrap',
                  fontSize: TYPO.smallSize,
                }}
              >
                <code style={{ fontFamily: TYPO.monoFamily }}>{dividendItems[0].asset_code}</code>
                <span style={{ color: COLORS.textPrimary }}>
                  {DIVIDEND_TYPE_LABEL[dividendItems[0].trade_type] ?? dividendItems[0].trade_type}
                </span>
              </div>
            </>
          )}
        </Block>

        {/* ⑤ 重点关注（持仓 + 候选有信号） */}
        <Block id="today-block-focus" title="重点关注">
          {holdingStatus === 'loading' && <Spinner inline label="加载中..." />}
          {holdingFailed && <DegradeText text={DEGRADE_HOLDING_SIGNAL_ERROR} />}
          {holdingStatus === 'ready' && focusHoldings.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {focusHoldings.slice(0, MAX_ITEMS_PER_GROUP).map((p) => (
                <FocusItem
                  key={`holding-${p.asset_code}`}
                  source="持仓"
                  code={p.asset_code}
                  direction={p.signal?.direction ?? 'hold'}
                  label={p.signal?.label}
                />
              ))}
              {focusHoldings.length > MAX_ITEMS_PER_GROUP && (
                <NoteText
                  text={`（持仓共 ${focusHoldings.length} 项有信号，仅显示前 ${MAX_ITEMS_PER_GROUP} 项）`}
                />
              )}
            </div>
          )}

          {candidatePending && <Spinner inline label="加载中..." />}
          {candidateFailed && <DegradeText text={DEGRADE_CANDIDATE_ERROR} />}
          {!candidateFailed && focusCandidates.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {focusCandidates.slice(0, MAX_ITEMS_PER_GROUP).map((row, i) => (
                <FocusItem
                  key={`candidate-${row.asset_code}-${row.plugin_id}-${i}`}
                  source="候选"
                  code={row.asset_code}
                  direction={row.direction}
                  label={row.label}
                />
              ))}
              {focusCandidates.length > MAX_ITEMS_PER_GROUP && (
                <NoteText
                  text={`（候选共 ${focusCandidates.length} 项有信号，仅显示前 ${MAX_ITEMS_PER_GROUP} 项）`}
                />
              )}
            </div>
          )}
          {/* 候选交集来自分页列表 —— 列表被截断时必须说明，否则用户会以为「候选没信号」 */}
          {!candidateFailed &&
            signalListStatus === 'ready' &&
            signalTotal !== null &&
            signalTotal > signalRows.length && <NoteText text={`（仅显示前 ${signalRows.length} 条）`} />}

          {holdingStatus !== 'loading' &&
            !candidatePending &&
            !holdingFailed &&
            !candidateFailed &&
            focusHoldings.length === 0 &&
            focusCandidates.length === 0 && <EmptyState title={EMPTY_FOCUS} />}
        </Block>
      </div>
    </section>
  );
}
