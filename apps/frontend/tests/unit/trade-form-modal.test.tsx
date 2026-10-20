import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import TradeFormModal, { type TradeFormModalProps } from '../../src/components/TradeFormModal';
import { mockErrorResponse, mockResponse, renderWithRouter } from '../helpers';

/**
 * T67 · 卡 4 交易录入弹窗（TradeFormModal）用例
 *
 * 覆盖卡 4 的验收断言：
 * - A1 代码预填 + 只读；
 * - A2 交易类型由触发方决定（buy / sell）；
 * - A3 ESC 关闭；
 * - A4 点遮罩关闭；
 * - A5 提交载荷（URL / method / 逐字段）；
 * - A6 操作理由为空 → 不发请求 + 中文提示；
 * - A7 数量为 0 → 不发请求 + 中文提示；
 * - A8 提交成功 → 父组件重新拉取 `/api/holding`；
 * - A9 `open=false` → 不渲染任何 DOM；
 * - A10 弹窗内**没有**实时预估面板（那属 T68 ④）。
 *
 * ## 载荷字段名的依据
 *
 * `apps/backend/src/routes/trade.ts:103-114` 的请求体类型（后端源码为准，不是凭想象）：
 * `asset_code` / `trade_type` / `trade_date` / `trade_time` / `quantity` / `price` /
 * `fee` / `trade_reason` / `remark` / `system_followed`。
 *
 * ## `trade_type` 的**取值**为什么不是 `'sell'`
 *
 * UI 上是「买入 / 卖出」（PRD §5.3 行 231），但载荷里卖出方向发的是 **`reduce`**：
 * - `Requirements_simplified.md` §5.1 行 95-104：7 种业务类型里**没有 `'sell'`**，
 *   「减仓 = 部分卖出」「清仓 = 全部卖出」；
 * - DDL 的 CHECK 约束（`configStore.ts:31`，本机 `data/business.db` 复制件实测）
 *   同样不含 `'sell'` → INSERT 'sell' → `SQLITE_CONSTRAINT_CHECK` → 后端 500。
 *
 * ⇒ 断言写 `'reduce'`（详见组件 `PAYLOAD_TRADE_TYPE` 的注释）。
 *
 * ## api mock
 *
 * 只 mock `src/api/client` 的 `api.get` / `api.post`（页面层惯例），
 * 后端 envelope 用 `tests/helpers.tsx` 的 `mockResponse` / `mockErrorResponse` 造。
 */

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock, post: postMock } }));

/* ------------------------------------------------------------------ *
 * 渲染辅助
 * ------------------------------------------------------------------ */

/** 渲染弹窗（默认：买入 sh600000，open=true）*/
function renderModal(props: Partial<TradeFormModalProps> = {}) {
  const onCancel = vi.fn();
  const onDone = vi.fn();
  const utils = renderWithRouter(
    <TradeFormModal open assetCode="sh600000" side="buy" onCancel={onCancel} onDone={onDone} {...props} />,
  );
  return { ...utils, onCancel, onDone };
}

/**
 * 填一份**合法**表单
 *
 * 交易日期与成交时间都写成固定值 → 载荷可逐字段精确断言（不依赖「今天」）。
 */
function fillValidForm(): void {
  fireEvent.change(screen.getByLabelText('交易日期'), { target: { value: '2026-10-20' } });
  fireEvent.change(screen.getByLabelText('成交时间'), { target: { value: '10:30:00' } });
  fireEvent.change(screen.getByLabelText('数量'), { target: { value: '100' } });
  fireEvent.change(screen.getByLabelText('价格'), { target: { value: '6.5' } });
  fireEvent.change(screen.getByLabelText('手续费'), { target: { value: '5.5' } });
  fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: 'MACD 金叉买入' } });
}

/** 提交按钮 */
function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '提交交易' }) as HTMLButtonElement;
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  postMock.mockResolvedValue(mockResponse({ trade_id: 1, position: { qty: 100, avgCost: 6.5 } }));
  getMock.mockResolvedValue(mockResponse([]));
});

/* ------------------------------------------------------------------ *
 * 字段 / 预填
 * ------------------------------------------------------------------ */

