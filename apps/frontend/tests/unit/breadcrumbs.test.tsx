import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import React from 'react';
import Breadcrumbs from '../../src/components/Breadcrumbs';
import { renderWithRouter } from '../helpers';

/**
 * T79 ④ · 面包屑组件
 *
 * 行为契约：
 * - 祖先项渲染为可点击的 `<Link>`；
 * - 当前页不可点击，且带 `aria-current="page"`；
 * - 分隔符对读屏隐藏；
 * - 空数组不渲染任何 DOM。
 */
describe('T79 ④ · Breadcrumbs', () => {
  it('祖先可点击、当前页带 aria-current', () => {
    renderWithRouter(
      <Breadcrumbs
        items={[{ label: '仪表盘', to: '/' }, { label: 'K线图', to: '/kline' }, { label: 'sh600000' }]}
      />,
    );

    const nav = screen.getByRole('navigation', { name: '面包屑' });
    expect(nav).toBeInTheDocument();

    expect(screen.getByRole('link', { name: '仪表盘' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'K线图' })).toHaveAttribute('href', '/kline');

    const current = screen.getByText('sh600000');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'sh600000' })).not.toBeInTheDocument();

    // 分隔符对读屏隐藏
    const separators = nav.querySelectorAll('[aria-hidden="true"]');
    expect(separators).toHaveLength(2);
    separators.forEach((el) => expect(el.textContent).toBe('/'));
  });

  it('items 为空时不渲染', () => {
    const { container } = renderWithRouter(<Breadcrumbs items={[]} />);
    expect(container.querySelector('[data-testid="breadcrumbs"]')).toBeNull();
  });
});
