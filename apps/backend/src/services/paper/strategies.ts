/**
 * 纸面账户可绑定策略（PA-07）
 *
 * D4：账户锁定 `(strategy_id, strategy_version)`，运行时**精确匹配**；
 * 不做「同 id 取最新版本」的隐式升级 —— 否则同一条账本会被不同版本的策略解释，
 * 历史结果不可复现。
 *
 * 目前只登记仓库内置策略；插件策略接入属 S2 起的扩展项。
 */
import type { ParamField } from '../pluginEngine.js';
import type { Strategy } from '../backtest/strategy/types.js';
import { buyAndHoldStrategy } from '../backtest/strategies/buyAndHold.js';
import { createWufuRotationStrategy } from '../backtest/strategies/wufuRotation/index.js';
import { createDualMomentumStrategy } from '../backtest/strategies/dualmomentum/index.js';
import {
  COMBO_SIGNAL_STRATEGY_ID,
  COMBO_SIGNAL_STRATEGY_VERSION,
  createComboSignalStrategy,
} from '../backtest/strategies/comboSignal.js';
import { dbComboSignalSource } from './comboSignalSource.js';
import { PaperError } from './errors.js';

interface BuiltinEntry {
  id: string;
  version: string;
  create: () => Strategy;
}

const BUILTINS: readonly BuiltinEntry[] = [
  { id: buyAndHoldStrategy.id, version: buyAndHoldStrategy.version, create: () => buyAndHoldStrategy },
  {
    id: 'wufu-rotation',
    version: '5.2.0-m3',
    create: () => createWufuRotationStrategy(),
  },
  {
    // DualMomentum：池内轮动、多标的，与 wufu 同类；
    // id/version 必须与 `strategies/dualmomentum/index.ts` 的 `defineStrategy` 声明逐字一致。
    //
    // 🔖 **版本 `das-3.2`**（2026-11-13）：ADR-022（跑赢档 7 项 opt-in 转缺省）+
    //    ADR-024（基准破位切防御）**两次改了策略语义** ⇒ 按 D4「账户锁定 (id, version)、
    //    不做隐式升级，否则同一条账本会被不同版本的策略解释」升版本。
    //    旧的 `das-3.1` 账户将不再匹配（`STRATEGY_VERSION_NOT_FOUND`）——
    //    本地/生产均无已存在的 dualmomentum 纸面账户，暂无迁移负担。
    //
    // ⚠️ 纸面账户**已知不保真**：回放期用空组合且不产生成交（`onFill` 不调用），
    // 止盈 / 再平衡 / 高水位止损 / 止损止盈冷却在本策略下永不触发。
    // 纸面结果不得与回测结果互相校验。详见 `docs/audit/dualmomentum-l1-alignment.md` 的
    // 「纸面账户已知不保真」一节（方案 D 显式接受）。
    //
    // ✅ **例外（ADR-024）**：「基准破位切防御」**在纸面里能真实工作** ——
    //    它只依赖每日行情算出的基准动量与 `decide()` 内维护的状态位，
    //    **不依赖成交事件累积** ⇒ 不受「回放期无成交 / 不调 onFill」限制。
    id: 'dualmomentum',
    version: 'das-3.2',
    create: () => createDualMomentumStrategy(),
  },
  {
    // T133 / PA-09：组合信号跟随 —— 只读已预生成的 `combo:<id>` 信号（D3：判据只有一份），
    // 账户参数 `comboId` / `weight` 由建户时的 params 决定；不碰结算与盈亏口径。
    id: COMBO_SIGNAL_STRATEGY_ID,
    version: COMBO_SIGNAL_STRATEGY_VERSION,
    create: () => createComboSignalStrategy({ source: dbComboSignalSource }),
  },
];

/** 按 (id, version) 精确解析；版本不符与 id 不存在是两类不同错误 */
export function resolvePaperStrategy(id: string, version: string): Strategy {
  const entry = BUILTINS.find((e) => e.id === id);
  if (!entry) {
    throw new PaperError('STRATEGY_NOT_FOUND', 400, `策略 ${id} 未登记为纸面可用策略`);
  }
  if (entry.version !== version) {
    throw new PaperError(
      'STRATEGY_VERSION_NOT_FOUND',
      400,
      `策略 ${id} 不存在版本 ${version}（当前可用：${entry.version}）`,
    );
  }
  return entry.create();
}

/** 供建户 / 前端展示使用：可绑定策略清单（含参数 schema） */
export function listPaperStrategies(): {
  id: string;
  version: string;
  name: string;
  paramSchema: ParamField[];
}[] {
  return BUILTINS.map((e) => {
    const s = e.create();
    return { id: s.id, version: s.version, name: s.name, paramSchema: s.paramSchema };
  });
}
