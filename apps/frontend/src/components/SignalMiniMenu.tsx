import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import SignalBadge from './SignalBadge';
import {
  DIRECTION_LABEL,
  isSignalStale,
  type Position,
  type PositionSignal,
  type TradeSide,
} from './positionDomain';

/**
 * 信号 → 交易 一键链路 Mini-Menu（T67 · Wave 3 · 卡 7 · ux_v2 建议 E）
 *
 * 依据 ux_v2 行 497-528（建议 E）：
 * - 「在建议 A 的**信号标记**上加一个**二级点击交互**」
 *   （ASCII 稿行 506：`🔔 [▲买入] RSI 32 超卖 ← hover 信号标记 → 弹出 Mini-Menu`）；
 * - 「Mini-Menu 宽度约 180px，显示**插件名 + 参数摘要 + 【立即买入/卖出】按钮**」（行 524）；
 * - 点【立即买入 →】→ 打开 卡 4 的 `TradeFormModal`，**所有字段预填**（行 517-523）；
 * - 「信号方向=持有（灰·）时，Mini-Menu 只显示"当前无触发信号"提示」（行 526）。
 *
 * ## 三条口径裁决（本组件的公式唯一来源）
 *
 * | 裁决 | 内容 | 本文件落点 |
 * |---|---|---|
 * | **D-9** | 数量 = `Math.ceil(totalQuantity / 2)`（买卖同公式） | {@link suggestTradeQuantity} |
 * | **D-10** | **hover + click 双触发**（触屏可达，PRD §5.8 #1「桌面和手机功能对等」） | 见下方「触发方式」 |
 * | **D-11** | 理由 = `${plugin_id} ${label} ${DIRECTION_LABEL[direction]} (${trade_date})`；`label` 为空时省略该段 | {@link buildTradeReason} |
 *
 * ## 触发方式（D-10 的落地细节）
 *
 * - **hover**：包裹层（含触发器 + 菜单本体）的 `onMouseEnter` / `onMouseLeave`。
 *   菜单与触发器在**同一个包裹层**里 → 指针从触发器移到菜单时不会触发 leave
 *   （React 的 enter/leave 语义：进入子元素不算离开父元素）→ 菜单不会「闪一下就没」。
 * - **click**：触发器是真正的 `<button>`，点击 = **确保打开**（`aria-expanded` 同步）。
 *   ⚠️ **hover 与 click 同时存在时的坑**：`userEvent.click()` 会先「移动指针」→
 *       先触发 hover 打开 → 若 click 用「取反」语义会把刚打开的菜单又关掉。
 *       故 click 的语义是 **「确保打开」**（hover 已打开则保持打开），
 *       关闭交给 **鼠标移出 / Esc / 点击菜单外部 / 执行操作**。
 * - 包裹层 `position: relative` —— 菜单是 `position: absolute`，
 *   **不依赖持仓卡容器的定位上下文**（卡 7 风险与坑第 2 条：卡片容器若不是 relative，
 *   浮层会跑到页面别处）。
 *
 * ## 菜单里为什么**只有与信号方向一致的那一个**操作
 *
 * ux_v2 的 ASCII 稿（行 511）画的就是**一个**按钮 `[立即买入 →]`，
 * 且行 519 写明「类型：买入（**从信号 direction 推断**）」。
 * ⇒ `direction='buy'` → 【立即买入】；`direction='sell'` → 【立即卖出】；
 *   `direction='hold'` → 只有「当前无触发信号」，**没有任何操作按钮**。
 *
 * ⚠️ **不在买入信号下再放一个【立即卖出】**：
 *   1. D-11 的理由文案用的是**信号方向** —— 若允许反向操作，
 *      会出现「类型=卖出、理由=金叉**买入**」的自相矛盾文案；
 *   2. 反向操作属于「逆信号交易」，风险更高 —— 持仓卡上已有卡 4 的【买入】【卖出】按钮兜底。
 *
 * ## 为什么**不**在本组件里 import 并渲染 `TradeFormModal`
 *
 * 交易弹窗是 `position: fixed` 的**模态**，而本菜单在**鼠标移出时就会卸载**。
 * 若把弹窗渲染在菜单内部 → 用户点【立即买入】后鼠标一移开，菜单连同弹窗一起消失
 * （弹窗被误关，用户填了一半的表单丢失）。
 * ⇒ 本组件只负责「产出一份已预填的交易草稿」，由**父级**在菜单之外渲染弹窗
 *   （与 卡 6 的 `PositionDetailModal.onTrade` 同一套解耦思路）。
 *
 * ## 过期信号（`isSignalStale`）的处理
 *
 * 判据用裁决 D-5（信号交易日与最新行情交易日的**自然日**差 ≥ 5）。
 * 过期时：**操作按钮 `disabled` + `aria-disabled`**，并在菜单里显示中文过期提示
 * —— 目的是**不让用户拿过期信号下单**（过期信号仍可读，只是不再提供一键动作）。
 *
 * ## a11y
 *
 * - 触发器：`<button aria-haspopup="menu" aria-expanded>`；
 *   **不给 `aria-label`** —— 可访问名由可见文本（`SignalBadge` 的内容）提供，
 *   满足 WCAG 2.5.3「Label in Name」；详见触发器上方的注释。
 * - 菜单：`<div role="menu">`，操作项：`<button role="menuitem">`；
 * - 键盘：**↑↓ 移动**、**Enter 触发**（原生 button 行为）、**Esc 关闭**并把焦点还给触发器、
 *   **Home/End** 跳到首/末项；
 * - 菜单内的信息块用 `role="group"`（`role="menu"` 的合法子角色）承载。
 *   ⚠️ **实测（axe 4.14）**：`role="menu"` 若**只有** `role="group"` 子节点而无 `menuitem`，
 *   会触发 **`aria-required-children`（impact: critical）** → 故 hold 方向也给一个
 *   `aria-disabled` 的 `menuitem`（「当前无触发信号」），保证任何时候菜单里都有 menuitem。
 *
 * ⚠️ **焦点锁定 / 焦点回归（模态级）不在本任务范围** —— 属 **T76 ⑤**（Wave 8 弹窗焦点管理）。
 *    本组件只做**菜单级**的焦点移动（打开时进入首项、Esc 后回到触发器），
 *    不做 Tab 循环锁定。
 */

