/**
 * G3.5 · dashboard 375px 文档级横向溢出修复（Wave 3 出口门槛）
 *
 * ## 背景（实测数据，非推断）
 *
 * `scripts/probe-overflow.mjs` 在 375×812 视口下实测：
 * `document.documentElement.scrollWidth − clientWidth = +169px`（判据 ≤ 2 → FAIL），
 * 元凶是「最近日志」表（4 列 / 总宽 483px）的「消息」列（217px）——
 * 内容是后端系统日志里的**运维噪声路径**（如
 * 「插件目录不可读，跳过磁盘加载: /opt/invol/plugins/strategies」），属不可断长字符串。
 *
 * ## 本文件断言的是**结构契约**（jsdom 能测的部分）
 *
 * ⚠️ **jsdom 没有 layout engine**（`clientWidth` 恒 0、`getBoundingClientRect()` 全 0）
 *    → **真实溢出数值只能靠真浏览器探针**（`scripts/probe-overflow.mjs`），
 *    本文件负责把「为什么会溢出」拆成**可回归的结构契约**钉死：
 *
 * | 契约 | 对应真实世界的什么 |
 * |---|---|
 * | 表格外层有 `overflow-x:auto` 的滚动容器 | 表格在**自己内部**滚动 → 文档不被撑宽 |
 * | 滚动容器 `min-width:0` | Grid/Flex 子项默认 `min-width:auto` → 否则容器自己撑破父级 |
 * | 滚动容器 `role="region"` + `aria-label` + `tabindex="0"` | axe `scrollable-region-focusable`（serious）|
 * | 「消息」列长文本截断 + `title` 全文 | 列宽被钉住，不再由长路径决定 |
 *
 * ⚠️ axe 的 `scrollable-region-focusable` 在 jsdom 下**恒判 inapplicable**
 *    （见 `tests/helpers/a11y.ts` 的 `AXE_RULES_UNSUPPORTED_IN_JSDOM`），
 *    故这里只能断言**结构契约**；规则本身的真实验证走**真浏览器**（`scripts/a11y-check.mjs`）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import React from 'react';
import Dashboard from '../../src/pages/Dashboard';
import ScrollableTable from '../../src/components/ScrollableTable';
import { useUserStore } from '../../src/store/user';
import { mockResponse, renderWithRouter } from '../helpers';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock } }));

/**
 * 一条**长文本**日志 —— 复刻实测元凶：
 * 「插件目录不可读，跳过磁盘加载: /opt/invol/plugins/strategies」
 *
 * ⚠️ 这类内容是**运维噪声**（详见 `docs/audit/overflow-probe.md` §7 第 5 条）：
 *    dashboard 把它直接渲染给用户，本身是一个**待裁决的产品问题**。
 *    本用例只锁定「长文本不会把表格撑破」，**不改变日志的过滤语义**。
 */
const LONG_MESSAGE = '插件目录不可读，跳过磁盘加载: /opt/invol/plugins/strategies';

const LOGS = [
  {
    created_at: '2026-10-20 17:02:11',
    log_type: 'plugin',
    level: 'ERROR',
    message: LONG_MESSAGE,
  },
];

const SIGNALS = [
  {
    asset_code: 'sh600000',
    plugin_id: 'rsi_revert',
    direction: 'buy',
    label: 'RSI 跌破超卖线发出买入信号；RSI 升破超买线发出卖出信号',
    trade_date: '2026-10-20',
  },
];

const STAT = {
  trade_date: '2026-10-20',
  total_assets_price_yield: 0.1234,
  total_assets_actual_yield: 0.2345,
  total_profit_price: 1234.56,
  total_profit_actual: -789.01,
};

function installApiMock(): void {
  getMock.mockImplementation(async (url: string) => {
    switch (url) {
      case '/holding':
        return mockResponse([], { summary: null });
      case '/asset-stat/latest':
        return mockResponse(STAT);
      case '/signal':
        return mockResponse(SIGNALS);
      case '/admin/system-log':
        return mockResponse(LOGS, { pagination: { total: 1, totalPages: 1 } });
      default:
        throw new Error(`未预期的接口调用: ${url}`);
    }
  });
}

/** 页面里所有「可横向滚动的表格容器」*/
function scrollRegions(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="scrollable-table"]'));
}

