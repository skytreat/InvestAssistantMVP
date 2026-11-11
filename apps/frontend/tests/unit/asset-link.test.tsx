import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import React from 'react';
import AssetLink from '../../src/components/AssetLink';
import { renderWithRouter } from '../helpers';

/**
 * 交易复盘表格「标的列」：名称优先 + 代码副行 + 跳 K 线页。
 * 名称查不到（raw_symbol_name 覆盖约 70%）时必须回退显示代码，不能留空。
 */
describe('AssetLink 标的名称 + K 线超链接', () => {
  it('有名称：名称主行 + 代码副行，链接到 /kline?symbol=<code>', () => {
    renderWithRouter(<AssetLink assetCode="sh600000" assetName="浦发银行" />);

    const link = screen.getByRole('link', { name: /浦发银行/ });
    expect(link).toHaveAttribute('href', '/kline?symbol=sh600000');
    expect(link).toHaveTextContent('浦发银行');
    expect(link).toHaveTextContent('sh600000');
  });

  it('无名称：回退显示代码，仍可跳 K 线', () => {
    renderWithRouter(<AssetLink assetCode="sz000001" assetName={null} />);

    const link = screen.getByRole('link', { name: /sz000001/ });
    expect(link).toHaveAttribute('href', '/kline?symbol=sz000001');
    expect(link).toHaveTextContent('sz000001');
  });

  it('名称为空白串：按无名称处理（不渲染空主行）', () => {
    renderWithRouter(<AssetLink assetCode="sh600519" assetName="   " />);

    const link = screen.getByRole('link', { name: /sh600519/ });
    expect(link).toHaveTextContent('sh600519');
    expect(link.title).toContain('sh600519');
  });

  it('inline：标的名(代码) 单行展示，并链接 K 线页', () => {
    renderWithRouter(<AssetLink assetCode="sh600519" assetName="贵州茅台" variant="inline" />);

    const link = screen.getByRole('link', { name: '贵州茅台(sh600519)' });
    expect(link).toHaveAttribute('href', '/kline?symbol=sh600519');
    expect(link).toHaveTextContent('贵州茅台(sh600519)');
  });

  it('inline：无名称时回退为代码，仍链接 K 线页', () => {
    renderWithRouter(<AssetLink assetCode="sz000001" assetName={null} variant="inline" />);

    const link = screen.getByRole('link', { name: 'sz000001' });
    expect(link).toHaveAttribute('href', '/kline?symbol=sz000001');
    expect(link).toHaveTextContent('sz000001');
  });
});