/** 菜单宽度（ux_v2 行 524「约 180px」）*/
const MENU_WIDTH = 180;

/** 一条「已预填的交易草稿」—— 父级拿它去喂 `TradeFormModal` 的预填 props */
export interface SignalTradeDraft {
  /** 标的代码（= 持仓 `asset_code`）*/
  assetCode: string;
  /** 交易方向（`buy` / `sell`）*/
  side: TradeSide;
  /** 建议数量（D-9）；候选池买入等无持仓场景可以为空 */
  quantity?: number;
  /** 现价（`currentPrice`；无行情 → `null`）*/
  price: number | null;
  /** 操作理由（D-11）*/
  reason: string;
}

/**
 * D-9：数量建议公式 —— `Math.ceil(totalQuantity / 2)`
 *
 * ⚠️ **买卖同公式**（裁决 D-9 原文）：避免「一键清仓」的误操作。
 * `totalQuantity = 0` → `0` → 由 卡 4 的「数量 > 0」必填校验拦下（前端不会发请求）。
 */
export function suggestTradeQuantity(totalQuantity: number): number {
  if (!Number.isFinite(totalQuantity) || totalQuantity <= 0) return 0;
  return Math.ceil(totalQuantity / 2);
}

/**
 * D-11：操作理由文案
 *
 * `${plugin_id} ${label} ${DIRECTION_LABEL[direction]} (${trade_date})`
 * —— `label` 为空串时**省略该段**（不留多余空格）。
 *
 * ⚠️ `plugin_id` 是**英文插件 id**（如 `macd_cross`），`label` 才是中文（如「金叉」）——
 *    按公式拼，不另编文案（卡 7 风险与坑第 3 条）。
 */
