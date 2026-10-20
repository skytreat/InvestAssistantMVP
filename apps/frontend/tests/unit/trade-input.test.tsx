/**
 * T68 · 交易录入页（TradeInput）用例
 *
 * 覆盖 T68 任务卡的 ①~⑧ + G4.5（`trade_time` 提交前预检）：
 *
 * | 编号 | 要求 | 对应用例 |
 * |---|---|---|
 * | ① | 交易类型改 Tab 组（5 个主入口 + 除权补充次级入口）| 「Tab 组与字段联动」 |
 * | ② | 所有 label 中文化（无 `trade_reason` 等英文变量名残留）| 「label 中文化」 |
 * | ③ | `trade_reason` 必填 + 空值阻止提交 + 字段级红框 + 提示紧贴字段下方 | 「操作理由必填」 |
 * | ④ | 实时预估面板（新均价与 core golden 一致）| 「实时预估 · core golden」 |
 * | ⑤ | 减仓 / 清仓实时校验持仓 → 超持仓红字 + 禁用按钮 | 「持仓充足性校验」 |
 * | ⑥ | 除权补充理由自动填 + 不可编辑 | 「除权补充」 |
 * | ⑦ | 预设标签按钮按交易类型出现 / 消失 | 「预设标签」 |
 * | ⑧ | 375px 视口下 formRow 垂直排列 | 「响应式」 |
 * | G4.5 | 成交时刻占用预检：命中 → 禁用提交 + 提示；失败 → 仍可提交 | 「成交时刻预检」 |
 *
 * ## 端点口径（实测，非想象）
 *
 * - 持仓：**`GET /api/holding/:asset_code`**
 *   （后端 `apps/backend/src/routes/trade.ts:446` 登记的路由；
 *   ⚠️ 实施计划 T68 卡片里写的是 `/api/positions/:asset_code`，**与实现不符**，
 *   本前端按**实现**调用，SDD §4.4 的路由清单也是 `/api/holding`）；
 * - 成交时刻预检：**`GET /api/trade/check-duplicate`**
 *   （参数 `asset_code` / `trade_type` / `trade_date` / `trade_time`；后端端点由并行任务实现，
 *   端点不存在时前端按「预检失败不阻断提交」处理）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TradeInput from '../../src/pages/TradeInput';
import {
  PositionOversellError,
  TRADE_TYPE_DIRECTION,
  calculateMovingWeightedCost,
  estimateNewPosition,
  type TradeRecord,
} from '../../src/indicators/movingWeightedCost';
import { mockErrorResponse, mockResponse, renderWithRouter } from '../helpers';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock, post: postMock } }));

/** 可被用例改写的后端返回（默认值 = 正常路径）*/
const mockState = {
  /** `GET /api/holding/:asset_code` 的返回（null = 查无持仓）*/
  holding: { totalQuantity: 100, avgCost: 10 } as { totalQuantity: number; avgCost: number } | null,
  /** `GET /trade/check-duplicate` 的返回；`null` = 未命中；`'reject'` = 预检失败 */
  duplicate: null as null | { taken: boolean; taken_at?: string } | 'reject',
};

beforeEach(() => {
  mockState.holding = { totalQuantity: 100, avgCost: 10 };
  mockState.duplicate = null;

  getMock.mockReset();
  postMock.mockReset();

  getMock.mockImplementation(async (url: string) => {
    if (url === '/symbols/search') return mockResponse([]);
    if (url.startsWith('/holding/')) {
      if (mockState.holding === null)
        return mockResponse({ asset_code: 'sh600000', totalQuantity: 0, avgCost: 0 });
      return mockResponse({ asset_code: 'sh600000', ...mockState.holding });
    }
    if (url === '/trade/check-duplicate') {
      if (mockState.duplicate === 'reject') {
        // 模拟后端 400 PARAM_INVALID（参数缺失/非法）—— 语义是「无法确定」，前端须仍允许提交
        throw mockErrorResponse(400, 'PARAM_INVALID', 'asset_code 必填');
      }
      return mockResponse(mockState.duplicate ?? { taken: false });
    }
    throw new Error(`未预期的接口调用: ${url}`);
  });

  postMock.mockResolvedValue(mockResponse({ trade_id: 1, position: { qty: 200, avgCost: 15 } }));
});

