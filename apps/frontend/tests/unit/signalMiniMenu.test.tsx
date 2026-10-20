import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SignalMiniMenu, {
  buildTradeReason,
  suggestTradeQuantity,
  type SignalTradeDraft,
} from '../../src/components/SignalMiniMenu';
import TradeFormModal from '../../src/components/TradeFormModal';
import type { Position, PositionSignal } from '../../src/components/positionDomain';
import { renderWithRouter } from '../helpers';
import { filterViolationsByImpact, formatA11yViolations, runA11y } from '../helpers/a11y';

/**
 * T67 · Wave 3 卡 7 —— 信号 → 交易 一键链路 Mini-Menu（ux_v2 建议 E）
 *
 * 覆盖卡 7 的验收断言 + 三条口径裁决：
 * - **D-9** 数量 = `Math.ceil(totalQuantity / 2)`；
 * - **D-10** hover + click **双触发**（触屏可达 —— PRD §5.8 #1「桌面和手机功能对等」）；
 * - **D-11** 理由 = `${plugin_id} ${label} ${DIRECTION_LABEL[direction]} (${trade_date})`。
 *
 * ## 弹窗为什么在**测试夹具**里渲染（而不是组件内部）
 *
 * 卡 7 明确要求「不改 `TradeFormModal` 的对外接口，只通过已有的预填 props 传值」。
 * 而弹窗**不能**渲染在 Mini-Menu 内部（菜单在鼠标移出时会卸载 → 弹窗被误关）。
 * ⇒ 组件只产出「交易草稿」，由**父级**渲染弹窗。
 * 本文件的 `Harness` 就是**批次 5 接线形态的最小复刻**：
 * 草稿 → `TradeFormModal` 的 `assetCode` / `side` / `initialQuantity` /
 * `initialPrice` / `initialReason`。
 */

/* ------------------------------------------------------------------ *
 * api mock（TradeFormModal 会 import `src/api/client`）
 * ------------------------------------------------------------------ */

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock, post: postMock } }));

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

/* ------------------------------------------------------------------ *
 * 数据夹具
 * ------------------------------------------------------------------ */

/** 造一个买入信号 */
const BUY_SIGNAL: PositionSignal = {
  plugin_id: 'macd_cross',
  direction: 'buy',
  label: '金叉',
  trade_date: '2026-10-12',
};

/** 造一个卖出信号 */
const SELL_SIGNAL: PositionSignal = {
  plugin_id: 'rsi_revert',
  direction: 'sell',
  label: '超买',
  trade_date: '2026-10-12',
};

/** 造一个持有信号 */
const HOLD_SIGNAL: PositionSignal = {
  plugin_id: 'ma_cross',
  direction: 'hold',
  label: '',
  trade_date: '2026-10-12',
};

/** 造一条持仓（字段与 `GET /api/holding` 的 position 同形）*/
function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    asset_code: 'sh600519',
    totalQuantity: 100,
    totalCostBasis: 100000,
    avgCost: 1000,
    realizedPnL: 0,
    currentPrice: 1750,
    priceDate: '2026-10-12',
    marketValue: 175000,
    unrealizedPnl: 75000,
    unrealizedYield: 0.75,
    weight: 0.3,
    prevClose: 1700,
    signal: BUY_SIGNAL,
    name: '贵州茅台',
    industry: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 夹具组件（批次 5 接线形态的最小复刻）
 * ------------------------------------------------------------------ */

interface HarnessProps {
  position: Position;
  priceDate?: string | null;
  onTrade?: (draft: SignalTradeDraft) => void;
}

function Harness({ position, priceDate, onTrade }: HarnessProps) {
  const [draft, setDraft] = useState<SignalTradeDraft | null>(null);
  return (
    <>
      <SignalMiniMenu
        position={position}
        priceDate={priceDate}
        onTrade={(d) => {
          setDraft(d);
          onTrade?.(d);
        }}
      />
      <TradeFormModal
        open={draft !== null}
        assetCode={draft?.assetCode ?? ''}
        side={draft?.side ?? 'buy'}
        initialQuantity={draft?.quantity}
        initialPrice={draft?.price ?? undefined}
        initialReason={draft?.reason}
        onCancel={() => setDraft(null)}
      />
    </>
  );
}

