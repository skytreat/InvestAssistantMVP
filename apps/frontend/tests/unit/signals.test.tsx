import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import Signals from '../../src/pages/Signals';
import { mockResponse, renderWithRouter } from '../helpers';

/**
 * T61 · Signals 前端用例（信号页的键盘可达性与键盘操作）
 *
 * ⚠️ **口径说明（务必先读）**
 *
 * `src/pages/Signals.tsx` 当前**没有**表格行的键盘导航 —— 结果表是纯 `<tr>`，
 * 没有 tabIndex、没有 onKeyDown。真正的「表格行键盘导航 / 焦点锁定 / ESC 关闭」
 * 属于 **T76 ⑤（a11y 收尾）**，不在本任务范围。
 *
 * 故本文件把「信号键盘导航」落到**现有原生表单控件的键盘可达性与键盘操作**上：
 * 1. Tab 顺序：交易日期 → 起始日期 → 结束日期 → 标的代码 → 策略名称 → 方向 → 查询
 * 2. 查询按钮可用 Enter / Space 触发，且带上正确的查询参数
 * 3. 「方向」下拉可被键盘聚焦，改变选中项后值为 buy 且进入查询参数
 * 4. 「交易日期」输入可被键盘聚焦，填值后值正确且进入查询参数
 * 5. 查询参数组装：已填条件进 params，未填条件不进 params（源码：只有非空才加）
 * 6. 结果表可读：表头文案 + 方向列的中文映射（DIRECTION_LABEL）
 *
 * 🔴 **a11y 缺口（只报告、不在本任务修）**：
 * 源码里 `<label>交易日期</label>` 等 label **没有 htmlFor**，input 也没有 id，
 * → label 与控件**无程序化关联**，`screen.getByLabelText('交易日期')` 会抛错。
 * 同时 `<input type="date">` 在 aria-query 里**没有映射到任何 ARIA role**，
 * → 只能用 CSS 选择器定位该控件；「策略名称」输入框才是页面里**唯一**的 textbox。
 * label 关联修复属 T63 范围。
 *
 * ⚠️ **jsdom 环境限制（两处，均已实测确认）**：
 * - `<input type="date">` 的 `selectionStart` 在 jsdom 中为 `null`（jsdom 不实现
 *   原生的日期分段编辑），故 `user.type()` 逐字符输入只会把值打成空串。
 *   → 改值走 `fireEvent.change`（与用户选完日期后浏览器派发的 change 同源），
 *     键盘可达性仍由 Tab 断言。
 * - jsdom **不实现原生 `<select>` 的键盘下拉交互**：`user.keyboard('{ArrowDown}')`
 *   聚焦在 select 上时**不会**改变 value。
 *   → 改变选中项走 `user.selectOptions()`（它派发的正是真实键盘选择后浏览器
 *     会派发的那个 change 事件），键盘可达性仍由 Tab 断言。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴 **T72 改动说明（2026-10-20 · Wave 5 Signals 页增强）**
 *
 * 本文件在 T72 之后**必须同步更新**，因为它断言的正是 T72 明文要改掉的行为。
 * 逐条列出改动与依据（便于 review 核对）：
 *
 * | 断言 | 改动 | 依据 |
 * |---|---|---|
 * | 进页不发请求，靠点「查询」 | 改为**进页自动加载**（挂载即发 1 次）| T72 ①「进页自动加载（今日+全部策略+全部方向）」|
 * | 空态文案「请点击查询按钮加载数据」| **删除**，改为「今日暂无策略信号」| T72 ①「删『请点击查询』空态」|
 * | 请求参数 `{page_size, trade_date}` | 追加 **`page`**（分页，T72 ③）| 后端 `routes/signal.ts:32` 接受 `page`|
 * | Tab 顺序 4 站 | 扩到 7 站（新增起始/结束日期 + 标的代码）| T72 ⑤「加 asset_code 过滤」+ G5.5「start_date/end_date 筛选」|
 * | 表格列 = 后端返回的动态列 | 改为**固定列**（标的代码/策略/方向/强度/标签/交易日期）| T72 ②（方向 pill / 强度 / 标签 tag 需要固定列位）|
 * | 方向列文本「买入」 | 变为「▲ 买入」（pill 内含方向符号）| PRD §5.2「买入绿▲/卖出红▼」|
 *
 * ⚠️ **「升序」= 交易日（`trade_date`）升序，不是方向升序** ——
 *    后端固定 `ORDER BY trade_date ASC, created_at ASC, id ASC`
 *    （`apps/backend/src/routes/signal.ts:73`）→ 前端不重排，按返回顺序渲染。
 */