/* ------------------------------------------------------------------ *
 * 渲染 / 交互辅助
 * ------------------------------------------------------------------ */

function renderPage() {
  return renderWithRouter(<TradeInput />);
}

/** 设置视口宽度（jsdom 的 innerWidth 是只读 getter → 必须 defineProperty）*/
function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
}

/** 填入标的代码（触发持仓查询）*/
async function fillAssetCode(code = 'sh600000'): Promise<void> {
  // ⚠️ 自动补全会异步拉候选 → 必须用 act 包住并等微任务落地，
  //    否则 React 报「update was not wrapped in act(...)」
  await act(async () => {
    fireEvent.change(screen.getByLabelText('股票代码'), { target: { value: code } });
  });
}

/** 填数量 / 价格 / 手续费 */
function fillNumbers(quantity: string, price: string, fee = '0'): void {
  fireEvent.change(screen.getByLabelText('数量'), { target: { value: quantity } });
  fireEvent.change(screen.getByLabelText('价格'), { target: { value: price } });
  fireEvent.change(screen.getByLabelText('手续费'), { target: { value: fee } });
}

/** 填操作理由 */
function fillReason(reason = '策略触发'): void {
  fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: reason } });
}

/** 提交按钮 */
function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '提交交易' }) as HTMLButtonElement;
}

/** 字段是否带「危险红框」（jsdom 会把 hex 归一化成 rgb()，两种都认）*/
function hasDangerBorder(el: HTMLElement): boolean {
  const border = el.style.border ?? '';
  return border.includes('#dc2626') || border.includes('220, 38, 38');
}

/* ------------------------------------------------------------------ *
 * ① Tab 组 + 字段联动
 * ------------------------------------------------------------------ */

describe('T68 ① · 交易类型 Tab 组与字段联动', () => {
  it('顶部是 Tab 组：买入 / 加仓 / 减仓 / 清仓 / 除权补充 5 个入口（不再是下拉框）', () => {
    const { container } = renderPage();

    const tablist = screen.getByRole('tablist', { name: '交易类型' });
    expect(tablist).toBeInTheDocument();
    for (const label of ['买入', '加仓', '减仓', '清仓']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('tab', { name: /除权补充/ })).toBeInTheDocument();

    // 原来的 <select> 下拉已被 Tab 组取代
    expect(container.querySelector('select')).toBeNull();
  });

  it('「除权补充」是次级入口：点击后展开 分红 / 送股 / 转增 三个子类型', () => {
    renderPage();

    // 初始不展开
    expect(screen.queryByTestId('trade-exdividend-panel')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /除权补充/ }));

    const panel = screen.getByTestId('trade-exdividend-panel');
    expect(panel).toBeInTheDocument();
    for (const label of ['分红', '送股', '转增']) {
      expect(
        screen.getByTestId(
          `trade-tab-${label === '分红' ? 'dividend' : label === '送股' ? 'bonus' : 'transfer'}`,
        ),
      ).toBeInTheDocument();
      expect(panel.textContent).toContain(label);
    }
  });

  it('收起「除权补充」次级面板 → 交易类型回到「买入」', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /除权补充/ }));
    fireEvent.click(screen.getByTestId('trade-tab-bonus'));
    await waitFor(() =>
      expect(screen.getByTestId('trade-tab-exdividend')).toHaveAttribute('aria-selected', 'true'),
    );

    // 再点一次「除权补充」= 收起次级面板
    fireEvent.click(screen.getByTestId('trade-tab-exdividend'));

    expect(screen.queryByTestId('trade-exdividend-panel')).toBeNull();
    expect(screen.getByRole('tab', { name: '买入' })).toHaveAttribute('aria-selected', 'true');
    expect((screen.getByLabelText('操作理由') as HTMLInputElement).value).toBe('');
  });

  it('切到「减仓」→ 数量栏显示当前持仓（字段联动）', async () => {
    renderPage();
    await fillAssetCode();
    await waitFor(() => expect(screen.getByTestId('estimate-holding')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: '减仓' }));

    expect(screen.getByTestId('trade-quantity-hint')).toHaveTextContent('当前持仓 100 股');
  });

  it('切到「清仓」→ 自动填入当前持仓数量（字段联动）', async () => {
    renderPage();
    await fillAssetCode();
    await waitFor(() => expect(screen.getByTestId('estimate-holding')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: '清仓' }));

    await waitFor(() => expect((screen.getByLabelText('数量') as HTMLInputElement).value).toBe('100'));
  });

  it('切到「分红」（除权补充）→ 理由自动固化且不可编辑（字段联动）', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('交易日期'), { target: { value: '2026-10-20' } });
    fireEvent.click(screen.getByRole('tab', { name: /除权补充/ }));
    fireEvent.click(screen.getByTestId('trade-tab-dividend'));

    await waitFor(() =>
      expect((screen.getByLabelText('操作理由') as HTMLInputElement).value).toBe(
        '人工补充 - 2026-10-20 分红',
      ),
    );
  });
});