describe('TradeFormModal · 字段与预填', () => {
  it('字段齐全：标的代码 / 交易类型 / 交易日期 / 成交时间 / 数量 / 价格 / 手续费 / 操作理由', () => {
    renderModal();

    expect(screen.getByLabelText('标的代码')).toBeInTheDocument();
    expect(screen.getByLabelText('交易类型')).toBeInTheDocument();
    expect(screen.getByLabelText('交易日期')).toBeInTheDocument();
    expect(screen.getByLabelText('成交时间')).toBeInTheDocument();
    expect(screen.getByLabelText('数量')).toBeInTheDocument();
    expect(screen.getByLabelText('价格')).toBeInTheDocument();
    expect(screen.getByLabelText('手续费')).toBeInTheDocument();
    expect(screen.getByLabelText('操作理由')).toBeInTheDocument();
  });

  it('标的代码预填且只读', () => {
    renderModal({ assetCode: 'sh600000' });

    const code = screen.getByLabelText('标的代码') as HTMLInputElement;
    expect(code.value).toBe('sh600000');
    expect(code.readOnly).toBe(true);
  });

  it('成交时间预填当前时间（秒级 HH:mm:ss，与后端 validateTradeTime 同口径）', () => {
    renderModal();

    const time = screen.getByLabelText('成交时间') as HTMLInputElement;
    expect(time.value).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('交易类型由触发方决定：买入', () => {
    renderModal({ side: 'buy' });

    const select = screen.getByLabelText('交易类型') as HTMLSelectElement;
    expect(select.value).toBe('buy');
    expect(select.options[select.selectedIndex].text).toBe('买入');
  });

  it('交易类型由触发方决定：卖出', () => {
    renderModal({ side: 'sell' });

    const select = screen.getByLabelText('交易类型') as HTMLSelectElement;
    expect(select.value).toBe('sell');
    expect(select.options[select.selectedIndex].text).toBe('卖出');
    // 标题也跟随方向
    expect(screen.getByRole('dialog')).toHaveAccessibleName('卖出 sh600000');
  });
});

/* ------------------------------------------------------------------ *
 * 本地必填校验
 * ------------------------------------------------------------------ */

describe('TradeFormModal · 本地必填校验', () => {
  it('操作理由为空 → 提交按钮 disabled + 有中文提示，且不发请求', () => {
    renderModal();

    expect(submitButton()).toBeDisabled();
    expect(screen.getByText(/操作理由必填/)).toBeInTheDocument();

    // 填齐其它字段、只留理由为空 → 仍然 disabled、不发请求
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('价格'), { target: { value: '6.5' } });
    expect(submitButton()).toBeDisabled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('数量为 0 → 提交按钮 disabled + 有中文提示，且不发请求', () => {
    renderModal();

    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('价格'), { target: { value: '6.5' } });
    fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: 'MACD 金叉买入' } });

    expect(submitButton()).toBeDisabled();
    expect(screen.getByText('数量需大于 0')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('价格为负 → 提交按钮 disabled，且不发请求', () => {
    renderModal();

    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('价格'), { target: { value: '-1' } });
    fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: 'MACD 金叉买入' } });

    expect(submitButton()).toBeDisabled();
    expect(screen.getByText('价格需大于或等于 0')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('全部字段合法 → 提交按钮可用', () => {
    renderModal();
    fillValidForm();

    expect(submitButton()).toBeEnabled();
  });
});

/* ------------------------------------------------------------------ *
 * 提交
 * ------------------------------------------------------------------ */

describe('TradeFormModal · 提交', () => {
  it('提交成功：api.post 只调 1 次，URL=/trade，载荷逐字段符合后端契约', async () => {
    const user = userEvent.setup();
    const { onDone } = renderModal({ side: 'buy' });
    fillValidForm();

    await user.click(submitButton());

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(getMock).not.toHaveBeenCalled();

    const [url, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/trade');
    expect(body).toEqual({
      asset_code: 'sh600000',
      trade_type: 'buy',
      trade_date: '2026-10-20',
      trade_time: '10:30:00',
      quantity: 100,
      price: 6.5,
      fee: 5.5,
      trade_reason: 'MACD 金叉买入',
    });

    // 成功后回调 onDone（父组件据此刷新持仓）
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('提交成功：卖出方向的 trade_type 为 reduce（DDL 合法值，详见组件注释）', async () => {
    const user = userEvent.setup();
    renderModal({ side: 'sell' });
    fillValidForm();

    await user.click(submitButton());

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    // ⚠️ 不是 'sell' —— 'sell' 既不是 §5.1 的 7 种业务类型之一，也不在 DDL 的 CHECK 约束里
    //    （实测 INSERT 'sell' → SQLITE_CONSTRAINT_CHECK → 后端 500）
    expect(body.trade_type).toBe('reduce');
  });

  it('提交中：按钮 disabled 且显示「提交中…」', async () => {
    const user = userEvent.setup();
    let resolvePost: (value: unknown) => void = () => {};
    postMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );

    renderModal();
    fillValidForm();
    await user.click(submitButton());

    const pending = screen.getByRole('button', { name: '提交中…' }) as HTMLButtonElement;
    expect(pending).toBeDisabled();

    await act(async () => {
      resolvePost(mockResponse({ trade_id: 1 }));
    });
  });

  it('提交失败：显示后端返回的中文 message', async () => {
    const user = userEvent.setup();
    postMock.mockRejectedValue(mockErrorResponse(409, 'HOLDING_INSUFFICIENT', '持仓不足：无法sell sh600000'));

    const { onDone } = renderModal({ side: 'sell' });
    fillValidForm();

    await user.click(submitButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('持仓不足：无法sell sh600000'));
    expect(onDone).not.toHaveBeenCalled();
    // 失败后按钮恢复可用（可以改参数重试）
    expect(submitButton()).toBeEnabled();
  });

  it('提交成功后父组件重新拉取 /api/holding（持仓卡与资产卡一起刷新）', async () => {
    const user = userEvent.setup();

    /** 模拟批次 5 的接线：onDone → 关闭弹窗 + 重新拉取 /api/holding */
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <TradeFormModal
          open={open}
          assetCode="sh600000"
          side="buy"
          onCancel={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            void getMock('/holding');
          }}
        />
      );
    }

    renderWithRouter(<Harness />);
    fillValidForm();
    await user.click(submitButton());

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    expect(getMock).toHaveBeenCalledWith('/holding');
  });
});