/** api.get 的第二个参数（axios config），本文件只关心 params */
interface ApiGetConfig {
  params?: Record<string, unknown>;
}

/** 全局 mock：`api.get` 返回固定的信号列表 */
const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: ApiGetConfig) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock } }));

/** 一行信号（与 `Signals.tsx` 消费的字段同名）*/
interface SignalFixture {
  id: number;
  symbol: string;
  plugin_id: string;
  direction: string;
  label: string;
  trade_date: string;
}

/** 默认信号行（方向 buy → 表格显示「买入」）*/
const DEFAULT_ROW: SignalFixture = {
  id: 1,
  symbol: 'sh600000',
  plugin_id: 'filter_v2',
  direction: 'buy',
  label: '放量突破',
  trade_date: '2026-10-12',
};

/**
 * 安装 api.get 的 mock（每个用例自给自足 —— sequence.shuffle 下用例顺序随机）
 *
 * 返回体用 `mockResponse` 造，与后端 envelope（`{code, data, timestamp}`）
 * 同形：源码读的是 `res.data.code` 与 `res.data.data`（T89b 起成功判定看 `code === 0`）。
 */
function installApiMock(rows: SignalFixture[] = [DEFAULT_ROW]): void {
  getMock.mockResolvedValue(mockResponse(rows));
}

/**
 * 取「交易日期」输入框
 *
 * ⚠️ `input[type="date"]` **没有对应的 ARIA role**（aria-query 未把 date 类型的
 * input 映射到任何 role），因此无法用 `getByRole` 定位，只能走 CSS 选择器。
 *
 * ⚠️ T72 后页面有 **3 个** date 输入（交易日期 / 起始日期 / 结束日期），
 *    顺序与 DOM 顺序一致；本 helper 取**第一个**（交易日期）。
 */
function dateInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('input[type="date"]');
  if (!el) throw new Error('未找到「交易日期」输入框');
  return el;
}

/**
 * 取全部 date 输入（顺序：交易日期 / 起始日期 / 结束日期）
 */
function dateInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="date"]')];
}

/** 取最后一次请求的查询参数 */
function lastParams(): Record<string, unknown> {
  const calls = getMock.mock.calls;
  const last = calls[calls.length - 1];
  return last?.[1]?.params ?? {};
}

/**
 * 等首屏加载完成
 *
 * ⚠️ T72 ① 起**进页就自动加载** → 按钮在加载期间是 `disabled`，
 *    直接点会落空（userEvent 对 disabled 按钮不派发 click）。
 *    故所有「点查询」类用例都先等表格渲染出来（= loading 已解除）。
 */
async function waitForLoaded(): Promise<void> {
  await waitFor(() => expect(getMock).toHaveBeenCalled());
  await screen.findByRole('table');
}

