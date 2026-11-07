/**
 * 纸面账户可绑定策略（PA-07）
 *
 * D4：账户锁定 `(strategy_id, strategy_version)`，运行时**精确匹配**；
 * 不做「同 id 取最新版本」的隐式升级 —— 否则同一条账本会被不同版本的策略解释，
 * 历史结果不可复现。
 *
 * 目前只登记仓库内置策略；插件策略接入属 S2 起的扩展项。
 */
import type { Strategy } from '../backtest/strategy/types.js';
import { buyAndHoldStrategy } from '../backtest/strategies/buyAndHold.js';
import { createWufuRotationStrategy } from '../backtest/strategies/wufuRotation/index.js';
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

/** 供建户 / 前端展示使用：可绑定策略清单 */
export function listPaperStrategies(): { id: string; version: string; name: string }[] {
  return BUILTINS.map((e) => {
    const s = e.create();
    return { id: s.id, version: s.version, name: s.name };
  });
}