export function buildTradeReason(signal: PositionSignal): string {
  const parts = [signal.plugin_id, signal.label, DIRECTION_LABEL[signal.direction]].filter(
    (p) => typeof p === 'string' && p.trim() !== '',
  );
  return `${parts.join(' ')} (${signal.trade_date})`;
}

export interface SignalMiniMenuProps {
  /** 持仓条目（信号 / 现价 / 持仓数量 / 标的代码都在里面）*/
  position: Position;
  /**
   * 最新行情交易日（`summary.priceDate`）—— 信号过期判据（裁决 D-5）
   *
   * ⚠️ 传 `summary.priceDate`（**全市场**最新行情日）而不是持仓自己的 `priceDate`；
   *    不传时回退 `position.priceDate`。
   */
  priceDate?: string | null;
  /**
   * 点【立即买入/卖出】→ 交出一份**已预填的交易草稿**
   *
   * 父级负责打开 `TradeFormModal`（`open` / `assetCode` / `side` / `initialQuantity` /
   * `initialPrice` / `initialReason` 全部来自这份草稿）。
   * 未传时操作按钮渲染为 disabled 占位。
   */
  onTrade?: (draft: SignalTradeDraft) => void;
}

/** 菜单项的内部描述 */
interface MenuItem {
  key: string;
  /** 可见文案（也是可访问名）*/
  label: string;
  /** 原生 `disabled`（不可聚焦、不可点击）*/
  disabled?: boolean;
  /** `aria-disabled`（可聚焦但不可执行 —— 用于「只有提示、没有动作」的场景）*/
  ariaDisabled?: boolean;
  /** 点击时执行的动作 */
  onActivate: () => void;
}

