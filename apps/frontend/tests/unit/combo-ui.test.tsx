import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import Settings from '../../src/pages/Settings';
import { renderWithRouter, mockResponse } from '../helpers';

/**
 * 组合策略 UI（T133 / PA-08）
 *
 * 覆盖：
 * ① 组合列表渲染（条件 / 适用品种 / 冷却 / 配置版本）
 * ② 新建 → POST `/strategy/combos`；编辑 → PUT `/strategy/combos/:id`
 * ③ 启用开关 → PUT `/strategy/combos/:id/toggle`；删除 → 确认框 → DELETE
 * ④ 条件候选只含 monitor 且非风险/需持仓插件（与后端 `isAllowedComboCondition` 同口径）
 * ⑤ 跨境两档明确提示「当前不产出信号」（行情层无标维字段 ⇒ fail-closed）
 */

const { getMock, postMock, putMock, delMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  delMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock, post: postMock, put: putMock, patch: vi.fn(), delete: delMock },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/settings?tab=combos',
}));

/**
 * 插件清单：候选过滤的边界都在这里体现
 * - `turnover_filter`：filter 类 → 不可作条件
 * - `risk_guard`：monitor 但 `subCategory='risk'` → 不可作条件
 * - `profit_stop`：monitor 但 `requiresPositions=true` → 不可作条件
 * - `rsi_oversold` / `macd_golden`：唯二合法候选（新建时默认各占一行）
 */
const PLUGINS = [
  {
    id: 'turnover_filter',
    name: '流动性过滤',
    category: 'filter',
    description: '剔除低流动性标的',
    enabled: 1,
    params: { minTurnover: 10000000 },
    paramSchema: [
      { key: 'minTurnover', label: '最低成交额', type: 'number', min: 0, max: 1e9, default: 10000000 },
    ],
  },
  {
    id: 'risk_guard',
    name: '风险防护',
    category: 'monitor',
    subCategory: 'risk',
    description: '大盘风险过滤',
    enabled: 1,
    params: {},
    paramSchema: [{ key: 'days', label: '回看天数', type: 'integer', min: 1, max: 250, default: 120 }],
  },
  {
    id: 'profit_stop',
    name: '止盈止损',
    category: 'monitor',
    subCategory: 'profit',
    requiresPositions: true,
    description: '依赖持仓',
    enabled: 1,
    params: {},
    paramSchema: [{ key: 'ratio', label: '比例', type: 'number', min: 0, max: 100, default: 10 }],
  },
  {
    id: 'rsi_oversold',
    name: 'RSI 超卖',
    category: 'monitor',
    description: 'RSI 低于阈值触发买入信号',
    enabled: 1,
    params: { period: 6, threshold: 30 },
    paramSchema: [
      { key: 'period', label: '周期', type: 'number', min: 2, max: 100, default: 6 },
      { key: 'threshold', label: '阈值', type: 'number', min: 0, max: 100, default: 30, unit: '%' },
    ],
  },
  {
    id: 'macd_golden',
    name: 'MACD 金叉',
    category: 'monitor',
    description: 'DIF 上穿 DEA',
    enabled: 1,
    params: { fast: 12, slow: 26, signal: 9 },
    paramSchema: [
      { key: 'fast', label: '快线', type: 'integer', min: 2, max: 100, default: 12 },
      { key: 'slow', label: '慢线', type: 'integer', min: 2, max: 200, default: 26 },
      { key: 'signal', label: '信号线', type: 'integer', min: 1, max: 100, default: 9 },
    ],
  },
];