/* ------------------------------------------------------------------ *
 * ② label 中文化
 * ------------------------------------------------------------------ */

describe('T68 ② · label 中文化（无英文变量名残留）', () => {
  it('所有 <label> 都是纯中文（不含 trade_reason 等英文标识）', () => {
    const { container } = renderPage();

    const labels = Array.from(container.querySelectorAll('label'));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      const text = (label.textContent ?? '').trim();
      expect(text, `label「${text}」必须是纯中文`).toMatch(/^[一-龥]+$/);
    }
  });

  it('可见文本里不出现 trade_reason / asset_code / trade_type 等英文标识', () => {
    const { container } = renderPage();

    const text = container.textContent ?? '';
    for (const token of [
      'trade_reason',
      'asset_code',
      'trade_type',
      'trade_date',
      'trade_time',
      'quantity',
      'price',
      'fee',
    ]) {
      expect(text, `可见文本不应出现「${token}」`).not.toContain(token);
    }
  });

  it('「操作理由」是唯一的理由字段标签（不再是 trade_reason）', () => {
    renderPage();

    expect(screen.getByLabelText('操作理由')).toBeInTheDocument();
    expect(screen.queryByLabelText('trade_reason')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * ③ 操作理由必填
 * ------------------------------------------------------------------ */

describe('T68 ③ · 操作理由必填', () => {
  it('理由为空 → 提交按钮 disabled + 不发请求', async () => {
    const user = userEvent.setup();
    renderPage();

    fillNumbers('100', '10');
    expect(submitButton()).toBeDisabled();

    await user.click(submitButton());
    expect(postMock).not.toHaveBeenCalled();
  });

  it('理由为空 → 字段级红框 + 错误文案紧贴字段下方', () => {
    renderPage();

    const reason = screen.getByLabelText('操作理由') as HTMLInputElement;
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(hasDangerBorder(reason)).toBe(true);

    // 错误文案是 input 的**下一个兄弟节点**（紧贴字段下方）
    const hint = screen.getByTestId('trade-reason-hint');
    expect(reason.nextElementSibling).toBe(hint);
    expect(hint).toHaveTextContent('操作理由必填');
  });

  it('理由为空时程序化提交也被拦下（不发请求 + 顶部提示）', () => {
    const { container } = renderPage();

    fillNumbers('100', '10');
    const form = container.querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);

    expect(postMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('请检查表单后再提交');
  });

  it('填上理由 → 红框消失 + 提交按钮恢复可用', () => {
    renderPage();

    const reason = screen.getByLabelText('操作理由') as HTMLInputElement;
    expect(hasDangerBorder(reason)).toBe(true);

    fillReason('MACD 金叉买入');
    expect(hasDangerBorder(reason)).toBe(false);
    expect(reason).toHaveAttribute('aria-invalid', 'false');
  });
});

/* ------------------------------------------------------------------ *
 * ④ 实时预估面板（与 core golden 一致）
 * ------------------------------------------------------------------ */

/** `packages/core/tests/fixtures/golden/movingWeightedCost.json`（只读）*/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const golden = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'packages/core/tests/fixtures/golden/movingWeightedCost.json'), 'utf8'),
) as {
  scenarios: Array<{
    id: string;
    name: string;
    trades: TradeRecord[];
    expected: {
      totalQuantity: number;
      avgCost: number;
      totalCostBasis: number;
      realizedPnL: number;
      totalFee: number;
    };
  }>;
};

describe('T68 ④ · 实时预估面板（新均价与 core golden 一致）', () => {
  it('面板存在，随数量 / 价格 / 手续费实时变化', async () => {
    renderPage();
    await fillAssetCode();
    await waitFor(() => expect(screen.getByTestId('estimate-holding')).toBeInTheDocument());

    const panel = screen.getByTestId('trade-estimate-panel');
    expect(panel).toBeInTheDocument();
    expect(screen.getByTestId('estimate-本次金额')).toBeInTheDocument();
    expect(screen.getByTestId('estimate-手续费')).toBeInTheDocument();
    expect(screen.getByTestId('estimate-新均价')).toBeInTheDocument();
    expect(screen.getByTestId('estimate-新数量')).toBeInTheDocument();
  });

  it('新均价与 core golden（A2 场景口径）逐位一致', async () => {
    // 当前持仓 100 股 @ ¥10（= golden A2 的第一笔）→ 再买 100 股 @ ¥20
    // ⇒ 新均价 = (100×10 + 100×20) / 200 = ¥15 —— 与 golden A2 的 avgCost 完全一致
    renderPage();
    await fillAssetCode();
    await waitFor(() => expect(screen.getByTestId('estimate-holding')).toBeInTheDocument());

    fillNumbers('100', '20', '0');

    await waitFor(() => expect(screen.getByTestId('estimate-新均价')).toHaveTextContent('¥15.0000'));
    expect(screen.getByTestId('estimate-新均价')).toHaveTextContent('¥15.0000');
    expect(screen.getByTestId('estimate-新数量')).toHaveTextContent('200 股');
    expect(screen.getByTestId('estimate-本次金额')).toHaveTextContent('¥2000.00');
  });

  it('前端适配层与 core golden 5 个场景逐字段一致（零容差）', () => {
    expect(golden.scenarios.length).toBe(5);

    for (const scenario of golden.scenarios) {
      const actual = calculateMovingWeightedCost(scenario.trades);
      expect(actual.totalQuantity, `${scenario.id} totalQuantity`).toBe(scenario.expected.totalQuantity);
      expect(actual.avgCost, `${scenario.id} avgCost`).toBe(scenario.expected.avgCost);
      expect(actual.totalCostBasis, `${scenario.id} totalCostBasis`).toBe(scenario.expected.totalCostBasis);
      expect(actual.realizedPnL, `${scenario.id} realizedPnL`).toBe(scenario.expected.realizedPnL);
      expect(actual.totalFee, `${scenario.id} totalFee`).toBe(scenario.expected.totalFee);
    }
  });

  it('预估路径（当前持仓 + 本笔交易）与 core golden 5 个场景逐字段一致', () => {
    for (const scenario of golden.scenarios) {
      const prior = scenario.trades.slice(0, -1);
      const last = scenario.trades[scenario.trades.length - 1];

      const priorPosition = calculateMovingWeightedCost(prior);
      const estimate = estimateNewPosition({
        currentQuantity: priorPosition.totalQuantity,
        currentAvgCost: priorPosition.avgCost,
        direction: last.direction,
        quantity: last.quantity,
        price: last.price,
        fee: last.fee ?? 0,
      });

      expect(estimate.newQuantity, `${scenario.id} 预估新数量`).toBe(scenario.expected.totalQuantity);
      expect(estimate.newAvgCost, `${scenario.id} 预估新均价`).toBe(scenario.expected.avgCost);
      expect(estimate.newCostBasis, `${scenario.id} 预估成本基`).toBe(scenario.expected.totalCostBasis);
    }
  });

  it('卖出方向：均价不变、只剩数量（Requirements §5.3 边界）', async () => {
    renderPage();
    await fillAssetCode();
    await waitFor(() => expect(screen.getByTestId('estimate-holding')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: '减仓' }));
    fillNumbers('30', '15', '0');

    await waitFor(() => expect(screen.getByTestId('estimate-新均价')).toHaveTextContent('¥10.0000'));
    expect(screen.getByTestId('estimate-新数量')).toHaveTextContent('70 股');
  });
});

