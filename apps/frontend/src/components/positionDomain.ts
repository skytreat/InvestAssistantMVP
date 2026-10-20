/**
 * 持仓卡片的领域模型与纯函数（T67 · Wave 3 卡 3）
 *
 * ## 为什么单独一个文件
 *
 * `isEtf` / `DIRECTION_LABEL` / `TypeFilter` / `fmt` / `fmtPct` 原先都住在
 * `pages/Dashboard.tsx` 里。卡 3 新增的卡片组件位于**组件层**，
 * 组件层**不能反向依赖页面层**（`components/` → `pages/` 会形成循环依赖：
 * `Dashboard` → `PositionCard` → `Dashboard`）。
 *
 * ⇒ 把这些「与渲染无关的领域事实」下沉到这里，`pages/Dashboard.tsx`
 *    继续 **re-export**（`isEtf` / `DIRECTION_LABEL` / `TypeFilter` 的既有
 *    import 路径全部保持可用，卡 4 / 卡 6 / 卡 7 不受影响）。
 *
 * ⚠️ **为什么放在 `components/` 下**：本卡（Wave 3 卡 3）的改动范围被限定为
 *    `pages/Dashboard.tsx` + `components/` + `tests/`，
 *    故不新建 `src/utils/` 下的新文件（仓库里虽有 `src/utils/`，
 *    但不在本卡允许改动的范围内）。
 *    本文件**不含任何 React 组件**，只是被组件与页面共用的领域事实。
 *
 * ## 本文件只放「是什么」，不放「长什么样」
 *
 * 样式一律在组件文件里，且只用 `theme/tokens.ts` 的 token（不引入裸 hex）。
 */

/** 交易方向（卡 4 的 TradeFormModal 预填用）*/
export type TradeSide = 'buy' | 'sell';

/** 持仓类型过滤（饼图下钻与「标的类型筛选」共用同一个 state —— 单一真相源）*/
export type TypeFilter = 'all' | 'stock' | 'etf';

/** 排序依据（PRD §5.3 行 232「按盈亏金额/收益率/仓位占比排序」）*/
export type SortKey = 'pnl' | 'yield' | 'weight';

/** 排序方向 */
export type SortDirection = 'desc' | 'asc';

/**
 * 策略信号（`GET /api/holding` 的 `signal` 字段）
 *
 * ⚠️ `direction` 的取值域是 **`buy` / `sell` / `hold`**（后端 DDL CHECK 约束），
 *    **不是** PRD 文案里的「买入/卖出/持仓」中文。
 */
export interface PositionSignal {
  plugin_id: string;
  direction: 'buy' | 'sell' | 'hold';
  label: string;
  trade_date: string;
}

/**
 * 持仓条目（与 `GET /api/holding` 的 position 同形）
 *
 * ⚠️ T67 enrich 追加的 4 个字段：
 *   - `prevClose` —— 昨收（卡 5「总资产变化」用）；
 *   - `signal` —— 该标的最新一条信号（建议 A，卡 3 消费，卡 7 扩展）；
 *   - `name` —— 中文名（`raw_symbol_name`，覆盖率约 70%，**缺失是常态**）；
 *   - `industry` —— 行业（**契约预留字段，当前恒为 `null`**：
 *     `raw_tdx_blocks_member` 实测 0 行 → 行业筛选必须显式降级，裁决 D-4）。
 */
export interface Position {
  asset_code: string;
  totalQuantity: number;
  totalCostBasis: number;
  avgCost: number;
  realizedPnL: number;
  currentPrice: number | null;
  priceDate: string | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedYield: number | null;
  /** 仓位占比（**0~1 的小数**，不是百分数）*/
  weight: number | null;
  /** 昨收（无行情 → null）*/
  prevClose: number | null;
  /** 该标的最新一条策略信号（无信号 → null）*/
  signal: PositionSignal | null;
  /** 中文名（查不到 → null）*/
  name: string | null;
  /** 行业（**当前恒为 null**，见上方说明）*/
  industry: string | null;
}

/** 信号方向 → 中文（信号表与卡 7 的理由文案共用这一份）*/
export const DIRECTION_LABEL: Record<string, string> = {
  buy: '买入',
  sell: '卖出',
  hold: '持仓',
};

/**
 * A 股 ETF 判定：sh51xxxx / sh56xxxx / sh58xxxx / sz15xxxx / sz16xxxx
 *
 * ⚠️ **判定口径不许改** —— 既有单测（`dashboard.test.tsx` 的「isEtf · A 股 ETF 代码判定」）
 *    逐条锁定了 6 个代码的判定结果；卡 3 的类型过滤直接复用本函数，不另写一份正则。
 */
export function isEtf(code: string): boolean {
  return /^(sh5[168]|sz1[56])/.test(code);
}

/** 数值格式化（null / undefined / NaN → `--`，绝不显示 `NaN` / `undefined` 字面量）*/
export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  return n.toFixed(digits);
}

/** 百分比格式化（入参是 0~1 的小数）*/
export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  return `${(n * 100).toFixed(2)}%`;
}

/**
 * 信号过期阈值（**自然日**）
 *
 * ⚠️ ux_v2 原文是「超过 5 个**交易日**未更新」，但前端**没有交易日历**（SDD §4.4 无该端点），
 *    故按裁决 D-5 放宽为「自然日差 ≥ 5」—— 偏差已登记为 §13 待办。
 */
export const SIGNAL_STALE_DAYS = 5;

/** 两个 `YYYY-MM-DD` 之间的自然日差（`to - from`；无法解析时返回 0）*/
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * 信号是否过期
 *
 * 判据（裁决 D-5）：信号交易日 与 最新行情交易日（`summary.priceDate`）之间的自然日差 ≥ 5。
 * `priceDate` 缺失（无行情）→ **判为未过期**（没有判据就不臆造结论）。
 */
export function isSignalStale(
  signal: PositionSignal | null | undefined,
  priceDate: string | null | undefined,
): boolean {
  if (!signal || !priceDate) return false;
  return daysBetween(signal.trade_date, priceDate) >= SIGNAL_STALE_DAYS;
}