/* ------------------------------------------------------------------ *
 * 关闭
 * ------------------------------------------------------------------ */

describe('TradeFormModal · 关闭', () => {
  it('ESC 关闭 → 触发 onCancel', () => {
    const { onCancel } = renderModal();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('点击遮罩关闭 → 触发 onCancel', () => {
    const { onCancel } = renderModal();

    fireEvent.click(screen.getByTestId('trade-form-overlay'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('点击弹窗内部不关闭', () => {
    const { onCancel } = renderModal();

    fireEvent.click(screen.getByRole('dialog'));

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('open=false → 不渲染任何 DOM', () => {
    const { container } = renderWithRouter(
      <TradeFormModal open={false} assetCode="sh600000" side="buy" onCancel={vi.fn()} />,
    );

    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * a11y
 * ------------------------------------------------------------------ */

describe('TradeFormModal · a11y', () => {
  it('role="dialog" + aria-modal="true" + aria-labelledby 指向标题', () => {
    renderModal();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).toBe('买入 sh600000');

    // 可访问名来自标题
    expect(dialog).toHaveAccessibleName('买入 sh600000');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('操作理由的提示通过 aria-describedby 关联到控件', () => {
    renderModal();

    const reason = screen.getByLabelText('操作理由');
    const describedBy = reason.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toContain('操作理由必填');
  });
});

/* ------------------------------------------------------------------ *
 * 负向边界：T68 的实时预估面板不在本卡范围
 * ------------------------------------------------------------------ */

describe('TradeFormModal · 不越界到 T68', () => {
  it('弹窗内没有实时预估面板', () => {
    renderModal();

    expect(screen.queryByText(/预估/)).toBeNull();
    expect(screen.queryByText(/新均价/)).toBeNull();
  });
});