/* ------------------------------------------------------------------ *
 * ⑤ 减仓 / 清仓持仓充足性校验
 * ------------------------------------------------------------------ */

describe('T68 ⑤ · 减仓 / 清仓持仓充足性校验', () => {
  it('超持仓 → 红字提示 + 提交按钮 disabled', async () => {
    renderPage();
    await fillAssetCode();
    await waitFor(() => expect(screen.getByTestId('estimate-holding')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: '减仓' }));
    fillNumbers('150', '15', '0');
    fillReason('止损');

    await waitFor(() => expect(screen.getByTestId('trade-quantity-hint')).toHaveTextContent('超出持仓'));
    expect(screen.getByTestId('estimate-oversold')).toHaveTextContent('超出持仓');
    expect(submitButton()).toBeDisabled();
  });

  it('未超持仓 → 无红字、提交按钮可用', async () => {
    renderPage();
    await fillAssetCode();
    await waitFor(() => expect(screen.getByTestId('estimate-holding')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: '减仓' }));
    fillNumbers('50', '15', '0');
    fillReason('止损');

    await waitFor(() => expect(screen.getByTestId('estimate-新数量')).toHaveTextContent('50 股'));
    expect(screen.queryByTestId('estimate-oversold')).toBeNull();
    expect(submitButton()).toBeEnabled();
  });

  it('持仓查询端点是 GET /api/holding/:asset_code（实测后端实现）', async () => {
    renderPage();
    await fillAssetCode('sh600000');

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/holding/sh600000'));
  });
});