/** 触发器（信号徽章上的按钮）*/
function trigger(): HTMLButtonElement {
  return screen.getByTestId('signal-mini-menu-trigger') as HTMLButtonElement;
}

/** 读交易弹窗里某个字段的当前值 */
function fieldValue(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement).value;
}

/**
 * 渲染夹具
 *
 * ⚠️ **外面包一层 `<main>`** —— 真实页面里组件位于 `App.tsx` 的 `<main>` 语义骨架内；
 *    孤立渲染会让 axe 的 `region` 规则（内容必须落在 landmark 内）误报。
 */
function renderHarness(ui: React.ReactElement) {
  return renderWithRouter(<main>{ui}</main>);
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('SignalMiniMenu · 建议 E（信号 → 交易一键链路）', () => {
  /* ── 触发方式（D-10：hover + click 双触发） ── */

  it('建议 E：hover 信号标记弹出 Mini-Menu（含 plugin_id 与 label）', async () => {
    const user = userEvent.setup();
    renderHarness(<Harness position={makePosition()} priceDate="2026-10-12" />);

    // 未触发时没有任何浮层
    expect(screen.queryByRole('menu')).toBeNull();

    await user.hover(trigger());

    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    // 插件名 + 参数摘要（ux_v2 行 524）
    expect(menu).toHaveTextContent('macd_cross');
    expect(menu).toHaveTextContent('金叉');
    // 菜单里带操作按钮
    expect(screen.getByRole('menuitem', { name: '立即买入' })).toBeInTheDocument();
  });

  it('建议 E：click 信号标记同样弹出 Mini-Menu（触屏可达）', () => {
    renderHarness(<Harness position={makePosition()} priceDate="2026-10-12" />);

    // ⚠️ 用 `fireEvent.click`（**不带 hover**）—— 证明「只点也能开」
    fireEvent.click(trigger());

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '立即买入' })).toBeInTheDocument();
  });

  it('建议 E：hover 之后再 click 不会把刚打开的菜单关掉', async () => {
    const user = userEvent.setup();
    renderHarness(<Harness position={makePosition()} priceDate="2026-10-12" />);

    // `userEvent.click` 会先「移动指针」→ 先触发 hover 打开，再触发 click
    // ⇒ 若 click 用「取反」语义，菜单会被自己关掉（触屏/鼠标混合场景的经典坑）
    await user.click(trigger());

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  /* ── 预填（D-9 数量 / D-11 理由 / 代码 / 类型 / 现价） ── */

  it('建议 E：【立即买入】打开交易弹窗且 5 个字段全部预填正确', async () => {
    const user = userEvent.setup();
    const onTrade = vi.fn();
    renderHarness(<Harness position={makePosition()} priceDate="2026-10-12" onTrade={onTrade} />);

    fireEvent.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: '立即买入' }));

    // 弹窗已打开
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // 逐字段断言
    expect(fieldValue('标的代码')).toBe('sh600519');
    expect(fieldValue('交易类型')).toBe('buy');
    expect(fieldValue('数量')).toBe('50'); // D-9：ceil(100 / 2)
    expect(fieldValue('价格')).toBe('1750'); // currentPrice
    expect(fieldValue('操作理由')).toBe('macd_cross 金叉 买入 (2026-10-12)'); // D-11

    // 交给父级的草稿也逐字段一致
    expect(onTrade).toHaveBeenCalledTimes(1);
    expect(onTrade).toHaveBeenCalledWith({
      assetCode: 'sh600519',
      side: 'buy',
      quantity: 50,
      price: 1750,
      reason: 'macd_cross 金叉 买入 (2026-10-12)',
    });
  });

  it('建议 E：【立即卖出】预填 trade_type=sell', async () => {
    const user = userEvent.setup();
    const onTrade = vi.fn();
    renderHarness(
      <Harness position={makePosition({ signal: SELL_SIGNAL })} priceDate="2026-10-12" onTrade={onTrade} />,
    );

    fireEvent.click(trigger());
    // 卖出信号 → 菜单里是【立即卖出】
    expect(screen.queryByRole('menuitem', { name: '立即买入' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: '立即卖出' }));

    expect(fieldValue('标的代码')).toBe('sh600519');
    expect(fieldValue('交易类型')).toBe('sell');
    expect(fieldValue('数量')).toBe('50');
    expect(fieldValue('价格')).toBe('1750');
    expect(fieldValue('操作理由')).toBe('rsi_revert 超买 卖出 (2026-10-12)');
    expect(onTrade.mock.calls[0][0].side).toBe('sell');
  });

  it('建议 E：hold 方向只显示「当前无触发信号」且无操作按钮', () => {
    renderHarness(<Harness position={makePosition({ signal: HOLD_SIGNAL })} priceDate="2026-10-12" />);

    fireEvent.click(trigger());

    expect(screen.getByText('当前无触发信号')).toBeInTheDocument();
    // 卡 7 A4 的逐字断言
    expect(screen.queryByRole('button', { name: '立即买入' })).toBeNull();
    expect(screen.queryByRole('button', { name: '立即卖出' })).toBeNull();
    // 本组件的菜单项用的是 `role="menuitem"`（a11y 契约）→ 两种 role 都要断言
    expect(screen.queryByRole('menuitem', { name: '立即买入' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '立即卖出' })).toBeNull();
    // 文案层面也不许出现买卖按钮
    expect(screen.queryByText('立即买入')).toBeNull();
    expect(screen.queryByText('立即卖出')).toBeNull();
  });

  it('建议 E：无信号时不出现 Mini-Menu 入口', async () => {
    const user = userEvent.setup();
    renderHarness(<Harness position={makePosition({ signal: null })} priceDate="2026-10-12" />);

    // 卡片只显示「· 持有」
    expect(screen.getByTestId('signal-hold')).toHaveTextContent('· 持有');
    // 没有触发点
    expect(screen.queryByTestId('signal-mini-menu-trigger')).toBeNull();

    // hover 也不出现任何浮层（卡 7 A5）
    await user.hover(screen.getByTestId('signal-hold'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  /* ── D-9 数量公式（逐字） ── */

  it('建议 E：D-9 数量公式 —— ceil(持仓数量 / 2)（买卖同公式）', () => {
    expect(suggestTradeQuantity(100)).toBe(50);
    expect(suggestTradeQuantity(101)).toBe(51);
    expect(suggestTradeQuantity(1)).toBe(1);
    expect(suggestTradeQuantity(999)).toBe(500);
    // 持仓为 0 → 0（由 卡 4 的「数量 > 0」必填校验拦下，前端不发请求）
    expect(suggestTradeQuantity(0)).toBe(0);
  });

  it('建议 E：D-9 数量公式端到端生效（101 股 → 51 股）', async () => {
    const user = userEvent.setup();
    renderHarness(<Harness position={makePosition({ totalQuantity: 101 })} priceDate="2026-10-12" />);

    fireEvent.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: '立即买入' }));

    expect(fieldValue('数量')).toBe('51');
  });

  /* ── D-11 理由文案（逐字） ── */

  it('建议 E：D-11 理由文案逐字断言', () => {
    // 插件名 + 参数摘要 + 方向中文 + 交易日
    expect(
      buildTradeReason({
        plugin_id: 'macd_cross',
        direction: 'buy',
        label: '金叉',
        trade_date: '2026-10-12',
      }),
    ).toBe('macd_cross 金叉 买入 (2026-10-12)');
    expect(
      buildTradeReason({
        plugin_id: 'rsi_revert',
        direction: 'sell',
        label: '超买',
        trade_date: '2026-10-16',
      }),
    ).toBe('rsi_revert 超买 卖出 (2026-10-16)');
    // `label` 为空 → 省略该段（且不留多余空格）
    expect(
      buildTradeReason({ plugin_id: 'macd_cross', direction: 'buy', label: '', trade_date: '2026-10-12' }),
    ).toBe('macd_cross 买入 (2026-10-12)');
  });

  it('建议 E：D-11 理由文案端到端生效（label 为空时省略该段）', async () => {
    const user = userEvent.setup();
    renderHarness(
      <Harness
        position={makePosition({
          signal: { plugin_id: 'macd_cross', direction: 'buy', label: '', trade_date: '2026-10-12' },
        })}
        priceDate="2026-10-12"
      />,
    );

    fireEvent.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: '立即买入' }));

    expect(fieldValue('操作理由')).toBe('macd_cross 买入 (2026-10-12)');
  });

  /* ── 键盘可达 ── */

  it('建议 E：Esc 关闭菜单并把焦点还给触发按钮', async () => {
    const user = userEvent.setup();
    renderHarness(<Harness position={makePosition()} priceDate="2026-10-12" />);

    trigger().focus();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('建议 E：↑↓ 键盘移动 + Enter 触发', async () => {
    const user = userEvent.setup();
    const onTrade = vi.fn();
    renderHarness(<Harness position={makePosition()} priceDate="2026-10-12" onTrade={onTrade} />);

    // ↓ 打开菜单并把焦点移到第一个菜单项
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    const item = screen.getByRole('menuitem', { name: '立即买入' });
    expect(document.activeElement).toBe(item);

    // ↓ / ↑ 在菜单项之间漫游（当前只有 1 项 → 焦点不逃出菜单）
    fireEvent.keyDown(item, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(item);

    // Enter 触发
    await user.keyboard('{Enter}');
    expect(onTrade).toHaveBeenCalledTimes(1);
    expect(onTrade.mock.calls[0][0].side).toBe('buy');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  /* ── 过期信号 ── */

  it('建议 E：信号过期 → 操作禁用且明确提示过期（不给下单机会）', () => {
    const onTrade = vi.fn();
    renderHarness(
      <Harness
        position={makePosition({
          signal: { ...BUY_SIGNAL, trade_date: '2026-10-01' },
        })}
        priceDate="2026-10-20"
        onTrade={onTrade}
      />,
    );

    fireEvent.click(trigger());

    const item = screen.getByRole('menuitem', { name: '立即买入' });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('aria-disabled', 'true');
    // 明确提示过期
    expect(screen.getByTestId('signal-mini-menu-stale')).toHaveTextContent('信号已过期');

    // 点不动 → 不会下单、不会打开交易弹窗
    fireEvent.click(item);
    expect(onTrade).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /* ── a11y ── */

  it('建议 E：菜单 a11y —— role=menu / role=menuitem / 可访问名', () => {
    renderHarness(<Harness position={makePosition()} priceDate="2026-10-12" />);

    // 触发器：aria-haspopup / aria-expanded / 可访问名
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    // 可访问名 = 可见文本（SignalBadge 的内容）—— 满足 WCAG 2.5.3「Label in Name」
    expect(trigger()).toHaveAccessibleName(/macd_cross/);
    expect(trigger()).toHaveAccessibleName(/买入/);

    fireEvent.click(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    // 菜单有可访问名
    expect(screen.getByRole('menu', { name: '信号操作菜单' })).toBeInTheDocument();
    // 操作项是可访问名明确的 menuitem
    expect(screen.getByRole('menuitem', { name: '立即买入' })).toBeInTheDocument();
  });

  it('建议 E：菜单打开时 0 条 a11y 违规（axe，含 hold 方向）', async () => {
    // 买入方向
    const { unmount } = renderHarness(<Harness position={makePosition()} priceDate="2026-10-12" />);
    fireEvent.click(trigger());
    let result = await runA11y(document.body);
    expect(formatA11yViolations(filterViolationsByImpact(result.violations, 'all'))).toBe('（无违规）');
    unmount();

    // hold 方向（菜单里只有一个不可执行的 menuitem —— 仍须满足 aria-required-children）
    renderHarness(<Harness position={makePosition({ signal: HOLD_SIGNAL })} priceDate="2026-10-12" />);
    fireEvent.click(trigger());
    result = await runA11y(document.body);
    expect(formatA11yViolations(filterViolationsByImpact(result.violations, 'all'))).toBe('（无违规）');
  });
});
