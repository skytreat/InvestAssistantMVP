import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { useUserStore } from '../store/user';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import { ghostButtonStyle, truncatedTextStyle } from '../theme/styles';
import Spinner from '../components/Spinner';
import PositionCard from '../components/PositionCard';
import PositionToolbar from '../components/PositionToolbar';
import PositionDetailModal from '../components/PositionDetailModal';
import ScrollableTable from '../components/ScrollableTable';
import TodayActivityCard from '../components/TodayActivityCard';
import TradeFormModal from '../components/TradeFormModal';
import type { SignalTradeDraft } from '../components/SignalMiniMenu';
import {
  DIRECTION_LABEL,
  fmt,
  fmtPct,
  isEtf,
  type Position,
  type SortDirection,
  type SortKey,
  type TradeSide,
  type TypeFilter,
} from '../components/positionDomain';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  cardTitleStyle,
  tableStyle,
  thStyle,
  thTdStyle,
  buttonStyle,
} from './_shared';

/**
 * 既有导出继续可用（卡 4 / 卡 6 / 卡 7 与既有单测都从这里取）
 *
 * ⚠️ 定义已下沉到 `components/positionDomain.ts`（组件层不能反向依赖页面层），
 *    这里只做 **re-export**，对外的 import 路径与语义完全不变。
 */
export { DIRECTION_LABEL, isEtf };
export type { Position, TypeFilter };

/** 双口径口径说明（Requirements §5.4） */
type Caliber = 'price' | 'actual';

interface AssetStat {
  trade_date: string;
  total_assets_price_yield: number;
  total_assets_actual_yield: number;
  total_profit_price: number;
  total_profit_actual: number;
}

interface PositionSummary {
  totalMarketValue: number;
  totalCostBasis: number;
  unrealizedPnl: number;
  realizedPnl: number;
  priceDate: string | null;
  positionCount: number;
}

interface Signal {
  asset_code: string;
  plugin_id: string;
  direction: string;
  label: string;
  trade_date: string;
}

interface SystemLog {
  created_at: string;
  log_type: string;
  level: string;
  message: string;
}

const LEVEL_COLOR: Record<string, string> = {
  ERROR: COLORS.danger,
  WARN: COLORS.warning,
  SKIP: COLORS.textMuted,
  SUCCESS: COLORS.success,
  INFO: COLORS.brand,
};

/**
 * 持仓类型过滤的**单一真相源**
 *
 * ⚠️ 饼图下钻（卡 2）与「标的类型筛选」（卡 3）共用这同一个 state，
 *    否则两套过滤会互相覆盖 —— 卡 3 的类型筛选控件直接写 `typeFilter` 即可。
 *
 * （`TypeFilter` 类型定义已下沉到 `components/positionDomain.ts`，本文件顶部做了 re-export。）
 */

/** 类型 → 中文标签（过滤状态提示文案用）*/
const TYPE_LABEL: Record<Exclude<TypeFilter, 'all'>, string> = {
  stock: '股票',
  etf: 'ETF',
};

/**
 * 纯 CSS 环形图（G7c 资产组成饼图）
 *
 * MVP 不引第三方图表库：conic-gradient 直接画，股票 / ETF 两段配色。
 *
 * ⚠️ **可点击下钻**（PRD §5.3 行 229「股票 + ETF 按市值分布，支持点击下钻到持仓列表过滤」）：
 *   - 图例是真正的 `<button>`（带 `aria-pressed`）→ 键盘可达、读屏有可访问名；
 *   - 饼图本体也可点 → 按点击位置落在哪一段决定下钻哪一类；
 *   - 两个入口共用同一个 `onSelect`，行为完全一致。
 *
 * ⚠️ **conic-gradient 的计算口径不许动** —— 现有用例逐字断言背景的
 *    「品牌色 0% → 原始 stockPct% → 成功色 stockPct% → 100%」分段
 *    （背景用原始 `stockPct`，图例才 toFixed）。
 */
export interface DonutChartProps {
  /** 股票市值 */
  stock: number;
  /** ETF 市值 */
  etf: number;
  /** 当前选中的类型（'all' = 未下钻）*/
  selected?: TypeFilter;
  /** 点击某一段时的回调（不传则图例不可交互）*/
  onSelect?: (type: Exclude<TypeFilter, 'all'>) => void;
}