/* ------------------------------------------------------------------ *
 * ⑥ 除权补充：理由自动填 + 不可编辑
 * ------------------------------------------------------------------ */

describe('T68 ⑥ · 除权补充（理由自动填 + 不可编辑）', () => {
  it('切到「送股」→ 理由自动填「人工补充 - {除权日} 送股」且只读', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('交易日期'), { target: { value: '2026-10-20' } });
    fireEvent.click(screen.getByRole('tab', { name: /除权补充/ }));
    fireEvent.click(screen.getByTestId('trade-tab-bonus'));

    await waitFor(() =>
      expect((screen.getByLabelText('操作理由') as HTMLInputElement).value).toBe(
        '人工补充 - 2026-10-20 送股',
      ),
    );

    const reason = screen.getByLabelText('操作理由') as HTMLInputElement;
    expect(reason.readOnly).toBe(true);
    expect(reason).toHaveAttribute('aria-readonly', 'true');
  });

  it('除权补充不要求用户填理由（无红框、无必填提示）', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /除权补充/ }));
    fireEvent.click(screen.getByTestId('trade-tab-transfer'));

    await waitFor(() =>
      expect((screen.getByLabelText('操作理由') as HTMLInputElement).value).toContain('转增'),
    );
    const reason = screen.getByLabelText('操作理由') as HTMLInputElement;
    expect(hasDangerBorder(reason)).toBe(false);
    expect(screen.getByTestId('trade-reason-hint')).toHaveTextContent('由系统固化');
  });

  it('从除权切回「买入」→ 系统固化的理由被清空（可重新填写）', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /除权补充/ }));
    fireEvent.click(screen.getByTestId('trade-tab-dividend'));
    await waitFor(() => expect((screen.getByLabelText('操作理由') as HTMLInputElement).value).not.toBe(''));

    fireEvent.click(screen.getByRole('tab', { name: '买入' }));

    expect((screen.getByLabelText('操作理由') as HTMLInputElement).value).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * ⑦ 预设标签按钮
 * ------------------------------------------------------------------ */

describe('T68 ⑦ · 预设标签按钮（按交易类型出现 / 消失）', () => {
  it('买入 → 策略触发 / 抄底 / 长期持有 出现，止损不出现', () => {
    renderPage();

    expect(screen.getByTestId('reason-tag-策略触发')).toBeInTheDocument();
    expect(screen.getByTestId('reason-tag-抄底')).toBeInTheDocument();
    expect(screen.getByTestId('reason-tag-长期持有')).toBeInTheDocument();
    expect(screen.queryByTestId('reason-tag-止损')).toBeNull();
  });

  it('减仓 → 止损出现、抄底消失', () => {
    renderPage();

    fireEvent.click(screen.getByRole('tab', { name: '减仓' }));

    expect(screen.getByTestId('reason-tag-止损')).toBeInTheDocument();
    expect(screen.queryByTestId('reason-tag-抄底')).toBeNull();
  });

  it('除权补充 → 标签全部消失（理由由系统固化）', () => {
    renderPage();

    fireEvent.click(screen.getByRole('tab', { name: /除权补充/ }));
    fireEvent.click(screen.getByTestId('trade-tab-bonus'));

    expect(screen.queryByTestId('trade-reason-tags')).toBeNull();
  });

  it('点击标签 → 一键填入操作理由', () => {
    renderPage();

    fireEvent.click(screen.getByTestId('reason-tag-抄底'));

    expect((screen.getByLabelText('操作理由') as HTMLInputElement).value).toBe('抄底');
  });
});

