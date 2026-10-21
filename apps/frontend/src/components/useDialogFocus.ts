import { useEffect, useRef, type RefObject } from 'react';

/**
 * 弹窗焦点管理（Wave 7 · 卡 5 · T76 ⑤ / ui-spec §4「焦点锁定」 / gap-list F-A15）
 *
 * ## 要解决什么
 *
 * 1. **打开时把焦点移入弹窗** —— 否则键盘用户的焦点仍留在背景里的触发按钮上，
 *    读屏会继续念背景内容，Tab 会从页面顶部重新走一遍。
 * 2. **Tab 在弹窗内循环（焦点陷阱）** —— 弹窗是模态的，焦点跑到弹窗外就等于
 *    「弹窗没有真正拦住用户」。
 * 3. **关闭后把焦点还给触发元素** —— 否则焦点掉到 `<body>`，键盘用户得从头 Tab。
 *
 * ## 为什么自己实现（不引第三方库）
 *
 * - AGENTS.md：「新增 npm 依赖必须说明理由，禁止随意引入第三方库」；
 * - 实施计划 U21 / ui-spec §5 决策 1：本波禁止引入 CSS Module / Tailwind / 图表库，
 *   架构决策是**约束项**；
 * - 裁决 D-15：「`focus-trap` 之类第三方库不能引，用原生 `keydown` + `document.activeElement` 实现」。
 *
 * ⇒ 只用原生 `keydown` 事件 + `HTMLElement.focus()`，**零新依赖**。
 *
 * ## 实现要点
 *
 * - 可聚焦元素的判定**不看可见性**（jsdom 里 `offsetParent` 恒为 `null`，
 *   用它过滤会把所有元素都滤掉 ⇒ 单测会假绿）；只看 `disabled` / `hidden` / `aria-hidden`。
 * - 焦点陷阱用「**首尾回绕**」实现：焦点在最后一个可聚焦元素上按 Tab → 回到第一个；
 *   在第一个上按 Shift+Tab → 回到最后一个；焦点已在弹窗外 → 拉回第一个。
 * - 焦点归还记在 `open === true` 的那一刻（`document.activeElement` 此时仍是触发元素），
 *   在 `open` 变 false 或组件卸载时归还。
 */

/** 可聚焦元素选择器（表单控件 + 链接 + 带 tabindex 的元素）*/
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** 取容器内的可聚焦元素（按 DOM 顺序）*/
function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  );
}

export interface UseDialogFocusOptions {
  /**
   * 打开后**优先聚焦**的元素（如某个输入框）
   *
   * 不传时：聚焦弹窗内第一个**可编辑**的可聚焦元素；一个都没有时聚焦弹窗容器本身。
   */
  initialFocusRef?: RefObject<HTMLElement>;
  /**
   * 焦点落在**弹窗容器**本身（不给默认按钮「上膛」）
   *
   * ⚠️ 为什么需要这个开关：焦点若落在按钮上，**Enter 会直接激活该按钮**
   *    （浏览器的标准行为）—— 对「确认删除」这类**破坏性**按钮就是「一按回车就删」。
   *    ⇒ 破坏性确认弹窗应当把焦点放在容器上（读屏会念出弹窗标题），
   *    键盘用户再 Tab 一步就能选到按钮。
   */
  focusContainer?: boolean;
}

export interface UseDialogFocusResult<T extends HTMLElement = HTMLElement> {
  /** 弹窗容器 ref（必须挂在 `role="dialog"` 的元素上）*/
  dialogRef: RefObject<T>;
}

/** 只读控件（`readOnly` 的 input / textarea）—— 不适合作为默认落点 */
function isReadOnly(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.readOnly;
  return false;
}

/**
 * 弹窗焦点管理 hook
 *
 * @param open 弹窗是否打开（关闭时**不渲染任何 DOM** 的组件传 `open` 即可）
 * @param options 初始聚焦元素等选项
 */
export function useDialogFocus<T extends HTMLElement = HTMLElement>(
  open: boolean,
  options: UseDialogFocusOptions = {},
): UseDialogFocusResult<T> {
  const dialogRef = useRef<T>(null);
  /** 打开前的焦点所在元素（关闭后归还给它）*/
  const returnFocusRef = useRef<HTMLElement | null>(null);
  /**
   * `options` 是对象字面量，每次渲染都是新引用 ⇒ 不能进依赖数组，
   * 否则 effect 会跟着父组件的重渲染反复重跑（焦点被反复抢走）。
   */
  const initialFocusRef = useRef(options.initialFocusRef);
  initialFocusRef.current = options.initialFocusRef;
  const focusContainer = useRef(options.focusContainer ?? false);
  focusContainer.current = options.focusContainer ?? false;

  useEffect(() => {
    if (!open) return;

    // ① 记下触发元素（此刻 activeElement 仍是点开弹窗的那个按钮）
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement ? active : null;

    // ② 焦点移入弹窗
    const dialog = dialogRef.current;
    if (dialog) {
      const preferred = initialFocusRef.current?.current;
      // 首选按钮可能是 `disabled`（如 TradeFormModal 的「提交交易」在表单未填完时禁用）
      // —— 禁用按钮无法聚焦，此时退回「弹窗内第一个可聚焦元素」。
      const usable = preferred && !preferred.hasAttribute('disabled') ? preferred : undefined;
      const focusable = getFocusable(dialog);
      const target = focusContainer.current
        ? dialog
        : (usable ?? focusable.find((el) => !isReadOnly(el)) ?? focusable[0] ?? dialog);
      // 容器本身要能被聚焦（没有可聚焦子元素时兜底）
      if (!target.hasAttribute('tabindex') && target === dialog) {
        target.setAttribute('tabindex', '-1');
      }
      target.focus();
    }

    // ③ Tab 焦点陷阱（首尾回绕）
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const current = dialogRef.current;
      if (!current) return;
      const focusable = getFocusable(current);
      if (focusable.length === 0) {
        event.preventDefault();
        current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement;
      const inside = activeEl instanceof HTMLElement && current.contains(activeEl);
      if (event.shiftKey) {
        if (!inside || activeEl === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // ④ 关闭 / 卸载时归还焦点
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target && document.contains(target)) {
        target.focus();
      }
    };
  }, [open]);

  return { dialogRef };
}