export function SignalMiniMenu({ position, priceDate, onTrade }: SignalMiniMenuProps) {
  const signal = position.signal;

  const [open, setOpen] = useState(false);
  /** 包裹层（触发器 + 菜单）—— 菜单的定位上下文 + 「点击外部关闭」的判定范围 */
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  /** 菜单项的 DOM 引用（↑↓ 漫游焦点用）*/
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** 「本次打开是 hover 带来的」标记 —— 用来避免 click 把 hover 刚打开的菜单又关掉 */
  const hoverOpenedRef = useRef(false);
  /** 打开后要把焦点放到哪一项（`first` / `last` / 不放）*/
  const pendingFocusRef = useRef<'first' | 'last' | null>(null);

  const effectivePriceDate = priceDate ?? position.priceDate ?? null;
  const stale = isSignalStale(signal, effectivePriceDate);

  /** 信号方向 → 操作方向（`hold` 没有操作）*/
  const actionSide: TradeSide | null = signal && signal.direction !== 'hold' ? signal.direction : null;

  const closeMenu = useCallback((returnFocus: boolean) => {
    setOpen(false);
    hoverOpenedRef.current = false;
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback((focusTarget: 'first' | 'last' | null) => {
    pendingFocusRef.current = focusTarget;
    setOpen(true);
  }, []);

  /** 执行操作 → 产出草稿 → 交回父级（弹窗由父级渲染，见文件头注释）*/
  const activate = useCallback(
    (side: TradeSide) => {
      if (!signal) return;
      const draft: SignalTradeDraft = {
        assetCode: position.asset_code,
        side,
        quantity: suggestTradeQuantity(position.totalQuantity),
        price: position.currentPrice,
        reason: buildTradeReason(signal),
      };
      closeMenu(false);
      onTrade?.(draft);
    },
    [signal, position.asset_code, position.totalQuantity, position.currentPrice, onTrade, closeMenu],
  );

  /** 菜单项清单（当前至多 1 项；结构按 N 项写，键盘逻辑不随条目数变化）*/
  const menuItems: MenuItem[] = useMemo(() => {
    if (!signal) return [];
    if (!actionSide) {
      // hold 方向：**没有操作**，只有一个「不可执行」的提示项
      // （实测 axe：`role="menu"` 里没有 menuitem 会触发 critical 级 `aria-required-children`）
      return [{ key: 'hold', label: '当前无触发信号', ariaDisabled: true, onActivate: () => {} }];
    }
    // 过期信号 → 操作禁用（不让用户拿过期信号下单）
    return [
      {
        key: 'action',
        label: `立即${DIRECTION_LABEL[actionSide]}`,
        disabled: stale || !onTrade,
        ariaDisabled: stale || !onTrade,
        onActivate: () => activate(actionSide),
      },
    ];
  }, [signal, actionSide, stale, onTrade, activate]);

  /** 菜单打开后按需把焦点移进菜单 */
  useEffect(() => {
    if (!open) return;
    const target = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (target === 'first') itemRefs.current[0]?.focus();
    else if (target === 'last') itemRefs.current[itemRefs.current.length - 1]?.focus();
  }, [open, menuItems.length]);

  /** 点击菜单外部 → 关闭（触屏场景没有「鼠标移出」）*/
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const el = wrapperRef.current;
      if (el && !el.contains(e.target as Node)) closeMenu(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, closeMenu]);

  /** Esc（焦点不在菜单内时的兜底；焦点在菜单内时由包裹层的 onKeyDown 处理）*/
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeMenu(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, closeMenu]);

  /** ↑↓ 在菜单项之间漫游（跳过 disabled 项）*/
  const moveFocus = (delta: number) => {
    const count = menuItems.length;
    if (count === 0) return;
    const current = itemRefs.current.findIndex((el) => el !== null && el === document.activeElement);
    // 当前没有焦点在菜单项上 → ↑ 落到最后一项，↓ 落到第一项
    if (current === -1) {
      const idx = delta > 0 ? 0 : count - 1;
      itemRefs.current[idx]?.focus();
      return;
    }
    for (let step = 1; step <= count; step += 1) {
      const idx = (((current + delta * step) % count) + count) % count;
      const el = itemRefs.current[idx];
      if (el && !el.disabled) {
        el.focus();
        return;
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // 焦点在菜单内时优先由这里处理（并阻断 document 上的兜底监听）
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        openMenu(e.key === 'ArrowDown' ? 'first' : 'last');
        return;
      }
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      if (!open) return;
      e.preventDefault();
      const idx = e.key === 'Home' ? 0 : menuItems.length - 1;
      itemRefs.current[idx]?.focus();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target === triggerRef.current) {
      // 自己处理（不依赖原生 click）：避免「原生 click 再开一次」
      e.preventDefault();
      openMenu('first');
    }
  };

  const handleTriggerClick = () => {
    if (hoverOpenedRef.current) {
      // hover 刚打开过 → 这次 click **保持打开**（否则 click 会把 hover 打开的菜单关掉）
      hoverOpenedRef.current = false;
      setOpen(true);
      return;
    }
    setOpen((prev) => !prev);
  };

  /* ── 样式（全部取自 theme/tokens，不引入裸 hex） ── */

  const triggerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    background: 'transparent',
    border: 'none',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    font: 'inherit',
    color: 'inherit',
  };

  const menuStyle: React.CSSProperties = {
    position: 'absolute',
    top: '100%',
    right: 0,
    zIndex: 30,
    width: MENU_WIDTH,
    boxSizing: 'border-box',
    padding: SPACING.gapBase,
    background: COLORS.cardBg,
    border: `1px solid ${COLORS.borderLight}`,
    borderRadius: RADIUS.md,
    boxShadow: `0 6px 16px ${COLORS.shadowSoft}`,
    display: 'flex',
    flexDirection: 'column',
    gap: SPACING.gapTight,
    textAlign: 'left',
  };

  const pluginStyle: React.CSSProperties = {
    fontSize: TYPO.smallSize,
    fontWeight: TYPO.cardTitleWeight,
    color: COLORS.textPrimary,
    fontFamily: TYPO.monoFamily,
    overflowWrap: 'anywhere',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: TYPO.captionSize,
    color: COLORS.textSecondary,
    overflowWrap: 'anywhere',
  };

  const metaStyle: React.CSSProperties = {
    fontSize: TYPO.captionSize,
    color: COLORS.textMuted,
  };

  const warnStyle: React.CSSProperties = {
    fontSize: TYPO.captionSize,
    // ⚠️ 用 `textDisclaimer`（深黄 6.8:1）而不是 `warning`（3.2:1）——
    //    小字需要 4.5:1（真浏览器 axe 的 color-contrast 会查，见 tests/helpers/a11y.ts）
    color: COLORS.textDisclaimer,
    overflowWrap: 'anywhere',
  };

  const itemStyle: React.CSSProperties = {
    width: '100%',
    marginTop: SPACING.gapTight,
    padding: SPACING.inputPadding,
    fontSize: TYPO.smallSize,
    fontFamily: TYPO.fontFamily,
    textAlign: 'center',
    background: COLORS.brand,
    color: COLORS.cardBg,
    border: 'none',
    borderRadius: RADIUS.sm,
    cursor: 'pointer',
  };

  const itemDisabledStyle: React.CSSProperties = {
    ...itemStyle,
    background: COLORS.borderLight,
    color: COLORS.textSecondary,
    cursor: 'not-allowed',
  };

  /* ── 无信号 → 不给任何入口（卡 7 A5：hover 后不出现任何浮层） ── */

  if (!signal) {
    return <SignalBadge signal={null} priceDate={effectivePriceDate} />;
  }

  const triggerTitle = stale ? '信号已过期 —— 打开信号详情' : '打开信号操作菜单';

  return (
    <div
      ref={wrapperRef}
      data-testid="signal-mini-menu"
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => {
        hoverOpenedRef.current = true;
        setOpen(true);
      }}
      onMouseLeave={() => closeMenu(false)}
      onKeyDown={handleKeyDown}
    >
      {/*
        ⚠️ **触发器刻意不给 `aria-label`** ——
        1. 可访问名由**可见文本**（`SignalBadge` 的内容）提供 → 满足 WCAG 2.5.3
           「Label in Name」（可见文字必须出现在可访问名里）；
        2. 避免在两处重复拼 SignalBadge 的文案（badge 一改就漂移）；
        3. 实测（axe 4.14）：一旦给了 `aria-label`，`label-content-name-mismatch` 规则
           会去测「可见文本 vs 可访问名」→ 内部调用 `canvas.getContext` →
           jsdom 未实现 → **stderr 刷 Not implemented 噪声**。
        「这是个会弹出菜单的按钮」由 `aria-haspopup="menu"` + `aria-expanded` 表达，
        鼠标用户另有 `title` 提示。
      */}
      <button
        ref={triggerRef}
        type="button"
        data-testid="signal-mini-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerTitle}
        onClick={handleTriggerClick}
        style={triggerStyle}
      >
        <SignalBadge signal={signal} priceDate={effectivePriceDate} />
      </button>

      {open && (
        <div role="menu" aria-label="信号操作菜单" style={menuStyle}>
          {/* ① 信号信息（非交互 —— role="group" 是 role="menu" 的合法子角色）*/}
          <div role="group" aria-label="信号信息">
            <div style={pluginStyle}>{signal.plugin_id}</div>
            {signal.label ? <div style={labelStyle}>{signal.label}</div> : null}
            <div style={metaStyle}>交易日 {signal.trade_date}</div>
            {stale ? (
              <div data-testid="signal-mini-menu-stale" style={warnStyle}>
                信号已过期（{signal.trade_date}），已停用一键下单
              </div>
            ) : null}
          </div>

          {/* ② 操作项 */}
          {menuItems.map((item, index) => (
            <button
              key={item.key}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              data-testid={`signal-mini-menu-item-${item.key}`}
              disabled={item.disabled}
              aria-disabled={item.ariaDisabled}
              onClick={item.onActivate}
              style={item.disabled || item.ariaDisabled ? itemDisabledStyle : itemStyle}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default SignalMiniMenu;