describe('Signals · 键盘可达性与键盘操作', () => {
  beforeEach(() => {
    getMock.mockReset();
    installApiMock();
  });

  it('Tab 顺序：交易日期 → 起始日期 → 结束日期 → 标的代码 → 策略名称 → 方向 → 查询', async () => {
    const user = userEvent.setup();
    const { container } = renderWithRouter(<Signals />);

    const dates = dateInputs(container);
    expect(dates).toHaveLength(3);
    const [tradeDateInput, startDateInput, endDateInput] = dates;

    // 从页面起点开始按 Tab
    await user.tab();
    expect(document.activeElement).toBe(tradeDateInput);

    await user.tab();
    expect(document.activeElement).toBe(startDateInput);

    await user.tab();
    expect(document.activeElement).toBe(endDateInput);

    // 两个 textbox：标的代码（先）/ 策略名称（后）
    await user.tab();
    const textboxes = screen.getAllByRole<HTMLInputElement>('textbox');
    expect(textboxes).toHaveLength(2);
    expect(document.activeElement).toBe(textboxes[0]);

    await user.tab();
    expect(document.activeElement).toBe(textboxes[1]);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('combobox'));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '查询' }));
  });

  it('「查询」按钮可用 Enter 键触发，且带上正确的查询参数', async () => {
    const user = userEvent.setup();
    const { container } = renderWithRouter(<Signals />);

    await waitForLoaded();

    // 默认交易日期 = 组件挂载时的今天（源码 todayStr()），此处直接取控件当前值，避免跨天抖动
    const defaultDate = dateInput(container).value;
    expect(defaultDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 用 Tab 把焦点移到「查询」按钮
    for (let i = 0; i < 7; i += 1) await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '查询' }));

    await user.keyboard('{Enter}');

    // 进页自动加载已发过一次 → 这里应是第 2 次
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(getMock.mock.calls[1]?.[0]).toBe('/signal');
    expect(lastParams()).toEqual({ page: 1, page_size: 50, trade_date: defaultDate });
  });

  it('「查询」按钮可用空格键触发', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Signals />);

    await waitForLoaded();

    const button = screen.getByRole('button', { name: '查询' });
    button.focus();
    expect(document.activeElement).toBe(button);

    await user.keyboard(' ');

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(getMock.mock.calls[1]?.[0]).toBe('/signal');
  });

  it('「方向」下拉可被键盘聚焦，改变选中项后值为 buy 并进入查询参数', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Signals />);

    await waitForLoaded();

    // Tab 六下到达「方向」下拉（交易日期 / 起始 / 结束 / 标的代码 / 策略名称 / 方向）
    for (let i = 0; i < 6; i += 1) await user.tab();
    const select = screen.getByRole<HTMLSelectElement>('combobox');
    expect(document.activeElement).toBe(select);
    expect(select.value).toBe('');

    // jsdom 不实现原生 select 的键盘下拉交互（ArrowDown 不改变 value），
    // 故用 selectOptions 触发与真实键盘选择相同的 change 事件
    await user.selectOptions(select, 'buy');
    expect(select.value).toBe('buy');

    await user.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => expect(lastParams().direction).toBe('buy'));
  });

  it('「交易日期」输入可被键盘聚焦，填入 2026-10-12 后值正确且进入查询参数', async () => {
    const user = userEvent.setup();
    const { container } = renderWithRouter(<Signals />);

    await waitForLoaded();

    await user.tab();
    const dateEl = dateInput(container);
    expect(document.activeElement).toBe(dateEl);

    // jsdom 的 date 输入 selectionStart 为 null，无法逐字符键入（详见文件头注释）
    fireEvent.change(dateEl, { target: { value: '2026-10-12' } });
    expect(dateEl.value).toBe('2026-10-12');

    await user.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => expect(lastParams().trade_date).toBe('2026-10-12'));
  });
});

