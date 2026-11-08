/**
 * 组合策略适配器（T133，PA-04）—— 回测/纸面"信号跟随"
 *
 * 口径（方案 §6.3，D3 已定）：**先批量预生成信号、再跟随**。
 * 本适配器不在 `decide()` 内重算条件，只读注入的 `ComboSignalSource`
 * ⇒ 回测与实盘共用同一份条件实现，避免算法漂移。
 *
 * 无前视契约：读取只到 `ctx.asOf`（= T-1）；信号日期晚于 `asOf` 的一律丢弃。
 * 注册入口见 `paper/strategies.ts`（PA-09）。
 */
import { defineStrategy, type Strategy, type StrategyContext, type TargetSet } from '../strategy/types.js';

/** 纸面/回测登记用的策略 id 与版本（`paper_account` 建户时冻结这两项） */
export const COMBO_SIGNAL_STRATEGY_ID = 'combo-signal-follow';
export const COMBO_SIGNAL_STRATEGY_VERSION = '0.1.0';

export interface ComboSignalView {
  symbol: string;
  /** 信号生成日（YYYY-MM-DD） */
  tradeDate: string;
  direction: 'buy' | 'sell' | 'hold';
  strength: number;
}

/** 预生成信号源（实盘/回测由各自实现按 `comboId` + `asOf` 查询） */
export interface ComboSignalSource {
  listSignals(comboId: string, asOf: string): readonly ComboSignalView[];
}

export interface ComboSignalStrategyOptions {
  source: ComboSignalSource;
  comboId?: string;
  /** 单标的目标权重（默认 0.1，骨架首个可运行值） */
  weight?: number;
}

const DEFAULT_WEIGHT = 0.1;

const DEFAULT_COMBO_ID = '';

/**
 * 构造"组合信号跟随"策略
 *
 * 买入：`targetWeight = weight`（已持仓则不动，避免每日再平衡）；
 * 卖出：`targetWeight = 0`（仅对已持仓标的生效）；
 * 同一标的同日多方向时取 `strength` 最高的一条。
 */
export function createComboSignalStrategy(options: ComboSignalStrategyOptions): Strategy {
  return defineStrategy({
    id: COMBO_SIGNAL_STRATEGY_ID,
    version: COMBO_SIGNAL_STRATEGY_VERSION,
    name: '组合策略：信号跟随',
    paramSchema: [
      {
        key: 'comboId',
        label: '组合 ID',
        type: 'string',
        default: options.comboId ?? DEFAULT_COMBO_ID,
        description: 'strategy_combo.id；回测/纸面绑定到具体组合',
      },
      {
        key: 'weight',
        label: '单标的目标权重',
        type: 'number',
        default: options.weight ?? DEFAULT_WEIGHT,
        min: 0,
        max: 1,
        step: 0.01,
        description: '占总权益比例；骨架默认 0.1。正式默认值需在 T133 按 INV-S3-21 补依据',
      },
    ],
    warmupDays: 0,
    priceMode: 'open',

    decide(ctx: StrategyContext): TargetSet | null {
      const comboId = String(ctx.params.comboId ?? options.comboId ?? '');
      const weight = Number(ctx.params.weight ?? options.weight ?? DEFAULT_WEIGHT);

      if (comboId === '') {
        ctx.log('warn', '组合信号跟随：缺少 comboId，跳过');
        return null;
      }
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
        ctx.log('warn', `组合信号跟随：weight 非法（${weight}），跳过`);
        return null;
      }

      const signals = options.source.listSignals(comboId, ctx.asOf);

      // ① 无前视：只吃 <= asOf 的信号；HOLD 不产生操作
      const usable = signals.filter((signal) => signal.tradeDate <= ctx.asOf && signal.direction !== 'hold');

      // ② 同标的去重：取 strength 最高的一条（相等时保留先到者）
      const bySymbol = new Map<string, ComboSignalView>();
      for (const signal of usable) {
        const picked = bySymbol.get(signal.symbol);
        if (!picked || signal.strength > picked.strength) {
          bySymbol.set(signal.symbol, signal);
        }
      }

      const targets: Array<{
        symbol: string;
        targetWeight: number;
        reason: 'rebalance';
      }> = [];

      for (const signal of bySymbol.values()) {
        if (signal.direction === 'buy') {
          // 已持有则保持，不做每日再平衡
          if (ctx.position(signal.symbol)?.qty) {
            continue;
          }
          targets.push({
            symbol: signal.symbol,
            targetWeight: weight,
            reason: 'rebalance',
          });
        } else {
          // 卖出只对已持仓标的生效
          if (!ctx.position(signal.symbol)?.qty) {
            continue;
          }
          targets.push({ symbol: signal.symbol, targetWeight: 0, reason: 'rebalance' });
        }
      }

      if (targets.length === 0) {
        return null;
      }
      return { targets, mode: 'incremental' };
    },
  });
}
