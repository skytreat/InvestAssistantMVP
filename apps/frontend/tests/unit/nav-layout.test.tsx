/**
 * T76 ②③④ · 顶栏 hamburger + 容器 fluid + 断点 padding
 *
 * ## 覆盖的验收断言（Wave 7 卡 4）
 *
 * - A2：`innerWidth = 800`（平板）→ 左侧栏**不存在**，顶栏导航**可见**（功能对等）
 * - A3：`innerWidth = 375` → 顶栏只有 hamburger 按钮；点它 → 菜单展开且 `aria-expanded === 'true'`；ESC → 收起
 * - A6：`App.tsx` / `pages/_shared.tsx` 中不得再出现 `maxWidth`（T76 验收 ④ 的落地判据）
 * - A7：容器 fluid（`width: 100%` + `box-sizing: border-box`），不出现 `width: 1200px` 之类的固定值
 * - A8：`global.css` 中存在 `@media (max-width: 768px)` 规则命中 `.page-container`
 *
 * ⚠️ **断点 padding 只能在真浏览器量**（jsdom 不解析 media query）——
 *    本文件断言的是「断点规则确实落在 CSS 文件里」这条**结构契约**，
 *    真实像素由卡 6 的真浏览器溢出探针兜底。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../helpers';
import App from '../../src/App';
import { Navbar } from '../../src/pages/_shared';
import { useUserStore } from '../../src/store/user';

/** jsdom 默认视口宽度（1024）*/
const JSDOM_DEFAULT_WIDTH = 1024;

const SRC_DIR = path.resolve(__dirname, '../../src');

/** 改视口宽度（hook 在挂载时读 `window.innerWidth`，故必须在 render 之前改）*/
function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

/** 读 src 下的源文件文本 */
function readSrc(relative: string): string {
  return fs.readFileSync(path.resolve(SRC_DIR, relative), 'utf8');
}

beforeEach(() => {
  useUserStore.setState({
    token: 'tok-test',
    refreshToken: null,
    username: 'tester',
    role: 'user',
  });
});

afterEach(() => {
  setViewportWidth(JSDOM_DEFAULT_WIDTH);
});

describe('T76 ③ · `<768px` 顶栏折叠为 hamburger 菜单', () => {
  it('<768px 顶栏折叠为 hamburger 菜单（aria-expanded 切换 + ESC 关闭）', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderWithRouter(<Navbar />);

    // 顶栏只有 hamburger 按钮 —— 没有平铺的导航入口
    const button = screen.getByRole('button', { name: '打开导航菜单' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'mobile-menu');
    // 收起状态下「主导航」不可见（读屏也读不到）
    expect(screen.queryByRole('navigation', { name: '主导航' })).not.toBeInTheDocument();

    // 点开 → 菜单出现，aria-expanded 变 true
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('navigation', { name: '主导航' });
    expect(menu).toBeVisible();
    expect(menu).toHaveAttribute('id', 'mobile-menu');
    // 菜单里是纵向的入口列表
    expect(menu.querySelector('ul')?.style.flexDirection).toBe('column');

    // ESC → 收起
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: '主导航' })).not.toBeInTheDocument();
  });

  it('平板（768~1023px）无左侧栏但顶栏导航可见（功能对等，不是「无导航」）', () => {
    setViewportWidth(800);
    renderWithRouter(<App />, { initialEntries: ['/notfound'] });

    // 左侧栏不存在
    expect(screen.queryByTestId('side-nav')).not.toBeInTheDocument();
    // 顶栏导航可见
    const topNav = screen.getByRole('navigation', { name: '主导航' });
    expect(topNav).toBeVisible();
    // ⚠️ 用 `within` 限定在顶栏导航内 —— 404 页自身也有同名快捷入口链接
    expect(within(topNav).getByRole('link', { name: '仪表盘' })).toBeInTheDocument();
    // 没有 hamburger（平板用平铺导航）
    expect(screen.queryByRole('button', { name: '打开导航菜单' })).not.toBeInTheDocument();
  });

  it('桌面（≥1024px）左侧栏出现，顶栏不再重复渲染同一批入口', () => {
    setViewportWidth(1440);
    renderWithRouter(<App />, { initialEntries: ['/notfound'] });

    expect(screen.getByTestId('side-nav')).toBeInTheDocument();
    // 顶栏里不再有「主导航」导航（否则同一批入口渲染两遍）
    const navs = screen.getAllByRole('navigation');
    expect(navs).toHaveLength(1);
  });
});

describe('T76 ④ · 容器 fluid（去掉固定 maxWidth 硬编码）', () => {
  it('容器 fluid：无固定 maxWidth 硬编码（App.tsx / _shared.tsx 均无 maxWidth）', () => {
    // A6：这两个文件里不得再出现 maxWidth
    expect(readSrc('App.tsx')).not.toMatch(/maxWidth/);
    expect(readSrc('pages/_shared.tsx')).not.toMatch(/maxWidth/);

    // 全站：固定上限只允许出现在 token 定义与共享样式层
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/maxWidth:\s*(MAX_WIDTH|1200)/.test(text)) {
            hits.push(path.relative(SRC_DIR, full));
          }
        }
      }
    };
    walk(SRC_DIR);
    expect(hits.sort()).toEqual(['theme/styles.ts']);

    // tokens.ts 里 MAX_WIDTH 保留（桌面仍需 1200px 上限）
    expect(readSrc('theme/tokens.ts')).toMatch(/MAX_WIDTH = 1200/);
  });

  it('容器是 fluid 的：width:100% + border-box + 挂 page-container 类名', () => {
    setViewportWidth(375);
    renderWithRouter(<App />, { initialEntries: ['/notfound'] });

    const container = document.querySelector<HTMLElement>('.page-container');
    expect(container).not.toBeNull();
    expect(container?.style.width).toBe('100%');
    expect(container?.style.boxSizing).toBe('border-box');
    // 不是固定宽度
    expect(container?.style.width).not.toBe('1200px');
    expect(container?.style.maxWidth).toBe('');
  });

  it('容器断点 padding 走 global.css 的 @media（≤768px 时 padding=12px）', () => {
    // A8：断点 padding 必须真的落在 CSS 文件里（inline style 表达不了 @media）
    const css = readSrc('styles/global.css');
    const idx = css.indexOf('@media (max-width: 768px)');
    expect(idx).toBeGreaterThan(-1);

    const mediaBlock = css.slice(idx);
    expect(mediaBlock).toMatch(/\.page-container\s*\{[^}]*padding:\s*12px/);

    // 桌面默认 24px（SPACING.pagePadding）
    expect(css).toMatch(/\.page-container\s*\{\s*padding:\s*24px/);

    // 组件侧只挂 className，不在 inline style 里写死断点 padding
    expect(readSrc('App.tsx')).toMatch(/className="page-container"/);
  });
});
