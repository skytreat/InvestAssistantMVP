/**
 * M3 —— `--universe dynamic` 全市场面板装载的**真库规模断言（手动跑）**
 *
 * 从 `backtest-m3-dynamic-panel.test.ts` 拆出（2026-11-06 测试基建改造）：
 *   原文件 8 条用例里，3 条是纯参数校验（留在主套件，CI 必跑），
 *   5 条断言的是**全市场规模**（1894 只标的 / 2,038,316 根 bar / 四指数各 727 根），
 *   迷你库（41~57 只 ETF、无四指数）与 CI（12KB 空壳）一律撑不起。
 *   ⇒ 这 5 条移入本文件，只在 `vitest.anchors.config.ts` 下运行
 *     （`npm run test:anchors -w @invest/backend`），日常 `npm test` 已在主配置里排除。
 *
 * ⚠️ **不用 `it.skipIf` 守卫**：`tests/anchors.setup.ts` 会在开跑前校验档位必须为 `full`
 *   且真库探测可用，否则直接抛错。若守卫仍用 skip，环境没配对时会得到「0 失败」的假绿。
 *
 * 🔒 实测锚点（2026-11-06，真库 1.24GB）：
 *   - `symbols` = **1894**（`v_etf_qfq` 区间内去重标的；单日只数 1161 → 1797，
 *     并集比单日大得多，故**不是**任务书预估的 500–900）；
 *   - `barCount` = **2,038,316**（qfq 1,017,704 + bfq 1,017,704 + 四指数 4×727）；
 *   - 四指数各 **727** 根 bar；
 *   - `execBars` 的 `preclose > 0` 覆盖率 **100%**（1,017,704 / 1,017,704）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadUniversePanel, type UniversePanel } from '../../src/services/backtest/universe/dynamicPanel.js';
import { DEFENSIVE_ETF, FIXED_ETF_POOL } from '../../src/services/backtest/universe/fixedPool.js';
import { WEAK_PERIOD_INDEXES } from '../../src/services/backtest/universe/pointInTime.js';

describe('全市场面板（真库规模断言）', () => {
  let panel: UniversePanel;

  beforeAll(async () => {
    panel = await loadUniversePanel({
      start: '2023-01-01',
      end: '2025-12-31',
      extraSymbols: [...FIXED_ETF_POOL, DEFENSIVE_ETF, 'sh510300'],
      indexCodes: WEAK_PERIOD_INDEXES,
    });
  }, 180_000);

  it('标的数落在实测区间', () => {
    // 实测 1894；预留 ±15% 余量以容忍行情库追加历史/新标的
    expect(panel.symbols.length).toBeGreaterThanOrEqual(1500);
    expect(panel.symbols.length).toBeLessThanOrEqual(2200);
    // 升序且无重复
    expect(panel.symbols).toEqual([...panel.symbols].sort());
    expect(new Set(panel.symbols).size).toBe(panel.symbols.length);
  });

  it('barCount > 400_000（实测 2,038,316）', () => {
    expect(panel.barCount).toBeGreaterThan(400_000);
  });

  it('四指数都有 bar（实测各 727 根）', () => {
    for (const code of WEAK_PERIOD_INDEXES) {
      const bars = panel.indexBars.get(code);
      expect(bars, `指数 ${code} 缺失`).toBeDefined();
      expect(bars!.length).toBeGreaterThan(0);
    }
    // 指数不进 ETF 轨（构建面板时不允许把 class 混淆）
    expect(panel.signalBars.has('sh000300')).toBe(false);
  });

  it('execBars 的 preclose > 0 覆盖率 100%（实测 1,017,704/1,017,704）', () => {
    let total = 0;
    let bad = 0;
    for (const bars of panel.execBars.values()) {
      for (const bar of bars) {
        total++;
        if (!(bar.preclose > 0)) bad++;
      }
    }
    expect(total).toBeGreaterThan(400_000);
    expect(bad).toBe(0);
  });

  it('固定池 / 防御 ETF / 基准 都在面板里（extraSymbols 生效）', () => {
    for (const symbol of [DEFENSIVE_ETF, 'sh510300', FIXED_ETF_POOL[0]]) {
      expect(panel.signalBars.has(symbol), `${symbol} 不在 signalBars`).toBe(true);
      expect(panel.execBars.has(symbol), `${symbol} 不在 execBars`).toBe(true);
    }
  });
});