/**
 * 按点击位置判断落在哪一段
 *
 * conic-gradient 从 12 点方向开始、顺时针展开 → 角度 ≤ 股票占比即落在股票段。
 *
 * ⚠️ jsdom 没有布局引擎 → `getBoundingClientRect()` 恒为 0×0 → 无法按坐标判段，
 *    此时退化为「市值占比大的一段」，保证测试与降级路径都有确定行为。
 */
function segmentAtPoint(
  el: HTMLElement,
  clientX: number,
  clientY: number,
  stockPct: number,
): Exclude<TypeFilter, 'all'> {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return stockPct >= 50 ? 'stock' : 'etf';
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let deg = (Math.atan2(clientX - cx, -(clientY - cy)) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg <= stockPct ? 'stock' : 'etf';
}

/**
 * 图例按钮样式
 *
 * 选中态用「底色 + 边框 + 字重」三重差异 —— 人眼能分辨，测试也能断言。
 * 颜色全部走 token（`bgSelectedPrimary` / `borderSelectedPrimary`），不引入裸 hex。
 */
function legendButtonStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    background: active ? COLORS.bgSelectedPrimary : 'transparent',
    border: `1px solid ${active ? COLORS.borderSelectedPrimary : 'transparent'}`,
    borderRadius: RADIUS.sm,
    padding: '2px 6px',
    cursor: 'pointer',
    fontFamily: TYPO.fontFamily,
    fontSize: TYPO.bodySize,
    fontWeight: active ? 700 : 400,
    color: COLORS.textPrimary,
    textAlign: 'left',
    // 窄屏（375px）下不让按钮撑破卡片 —— 文字允许换行
    maxWidth: '100%',
  };
}

