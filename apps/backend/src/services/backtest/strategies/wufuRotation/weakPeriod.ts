/**
 * 走弱期状态机 —— 照抄 `五福轮动ETF_v5.2.py` L789-L861 `check_a_share_weak_period`
 *
 * 四个指数（聚宽 `000300.XSHG / 399101.XSHE / 399006.XSHE / 000510.XSHG` → 本地代码）：
 * `sh000300` / `sz399101` / `sz399006` / `sh000510`。
 * 每个取「11 个收盘」：`current = 最后一个`，`MA10 = 后 10 个均值`；
 * `below = current < MA10`，`above = current > MA10`（`==` 两边都不计，对应「➡️持平」）。
 *
 * 状态迁移（「现状即口径」，逐分支照抄）：
 * - 进入：`belowCount >= 3` 且当前不在走弱期；
 * - 已在走弱期：
 *   ① `count >= maxWeakDays(20)` → 强退；
 *   ② `aboveCount >= 3` → 退出；
 *   ③ `belowCount >= 3` → **把 `startDayIndex` 重置为今天**（L837-L841），
 *      故持续走弱时计数永远回到起点、20 日强退实际不触发；
 *   ④ 否则保持（计数继续累加）。
 *
 * `weakDays` 的返回值口径：取**迁移后**状态的 `dayIndex - startDayIndex + 1`
 * （进入日 / 重置日均为 1）。强退判定用的仍是**迁移前**的计数（与 v5.2 L820-L824 一致），
 * 只是日志展示值在原脚本重置后为 0、此处为 1（仅展示差异，不影响强退时机）。
 */
import type { StrategyContext } from '../../strategy/types.js';

export const WEAK_PERIOD_INDEX_CODES: readonly string[] = ['sh000300', 'sz399101', 'sz399006', 'sh000510'];

/** 跨交易日持久的状态（由策略实例持有，`init()` 清零） */
export interface WeakPeriodState {
  weak: boolean;
  /** 进入/最近一次重置当天的 `ctx.dayIndex` */
  startDayIndex: number | null;
}

export interface WeakPeriodSnapshot {
  weak: boolean;
  /** 走弱期已持续交易日数；不在走弱期为 0 */
  weakDays: number;
  belowCount: number;
  aboveCount: number;
}

export interface EvaluateWeakPeriodInput {
  state: WeakPeriodState;
  dayIndex: number;
  maLookback: number;
  maxWeakDays: number;
  /** 通常传 `(code, n) => ctx.indexSeries(code, n)` */
  indexSeries: (code: string, n: number) => number[];
}

/** 就地推进状态机，返回当日快照 */
export function evaluateWeakPeriod(input: EvaluateWeakPeriodInput): WeakPeriodSnapshot {
  const { state, dayIndex, maLookback, maxWeakDays, indexSeries } = input;

  let aboveCount = 0;
  let belowCount = 0;
  for (const code of WEAK_PERIOD_INDEX_CODES) {
    const closes = indexSeries(code, maLookback + 1);
    // L802：数据不足则跳过该指数（不计入 above / below）
    if (closes.length < maLookback) continue;
    const current = closes[closes.length - 1];
    let sum = 0;
    for (const v of closes.slice(-maLookback)) sum += v;
    const ma = sum / maLookback;
    if (current > ma) aboveCount++;
    if (current < ma) belowCount++;
  }

  const weakConditionMet = belowCount >= 3;
  const exitConditionMet = aboveCount >= 3;

  // 强退判定用「迁移前」计数（等价 `len(get_trade_days(start, today))`）
  const daysBefore = state.weak && state.startDayIndex !== null ? dayIndex - state.startDayIndex + 1 : 0;

  if (state.weak) {
    if (daysBefore >= maxWeakDays) {
      state.weak = false;
      state.startDayIndex = null;
    } else if (exitConditionMet) {
      state.weak = false;
      state.startDayIndex = null;
    } else if (weakConditionMet) {
      state.startDayIndex = dayIndex;
    }
  } else if (weakConditionMet) {
    state.weak = true;
    state.startDayIndex = dayIndex;
  }

  const weakDays = state.weak && state.startDayIndex !== null ? dayIndex - state.startDayIndex + 1 : 0;
  return { weak: state.weak, weakDays, belowCount, aboveCount };
}

/** 便捷包装：直接从 `StrategyContext` 取指数序列 */
export function evaluateWeakPeriodFromContext(
  ctx: StrategyContext,
  state: WeakPeriodState,
  maLookback: number,
  maxWeakDays: number,
): WeakPeriodSnapshot {
  return evaluateWeakPeriod({
    state,
    dayIndex: ctx.dayIndex,
    maLookback,
    maxWeakDays,
    indexSeries: (code, n) => ctx.indexSeries(code, n),
  });
}