const COMBO = {
  id: 'cmb_1',
  name: '超卖金叉组合',
  enabled: true,
  assetScope: 'stock',
  cooldownBars: 3,
  configVersion: 1,
  conditions: [
    { pluginId: 'rsi_oversold', enabled: true, params: { period: 6, threshold: 30 }, seq: 1 },
    { pluginId: 'macd_golden', enabled: true, params: { fast: 12, slow: 26, signal: 9 }, seq: 2 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockImplementation(async (url: string) => {
    switch (url) {
      case '/strategy/plugins':
        return mockResponse(PLUGINS);
      case '/strategy/combos?include_disabled=1':
        return mockResponse([COMBO]);
      default:
        return mockResponse({ data: [] });
    }
  });
  postMock.mockResolvedValue(mockResponse({ data: null }));
  putMock.mockResolvedValue(mockResponse({ data: null }));
  delMock.mockResolvedValue(mockResponse({ data: null }));
});

describe('组合策略列表（PA-08）', () => {
  it('渲染组合行：名称 / 条件 / 适用品种 / 冷却 / 配置版本', async () => {
    renderWithRouter(<Settings />, { initialEntries: ['/settings?tab=combos'] });

    const row = await screen.findByTestId('combo-row-cmb_1');
    expect(within(row).getByText('超卖金叉组合')).toBeInTheDocument();
    expect(within(row).getByText('cmb_1 · v1')).toBeInTheDocument();
    expect(within(row).getByText('RSI 超卖 + MACD 金叉')).toBeInTheDocument();
    expect(within(row).getByText('仅股票')).toBeInTheDocument();
    expect(within(row).getByText('3 根')).toBeInTheDocument();
    expect(screen.getByTestId('combo-toggle-cmb_1')).toBeChecked();
  });

  it('停用的组合条件在列表里标注「（停用）」，且不产出（列表口径）', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (url === '/strategy/plugins') return mockResponse(PLUGINS);
      return mockResponse([
        {
          ...COMBO,
          conditions: [
            { pluginId: 'rsi_oversold', enabled: true, params: { period: 6, threshold: 30 }, seq: 1 },
            { pluginId: 'macd_golden', enabled: false, params: { fast: 12, slow: 26, signal: 9 }, seq: 2 },
          ],
        },
      ]);
    });

    renderWithRouter(<Settings />, { initialEntries: ['/settings?tab=combos'] });
    const row = await screen.findByTestId('combo-row-cmb_1');
    expect(within(row).getByText('RSI 超卖 + MACD 金叉（停用）')).toBeInTheDocument();
  });
});