/* ------------------------------------------------------------------ *
 * ⑧ 响应式：375px 下 formRow 垂直排列
 * ------------------------------------------------------------------ */

describe('T68 ⑧ · 响应式（375px 下 formRow 垂直排列）', () => {
  it('375px 视口 → 所有 formRow 都是 column 方向（label 在控件上方）', () => {
    setViewportWidth(375);
    const { container } = renderPage();

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="trade-form-row"]'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.style.flexDirection).toBe('column');
    }
  });

  it('375px 视口 → label 取消 minWidth（不再挤压控件）', () => {
    setViewportWidth(375);
    const { container } = renderPage();

    const label = container.querySelector('label') as HTMLElement;
    // ⚠️ CSSOM 会把 0 的单位规范化掉 → 读回来是 '0' 而不是 '0px'
    expect(label.style.minWidth).toBe('0');
  });

  it('桌面视口 → formRow 保持 row 方向', () => {
    setViewportWidth(1280);
    const { container } = renderPage();

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="trade-form-row"]'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.style.flexDirection).toBe('row');
    }
  });
});

/* ------------------------------------------------------------------ *
 * G4.5 · 成交时刻占用预检
 * ------------------------------------------------------------------ */

describe('G4.5 · trade_time 提交前预检', () => {
  it('命中占用 → 禁用提交 + 提示（成交时间字段红框）', async () => {
    mockState.duplicate = { taken: true, taken_at: '2026-10-20T10:30:00.000Z' };
    renderPage();

    await fillAssetCode();
    await waitFor(() =>
      expect(screen.getByTestId('trade-time-hint')).toHaveTextContent('该成交时刻已被占用'),
    );

    const time = screen.getByLabelText('成交时间') as HTMLInputElement;
    expect(hasDangerBorder(time)).toBe(true);
    expect(submitButton()).toBeDisabled();
  });

  it('命中占用 → 不发请求（点提交也不会 POST）', async () => {
    const user = userEvent.setup();
    mockState.duplicate = { taken: true, taken_at: '2026-10-20T10:30:00.000Z' };
    renderPage();

    await fillAssetCode();
    fillNumbers('100', '10');
    fillReason('策略触发');
    await waitFor(() =>
      expect(screen.getByTestId('trade-time-hint')).toHaveTextContent('该成交时刻已被占用'),
    );

    await user.click(submitButton());
    expect(postMock).not.toHaveBeenCalled();
  });

  it('预检失败（端点未上线 / 超时）→ 不阻断提交（乐观 UI）', async () => {
    mockState.duplicate = 'reject';
    renderPage();

    await fillAssetCode();
    fillNumbers('100', '10');
    fillReason('策略触发');

    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(screen.getByTestId('trade-time-hint')).not.toHaveTextContent('已被占用');
  });

  it('预检请求按约定参数发起（asset_code / trade_type / trade_date / trade_time）', async () => {
    renderPage();

    await fillAssetCode('sh600000');
    fireEvent.change(screen.getByLabelText('交易日期'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('成交时间'), { target: { value: '10:30:00' } });

    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/trade/check-duplicate', {
        params: {
          asset_code: 'sh600000',
          trade_type: 'buy',
          trade_date: '2026-10-20',
          trade_time: '10:30:00',
        },
      }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 提交
 * ------------------------------------------------------------------ */

describe('T68 · 提交', () => {
  it('提交成功：载荷逐字段符合后端契约', async () => {
    const user = userEvent.setup();
    renderPage();

    await fillAssetCode('sh600000');
    fireEvent.change(screen.getByLabelText('交易日期'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('成交时间'), { target: { value: '10:30:00' } });
    fillNumbers('100', '10', '5');
    fillReason('MACD 金叉买入');

    await waitFor(() => expect(submitButton()).toBeEnabled());
    await user.click(submitButton());

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [url, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/trade');
    expect(body).toEqual({
      asset_code: 'sh600000',
      trade_type: 'buy',
      trade_date: '2026-10-20',
      trade_time: '10:30:00',
      quantity: 100,
      price: 10,
      fee: 5,
      trade_reason: 'MACD 金叉买入',
    });
  });

  it('提交失败：展示后端返回的中文 message', async () => {
    const user = userEvent.setup();
    postMock.mockRejectedValue(
      mockErrorResponse(409, 'HOLDING_INSUFFICIENT', '持仓不足：无法reduce sh600000'),
    );
    renderPage();

    await fillAssetCode('sh600000');
    fillNumbers('100', '10');
    fillReason('策略触发');
    await waitFor(() => expect(submitButton()).toBeEnabled());

    await user.click(submitButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('持仓不足：无法reduce sh600000'));
  });

  it('持仓查询失败 → 提示但**不阻断提交**（服务端仍会二次校验）', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (url === '/symbols/search') return mockResponse([]);
      if (url.startsWith('/holding/')) throw new Error('持仓接口不可用');
      if (url === '/trade/check-duplicate') return mockResponse({ taken: false });
      throw new Error(`未预期的接口调用: ${url}`);
    });

    renderPage();
    await fillAssetCode('sh600000');

    await waitFor(() => expect(screen.getByText(/持仓信息获取失败/)).toBeInTheDocument());

    fillNumbers('100', '10');
    fillReason('策略触发');
    await waitFor(() => expect(submitButton()).toBeEnabled());
  });
});

/* ------------------------------------------------------------------ *
 * 自动补全（SymbolAutocomplete）
 * ------------------------------------------------------------------ */

describe('T68 · 标的自动补全', () => {
  it('输入 ≥ 2 个字符 → 弹出候选列表；点击候选 → 填入完整代码', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (url === '/symbols/search') {
        return mockResponse([
          { symbol: 'sh600000', name: '浦发银行' },
          { symbol: 'sh600519', name: '贵州茅台' },
        ]);
      }
      if (url.startsWith('/holding/')) return mockResponse({ totalQuantity: 0, avgCost: 0 });
      if (url === '/trade/check-duplicate') return mockResponse({ taken: false });
      throw new Error(`未预期的接口调用: ${url}`);
    });

    renderPage();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('股票代码'), { target: { value: '浦发' } });
    });

    await waitFor(() => expect(screen.getByText('浦发银行')).toBeInTheDocument());
    expect(screen.getByText('贵州茅台')).toBeInTheDocument();

    fireEvent.click(screen.getByText('浦发银行'));

    await waitFor(() =>
      expect((screen.getByLabelText('股票代码') as HTMLInputElement).value).toBe('sh600000'),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 适配层：超卖边界 + 交易类型 → 方向映射
 * ------------------------------------------------------------------ */

describe('T68 · 移动加权适配层的边界口径', () => {
  it('严格模式（默认）：卖出超持仓 → 抛 PositionOversellError', () => {
    expect(() =>
      calculateMovingWeightedCost([
        { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10 },
        { date: '2026-10-20', direction: 'sell', quantity: 150, price: 12 },
      ]),
    ).toThrow(PositionOversellError);
  });

  it('容错模式：不抛错但置 hasOversell，且持仓数量被夹到 0（不产生负持仓）', () => {
    const result = calculateMovingWeightedCost(
      [
        { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10 },
        { date: '2026-10-20', direction: 'sell', quantity: 150, price: 12 },
      ],
      { strictOversell: false },
    );

    expect(result.hasOversell).toBe(true);
    expect(result.oversellDetail?.requested).toBe(150);
    expect(result.oversellDetail?.available).toBe(100);
    expect(result.totalQuantity).toBe(0);
  });

  it('交易类型 → 移动加权方向：add 必须是 buy（与后端 mapToCoreTrade 同口径）', () => {
    expect(TRADE_TYPE_DIRECTION.buy).toBe('buy');
    expect(TRADE_TYPE_DIRECTION.add).toBe('buy');
    expect(TRADE_TYPE_DIRECTION.reduce).toBe('sell');
    expect(TRADE_TYPE_DIRECTION.clear).toBe('sell');
    // 除权三类不参与移动加权
    expect(TRADE_TYPE_DIRECTION.dividend).toBeNull();
    expect(TRADE_TYPE_DIRECTION.bonus).toBeNull();
    expect(TRADE_TYPE_DIRECTION.transfer).toBeNull();
  });
});
