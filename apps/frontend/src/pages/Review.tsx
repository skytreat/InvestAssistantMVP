import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import { truncatedTextStyle } from '../theme/styles';
import Spinner from '../components/Spinner';
import ScrollableTable from '../components/ScrollableTable';
import TriStateGroup, { type TriState } from '../components/TriStateGroup';
import { ReviewTagLegend, ReviewTagPill, reviewTagOf } from '../components/ReviewTag';
import { TRADE_TYPES, tradeTypeLabel } from '../components/tradeTypes';
import { useDialogFocus } from '../components/useDialogFocus';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  cardTitleStyle,
  tableStyle,
  thStyle,
  thTdStyle,
  inputStyle,
  buttonStyle,
  errorStyle,
} from './_shared';

interface TradeRow {
  id: number;
  asset_code: string;
  trade_type: string;
  trade_date: string;
  quantity: number;
  price: number;
  fee: number;
  trade_reason: string | null;
  is_auto_import: number;
  system_followed: number | null;
  strategy_match: number | null;
  is_stop_loss: number | null;
  review_summary: string | null;
  remark: string | null;
  created_at: string;
}

interface ReviewStats {
  totalTrades: number;
  reviewedCount: number;
  closedCount: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitLossRatio: number | null;
  totalRealizedPnl: number;
}

/** 双口径（Requirements §5.4） */
type Caliber = 'price' | 'actual';

const CALIBER_LABEL: Record<Caliber, string> = {
  price: '价格口径（不含分红送转）',
  actual: '实际口径（含分红现金流）',
};

/** 收益曲线周期（PRD R2 月度/季度/年度） */
type CurvePeriod = 'monthly' | 'quarterly' | 'yearly';

const PERIOD_MONTHS: Record<CurvePeriod, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/**
 * 筛选防抖时长（ux_v2 §3.3-3「筛选即时生效」）
 *
 * 300ms：既能合并「连续改多个下拉」产生的请求风暴，
 * 又短到用户感觉不到延迟（ux_v2 只要求「即时」，未给具体值）。
 */
export const FILTER_DEBOUNCE_MS = 300;

/**
 * 空值统一渲染 `--`（T65）
 *
 * ⚠️ **0 是有效值，必须原样显示** —— 只有 `null` / `undefined` 才走占位符。
 *    典型场景：统计接口还没回来（`stats === null`）时，
 *    早先用 `stats?.totalTrades ?? 0` 会渲染成「0 笔交易」，
 *    让用户误以为账户是空的 —— 现在统一渲染 `--`。
 */
function dash(value: number | null | undefined): string {
  return value === null || value === undefined ? '--' : String(value);
}

/** 百分比格式化（带正负号）*/
function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/** 历史快照（/api/asset-stat/history） */
interface HistoryPoint {
  trade_date: string;
  total_assets_price_yield: number;
  total_assets_actual_yield: number;
  total_profit_price: number;
  total_profit_actual: number;
}

/** 按周期取每期最后一个快照（收益率曲线终点用） */
export function bucketByPeriod(rows: HistoryPoint[], period: CurvePeriod): HistoryPoint[] {
  const months = PERIOD_MONTHS[period];
  const bucket = new Map<string, HistoryPoint>();
  for (const r of rows) {
    const d = new Date(r.trade_date);
    if (Number.isNaN(d.getTime())) continue;
    const monthIndex = d.getFullYear() * 12 + d.getMonth();
    const key = String(Math.floor(monthIndex / months));
    const prev = bucket.get(key);
    // 按日期升序遍历，后来的覆盖先前的 → 每期留最后一天
    if (!prev || r.trade_date >= prev.trade_date) bucket.set(key, r);
  }
  return [...bucket.values()].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
}

/**
 * 纯 SVG 收益曲线（不引第三方图表库）
 *
 * PRD §5.5「收益曲线：月度/季度/年度切换；**悬浮显示具体数值**」——
 * 每个数据点有一个透明命中圆（`fill="transparent"` + `pointerEvents:'all'`），
 * 鼠标移上去显示该点的日期 + 两个口径的收益率（T69 ⑤）。
 */