describe('Signals · 查询参数组装', () => {
  beforeEach(() => {
    getMock.mockReset();
    installApiMock();
  });

  it('三个筛选条件齐填 → params 含 page / page_size / trade_date / plugin_id / direction', async () => {
    const user = userEvent.setup();
    const { container } = renderWithRouter(<Signals />);

    await waitForLoaded();

    fireEvent.change(dateInput(container), { target: { value: '2026-10-12' } });
    // 两个 textbox：[0] 标的代码、[1] 策略名称
    await user.type(screen.getAllByRole<HTMLInputElement>('textbox')[1], 'filter_v2');
    await user.selectOptions(screen.getByRole<HTMLSelectElement>('combobox'), 'buy');

    await user.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => expect(lastParams().direction).toBe('buy'));
    expect(lastParams()).toEqual({
      page: 1,
      page_size: 50,
      trade_date: '2026-10-12',
      plugin_id: 'filter_v2',
      direction: 'buy',
    });
  });

  it('未填的条件不进 params（默认只有 page / page_size 与 trade_date）', async () => {
    const user = userEvent.setup();
    const { container } = renderWithRouter(<Signals />);

    await waitForLoaded();

    const defaultDate = dateInput(container).value;

    await user.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    const params = lastParams();
    expect(params).toEqual({ page: 1, page_size: 50, trade_date: defaultDate });
    expect(params).not.toHaveProperty('plugin_id');
    expect(params).not.toHaveProperty('direction');
    expect(params).not.toHaveProperty('asset_code');
    expect(params).not.toHaveProperty('start_date');
    expect(params).not.toHaveProperty('end_date');
  });

  it('清空交易日期 → params 里不再出现 trade_date', async () => {
    const user = userEvent.setup();
    const { container } = renderWithRouter(<Signals />);

    await waitForLoaded();

    await user.clear(dateInput(container));
    expect(dateInput(container).value).toBe('');

    await user.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(lastParams()).toEqual({ page: 1, page_size: 50 });
  });
});

describe('Signals · 空态', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('进页自动加载后展示空态，且不再有「请点击查询按钮加载数据」', async () => {
    installApiMock([]);
    renderWithRouter(<Signals />);

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('请点击查询按钮加载数据')).not.toBeInTheDocument();
    expect(await screen.findByTestId('signals-empty')).toHaveTextContent('今日暂无策略信号');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('Signals · 结果表可读性', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('查询成功后表头为 标的代码/策略/方向/强度/标签/交易日期', async () => {
    installApiMock();
    const user = userEvent.setup();
    renderWithRouter(<Signals />);

    await waitForLoaded();
    await user.click(screen.getByRole('button', { name: '查询' }));

    await screen.findByRole('table');
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(['标的代码', '策略', '方向', '强度', '标签', '交易日期']);
  });

  it('数据行按列顺序渲染（标的代码 / 策略 / 方向 / 强度 / 标签 / 交易日期）', async () => {
    installApiMock();
    const user = userEvent.setup();
    renderWithRouter(<Signals />);

    await waitForLoaded();
    await user.click(screen.getByRole('button', { name: '查询' }));

    await screen.findByRole('table');
    const dataRows = screen.getAllByRole('row').slice(1);
    expect(dataRows).toHaveLength(1);
    const cells = within(dataRows[0])
      .getAllByRole('cell')
      .map((td) => td.textContent);
    // 方向 pill 内含方向符号（▲ 买入）；强度字段缺省 → 降级 `--`
    expect(cells).toEqual(['sh600000', 'filter_v2', '▲ 买入', '--', '放量突破', '2026-10-12']);
  });

  it('方向列按 DIRECTION_LABEL 映射（buy→买入 / sell→卖出 / hold→持仓）', async () => {
    installApiMock([
      { ...DEFAULT_ROW, id: 1, direction: 'buy' },
      { ...DEFAULT_ROW, id: 2, direction: 'sell' },
      { ...DEFAULT_ROW, id: 3, direction: 'hold' },
    ]);
    const user = userEvent.setup();
    renderWithRouter(<Signals />);

    await waitForLoaded();
    await user.click(screen.getByRole('button', { name: '查询' }));

    await screen.findByRole('table');
    const dataRows = screen.getAllByRole('row').slice(1);
    expect(dataRows).toHaveLength(3);

    // 第 3 列是 direction（列序固定：标的代码 / 策略 / 方向 / 强度 / 标签 / 交易日期）
    const directionCells = dataRows.map((row) => within(row).getAllByRole('cell')[2].textContent);
    expect(directionCells).toEqual(['▲ 买入', '▼ 卖出', '· 持仓']);
    // 原始英文枚举值不应直接上屏
    expect(directionCells).not.toContain('buy');
    expect(directionCells).not.toContain('sell');
    expect(directionCells).not.toContain('hold');
  });
});
