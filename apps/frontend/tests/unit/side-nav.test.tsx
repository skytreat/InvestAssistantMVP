/**
 * T76 ① · 桌面左侧导航栏（PRD §5.8 #7）
 *
 * ## 覆盖的验收断言（Wave 7 卡 4）
 *
 * - A1：`innerWidth = 1440` → 左侧栏存在（`getByRole('navigation', { name: '主导航' })` 可见）且**垂直排列**
 * - A4：侧栏入口**顺序** = ux_v2 §1-2 业务流顺序（裁决 D-11）
 * - A5：当前页入口带 `aria-current="page"` 且有可见高亮（F-G1 回归）
 * - A9：非管理员在侧栏 / 顶栏都看不到「管理员」入口；管理员看得到
 *
 * ⚠️ **jsdom 没有 layout engine** —— 「垂直排列」「可见高亮」只能断言**结构契约**
 *    （`flex-direction: column` / `background !== transparent`），
 *    真实像素由卡 6 的真浏览器探针兜底。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { screen, within } from '@testing-library/react';
import { renderWithRouter } from '../helpers';
import App from '../../src/App';
import SideNav from '../../src/components/SideNav';
import { NAV_ITEMS, Navbar } from '../../src/pages/_shared';
import { useUserStore } from '../../src/store/user';

/* ------------------------------------------------------------------ *
 * 期望值（口径来源见注释）
 * ------------------------------------------------------------------ */

/**
 * ux_v2 §1-2 业务流顺序（裁决 D-11）
 *
 * ⚠️ ux_v2 §1-2 的建议顺序是「仪表盘 → 交易录入 → 条件选股 → K线图 → 策略信号 → 交易复盘 → 管理员」，
 *    T74 追加的「候选池」按 PRD §5.8 #7 放在「交易复盘」与「设置」之间。
 */
const UX_ORDER = [
  '仪表盘',
  '交易录入',
  '条件选股',
  'K线图',
  '策略信号',
  '交易复盘',
  '候选池',
  '设置',
  '管理员',
];

/**
 * PRD §5.8 #7 逐字的 6 个桌面入口 → 实现里的标签
 *
 * ⚠️ 同一功能在 PRD（口语）与实现（页面标题）里叫法不同，这里显式建映射，
 *    **不做字符串模糊匹配**（否则「选股」会误命中「条件选股」之外的其它入口）。
 */
const PRD_DESKTOP_ENTRIES: { prd: string; impl: string }[] = [
  { prd: '持仓', impl: '仪表盘' },
  { prd: 'K线', impl: 'K线图' },
  { prd: '选股', impl: '条件选股' },
  { prd: '复盘', impl: '交易复盘' },
  { prd: '候选池', impl: '候选池' },
  { prd: '设置', impl: '设置' },
];

/** jsdom 默认视口宽度（1024）*/
const JSDOM_DEFAULT_WIDTH = 1024;

/** 改视口宽度（hook 在挂载时读 `window.innerWidth`，故必须在 render 之前改）*/
function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

/** 取某个导航容器里的入口文案（按 DOM 顺序）*/
function navLabels(nav: HTMLElement): string[] {
  return within(nav)
    .getAllByRole('link')
    .map((a) => a.textContent ?? '');
}

beforeEach(() => {
  useUserStore.setState({
    token: 'tok-test',
    refreshToken: null,
    username: 'tester',
    role: 'admin',
  });
});

afterEach(() => {
  setViewportWidth(JSDOM_DEFAULT_WIDTH);
});

describe('T76 ① · 桌面左侧导航栏（PRD §5.8 #7）', () => {
  it('桌面端（≥1024px）显示左侧导航且含 PRD §5.8 #7 的 6 个入口', () => {
    setViewportWidth(1440);
    renderWithRouter(<App />, { initialEntries: ['/notfound'] });

    // A1：左侧栏存在且可见
    const sideNav = screen.getByRole('navigation', { name: '主导航' });
    expect(sideNav).toBeVisible();
    expect(sideNav).toHaveAttribute('data-testid', 'side-nav');

    // PRD §5.8 #7 的 6 个入口逐个在位
    const labels = navLabels(sideNav);
    for (const { prd, impl } of PRD_DESKTOP_ENTRIES) {
      expect(labels, `PRD §5.8 #7 的「${prd}」入口缺失`).toContain(impl);
    }

    // A1：垂直排列（结构契约 —— jsdom 无 layout engine）
    const list = sideNav.querySelector('ul');
    expect(list).not.toBeNull();
    expect(list?.style.flexDirection).toBe('column');
  });

  it('左侧导航顺序按业务流程重排（ux_v2 §1-2）', () => {
    setViewportWidth(1440);
    renderWithRouter(<App />, { initialEntries: ['/notfound'] });

    const sideNav = screen.getByRole('navigation', { name: '主导航' });
    expect(navLabels(sideNav)).toEqual(UX_ORDER);
  });

  it('顶栏平铺导航与左侧栏是同一批入口（顺序逐项相等）', () => {
    // 平板（768~1023px）：无左侧栏，入口由顶栏承担
    setViewportWidth(800);
    renderWithRouter(<App />, { initialEntries: ['/notfound'] });

    const topNav = screen.getByRole('navigation', { name: '主导航' });
    expect(navLabels(topNav)).toEqual(UX_ORDER);
    // 平板下**不该**出现左侧栏
    expect(screen.queryByTestId('side-nav')).not.toBeInTheDocument();
  });

  it('当前页导航项带 aria-current=page 且有高亮', () => {
    renderWithRouter(<SideNav items={NAV_ITEMS} isAdmin={true} />, { initialEntries: ['/kline'] });

    const active = screen.getByRole('link', { name: 'K线图' });
    expect(active).toHaveAttribute('aria-current', 'page');
    // 可见高亮：激活态底色不是 transparent（ui-spec §4「当前页必须有可见高亮」）
    expect(active.style.background).not.toBe('');
    expect(active.style.background).not.toBe('transparent');
    expect(active.style.fontWeight).toBe('600');

    // 非当前页不带 aria-current
    expect(screen.getByRole('link', { name: '仪表盘' })).not.toHaveAttribute('aria-current');
  });

  it('非管理员不渲染管理员入口', () => {
    renderWithRouter(<SideNav items={NAV_ITEMS} isAdmin={false} />);

    expect(screen.queryByRole('link', { name: '管理员' })).not.toBeInTheDocument();
    // 其余入口不受影响
    expect(screen.getByRole('link', { name: '设置' })).toBeInTheDocument();
  });

  it('管理员看得到管理员入口（侧栏与顶栏都有）', () => {
    // 侧栏
    const { unmount } = renderWithRouter(<SideNav items={NAV_ITEMS} isAdmin={true} />);
    expect(screen.getByRole('link', { name: '管理员' })).toHaveAttribute('href', '/admin');
    unmount();

    // 顶栏（平板 800px —— 无左侧栏，入口由顶栏承担）
    setViewportWidth(800);
    renderWithRouter(<Navbar />);
    expect(screen.getByRole('link', { name: '管理员' })).toHaveAttribute('href', '/admin');
  });

  it('非管理员在顶栏也看不到管理员入口', () => {
    useUserStore.setState({ token: 'tok-test', refreshToken: null, username: 'tester', role: 'user' });
    setViewportWidth(800);
    renderWithRouter(<Navbar />);

    expect(screen.queryByRole('link', { name: '管理员' })).not.toBeInTheDocument();
  });
});