function YieldCurve({ points, caliber }: { points: HistoryPoint[]; caliber: Caliber }) {
  /** 当前悬浮的数据点下标（null = 未悬浮）*/
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div style={{ color: COLORS.textMuted, fontSize: TYPO.smallSize }}>
        暂无历史快照（每天 17:02 自动写入）
      </div>
    );
  }
  const W = 640;
  const H = 180;
  const PAD = { top: 12, right: 44, bottom: 24, left: 8 };

  const values = points.map(
    (p) => (caliber === 'price' ? p.total_assets_price_yield : p.total_assets_actual_yield) * 100,
  );
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const x = (i: number) => PAD.left + (points.length === 1 ? chartW / 2 : (i / (points.length - 1)) * chartW);
  const y = (v: number) => PAD.top + ((max - v) / range) * chartH;

  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zeroY = y(0);
  const last = values[values.length - 1];
  /**
   * T65：数值异常（NaN / Infinity）时统一渲染 `--`，不渲染「NaN%」。
   * 正常口径下后端 `user_asset_stat` 的收益率列是 NOT NULL 的有限值，
   * 这里只是兜底 —— 避免脏数据把整张图变成 NaN 坐标。
   */
  const color = Number.isFinite(last) ? (last >= 0 ? COLORS.textSuccess : COLORS.danger) : COLORS.neutral;
  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`收益率曲线（${CALIBER_LABEL[caliber]}）`}
        style={{ width: '100%', maxWidth: W, height: 'auto' }}
      >
        <rect x={0} y={0} width={W} height={H} fill={COLORS.headerBg} rx={4} />
        {/* 零轴 */}
        <line
          x1={PAD.left}
          y1={zeroY}
          x2={W - PAD.right}
          y2={zeroY}
          stroke={COLORS.textMuted}
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        {/* 面积 */}
        <path
          d={`${path} L${x(values.length - 1)},${zeroY} L${x(0)},${zeroY} Z`}
          fill={color}
          fillOpacity={0.12}
        />
        {/* 折线 */}
        <path d={path} fill="none" stroke={color} strokeWidth={2} />
        {/* 端点 */}
        <circle cx={x(values.length - 1)} cy={y(last)} r={3.5} fill={color} />
        {/* y 轴刻度 */}
        <text x={W - PAD.right + 6} y={PAD.top + 10} fontSize={10} fill={COLORS.neutral}>
          {Number.isFinite(max) ? `${max.toFixed(1)}%` : '--'}
        </text>
        <text x={W - PAD.right + 6} y={zeroY + 4} fontSize={10} fill={COLORS.neutral}>
          0%
        </text>
        <text x={W - PAD.right + 6} y={H - PAD.bottom} fontSize={10} fill={COLORS.neutral}>
          {Number.isFinite(min) ? `${min.toFixed(1)}%` : '--'}
        </text>
        {/* x 轴首尾日期 */}
        <text x={PAD.left} y={H - 6} fontSize={10} fill={COLORS.neutral}>
          {points[0].trade_date}
        </text>
        <text x={W - PAD.right} y={H - 6} fontSize={10} fill={COLORS.neutral} textAnchor="end">
          {points[points.length - 1].trade_date}
        </text>
        {/*
          命中区（每个数据点一个透明圆）：鼠标移上去显示具体数值。
          ⚠️ `fill="transparent"` + `pointerEvents:'all'` —— `fill="none"` 的元素**不接收指针事件**，
          那样命中区就永远触发不了。
        */}
        {points.map((p, i) => (
          <circle
            key={`${p.trade_date}-${i}`}
            data-testid={`yield-point-${i}`}
            cx={x(i)}
            cy={y(values[i])}
            r={7}
            fill="transparent"
            style={{ pointerEvents: 'all', cursor: 'crosshair' }}
            onMouseEnter={() => setHoverIndex(i)}
            onMouseLeave={() => setHoverIndex((cur) => (cur === i ? null : cur))}
          />
        ))}
      </svg>
      {hovered && hoverIndex !== null && (
        <div
          data-testid="yield-curve-tooltip"
          style={{
            position: 'absolute',
            left: `${(x(hoverIndex) / W) * 100}%`,
            top: `${(y(values[hoverIndex]) / H) * 100}%`,
            transform: 'translate(-50%, calc(-100% - 8px))',
            background: COLORS.textPrimary,
            color: COLORS.cardBg,
            padding: '4px 8px',
            borderRadius: RADIUS.sm,
            fontSize: TYPO.captionSize,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
          <div>{hovered.trade_date}</div>
          <div>价格口径 {fmtPct(hovered.total_assets_price_yield * 100)}</div>
          <div>实际口径 {fmtPct(hovered.total_assets_actual_yield * 100)}</div>
        </div>
      )}
      <div style={{ fontSize: TYPO.smallSize, marginTop: SPACING.gapTight, color }}>
        期末收益率 {Number.isFinite(last) ? `${last.toFixed(2)}%` : '--'}（{CALIBER_LABEL[caliber]}）
      </div>
    </div>
  );
}