describe('组合策略编辑（PA-08）', () => {
  it('新建：默认两行候选条件，保存 → POST /strategy/combos 且列表追加', async () => {
    const created = { ...COMBO, id: 'cmb_new', name: '新组合' };
    postMock.mockResolvedValueOnce(mockResponse(created));

    renderWithRouter(<Settings />, { initialEntries: ['/settings?tab=combos'] });
    await screen.findByTestId('combos-section');
    await userEvent.click(screen.getByTestId('combo-new'));

    const nameInput = await screen.findByLabelText('组合名称');
    await userEvent.type(nameInput, '新组合');
    await userEvent.selectOptions(screen.getByLabelText('适用品种'), 'etf');
    await userEvent.click(screen.getByRole('button', { name: '保存组合' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [url, payload] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/strategy/combos');
    expect(payload.name).toBe('新组合');
    expect(payload.assetScope).toBe('etf');
    expect(payload.cooldownBars).toBe(3);
    // 默认两行条件 = 前两个合法候选（各带 schema 默认参数）
    expect(payload.conditions).toEqual([
      { pluginId: 'rsi_oversold', enabled: true, params: { period: 6, threshold: 30 } },
      { pluginId: 'macd_golden', enabled: true, params: { fast: 12, slow: 26, signal: 9 } },
    ]);

    // onSaved 后列表追加新行（不重新拉列表）
    expect(await screen.findByTestId('combo-row-cmb_new')).toBeInTheDocument();
    expect(screen.getByText(/已保存组合策略「新组合」/)).toBeInTheDocument();
  });

  it('编辑：回填已有配置，保存 → PUT /strategy/combos/:id', async () => {
    putMock.mockResolvedValueOnce(mockResponse({ ...COMBO, name: '改名后的组合', configVersion: 2 }));

    renderWithRouter(<Settings />, { initialEntries: ['/settings?tab=combos'] });
    await screen.findByTestId('combo-row-cmb_1');
    await userEvent.click(screen.getByTestId('combo-edit-cmb_1'));

    const nameInput = await screen.findByLabelText('组合名称');
    expect(nameInput).toHaveValue('超卖金叉组合');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, '改名后的组合');
    await userEvent.click(screen.getByRole('button', { name: '保存组合' }));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [url, payload] = putMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/strategy/combos/cmb_1');
    expect(payload.name).toBe('改名后的组合');
    expect(payload.conditions).toHaveLength(2);
    expect(await screen.findByText('改名后的组合')).toBeInTheDocument();
  });

  it('条件候选排除 filter / 风险类 / 需持仓插件', async () => {
    renderWithRouter(<Settings />, { initialEntries: ['/settings?tab=combos'] });
    await screen.findByTestId('combos-section');
    await userEvent.click(screen.getByTestId('combo-new'));

    const select = await screen.findByLabelText('条件 1 插件');
    const optionTexts = [...(select as HTMLSelectElement).options].map((o) => o.textContent);
    expect(optionTexts).toEqual(['RSI 超卖', 'MACD 金叉']);
    expect(optionTexts).not.toContain('流动性过滤');
    expect(optionTexts).not.toContain('风险防护');
    expect(optionTexts).not.toContain('止盈止损');
  });

  it('跨境两档：选择后明确提示当前不产出信号', async () => {
    renderWithRouter(<Settings />, { initialEntries: ['/settings?tab=combos'] });
    await screen.findByTestId('combos-section');
    await userEvent.click(screen.getByTestId('combo-new'));

    const scope = await screen.findByLabelText('适用品种');
    expect(screen.queryByTestId('combo-scope-note')).not.toBeInTheDocument();

    await userEvent.selectOptions(scope, 'cross_border');
    expect(screen.getByTestId('combo-scope-note')).toHaveTextContent('当前不会产出信号');

    await userEvent.selectOptions(scope, 'exclude_cross_border');
    expect(screen.getByTestId('combo-scope-note')).toHaveTextContent('当前不会产出信号');

    await userEvent.selectOptions(scope, 'all');
    expect(screen.queryByTestId('combo-scope-note')).not.toBeInTheDocument();
  });

  it('名称空 / 条件不足 2 个 → 前端拦截，不发请求', async () => {
    renderWithRouter(<Settings />, { initialEntries: ['/settings?tab=combos'] });
    await screen.findByTestId('combos-section');
    await userEvent.click(screen.getByTestId('combo-new'));

    await screen.findByLabelText('组合名称');
    await userEvent.click(screen.getByRole('button', { name: '保存组合' }));
    expect(await screen.findByText('组合名称不能为空')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('组合名称'), '仅一个条件');
    await userEvent.click(screen.getByRole('button', { name: '删除条件 2' }));
    await userEvent.click(screen.getByRole('button', { name: '保存组合' }));
    expect(await screen.findByText('组合至少需要 2 个条件')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('冷却根数：清空后保存 → 字段旁提示且不发请求；填回合法值后正常保存', async () => {
    postMock.mockResolvedValueOnce(
      mockResponse({ ...COMBO, id: 'cmb_cooldown', name: '冷却校验', cooldownBars: 5 }),
    );

    renderWithRouter(<Settings />, { initialEntries: ['/settings?tab=combos'] });
    await screen.findByTestId('combos-section');
    await userEvent.click(screen.getByTestId('combo-new'));

    await userEvent.type(await screen.findByLabelText('组合名称'), '冷却校验');
    const cooldown = screen.getByLabelText('冷却根数');
    expect(cooldown).toHaveValue(3);

    // 清空 ⇒ 保持为空（旧实现会静默变 0），保存被字段级校验拦下
    await userEvent.clear(cooldown);
    expect(cooldown).toHaveValue(null);
    await userEvent.click(screen.getByRole('button', { name: '保存组合' }));
    expect(await screen.findByTestId('combo-cooldown-error')).toHaveTextContent('冷却根数必须是 1~20 的整数');
    expect(cooldown).toHaveAttribute('aria-invalid', 'true');
    expect(postMock).not.toHaveBeenCalled();

    // 超范围 21 ⇒ 仍被拦下
    await userEvent.type(cooldown, '21');
    await userEvent.click(screen.getByRole('button', { name: '保存组合' }));
    expect(await screen.findByTestId('combo-cooldown-error')).toHaveTextContent('1~20');
    expect(postMock).not.toHaveBeenCalled();

    // 填回 5 ⇒ 提示消失并正常提交数字
    await userEvent.clear(cooldown);
    await userEvent.type(cooldown, '5');
    await userEvent.click(screen.getByRole('button', { name: '保存组合' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('combo-cooldown-error')).not.toBeInTheDocument();
    expect((postMock.mock.calls[0][1] as Record<string, unknown>).cooldownBars).toBe(5);
  });
});

describe('组合启停与删除（PA-08）', () => {
  it('启用开关 → PUT /strategy/combos/:id/toggle', async () => {
    renderWithRouter(<Settings />, { initialEntries: ['/settings?tab=combos'] });
    const toggle = await screen.findByTestId('combo-toggle-cmb_1');
    await userEvent.click(toggle);

    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/strategy/combos/cmb_1/toggle', { enabled: false }),
    );
    expect(await screen.findByText(/「超卖金叉组合」已停用/)).toBeInTheDocument();
  });

  it('删除 → 确认框 → DELETE /strategy/combos/:id 且行消失', async () => {
    renderWithRouter(<Settings />, { initialEntries: ['/settings?tab=combos'] });
    await screen.findByTestId('combo-row-cmb_1');
    await userEvent.click(screen.getByTestId('combo-delete-cmb_1'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('删除组合策略')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(delMock).toHaveBeenCalledWith('/strategy/combos/cmb_1'));
    await waitFor(() => expect(screen.queryByTestId('combo-row-cmb_1')).not.toBeInTheDocument());
    expect(await screen.findByText(/已删除组合策略「超卖金叉组合」/)).toBeInTheDocument();
  });
});
