/**
 * V3-B15 —— 每日信号生成链路必须写 `user_strategy_signal.sub_category`
 *
 * ## 缺口
 *
 * `persistSignals()` 的第 7 参是 `subCategory`（`signalService.ts:111-125`）。漏传 ⇒ 恒落 NULL。
 * 读取侧用 `(sub_category IS NULL OR sub_category <> 'risk')` 判「非风险」
 * （`routes/signal.ts`、`todaySignals.ts`），所以漏写会让风险类插件（`position_risk_alert`）
 * 产生的 HOLD 提示被读成非风险信号，可能抢占持仓卡徽标。
 *
 * 本文件覆盖 **`routes/admin.ts` 手动生成链路**（`POST /api/admin/run-signal`）——
 * 与 `scheduler.ts` 17:02 定时链路调用同一 `persistSignals`，是同一缺口的两处漏写点之一。
 *
 * 断言：
 *   ① 风险类插件 → `sub_category = 'risk'`
 *   ② 普通插件 → 落自身分类（`momentum`）
 *   ③ 旧口径 `breakout` → 经 `normalizeSubCategory` 归一为 `volume`（证明写入前走了唯一归一口）
 *
 * 用 `app.inject()`（进程内，不 listen、不占端口）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestApp } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';
import { SIGNAL_USER_ID } from '../../src/services/signalService.js';

// 只替换 executeAllPlugins，其余插件引擎能力（normalizeSubCategory 等）保持真实实现
const { executeAllPluginsMock } = vi.hoisted(() => ({ executeAllPluginsMock: vi.fn() }));

vi.mock('../../src/services/pluginEngine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/pluginEngine.js')>();
  return { ...actual, executeAllPlugins: executeAllPluginsMock };
});

const TRADE_DATE = '2026-11-06';

const RISK_SYMBOL = 'sh600031';
const MOMENTUM_SYMBOL = 'sh600032';
const LEGACY_SYMBOL = 'sh600033';

function signal(symbol: string, pluginId: string) {
  return {
    symbol,
    pluginId,
    signalType: 'HOLD' as const,
    label: `${pluginId} 测试信号`,
    timestamp: `${TRADE_DATE}T00:00:00.000Z`,
  };
}

let bundle: TestAppBundle;

beforeAll(async () => {
  bundle = await createTestApp();
  executeAllPluginsMock.mockResolvedValue({
    signals: [],
    stats: { total: 3, success: 3, timeout: 0, error: 0, skip: 0, noData: 0 },
    results: [
      {
        pluginId: 'position_risk_alert',
        subCategory: 'risk',
        status: 'SUCCESS',
        signals: [signal(RISK_SYMBOL, 'position_risk_alert')],
        durationMs: 1,
      },
      {
        pluginId: 'rsi_oversold',
        subCategory: 'momentum',
        status: 'SUCCESS',
        signals: [signal(MOMENTUM_SYMBOL, 'rsi_oversold')],
        durationMs: 1,
      },
      {
        pluginId: 'volume_breakout',
        // 旧口径：应被 normalizeSubCategory 归一为 'volume'
        subCategory: 'breakout',
        status: 'SUCCESS',
        signals: [signal(LEGACY_SYMBOL, 'volume_breakout')],
        durationMs: 1,
      },
    ],
  });
});

afterAll(async () => {
  await bundle?.app.close().catch(() => {});
});

function subCategoryOf(assetCode: string): string | null | undefined {
  const row = bundle.db.db
    .prepare(
      `SELECT sub_category FROM user_strategy_signal
       WHERE user_id = ? AND asset_code = ? AND trade_date = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(SIGNAL_USER_ID, assetCode, TRADE_DATE) as { sub_category: string | null } | undefined;
  return row?.sub_category;
}

/** 调一次手动生成链路（同一交易日的重复调用命中唯一索引 → skip，不改变已有行） */
async function runSignalGenerate() {
  return bundle.app.inject({
    method: 'POST',
    url: '/api/admin/run-signal',
    headers: { authorization: `Bearer ${bundle.adminToken}` },
    payload: { trade_date: TRADE_DATE },
  });
}

describe('V3-B15 · 手动信号生成落库写 sub_category', () => {
  it('风险类插件 → sub_category = risk（不是 NULL）', async () => {
    const res = await runSignalGenerate();
    expect(res.statusCode).toBe(200);

    expect(subCategoryOf(RISK_SYMBOL)).toBe('risk');
  });

  it('普通插件 → 落自身分类（momentum）', async () => {
    await runSignalGenerate();
    expect(subCategoryOf(MOMENTUM_SYMBOL)).toBe('momentum');
  });

  it('旧口径 breakout → 经唯一归一口归一为 volume', async () => {
    await runSignalGenerate();
    expect(subCategoryOf(LEGACY_SYMBOL)).toBe('volume');
  });
});
