/**
 * M3 —— `--universe dynamic` 的全市场面板装载（`universe/dynamicPanel.ts`）
 *
 * 覆盖两层：
 *   1. **参数校验**（纯函数 / 在查询之前抛）—— 无行情库也能跑，CI 必跑；
 *   2. **全市场规模/口径**（真库 2023-01-01 ~ 2025-12-31）—— 只有 `scale` 档（真库）才断言，
 *      迷你库（41~57 只 ETF、无四指数）与 CI（12KB 空壳）一律 **skip**，不假绿也不假红。
 *
 * 🔒 实测锚点（2026-11-06，`/opt/invol` 同级真库 1.24GB）：
 *   - `symbols` = **1894**（`v_etf_qfq` 区间内去重标的；单日只数 1161 → 1797，
 *     并集比单日大得多，故**不是**任务书预估的 500–900）；
 *   - `barCount` = **2,038,316**（qfq 1,017,704 + bfq 1,017,704 + 四指数 4×727）；
 *   - 四指数各 **727** 根 bar；
 *   - `execBars` 的 `preclose > 0` 覆盖率 **100%**（1,017,704 / 1,017,704）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { marketDataUsableFor, SKIP_REASON_NO_SCALE_DATA } from '../_marketData.js';
import {
  loadUniversePanel,
  validatePanelOptions,
  type UniversePanel,
} from '../../src/services/backtest/universe/dynamicPanel.js';
import { DEFENSIVE_ETF, FIXED_ETF_POOL } from '../../src/services/backtest/universe/fixedPool.js';
import { WEAK_PERIOD_INDEXES } from '../../src/services/backtest/universe/pointInTime.js';

const SCALE_READY = await marketDataUsableFor('scale');

describe('参数校验（不碰 DuckDB —— CI 无行情库也跑）', () => {
  it('start / end 必须是 YYYY-MM-DD', () => {
    expect(() => validatePanelOptions({ start: '2023-1-1', end: '2025-12-31' })).toThrow(
      /start 必须是 YYYY-MM-DD/,
    );
    expect(() => validatePanelOptions({ start: '2023-01-01', end: '2025/12/31' })).toThrow(
      /end 必须是 YYYY-MM-DD/,
    );
  });

  it('start 晚于 end ⇒ 报错（含两端取值）', () => {
    expect(() => validatePanelOptions({ start: '2025-12-31', end: '2023-01-01' })).toThrow(
      /start 不能晚于 end（2025-12-31 > 2023-01-01）/,
    );
  });

  it('非法参数在**发查询之前**就被拒（不会去连行情库）', async () => {
    // 若校验被挪到查询之后，无行情库环境这条会变成「连接失败」而不是「参数错误」
    await expect(loadUniversePanel({ start: 'bad-date', end: '2025-12-31' })).rejects.toThrow(
      /start 必须是 YYYY-MM-DD/,
    );
  });
});

describe('全市场面板（真库规模断言）', () => {
  let panel: UniversePanel;

  beforeAll(async () => {
    if (!SCALE_READY) return;
    panel = await loadUniversePanel({
      start: '2023-01-01',
      end: '2025-12-31',
      extraSymbols: [...FIXED_ETF_POOL, DEFENSIVE_ETF, 'sh510300'],
      indexCodes: WEAK_PERIOD_INDEXES,
    });
  }, 180_000);

  it.skipIf(!SCALE_READY)(`标的数落在实测区间（${SKIP_REASON_NO_SCALE_DATA}）`, () => {
    // 实测 1894；预留 ±15% 余量以容忍行情库追加历史/新标的
    expect(panel.symbols.length).toBeGreaterThanOrEqual(1500);
    expect(panel.symbols.length).toBeLessThanOrEqual(2200);
    // 升序且无重复
    expect(panel.symbols).toEqual([...panel.symbols].sort());
    expect(new Set(panel.symbols).size).toBe(panel.symbols.length);
  });

  it.skipIf(!SCALE_READY)('barCount > 400_000（实测 2,038,316）', () => {
    expect(panel.barCount).toBeGreaterThan(400_000);
  });

  it.skipIf(!SCALE_READY)('四指数都有 bar（实测各 727 根）', () => {
    for (const code of WEAK_PERIOD_INDEXES) {
      const bars = panel.indexBars.get(code);
      expect(bars, `指数 ${code} 缺失`).toBeDefined();
      expect(bars!.length).toBeGreaterThan(0);
    }
    // 指数不进 ETF 轨（构建面板时不允许把 class 混淆）
    expect(panel.signalBars.has('sh000300')).toBe(false);
  });

  it.skipIf(!SCALE_READY)('execBars 的 preclose > 0 覆盖率 100%（实测 1,017,704/1,017,704）', () => {
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

  it.skipIf(!SCALE_READY)('固定池 / 防御 ETF / 基准 都在面板里（extraSymbols 生效）', () => {
    for (const symbol of [DEFENSIVE_ETF, 'sh510300', FIXED_ETF_POOL[0]]) {
      expect(panel.signalBars.has(symbol), `${symbol} 不在 signalBars`).toBe(true);
      expect(panel.execBars.has(symbol), `${symbol} 不在 execBars`).toBe(true);
    }
  });
});
