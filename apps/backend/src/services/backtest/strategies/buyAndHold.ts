/**
 * 参考策略：买入持有单只标的
 *
 * 存在的理由（**不是产品策略**，M3 才做 v5.2 移植）：
 * - 验收锚点 ③ 需要「`sh510300` 买入持有」基准曲线；
 * - 验收锚点 ④ 需要一条「有持仓」的引擎运行来核对现金恒等式；
 * - CLI 需要一个最小可跑策略，证明引擎端到端打通。
 *
 * 口径：
 * - 默认**只买一次**（`rebalance=false`）：首个决策日按目标权重买入，之后不再调仓，
 *   这样净值就是纯粹的「买入持有」；若已持有则返回 null（不下单、不产生额外费用）。
 * - `weight=0` 可当作「空仓位基准」：引擎每天收到空 targets（replace），无成交。
 */
import { defineStrategy, type TargetSet, type StrategyContext } from '../strategy/types.js';

export interface BuyAndHoldParams {
  symbol: string;
  weight: number;
  rebalance: boolean;
}

export const BUY_AND_HOLD_PARAMS: BuyAndHoldParams = {
  symbol: 'sh510300',
  weight: 1,
  rebalance: false,
};

export const buyAndHoldStrategy = defineStrategy({
  id: 'ref-buy-and-hold',
  version: '0.1.0',
  name: '参考策略：买入持有',
  paramSchema: [
    {
      key: 'symbol',
      label: '标的代码',
      type: 'string',
      default: BUY_AND_HOLD_PARAMS.symbol,
      description: 'sh510300 形式；CLI 通过 --symbol 注入',
    },
    {
      key: 'weight',
      label: '目标权重',
      type: 'number',
      default: BUY_AND_HOLD_PARAMS.weight,
      min: 0,
      max: 1,
      step: 0.05,
      description: '占总权益比例；0 = 空仓位基准',
    },
    {
      key: 'rebalance',
      label: '每日再平衡',
      type: 'boolean',
      default: BUY_AND_HOLD_PARAMS.rebalance,
      description: 'false = 只买一次（纯买入持有）',
    },
  ],
  warmupDays: 0,
  priceMode: 'open',

  decide(ctx: StrategyContext): TargetSet | null {
    const symbol = String(ctx.params.symbol ?? BUY_AND_HOLD_PARAMS.symbol);
    const weight = Number(ctx.params.weight ?? BUY_AND_HOLD_PARAMS.weight);
    const rebalance = Boolean(ctx.params.rebalance ?? BUY_AND_HOLD_PARAMS.rebalance);

    if (weight <= 0) {
      // 空仓位基准：显式 replace + 空 targets（有持仓会被清掉）
      return { targets: [], mode: 'replace' };
    }
    if (!rebalance && ctx.position(symbol)?.qty) {
      return null;
    }
    return {
      targets: [{ symbol, targetWeight: weight, reason: 'rebalance' }],
      mode: 'replace',
    };
  },
});
