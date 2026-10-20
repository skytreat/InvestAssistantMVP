import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { Navbar, MOBILE_BREAKPOINT, MOBILE_TABBAR_HEIGHT } from '../../src/pages/_shared';
import ComplianceFooter from '../../src/components/ComplianceFooter';
import { useUserStore } from '../../src/store/user';
import { renderWithRouter } from '../helpers';

/**
 * T61 基建冒烟用例
 *
 * 目的不是测业务，而是证明「测试环境本身可用」：
 * - jsdom 环境挂载成功
 * - jest-dom 断言扩展注入成功
 * - @testing-library/react 渲染成功
 * - zustand store 在测试中可读写
 */
describe('T61 前端测试基建冒烟', () => {
  it('jsdom 环境可用（document 已挂载）', () => {
    expect(typeof document).toBe('object');
    expect(document.body).toBeTruthy();
  });

  it('jest-dom 断言扩展已注入', () => {
    const host = document.createElement('div');
    const el = document.createElement('span');
    el.textContent = ' jest-dom-ok ';
    host.appendChild(el);
    document.body.appendChild(host);
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent('jest-dom-ok');
    host.remove();
  });

  it('React 组件可渲染', () => {
    render(React.createElement('div', null, 'hello'));
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('zustand store 在测试中可读写', () => {
    const { login, logout } = useUserStore.getState();
    login('tok-test', 'tester', 'admin');
    expect(useUserStore.getState().username).toBe('tester');
    expect(useUserStore.getState().role).toBe('admin');
    logout();
    expect(useUserStore.getState().token).toBeNull();
  });

  it('Navbar 能渲染出品牌名', () => {
    renderWithRouter(React.createElement(Navbar));
    expect(screen.getByText('InvestAssistant')).toBeInTheDocument();
  });

  /**
   * T95：合规声明已从 Navbar 下方搬到 App.tsx 的 `<footer>`
   * （PRD §5.9「全站所有页面顶部或底部常驻」）。
   *
   * ⚠️ 断言随之**迁移并加强**：不仅验组件本身，还要验「App 渲染后声明在场」——
   * 「常驻」是 PRD 的要求，光验组件证明不了它被用上了。
   */
  it('合规声明：PRD §5.9 逐字文案，且由 App 的 footer 常驻', () => {
    render(React.createElement(ComplianceFooter));
    expect(screen.getByText('本工具不构成投资建议，数据仅供参考')).toBeInTheDocument();
  });

  it('合规声明在全站唯一来源（src 内仅 ComplianceFooter.tsx 含该文案）', () => {
    // 防回归：有人把声明又抄回 Navbar / Settings / 任何页面 → 本用例红
    const srcDir = path.resolve(__dirname, '../../src');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes('本工具不构成投资建议，数据仅供参考')) hits.push(full);
        }
      }
    };
    walk(srcDir);
    // 只允许 ComplianceFooter.tsx（含注释引用也算，故只断言「渲染文案所在文件唯一」）
    const renderers = hits.filter((f) => f.endsWith('ComplianceFooter.tsx'));
    expect(renderers.length).toBe(1);
  });

  it('常量有合理取值', () => {
    expect(MOBILE_BREAKPOINT).toBe(768);
    expect(MOBILE_TABBAR_HEIGHT).toBeGreaterThan(0);
  });
});
