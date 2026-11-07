/**
 * M3 —— `--universe dynamic` 全市场面板装载：**参数校验**（纯函数，无行情库也跑）
 *
 * 🔴 2026-11-06 测试基建改造：本文件原先还有 5 条**真库规模**断言
 *   （1894 只标的 / 2,038,316 根 bar / 四指数各 727 根），已拆到
 *   `backtest-m3-dynamic-panel.anchors.test.ts` —— 那 5 条必须读 1.24 GB 真库，
 *   与日常套件混跑会把进程内存峰值推到 ~3.65 GB。
 *   ⇒ 真库断言：`npm run test:anchors -w @invest/backend`（环境不是真库会直接抛错）。
 *   ⇒ 本文件只剩 3 条**纯参数校验**（在查询之前抛，CI 必跑）。
 */
import { describe, expect, it } from 'vitest';
import {
  loadUniversePanel,
  validatePanelOptions,
} from '../../src/services/backtest/universe/dynamicPanel.js';

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
