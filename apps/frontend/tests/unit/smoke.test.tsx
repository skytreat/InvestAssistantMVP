import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { Navbar, MOBILE_BREAKPOINT, MOBILE_TABBAR_HEIGHT } from '../../src/pages/_shared';
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

  it('Navbar 能渲染出品牌名与合规声明', () => {
    renderWithRouter(React.createElement(Navbar));
    expect(screen.getByText('InvestAssistant')).toBeInTheDocument();
    expect(screen.getByText(/本工具不构成投资建议/)).toBeInTheDocument();
  });

  it('常量有合理取值', () => {
    expect(MOBILE_BREAKPOINT).toBe(768);
    expect(MOBILE_TABBAR_HEIGHT).toBeGreaterThan(0);
  });
});