export default function Review() {
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 分页页码（T69 ③ 修 bug）
   *
   * ⚠️ **旧实现是 `const [page] = useState(1)` —— `setPage` 从未被调用**：
   *    翻页按钮走 `fetchTrades(page ± 1)`（只发请求、不改页码状态），
   *    于是「第 X / Y 页」永远显示第 1 页，保存/删除后也总是回查第 1 页。
   *    现在 `setPage` 在 `fetchTrades` 发起时同步更新 → 页码与请求一致。
   */
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // 筛选
  const [tradeType, setTradeType] = useState('');
  const [systemFollowed, setSystemFollowed] = useState('');
  const [strategyMatch, setStrategyMatch] = useState('');
  const [isStopLoss, setIsStopLoss] = useState('');
  /** 日期范围（T69 ① · gap-list F-R1；后端 `/review/trades` 已支持 start_date / end_date）*/
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // 编辑中的交易
  const [editingTrade, setEditingTrade] = useState<TradeRow | null>(null);
  const [editForm, setEditForm] = useState({
    review_summary: '',
    strategy_match: '' as TriState,
    is_stop_loss: '' as TriState,
    remark: '',
  });

  /**
   * 编辑弹窗的 a11y（Wave 7 卡 5 · T76 ⑤ / gap-list F-A15）
   *
   * ⚠️ 旧实现是**裸遮罩**（`position:fixed` + 一个 `<div>`）：没有 `role="dialog"`、
   *    没有 ESC 关闭、没有焦点锁定 —— 读屏会把它当普通内容，键盘用户 Tab 得出去。
   * ⇒ 补 `role` / `aria-modal` / `aria-labelledby`（`useId`）+ ESC 关闭 +
   *   **焦点锁定 + 焦点回归**（原生实现，见 `components/useDialogFocus.ts`，不引第三方库）。
   */
  const editDialogTitleId = useId();
  const { dialogRef: editDialogRef } = useDialogFocus<HTMLDivElement>(editingTrade !== null);

  // ESC 关闭编辑弹窗（只在弹窗打开时挂监听，卸载时摘掉）
  useEffect(() => {
    if (!editingTrade) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setEditingTrade(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [editingTrade]);

  // T38 ① 双口径切换 + R2/R4 收益曲线
  const [caliber, setCaliber] = useState<Caliber>('price');
  const [curvePeriod, setCurvePeriod] = useState<CurvePeriod>('monthly');
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchStats = async () => {
    try {
      const res = await api.get('/review/yield');
      if (res.data.success) setStats(res.data.data);
    } catch {
      /* ignore */
    }
  };

  const fetchHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await api.get('/asset-stat/history', { params: { days: 365 } });
      if (res.data.success) setHistory(res.data.data ?? []);
    } catch {
      /* ignore */
    } finally {
      setHistoryLoading(false);
    }
  };

  const curvePoints = useMemo(() => bucketByPeriod(history, curvePeriod), [history, curvePeriod]);

  const fetchTrades = async (p: number) => {
    // 页码与请求**同步**更新（乐观分页）：翻页后「第 X / Y 页」立即反映目标页
    setPage(p);
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, unknown> = { page: p, limit: 20 };
      if (tradeType) params.trade_type = tradeType;
      if (systemFollowed !== '') params.system_followed = systemFollowed;
      if (strategyMatch !== '') params.strategy_match = strategyMatch;
      if (isStopLoss !== '') params.is_stop_loss = isStopLoss;
      if (startDate) params.start_date = startDate;
      if (endDate) params.end_date = endDate;
      const res = await api.get('/review/trades', { params });
      if (res.data.success) {
        setTrades(res.data.data ?? []);
        setTotalPages(res.data.pagination?.totalPages ?? 1);
        setTotal(res.data.pagination?.total ?? 0);
      }
    } catch (err) {
      setError(extractErrorMessage(err, '加载失败'));
    } finally {
      setLoading(false);
    }
  };

  // 挂载时拉一次统计 / 交易 / 历史快照
  useEffect(() => {
    fetchStats();
    fetchTrades(1);
    fetchHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 筛选即时生效（ux_v2 §3.3-3 · T69 ⑥）
   *
   * 旧实现有一个「筛选」按钮，改完下拉还要再点一下才生效 —— 与 PRD/ux_v2 的
   * 「即时生效」口径不符，**按钮已删除**。
   *
   * 这里用 300ms 防抖把 6 个筛选控件（4 个下拉 + 2 个日期）合并成一次请求：
   * - 防抖窗口内连续改动**只发一次**请求（避免请求风暴）；
   * - 窗口过后自动重查，**无需任何按钮**。
   *
   * ⚠️ `lastQueriedFilterKey` 初始化为**挂载时的筛选指纹**（全空），
   *    故挂载那一次不会重复触发（挂载 effect 已经查过第 1 页）。
   */
  const filterKey = JSON.stringify([
    tradeType,
    systemFollowed,
    strategyMatch,
    isStopLoss,
    startDate,
    endDate,
  ]);
  const lastQueriedFilterKey = useRef<string>(filterKey);

  useEffect(() => {
    if (lastQueriedFilterKey.current === filterKey) return;
    const timer = setTimeout(() => {
      lastQueriedFilterKey.current = filterKey;
      void fetchTrades(1);
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const openEdit = (trade: TradeRow) => {
    setEditingTrade(trade);
    setEditForm({
      review_summary: trade.review_summary ?? '',
      strategy_match: trade.strategy_match === 1 ? '1' : trade.strategy_match === 0 ? '0' : '',
      is_stop_loss: trade.is_stop_loss === 1 ? '1' : trade.is_stop_loss === 0 ? '0' : '',
      remark: trade.remark ?? '',
    });
  };

  const saveEdit = async () => {
    if (!editingTrade) return;
    try {
      const payload: Record<string, unknown> = {};
      if (editForm.review_summary !== editingTrade.review_summary)
        payload.review_summary = editForm.review_summary || null;
      if (
        editForm.strategy_match !== '' &&
        editForm.strategy_match !== String(editingTrade.strategy_match ?? '')
      ) {
        payload.strategy_match = editForm.strategy_match === '1' ? 1 : 0;
      }
      if (editForm.is_stop_loss !== '' && editForm.is_stop_loss !== String(editingTrade.is_stop_loss ?? '')) {
        payload.is_stop_loss = editForm.is_stop_loss === '1' ? 1 : 0;
      }
      if (editForm.remark !== editingTrade.remark) payload.remark = editForm.remark || null;
      if (Object.keys(payload).length === 0) {
        setEditingTrade(null);
        return;
      }
      await api.patch(`/trade/${editingTrade.id}`, payload);
      setEditingTrade(null);
      fetchTrades(page);
      fetchStats();
    } catch (err) {
      setError(extractErrorMessage(err, '保存失败'));
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确认软删除此交易？')) return;
    try {
      await api.post(`/trade/${id}/soft-delete`);
      fetchTrades(page);
      fetchStats();
    } catch (err) {
      setError(extractErrorMessage(err, '删除失败'));
    }
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>交易复盘</h1>

      {/* T38 ① 顶部双口径 Tab（PRD §5.5 / Requirements §5.4） */}
      <div style={{ display: 'flex', gap: SPACING.gapBase, marginBottom: 20, flexWrap: 'wrap' }}>
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
              background: caliber === k ? COLORS.brand : COLORS.cardBg,
              color: caliber === k ? COLORS.cardBg : COLORS.textSecondary,
              border: `1px solid ${COLORS.borderMedium}`,
            }}
          >
            {label}
          </button>
        ))}
        <span style={{ fontSize: TYPO.smallSize, color: COLORS.neutral, alignSelf: 'center' }}>
          {CALIBER_LABEL[caliber]}
        </span>
      </div>

      {/* R2/R4 收益曲线（月度/季度/年度） */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ ...cardTitleStyle, border: 'none', margin: 0, padding: 0, flex: 1 }}>收益曲线</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(
              [
                ['monthly', '月度'],
                ['quarterly', '季度'],
                ['yearly', '年度'],
              ] as [CurvePeriod, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setCurvePeriod(k)}
                style={{
                  padding: '3px 12px',
                  fontSize: TYPO.smallSize,
                  cursor: 'pointer',
                  border: `1px solid ${curvePeriod === k ? COLORS.brand : COLORS.borderMedium}`,
                  borderRadius: RADIUS.sm,
                  background: curvePeriod === k ? COLORS.brand : COLORS.cardBg,
                  color: curvePeriod === k ? COLORS.cardBg : COLORS.textSecondary,
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {historyLoading ? <Spinner size={16} /> : <YieldCurve points={curvePoints} caliber={caliber} />}
      </div>

      {/* 统计卡片 */}
      <div
        style={{
          display: 'flex',
          gap: SPACING.gapRelaxed,
          flexWrap: 'wrap',
          marginBottom: SPACING.gapLoose,
        }}
      >
        {[
          { label: '总交易数', value: dash(stats?.totalTrades), color: COLORS.brandLink },
          { label: '已复盘', value: dash(stats?.reviewedCount), color: COLORS.textSuccess },
          {
            label: '胜率',
            value: stats?.winRate != null ? `${stats.winRate}%` : '--',
            color: COLORS.accentPurple,
          },
          {
            label: '盈亏比',
            value: stats?.profitLossRatio != null ? `${stats.profitLossRatio}` : '--',
            color: COLORS.danger,
          },
          {
            label: '已实现盈亏',
            value:
              stats?.totalRealizedPnl != null
                ? `${stats.totalRealizedPnl >= 0 ? '+' : ''}${stats.totalRealizedPnl.toFixed(2)}`
                : '--',
            color: (stats?.totalRealizedPnl ?? 0) >= 0 ? COLORS.textSuccess : COLORS.danger,
          },
        ].map((card) => (
          <div key={card.label} style={{ ...cardStyle, flex: '1 1 140px', textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 'bold', color: card.color }}>{card.value}</div>
            <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral }}>{card.label}</div>
          </div>
        ))}
      </div>
      {stats && (
        <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral, marginTop: -12, marginBottom: 20 }}>
          平仓 {dash(stats.closedCount)} 笔（盈利 {dash(stats.winCount)} / 亏损 {dash(stats.lossCount)}）
          {stats.avgWin != null && ` · 平均盈利 ${stats.avgWin.toFixed(2)}`}
          {stats.avgLoss != null && ` · 平均亏损 ${stats.avgLoss.toFixed(2)}`}
        </div>
      )}

      {/*
        筛选栏（T69 ①⑥）
        ⚠️ **没有「筛选」按钮** —— 改动后 300ms 自动重查（ux_v2 §3.3-3）。
      */}
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label htmlFor="review-filter-trade-type" style={{ fontSize: TYPO.bodySize }}>
          交易类型：
        </label>
        <select
          id="review-filter-trade-type"
          style={inputStyle}
          value={tradeType}
          onChange={(e) => setTradeType(e.target.value)}
        >
          <option value="">全部</option>
          {/* 交易类型标签统一取自 `components/tradeTypes`（单一真相源，gap-list F-R2）*/}
          {TRADE_TYPES.map((t) => (
            <option key={t} value={t}>
              {tradeTypeLabel(t)}
            </option>
          ))}
        </select>
        <label htmlFor="review-filter-system-followed" style={{ fontSize: TYPO.bodySize }}>
          系统信号：
        </label>
        <select
          id="review-filter-system-followed"
          style={inputStyle}
          value={systemFollowed}
          onChange={(e) => setSystemFollowed(e.target.value)}
        >
          <option value="">全部</option>
          <option value="1">是</option>
          <option value="0">否</option>
        </select>
        <label htmlFor="review-filter-strategy-match" style={{ fontSize: TYPO.bodySize }}>
          符合策略：
        </label>
        <select
          id="review-filter-strategy-match"
          style={inputStyle}
          value={strategyMatch}
          onChange={(e) => setStrategyMatch(e.target.value)}
        >
          <option value="">全部</option>
          <option value="1">是</option>
          <option value="0">否</option>
        </select>
        <label htmlFor="review-filter-stop-loss" style={{ fontSize: TYPO.bodySize }}>
          止损：
        </label>
        <select
          id="review-filter-stop-loss"
          style={inputStyle}
          value={isStopLoss}
          onChange={(e) => setIsStopLoss(e.target.value)}
        >
          <option value="">全部</option>
          <option value="1">是</option>
          <option value="0">否</option>
        </select>
        <label htmlFor="review-filter-start-date" style={{ fontSize: TYPO.bodySize }}>
          起始日期：
        </label>
        <input
          id="review-filter-start-date"
          type="date"
          style={inputStyle}
          value={startDate}
          max={endDate || undefined}
          onChange={(e) => setStartDate(e.target.value)}
        />
        <label htmlFor="review-filter-end-date" style={{ fontSize: TYPO.bodySize }}>
          结束日期：
        </label>
        <input
          id="review-filter-end-date"
          type="date"
          style={inputStyle}
          value={endDate}
          min={startDate || undefined}
          onChange={(e) => setEndDate(e.target.value)}
        />
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      {/* 交易列表 */}
      <div style={cardStyle}>
        {/* 标签图例（PRD §5.5「列表标签颜色」——4 色 pill 必须配图例）*/}
        <div style={{ marginBottom: SPACING.gapBase }}>
          <ReviewTagLegend />
        </div>
        {loading ? (
          <Spinner />
        ) : trades.length === 0 ? (
          <div style={{ color: COLORS.neutral, padding: 20, textAlign: 'center' }}>暂无交易记录</div>
        ) : (
          /*
            G4.6（375px 无横向溢出）：
            11 列表格实测总宽 555px，在 375px 视口下会**把文档撑宽 +241px**。
            ⇒ 套 `ScrollableTable`（overflow-x:auto + min-width:0 + role/aria/tabindex），
              表格在**自己内部**横向滚动，文档不再被撑宽。
            ⚠️ **刻意不用 `table-layout: fixed`** —— 那会重算所有列宽、破坏既有观感与断言。
          */
          <ScrollableTable label="交易复盘列表表">
            <table style={tableStyle} aria-label="交易复盘列表">
              <thead>
                <tr>
                  <th scope="col" style={thStyle}>
                    日期
                  </th>
                  <th scope="col" style={thStyle}>
                    标的
                  </th>
                  <th scope="col" style={thStyle}>
                    类型
                  </th>
                  <th scope="col" style={thStyle}>
                    数量
                  </th>
                  <th scope="col" style={thStyle}>
                    价格
                  </th>
                  <th scope="col" style={thStyle}>
                    操作理由
                  </th>
                  <th scope="col" style={thStyle}>
                    复盘
                  </th>
                  <th scope="col" style={thStyle}>
                    符合策略
                  </th>
                  <th scope="col" style={thStyle}>
                    止损
                  </th>
                  <th scope="col" style={thStyle}>
                    标签
                  </th>
                  <th scope="col" style={thStyle}>
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td style={thTdStyle}>{t.trade_date}</td>
                    <td style={thTdStyle}>
                      <code>{t.asset_code}</code>
                    </td>
                    <td style={thTdStyle}>{tradeTypeLabel(t.trade_type)}</td>
                    <td style={thTdStyle}>{t.quantity}</td>
                    <td style={thTdStyle}>{t.price.toFixed(2)}</td>
                    <td style={thTdStyle}>
                      {/* 长文本截断（视觉），完整内容用 title 暴露；DOM 文本仍是全文 */}
                      <div style={truncatedTextStyle} title={t.trade_reason ?? undefined}>
                        {t.trade_reason ?? '-'}
                      </div>
                    </td>
                    <td style={thTdStyle}>
                      {t.review_summary ? (
                        <span style={{ color: COLORS.textSuccess }}>✓</span>
                      ) : (
                        <span style={{ color: COLORS.textMuted }}>—</span>
                      )}
                    </td>
                    <td style={thTdStyle}>
                      {t.strategy_match === 1 ? (
                        <span style={{ color: COLORS.textPillSuccess }}>是</span>
                      ) : t.strategy_match === 0 ? (
                        <span style={{ color: COLORS.textPillDanger }}>否</span>
                      ) : (
                        <span style={{ color: COLORS.textMuted }}>未标记</span>
                      )}
                    </td>
                    <td style={thTdStyle}>
                      {t.is_stop_loss === 1 ? (
                        <span style={{ color: COLORS.textPillSuccess }}>是</span>
                      ) : t.is_stop_loss === 0 ? (
                        <span style={{ color: COLORS.textPillDanger }}>否</span>
                      ) : (
                        <span style={{ color: COLORS.textMuted }}>未标记</span>
                      )}
                    </td>
                    <td style={thTdStyle}>
                      <ReviewTagPill tag={reviewTagOf(t)} />
                    </td>
                    <td style={thTdStyle}>
                      <button
                        style={{ ...buttonStyle, fontSize: 12, padding: '2px 8px', marginRight: 4 }}
                        onClick={() => openEdit(t)}
                      >
                        编辑复盘
                      </button>
                      <button
                        style={{
                          ...buttonStyle,
                          fontSize: 12,
                          padding: '2px 8px',
                          background: COLORS.danger,
                        }}
                        onClick={() => handleDelete(t.id)}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
        )}

        {/* 分页（T69 ③：页码 state 真的会变） */}
        {totalPages > 1 && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button style={buttonStyle} disabled={page <= 1} onClick={() => void fetchTrades(page - 1)}>
              上一页
            </button>
            <span style={{ fontSize: TYPO.bodySize }}>
              第 {page} / {totalPages} 页，共 {total} 条
            </span>
            <button
              style={buttonStyle}
              disabled={page >= totalPages}
              onClick={() => void fetchTrades(page + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </div>

      {/* 编辑弹窗 */}
      {editingTrade && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: COLORS.maskOverlay,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 200,
          }}
        >
          <div
            ref={editDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={editDialogTitleId}
            tabIndex={-1}
            style={{ ...cardStyle, maxWidth: 480, width: '90%' }}
          >
            <div id={editDialogTitleId} style={cardTitleStyle}>
              编辑复盘 — {editingTrade.asset_code} ({editingTrade.trade_date})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label
                  htmlFor="review-edit-summary"
                  style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}
                >
                  复盘总结
                </label>
                <textarea
                  id="review-edit-summary"
                  style={{ ...inputStyle, width: '100%', marginTop: 4, minHeight: 60, resize: 'vertical' }}
                  value={editForm.review_summary}
                  onChange={(e) => setEditForm((f) => ({ ...f, review_summary: e.target.value }))}
                />
              </div>
              {/*
                T63：三态按钮组**不是** form label（它标的是一组按钮，不是单个控件）
                → 标题由 `<label>` 改为 `<span id=...>`，按钮组用
                  `role="group"` + `aria-labelledby` 指向该 span；
                  每个按钮加 `aria-pressed` 暴露选中态（否则选中态仅靠颜色传达）。
                T69 ⑦：三态配色按 PRD §5.5 改为 是=绿 / 否=红 / 未标记=灰，
                  且选中项加粗（fontWeight 600 + borderWidth 2px）。
              */}
              <div style={{ display: 'flex', gap: SPACING.gapRelaxed, flexWrap: 'wrap' }}>
                <TriStateGroup
                  labelId="review-edit-strategy-match-label"
                  label="是否符合策略"
                  value={editForm.strategy_match}
                  onChange={(v) => setEditForm((f) => ({ ...f, strategy_match: v }))}
                />
                <TriStateGroup
                  labelId="review-edit-stop-loss-label"
                  label="是否止损"
                  value={editForm.is_stop_loss}
                  onChange={(v) => setEditForm((f) => ({ ...f, is_stop_loss: v }))}
                />
              </div>
              <div>
                <label
                  htmlFor="review-edit-remark"
                  style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}
                >
                  备注
                </label>
                <input
                  id="review-edit-remark"
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }}
                  value={editForm.remark}
                  onChange={(e) => setEditForm((f) => ({ ...f, remark: e.target.value }))}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: SPACING.gapBase, marginTop: 16 }}>
              <button style={buttonStyle} onClick={saveEdit}>
                保存
              </button>
              <button
                style={{ ...buttonStyle, background: COLORS.neutral }}
                onClick={() => setEditingTrade(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
