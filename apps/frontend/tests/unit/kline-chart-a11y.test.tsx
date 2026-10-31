/**
 * KlineChart 包装层的 a11y 收口用例（Wave 7 · 卡 6 · `/kline` 的 2 条 serious）
 *
 * ## 守的是哪两条 serious
 *
 * 真浏览器 axe 在 `/kline` 上报的 2 条 serious，**根因都在图表容器**：
 *
 * | # | axe 规则 | impact | 根因 | 修法（**在包装层**，不改库）|
 * |---|---|---|---|---|
 * | 1 | `aria-prohibited-attr` | serious | 包装层的裸 `<div aria-label="K 线图">` —— 无 role 的 `<div>` 隐式角色是 `generic`，`generic` **禁止** `aria-label` | 给包装层加 `role="figure"`（允许作者提供可访问名，且**不像 `role="img"` 会把子节点整体设为 presentational**）|
 * | 2 | `tabindex` | serious | **klinecharts 注入**的图表容器带 `tabIndex = 1`（正数 tabindex 打断浏览器自然 Tab 顺序）| 包装层在建图后把该节点的 `tabindex` 归一为 `0`（**不改 `node_modules`**）|
 *
 * ⚠️ axe 的 `color-contrast` 在 jsdom 恒 incomplete —— 本文件只钉**结构契约**
 *   （role / aria-label / tabindex），真浏览器那一层由 `scripts/a11y-check.mjs` 兜底。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { installFakeCanvas, restoreFakeCanvas } from '../helpers/fakeCanvas';
import KlineChart from '../../src/components/KlineChart';
import { DEFAULT_INDICATOR_PARAMS } from '../../src/indicators/chartParams';
import type { ChartBar } from '../../src/indicators/chartBars';

/** 造一根最小的 K 线（字段齐全即可，指标值不被本文件断言）*/
function makeBar(i: number): ChartBar {
  return {
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    timestamp: 1790000000000 + i * 86400000,
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 1000,
    amount: 10000,
    ma1: 10,
    ma2: 10,
    ma3: 10,
    ma4: 10,
    dif: 0,
    dea: 0,
    macd: 0,
    rsi: 50,
    k: 50,
    d: 50,
    j: 50,
    signal: null,
    trades: [],
  };
}

const BARS: ChartBar[] = [makeBar(0), makeBar(1), makeBar(2)];

describe('K 线图包装层 a11y（Wave 7 卡 6）', () => {
  beforeAll(() => {
    // klinecharts 在 jsdom 里没有 canvas 2D context → 装替身才能建图
    installFakeCanvas();
  });

  afterAll(() => {
    restoreFakeCanvas();
  });

  it('K 线图：包装层容器带 role=figure（裸 div 上的 aria-label 会被 aria-prohibited-attr 判违规）', async () => {
    render(
      <KlineChart
        symbol="sh600000"
        period="day"
        bars={BARS}
        dataSignature="sig-1"
        params={DEFAULT_INDICATOR_PARAMS}
        showMa
        subIndicator="macd"
      />,
    );

    const container = screen.getByTestId('kline-chart-container');
    expect(container.getAttribute('role')).toBe('figure');
    expect(container.getAttribute('aria-label')).toBe('K 线图');
  });

  it('K 线图：库注入的图表容器 tabindex 被归一为 0（不再是正数）且带图形语义', async () => {
    render(
      <KlineChart
        symbol="sh600000"
        period="day"
        bars={BARS}
        dataSignature="sig-2"
        params={DEFAULT_INDICATOR_PARAMS}
        showMa
        subIndicator="macd"
      />,
    );

    const container = screen.getByTestId('kline-chart-container');
    // klinecharts 会把自己的图表容器 append 进我们的容器
    await waitFor(() => expect(container.firstElementChild).not.toBeNull());

    const libContainer = container.firstElementChild as HTMLElement;
    expect(libContainer.hasAttribute('tabindex')).toBe(true);
    // 🔴 不得是正数（正数 tabindex 打断自然 Tab 顺序 → axe `tabindex` 规则 serious）
    expect(Number(libContainer.getAttribute('tabindex'))).toBe(0);
    expect(libContainer.getAttribute('role')).toBe('img');
    expect(libContainer.getAttribute('aria-label')).toBe('K 线图');
  });
});
