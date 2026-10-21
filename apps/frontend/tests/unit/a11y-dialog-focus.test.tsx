import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import ConfirmDialog from '../../src/components/ConfirmDialog';
import TradeFormModal from '../../src/components/TradeFormModal';
import Review from '../../src/pages/Review';
import { renderWithRouter } from '../helpers';

/**
 * 弹窗焦点管理用例（Wave 7 · 卡 5 · T76 ⑤ / ui-spec §4「焦点锁定」 / gap-list F-A15）
 *
 * ## 覆盖的验收断言（卡 5「验收断言」A4 ~ A6）
 *
 * - A4：`ConfirmDialog` 打开 → `document.activeElement` 在弹窗内；
 *       连续按 Tab **不会离开**弹窗；关闭 → 焦点回到触发按钮；
 * - A5：`Review.tsx` 的编辑弹窗 DOM 含 `role="dialog"` 与 `aria-modal="true"`；
 *       按 ESC → 弹窗消失；
 * - A6：`TradeFormModal` 打开 → 焦点进入弹窗；ESC → 关闭。
 *
 * ## 为什么这些能在 jsdom 里测（卡 5「风险与坑」第 3 条）
 *
 * jsdom **实现了** `document.activeElement` 与 `HTMLElement.focus()`，
 * 所以「焦点进没进弹窗」「焦点归没归还」是**真断言**，不必等真浏览器。
 *
 * ⚠️ 但 jsdom **不实现 Tab 键的原生焦点移动** ⇒ 「Tab 不逃逸」必须**显式模拟**：
 *    把焦点放到弹窗内最后一个可聚焦元素上，派发 `keydown{Tab}`，
 *    断言焦点被**回绕**到第一个可聚焦元素（而不是落到弹窗外）。
 *
 * ## 实现方式
 *
 * 焦点锁定由 `src/components/useDialogFocus.ts` 提供（原生 `keydown` +
 * `document.activeElement`，**不引第三方库** —— 裁决 D-15）。
 */

/* ------------------------------------------------------------------ *
 * api mock（Review 页要打接口）
 * ------------------------------------------------------------------ */

const { getMock, postMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock, post: postMock, patch: patchMock },
}));

/** 造一个后端统一 envelope 的成功响应 */
function ok(data: unknown) {
  return { data: { code: 0, data, timestamp: '2026-10-21T00:00:00.000Z', success: true } };
}

beforeEach(() => {
  getMock.mockImplementation(async (url: string) => {
    if (url === '/review/trades') return ok([]);
    if (url === '/review/yield') return ok(null);
    if (url === '/asset-stat/history') return ok([]);
    return ok([]);
  });
  postMock.mockResolvedValue(ok(null));
  patchMock.mockResolvedValue(ok(null));
});

/** 派发一次 Tab / Shift+Tab 键按下（jsdom 不做原生焦点移动，只能显式模拟）*/
function pressTab(opts: { shift?: boolean } = {}): void {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Tab',
      shiftKey: opts.shift ?? false,
    });
  });
}

/** 弹窗内所有可聚焦元素（与 `useDialogFocus` 的判定口径一致）*/
function focusablesIn(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('弹窗焦点管理（T76 ⑤ · 焦点锁定 / 焦点回归）', () => {
  it('ConfirmDialog：打开后焦点进入弹窗且 Tab 不逃逸', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开弹窗
          </button>
          <ConfirmDialog
            open={open}
            title="确认删除"
            message="删除后不可恢复"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }

    render(<Harness />);

    const trigger = screen.getByRole('button', { name: '打开弹窗' });
    act(() => {
      trigger.focus();
    });
    expect(document.activeElement).toBe(trigger);

    act(() => {
      trigger.click();
    });

    const dialog = screen.getByRole('dialog');
    // ① 焦点必须落在弹窗内（落在「确认」按钮上）
    expect(dialog.contains(document.activeElement)).toBe(true);

    // ② Tab 不能逃出弹窗：把焦点放到最后一个可聚焦元素上按 Tab → 回绕到第一个
    const items = focusablesIn(dialog);
    expect(items.length).toBeGreaterThan(1);
    const last = items[items.length - 1];
    act(() => {
      last.focus();
    });
    expect(document.activeElement).toBe(last);

    pressTab();

    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(items[0]);

    // ③ Shift+Tab 从第一个回绕到最后一个（同样不逃逸）
    act(() => {
      items[0].focus();
    });
    pressTab({ shift: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('ConfirmDialog：关闭后焦点归还触发元素', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开弹窗
          </button>
          <ConfirmDialog
            open={open}
            title="确认删除"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }

    render(<Harness />);

    const trigger = screen.getByRole('button', { name: '打开弹窗' });
    act(() => {
      trigger.focus();
      trigger.click();
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.activeElement).not.toBe(trigger);

    act(() => {
      screen.getByRole('button', { name: '取消' }).click();
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    // 焦点归还触发元素
    expect(document.activeElement).toBe(trigger);
  });

  it('TradeFormModal：ESC 关闭且焦点进入弹窗', () => {
    const onCancel = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            买入
          </button>
          <TradeFormModal
            open={open}
            assetCode="sh600000"
            side="buy"
            onCancel={() => {
              onCancel();
              setOpen(false);
            }}
          />
        </>
      );
    }

    render(<Harness />);

    const trigger = screen.getByRole('button', { name: '买入' });
    act(() => {
      trigger.focus();
      trigger.click();
    });

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);

    // ESC 关闭
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    // 关闭后焦点归还触发元素
    expect(document.activeElement).toBe(trigger);
  });

  it('Review 编辑弹窗：role=dialog + aria-modal + ESC 关闭', async () => {
    const TRADES = [
      {
        id: 1,
        asset_code: 'sh600000',
        trade_type: 'buy',
        trade_date: '2026-10-01',
        quantity: 100,
        price: 5,
        fee: 5,
        trade_reason: '测试买入',
        is_auto_import: 0,
        system_followed: 1,
        strategy_match: 1,
        is_stop_loss: 0,
        review_summary: '',
        remark: null,
        created_at: '2026-10-01 10:00:00',
      },
    ];
    getMock.mockImplementation(async (url: string) => {
      if (url === '/review/trades') {
        return { data: { code: 0, data: TRADES, timestamp: 'x', success: true } };
      }
      return ok([]);
    });

    renderWithRouter(<Review />);

    const editButton = await screen.findByRole('button', { name: '编辑复盘' });
    act(() => {
      editButton.focus();
      editButton.click();
    });

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // 标题节点与 aria-labelledby 关联
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)).toHaveTextContent('编辑复盘');
    // 焦点进入弹窗
    expect(dialog.contains(document.activeElement)).toBe(true);

    // ESC 关闭
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    // 关闭后焦点归还触发元素
    expect(document.activeElement).toBe(editButton);
  });
});