/** 按可访问名取滚动容器*/
function region(container: HTMLElement, label: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[role="region"][aria-label="${label}"]`);
  if (!el) throw new Error(`未找到滚动容器：${label}`);
  return el;
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('G3.5 · ① 表格容器化（文档级溢出归零的前提）', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('「最新信号」表被包在 overflow-x:auto 的滚动容器里', async () => {
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('最新信号');

    const el = region(container, '最新信号表');
    expect(el.style.overflowX).toBe('auto');
    // Grid/Flex 子项默认 min-width:auto → 不显式写 0，容器自己会撑破父级
    // ⚠️ CSSOM 会把 0 的单位规范化掉 → 读回来是 '0' 而不是 '0px'
    expect(el.style.minWidth).toBe('0');
    // 表格确实在这个容器**里面**
    expect(el.querySelector('table[aria-label="最新信号"]')).not.toBeNull();
  });

  it('「最近日志」表被包在 overflow-x:auto 的滚动容器里（admin 角色）', async () => {
    useUserStore.setState({ role: 'admin', token: null, username: null });
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('最近日志');

    const el = region(container, '最近日志表');
    expect(el.style.overflowX).toBe('auto');
    expect(el.style.minWidth).toBe('0');
    expect(el.querySelector('table[aria-label="最近日志"]')).not.toBeNull();
  });

  it('容器化**不新增也不删除**表格（回归护栏：只改包装，不改结构）', async () => {
    useUserStore.setState({ role: 'admin', token: null, username: null });
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('最近日志');

    // dashboard 的表格 = 最新信号 + 最近日志（持仓区已卡片化，见 F-D2）
    expect(container.querySelectorAll('table').length).toBe(2);
    expect(scrollRegions(container).length).toBe(2);
  });
});

describe('G3.5 · ② 滚动容器键盘可达（axe scrollable-region-focusable）', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'admin', token: null, username: null });
    installApiMock();
  });

  it('滚动容器带 role="region" + aria-label + tabindex="0"', async () => {
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('最近日志');

    for (const el of scrollRegions(container)) {
      // axe `scrollable-region-focusable`（serious 级）：可滚动区域必须键盘可达
      expect(el.getAttribute('role')).toBe('region');
      expect(el.getAttribute('tabindex')).toBe('0');
      // role="region" 必须有可访问名，否则读屏只会念「区域」
      expect(el.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('滚动容器的可访问名**互不相同**（防 axe landmark-unique 回归）', async () => {
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('最近日志');

    const names = scrollRegions(container).map((el) => el.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('滚动容器的可访问名与内部表格的 aria-label **刻意错开**（读屏不重名）', async () => {
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('最近日志');

    const el = region(container, '最近日志表');
    const table = el.querySelector('table[aria-label="最近日志"]');
    expect(el.getAttribute('aria-label')).not.toBe(table?.getAttribute('aria-label'));
  });
});

describe('G3.5 · ③ 长文本截断（「消息」列不再由路径长度决定）', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'admin', token: null, username: null });
    installApiMock();
  });

  it('「消息」列的长文本被截断（ellipsis）且 title 属性保留全文', async () => {
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('最近日志');

    const cell = region(container, '最近日志表').querySelector('table tbody tr td:last-child');
    const inner = cell?.firstElementChild as HTMLElement | null;
    expect(inner).not.toBeNull();

    // 视觉截断三件套
    expect(inner?.style.textOverflow).toBe('ellipsis');
    expect(inner?.style.overflow).toBe('hidden');
    expect(inner?.style.whiteSpace).toBe('nowrap');
    // 宽度被钉住（max-width 在**单元格内部的子元素**上，
    // 写在 <td> 上会被 CSS 2.1 忽略 —— 自动表格布局下 max-width 不适用于单元格）
    expect(inner?.style.maxWidth).toBe('220px');
    // 完整内容通过 title 暴露（悬停可见全文）
    expect(inner?.getAttribute('title')).toBe(LONG_MESSAGE);
  });

  it('截断**只作用于视觉**：DOM 里的文本仍是全文（读屏用户仍能读到）', async () => {
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('最近日志');

    const cell = region(container, '最近日志表').querySelector('table tbody tr td:last-child');
    expect(cell?.textContent).toContain(LONG_MESSAGE);
  });
});

describe('ScrollableTable 组件（可复用的滚动容器契约）', () => {
  it('渲染出 role="region" + aria-label + tabindex="0" 的滚动容器', () => {
    const { container } = renderWithRouter(
      <ScrollableTable label="示例表">
        <table aria-label="示例" />
      </ScrollableTable>,
    );

    const el = container.querySelector<HTMLElement>('[data-testid="scrollable-table"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('role')).toBe('region');
    expect(el?.getAttribute('aria-label')).toBe('示例表');
    expect(el?.getAttribute('tabindex')).toBe('0');
    expect(el?.style.overflowX).toBe('auto');
    expect(el?.style.minWidth).toBe('0');
  });

  it('容器只包内容、不改内容（表格原样渲染在容器内）', () => {
    const { container } = renderWithRouter(
      <ScrollableTable label="示例表">
        <table aria-label="示例">
          <tbody>
            <tr>
              <td>单元格</td>
            </tr>
          </tbody>
        </table>
      </ScrollableTable>,
    );

    expect(container.querySelector('table[aria-label="示例"]')).not.toBeNull();
    expect(screen.getByText('单元格')).toBeInTheDocument();
  });
});