export function DonutChart({ stock, etf, selected = 'all', onSelect }: DonutChartProps) {
  const total = stock + etf;
  if (total <= 0) {
    return <div style={{ color: COLORS.textMuted, fontSize: TYPO.bodySize }}>暂无持仓资产</div>;
  }
  const stockPct = (stock / total) * 100;

  const select = (type: Exclude<TypeFilter, 'all'>) => onSelect?.(type);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.gapLoose, flexWrap: 'wrap' }}>
      <div
        role="button"
        tabIndex={0}
        aria-label="资产组成饼图（点击扇区可按类型下钻持仓列表）"
        onClick={(e) => select(segmentAtPoint(e.currentTarget, e.clientX, e.clientY, stockPct))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select(stockPct >= 50 ? 'stock' : 'etf');
          }
        }}
        style={{
          width: 120,
          height: 120,
          borderRadius: '50%',
          background: `conic-gradient(${COLORS.brand} 0% ${stockPct}%, ${COLORS.success} ${stockPct}% 100%)`,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: SPACING.gapBase,
          fontSize: TYPO.bodySize,
          alignItems: 'flex-start',
        }}
      >
        <button
          type="button"
          aria-pressed={selected === 'stock'}
          onClick={() => select('stock')}
          style={legendButtonStyle(selected === 'stock')}
        >
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              background: COLORS.brand,
              marginRight: 6,
            }}
          />
          股票 {fmt(stock)}（{stockPct.toFixed(1)}%）
        </button>
        <button
          type="button"
          aria-pressed={selected === 'etf'}
          onClick={() => select('etf')}
          style={legendButtonStyle(selected === 'etf')}
        >
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              background: COLORS.success,
              marginRight: 6,
            }}
          />
          ETF {fmt(etf)}（{(100 - stockPct).toFixed(1)}%）
        </button>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { role } = useUserStore();

  const [positions, setPositions] = useState<Position[]>([]);
  const [posSummary, setPosSummary] = useState<PositionSummary | null>(null);
  const [posLoading, setPosLoading] = useState(false);
  const [posError, setPosError] = useState<string | null>(null);

  const [caliber, setCaliber] = useState<Caliber>('price');
  const [stat, setStat] = useState<AssetStat | null>(null);
  const [statLoading, setStatLoading] = useState(false);
  const [statError, setStatError] = useState<string | null>(null);

  /** 持仓类型过滤（饼图下钻；卡 3 的「标的类型筛选」复用同一个 state）*/
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  /** 排序依据（卡 3 · F-D5；PRD §5.3 行 232）*/
  const [sortKey, setSortKey] = useState<SortKey>('pnl');
  /** 排序方向（默认按盈亏金额**降序**）*/
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const [signals, setSignals] = useState<Signal[]>([]);
  const [sigLoading, setSigLoading] = useState(false);
  const [sigError, setSigError] = useState<string | null>(null);

  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  /* ------------------------------------------------------------------ *
   * 三个顶层模态的 state（批次 5 接线）
   * ------------------------------------------------------------------ */

  /**
   * 交易录入弹窗（卡 4）的打开状态
   *
   * ⚠️ **只存「打开 + 标的 + 方向」**，**不存预填字段** ——
   *    预填字段的唯一来源是 `signalDraft`（一键链路的草稿）。
   *    这样「持仓卡直接点【买入】」与「信号一键链路点【立即买入】」两条路径
   *    共用同一个弹窗，而预填与否由 `signalDraft` 是否为 `null` 决定。
   */
  const [tradeModal, setTradeModal] = useState<{ code: string; side: TradeSide } | null>(null);

  /**
   * 一键链路的交易草稿（卡 7 · `SignalTradeDraft`）
   *
   * - `null` = 弹窗**不带预填**（持仓卡【买入】【卖出】路径）；
   * - 非 `null` = 弹窗按草稿预填（数量 = D-9 / 价格 = 现价 / 理由 = D-11）。
   *
   * ⚠️ 关闭弹窗时必须**一并清空** —— 否则下一次从持仓卡打开弹窗时
   *    会残留上一次的预填（用户会误以为系统替他填好了）。
   */
  const [signalDraft, setSignalDraft] = useState<SignalTradeDraft | null>(null);

  /** 标的详情弹窗（卡 6）的标的代码；`null` = 关闭 */
  const [detailModal, setDetailModal] = useState<string | null>(null);

  /**
   * 详情弹窗对应的持仓条目
   *
   * ⚠️ 找不到就传 `null`（弹窗会显示占位），**不抛错** ——
   *    持仓在弹窗打开期间被删掉是合法情形（不能因此炸掉整页）。
   */
  const detailPosition = useMemo(
    () => (detailModal === null ? null : (positions.find((p) => p.asset_code === detailModal) ?? null)),
    [detailModal, positions],
  );

  /* ── 三个模态的打开 / 关闭 ── */

  /**
   * 持仓卡【买入】【卖出】→ 打开交易弹窗（**不带预填**）
   *
   * ⚠️ 先清空 `signalDraft` —— 两条路径共用一个弹窗，
   *    不清就会把「上一次一键链路的预填」带进这次的手工下单。
   */
  const handleTrade = (code: string, side: TradeSide) => {
    setSignalDraft(null);
    setTradeModal({ code, side });
  };

  /**
   * 信号 → 交易 一键链路（卡 7）→ 打开交易弹窗（**带预填**）
   *
   * 草稿（`draft`）由 `SignalMiniMenu` 产出，字段口径见 `SignalMiniMenu.tsx`：
   * - `quantity` = `Math.ceil(totalQuantity / 2)`（D-9）；
   * - `price` = `position.currentPrice`（可能为 `null`）；
   * - `reason` = `${plugin_id} ${label} ${方向中文} (${trade_date})`（D-11）。
   *
   * ⚠️ `setSignalDraft` 与 `setTradeModal` 在**同一个事件回调**里 → React 18 批量更新
   *    → 弹窗打开的那一帧就已经能拿到草稿（不会出现「先开空弹窗再填」的闪烁）。
   */
  const handleSignalTrade = (draft: SignalTradeDraft) => {
    setSignalDraft(draft);
    setTradeModal({ code: draft.assetCode, side: draft.side });
  };

  /** 关闭交易弹窗（并清掉预填草稿）*/
  const closeTradeModal = () => {
    setTradeModal(null);
    setSignalDraft(null);
  };

  /** 持仓卡名称点击 → 打开详情弹窗（卡 6）*/
  const handleOpenDetail = (code: string) => {
    setDetailModal(code);
  };

  /**
   * 详情弹窗里的【买入】【卖出】→ 换成交易弹窗
   *
   * ⚠️ **先把详情弹窗关掉**（而不是让两个模态叠在一起）：
   *   - 两个模态的遮罩 z-index 相同（400）→ 叠放时遮罩互相盖住，用户看不出底下还有一层；
   *   - 两个模态都监听 `document` 的 ESC → 按一次 ESC 会**同时**关掉两层
   *     （`stopPropagation` 拦不住**同一个元素**上的其它监听器）。
   *   ⇒ 「详情弹窗 → 交易弹窗」按「换一个弹窗」处理。
   */
  const handleDetailTrade = (code: string, side: TradeSide) => {
    setDetailModal(null);
    setSignalDraft(null);
    setTradeModal({ code, side });
  };

  /** 关闭详情弹窗 */
  const closeDetailModal = () => {
    setDetailModal(null);
  };

  /**
   * 交易提交成功后刷新持仓
   *
   * ⚠️ **刻意不置 `posLoading`** —— 刷新期间持仓卡必须**留在原地**
   *    （置成 loading 会把整块持仓区换成 Spinner，用户刚填完表单就被闪一下）。
   * ⚠️ 失败时**保留旧数据**，只把错误写进 `posError`（不白屏）。
   */
  const refreshPositions = async () => {
    try {
      const res = await api.get('/holding');
      if (res.data.success) {
        setPositions(res.data.data ?? []);
        setPosSummary(res.data.summary ?? null);
        setPosError(null);
      } else setPosError(res.data.message ?? '请求失败');
    } catch (err) {
      setPosError(extractErrorMessage(err));
    }
  };

  useEffect(() => {
    (async () => {
      setPosLoading(true);
      try {
        const res = await api.get('/holding');
        if (res.data.success) {
          setPositions(res.data.data ?? []);
          setPosSummary(res.data.summary ?? null);
        } else setPosError(res.data.message ?? '请求失败');
      } catch (err) {
        setPosError(extractErrorMessage(err));
      } finally {
        setPosLoading(false);
      }
    })();

    (async () => {
      setStatLoading(true);
      try {
        const res = await api.get('/asset-stat/latest');
        if (res.data.success) setStat(res.data.data ?? null);
        else setStatError(res.data.message ?? '请求失败');
      } catch (err) {
        setStatError(extractErrorMessage(err));
      } finally {
        setStatLoading(false);
      }
    })();

    (async () => {
      setSigLoading(true);
      try {
        const res = await api.get('/signal', { params: { page_size: 5 } });
        if (res.data.success) setSignals(res.data.data ?? []);
        else setSigError(res.data.message ?? '请求失败');
      } catch (err) {
        setSigError(extractErrorMessage(err));
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
          else setLogError(res.data.message ?? '请求失败');
        } catch (err) {
          setLogError(extractErrorMessage(err));
        } finally {
          setLogLoading(false);
        }
      })();
    }
  }, [role]);

  // 资产组成：股票 vs ETF（按市值汇总）
  const allocation = useMemo(() => {
    let stock = 0;
    let etf = 0;
    for (const p of positions) {
      const mv = p.marketValue ?? 0;
      if (isEtf(p.asset_code)) etf += mv;
      else stock += mv;
    }
    return { stock, etf };
  }, [positions]);

  const activePositions = positions.filter((p) => p.totalQuantity > 0);

  /**
   * 下钻后的持仓列表
   *
   * ⚠️ **下钻过滤的是持仓列表本身**（PRD §5.3 行 229），不是切页 —— 页面结构不变。
   */
  const filteredPositions = activePositions.filter((p) =>
    typeFilter === 'all' ? true : (typeFilter === 'etf') === isEtf(p.asset_code),
  );

  /** 点击饼图某一段：选中该类型；再点同一段 → 取消过滤（回到全部）*/
  const handleTypeSelect = (type: Exclude<TypeFilter, 'all'>) => {
    setTypeFilter((cur) => (cur === type ? 'all' : type));
  };

  /**
   * 排序后的持仓列表（卡 3 · F-D5）
   *
   * ⚠️ **缺失值（`null`）恒排最后**（无论升降序）——
   *    「无行情的标的」不该因为排序而冒到最前面抢占视线；
   *    同值时按代码字典序兜底，保证顺序**确定**（可复现、可断言）。
   */
  const sortedPositions = useMemo(() => {
    const valueOf = (p: Position): number | null => {
      if (sortKey === 'pnl') return p.unrealizedPnl;
      if (sortKey === 'yield') return p.unrealizedYield;
      return p.weight;
    };
    const dir = sortDirection === 'desc' ? -1 : 1;
    return [...filteredPositions].sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (va === null && vb === null) return a.asset_code.localeCompare(b.asset_code);
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va === vb) return a.asset_code.localeCompare(b.asset_code);
      return (va - vb) * dir;
    });
  }, [filteredPositions, sortKey, sortDirection]);

  /**
   * 行业过滤是否可用
   *
   * ⚠️ 当前**恒为 false** —— `raw_tdx_blocks_member` 实测 0 行 ⇒ `industry` 恒 `null`
   *    （裁决 D-4）。控件据此禁用并显示「行业数据源暂不可用」，
   *    **不许静默失效**。数据源恢复后会自动启用。
   */
  const industryAvailable = positions.some((p) => p.industry !== null && p.industry !== undefined);

  return (
    /*
     * ⚠️ **顶层用 Fragment 而不是单个 `<div>`** ——
     *    三个模态（`TradeFormModal` / `PositionDetailModal`）必须渲染在
     *    **页面滚动容器（`pageContainerStyle` 那个 div）之外**，
     *    否则祖先一旦带上 `overflow: auto / hidden`，
     *    `position: fixed` 的弹窗会被**裁剪**（只在祖先有 transform/filter 时才发生，
     *    但把模态放在容器外是更稳、也更符合「模态属于视口」的写法）。
     */
    <>
      <div style={pageContainerStyle}>
        <h1 style={titleStyle}>仪表盘</h1>

        {/* G7b 总资产卡（双口径切换，PRD §5.3） */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ ...cardTitleStyle, border: 'none', margin: 0, padding: 0, flex: 1 }}>总资产</div>
            <div
              style={{
                display: 'flex',
                border: `1px solid ${COLORS.borderMedium}`,
                borderRadius: RADIUS.sm,
                overflow: 'hidden',
              }}
            >
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
                    borderRadius: 0,
                    background: caliber === k ? COLORS.brand : COLORS.cardBg,
                    color: caliber === k ? COLORS.cardBg : COLORS.textSecondary,
                    border: 'none',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {statLoading && <Spinner />}
          {statError && <div style={{ color: COLORS.danger }}>{statError}</div>}
          {!statLoading &&
            !statError &&
            (stat ? (
              <>
                <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginTop: SPACING.gapBase }}>
                  <div>
                    <div style={{ fontSize: 30, fontWeight: 'bold', color: COLORS.brandLink }}>
                      {fmt(posSummary?.totalMarketValue)}
                    </div>
                    <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral }}>总资产</div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 30,
                        fontWeight: 'bold',
                        color:
                          (caliber === 'price' ? stat.total_profit_price : stat.total_profit_actual) >= 0
                            ? COLORS.success
                            : COLORS.danger,
                      }}
                    >
                      {(caliber === 'price' ? stat.total_profit_price : stat.total_profit_actual) >= 0
                        ? '+'
                        : ''}
                      {fmt(caliber === 'price' ? stat.total_profit_price : stat.total_profit_actual)}
                    </div>
                    <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral }}>总盈亏</div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 30,
                        fontWeight: 'bold',
                        color:
                          (caliber === 'price'
                            ? stat.total_assets_price_yield
                            : stat.total_assets_actual_yield) >= 0
                            ? COLORS.success
                            : COLORS.danger,
                      }}
                    >
                      {fmtPct(
                        caliber === 'price' ? stat.total_assets_price_yield : stat.total_assets_actual_yield,
                      )}
                    </div>
                    <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral }}>总收益率</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 30, fontWeight: 'bold', color: COLORS.accentPurple }}>
                      {fmt(posSummary?.realizedPnl)}
                    </div>
                    <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral }}>已实现盈亏</div>
                  </div>
                </div>
                {/*
                成本口径单列一行 —— **不能**与「总资产」共用同一个「值 div + 标签 div」父级：
                现有用例的 `metricText(label)` 取「标签父元素的首个子元素」，
                两个口径挤在同一个父级里会取错节点。
              */}
                <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral, marginTop: SPACING.gapTight }}>
                  持仓总成本 {fmt(posSummary?.totalCostBasis)}
                </div>
                <div style={{ fontSize: 12, color: COLORS.neutral, marginTop: SPACING.gapBase }}>
                  快照日期 {stat.trade_date}
                  {posSummary?.priceDate && ` · 现价取自 ${posSummary.priceDate}`}
                  {' · '}
                  {caliber === 'price'
                    ? '价格口径：纯价格涨跌，不含分红送转'
                    : '实际口径：含分红等现金流，反映真实收益'}
                </div>
              </>
            ) : (
              <div style={{ color: COLORS.textMuted, padding: '12px 0' }}>
                暂无资产快照（每天 17:02 信号生成后自动写入）
              </div>
            ))}
        </div>

        {/* G7c 资产组成饼图 */}
        <div style={cardStyle}>
          <div style={cardTitleStyle}>资产组成</div>
          <DonutChart
            stock={allocation.stock}
            etf={allocation.etf}
            selected={typeFilter}
            onSelect={handleTypeSelect}
          />
          <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral, marginTop: SPACING.gapBase }}>
            点击图例或饼图可下钻到持仓列表
          </div>
          {typeFilter !== 'all' && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: SPACING.gapBase,
                flexWrap: 'wrap',
                marginTop: SPACING.gapBase,
                fontSize: TYPO.smallSize,
                color: COLORS.textSecondary,
              }}
            >
              <span>
                已按「{TYPE_LABEL[typeFilter]}」筛选持仓（{filteredPositions.length} /{' '}
                {activePositions.length} 只）
              </span>
              <button
                type="button"
                onClick={() => setTypeFilter('all')}
                style={{
                  ...ghostButtonStyle,
                  borderRadius: RADIUS.sm,
                  padding: '2px 8px',
                  cursor: 'pointer',
                  fontFamily: TYPO.fontFamily,
                  fontSize: TYPO.smallSize,
                }}
              >
                清除筛选
              </button>
            </div>
          )}
        </div>

        {/*
        今日动态概览卡（卡 5 · ux_v2 建议 D）
        ⚠️ **位置契约**：插在「资产汇总卡（总资产 + 资产组成饼图）」与「持仓明细卡」之间 ——
           ux_v2 建议 D 原文「插在资产汇总卡和持仓卡之间」。
        ⚠️ **默认不传 `tradeDate` prop** —— 日期锚点 = `/api/holding` 的 `summary.priceDate`
           （最新行情交易日，裁决 D-6），由组件自己取。
      */}
        <TodayActivityCard />

        {/* 持仓卡片列表（T33 规格） */}
        <div style={cardStyle}>
          <div style={cardTitleStyle}>持仓明细（{filteredPositions.length} 只）</div>
          {posLoading && <Spinner />}
          {posError && <div style={{ color: COLORS.danger }}>{posError}</div>}
          {!posLoading &&
            !posError &&
            (activePositions.length === 0 ? (
              <div style={{ color: COLORS.neutral, padding: 20, textAlign: 'center' }}>暂无持仓</div>
            ) : (
              <div>
                {/* 排序 / 过滤工具条（卡 3 · F-D5）—— 过滤后为空时也要留着（否则改不回来）*/}
                <PositionToolbar
                  sortKey={sortKey}
                  sortDirection={sortDirection}
                  onSortKeyChange={setSortKey}
                  onSortDirectionToggle={() => setSortDirection((cur) => (cur === 'desc' ? 'asc' : 'desc'))}
                  typeFilter={typeFilter}
                  onTypeFilterChange={setTypeFilter}
                  industryAvailable={industryAvailable}
                />
                {filteredPositions.length === 0 ? (
                  <div style={{ color: COLORS.neutral, padding: 20, textAlign: 'center' }}>
                    当前筛选下无持仓
                  </div>
                ) : (
                  <>
                    {/*
                    持仓卡片网格（卡 3 · F-D2）
                    ⚠️ **纯 CSS Grid 流体列数**，不用 JS 断点、不用 media query：
                      `repeat(auto-fill, minmax(min(320px, 100%), 1fr))`
                    - `min(320px, 100%)` 是关键：`100%` 把轨道宽度**封顶在容器宽度**，
                      375px 窄屏下轨道不会撑到 320px → **不产生横向溢出**（G3.5）；
                    - 320px 的下限配合容器实际宽度，天然得到「桌面 3 列 / 平板 2 列 / 手机 1 列」
                      （页面容器最大 1200px - 内边距 48 - 卡片内边距 32 = 1120px 可用宽
                      → 1120/320 = 3.5 → 3 列；768px 时 688/320 = 2.15 → 2 列；
                      375px 时 295/320 < 1 → 1 列）；
                    - 卡片根节点另带 `min-width: 0`（Grid 子项默认 `min-width: auto`，
                      内容过宽会撑破轨道）。
                  */}
                    <div
                      data-testid="position-grid"
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))',
                        gap: SPACING.gapRelaxed,
                        alignItems: 'start',
                      }}
                    >
                      {sortedPositions.map((p) => (
                        <PositionCard
                          key={p.asset_code}
                          position={p}
                          assetType={isEtf(p.asset_code) ? 'etf' : 'stock'}
                          priceDate={posSummary?.priceDate ?? null}
                          /* 接线（批次 5）：三条入口 —— 交易弹窗 / 详情弹窗 / 信号一键链路 */
                          onTrade={handleTrade}
                          onOpenDetail={handleOpenDetail}
                          onSignalTrade={handleSignalTrade}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            ))}
        </div>

        <div style={cardStyle}>
          <div style={cardTitleStyle}>最新信号</div>
          {sigLoading && <Spinner />}
          {sigError && <div style={{ color: COLORS.danger }}>{sigError}</div>}
          {!sigLoading && !sigError && (
            /*
             * ⚠️ **表格必须套在可横向滚动的容器里**（G3.5）：
             *    `table` 的 `width:100%` 只是最小宽度，5 列（代码/策略/方向/标签/日期）
             *    在 375px 窄屏下最小内容宽度超过卡片宽度 → 表格溢出卡片 →
             *    溢出向上冒泡 → **文档级**横向溢出。
             *    套上 `overflow-x:auto` 的容器后，表格在自己内部横向滚动，文档不再被撑宽。
             */
            <ScrollableTable label="最新信号表">
              <table style={tableStyle} aria-label="最新信号">
                <thead>
                  <tr>
                    <th scope="col" style={thStyle}>
                      代码
                    </th>
                    <th scope="col" style={thStyle}>
                      策略
                    </th>
                    <th scope="col" style={thStyle}>
                      方向
                    </th>
                    <th scope="col" style={thStyle}>
                      标签
                    </th>
                    <th scope="col" style={thStyle}>
                      日期
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {signals.length === 0 ? (
                    <tr>
                      <td style={thTdStyle} colSpan={5}>
                        暂无信号
                      </td>
                    </tr>
                  ) : (
                    signals.map((s, i) => (
                      <tr key={i}>
                        <td style={thTdStyle}>{s.asset_code}</td>
                        <td style={thTdStyle}>{s.plugin_id}</td>
                        <td style={thTdStyle}>
                          <span
                            style={{
                              color:
                                s.direction === 'buy'
                                  ? COLORS.success
                                  : s.direction === 'sell'
                                    ? COLORS.danger
                                    : COLORS.textSecondary,
                              fontWeight: TYPO.cardTitleWeight,
                            }}
                          >
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
            </ScrollableTable>
          )}
        </div>

        {role === 'admin' && (
          <div style={cardStyle}>
            <div style={cardTitleStyle}>最近日志</div>
            {logLoading && <Spinner />}
            {logError && <div style={{ color: COLORS.danger }}>{logError}</div>}
            {!logLoading && !logError && (
              /*
               * ⚠️ **「最近日志」表是 dashboard@375 溢出的元凶**（G3.5，实测 +169px）：
               *    「消息」列的内容是后端系统日志（运维噪声路径，如
               *    「插件目录不可读，跳过磁盘加载: /opt/invol/plugins/strategies」），
               *    属于**不可断的长字符串** → 把这一列顶到 217px → 整表 483px
               *    → 超出卡片宽度 → 文档级横向溢出。
               *
               *    两道防线：
               *    1. **容器化**（`overflow-x:auto`）—— 表格在自己内部滚动，文档不被撑宽；
               *    2. **长文本截断**（`truncatedTextStyle`）—— 把「消息」列的宽度钉住，
               *       完整内容通过 `title` 属性悬停可见（DOM 文本不裁剪 → 读屏仍可读全文）。
               */
              <ScrollableTable label="最近日志表">
                <table style={tableStyle} aria-label="最近日志">
                  <thead>
                    <tr>
                      <th scope="col" style={thStyle}>
                        时间
                      </th>
                      <th scope="col" style={thStyle}>
                        类型
                      </th>
                      <th scope="col" style={thStyle}>
                        级别
                      </th>
                      <th scope="col" style={thStyle}>
                        消息
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.length === 0 ? (
                      <tr>
                        <td style={thTdStyle} colSpan={4}>
                          暂无日志
                        </td>
                      </tr>
                    ) : (
                      logs.map((l, i) => (
                        <tr key={i}>
                          <td style={thTdStyle}>{l.created_at}</td>
                          <td style={thTdStyle}>{l.log_type}</td>
                          <td style={{ ...thTdStyle, color: LEVEL_COLOR[l.level] ?? COLORS.textSecondary }}>
                            {l.level}
                          </td>
                          <td style={thTdStyle}>
                            {/* 截断只作用于**视觉**；DOM 里的文本仍是全文 */}
                            <div style={truncatedTextStyle} title={l.message}>
                              {l.message}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </ScrollableTable>
            )}
          </div>
        )}
      </div>

      {/* ────────────────────────────────────────────────────────────── *
       * 三个顶层模态（**在页面滚动容器之外**）
       *
       * ⚠️ 位置契约（批次 5 接线清单）：
       *   - `TodayActivityCard` 在**页面容器内**（资产汇总卡与持仓卡之间）；
       *   - `TradeFormModal` / `PositionDetailModal` 在**页面容器外**（Dashboard 顶层）——
       *     模态是 `position: fixed` 的视口级浮层，绝不能被祖先的 `overflow` 裁掉。
       * ────────────────────────────────────────────────────────────── */}

      {/*
        交易录入弹窗（卡 4）
        ⚠️ **预填字段的唯一来源是 `signalDraft`**：
           - `signalDraft === null`（持仓卡【买入】【卖出】）→ 数量/价格/理由**留空**；
           - `signalDraft !== null`（信号一键链路）→ 按 D-9 / 现价 / D-11 预填。
        ⚠️ `draft.price` 为 `null` 时必须传 `undefined`（不是 `null`）——
           `TradeFormModal` 用 `toInputValue()` 归一化，`null` 会变成字符串 "null"。
      */}
      <TradeFormModal
        open={tradeModal !== null}
        assetCode={tradeModal?.code ?? ''}
        side={tradeModal?.side ?? 'buy'}
        initialQuantity={signalDraft?.quantity}
        initialPrice={signalDraft?.price ?? undefined}
        initialReason={signalDraft?.reason}
        onCancel={closeTradeModal}
        onDone={() => {
          // 提交成功 → 关闭弹窗 + 刷新持仓（父级负责刷新，组件层不自己拉数据）
          closeTradeModal();
          void refreshPositions();
        }}
      />

      {/* 标的详情弹窗（卡 6）：`position` 来自父级已持有的持仓数据（不重复请求）*/}
      <PositionDetailModal
        open={detailModal !== null}
        position={detailPosition}
        onCancel={closeDetailModal}
        onTrade={handleDetailTrade}
      />
    </>
  );
}
