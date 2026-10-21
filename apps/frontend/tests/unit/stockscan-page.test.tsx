import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import StockScan from '../../src/pages/StockScan';
import { mockResponse, renderWithRouter } from '../helpers';

/**
 * T73 · 条件选股页（StockScan 全量重写）—— 页面级用例
 *
 * 覆盖 `docs/audit/gap-list-2026-10-17.md` §5.6 的 F-S1 ~ F-S5 + 附带缺陷：
 *
 * | 用例组 | 对应交付 |
 * |---|---|
 * | F-S1 公共过滤 | 标的类型生效 / 排除 ST 生效 / 行业控件 disabled + 文案 |
 * | F-S2 参数表单 | schema 驱动（**不是**裸 JSON textarea）|
 * | F-S3 结果上限 | 强制 ≤100，UI 不可调到 500 |
 * | F-S4 批量加入候选池 | 勾选 / 全选 / 批量按钮 → `POST /api/candidates/batch` |
 * | F-S5 结果表 | 名称 / 现价 / 涨跌幅 / 成交额 + 分页 |
 * | G6.6 结构契约 | 滚动容器（role=region / tabindex / min-width:0）+ 表单行可换行 |
 *
 * ⚠️ **375px 的真实溢出不在本文件断言**（jsdom 没有 layout engine，
 *    `scrollWidth`/`clientWidth` 恒为 0 ⇒ 像素断言必然假绿）。
 *    真实判定由 `scripts/probe-overflow.mjs`（真浏览器）负责；
 *    本文件只锁**结构契约**（滚动容器存在 + 无障碍属性齐备 + 表单行允许换行）。
 */

/** 全局 mock：`api.get` / `api.post` */
const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string) => Promise<unknown>>(),
  postMock: vi.fn<(url: string, data?: unknown) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock, post: postMock } }));

/** filter 类插件（选股页只列 filter 类）*/
const FILTER_PLUGIN = {
  id: 'ma_bullish_alignment',
  name: '均线多头排列',
  description: '筛选出均线呈多头排列的标的',
  category: 'filter' as const,
  paramSchema: [
    { key: 'symbol', label: '标的代码', type: 'string' as const, default: '' },
    { key: 'symbols', label: '批量标的', type: 'string' as const, default: '' },
    { key: 'periodShort', label: '短期均线', type: 'integer' as const, default: 5, min: 2, max: 60 },
    { key: 'periodMid', label: '中期均线', type: 'integer' as const, default: 10, min: 3, max: 120 },
  ],
};

/** monitor 类插件 —— **不应出现在选股页的下拉里**（PRD §5.6「筛选插件下拉」）*/
const MONITOR_PLUGIN = {
  id: 'rsi_oversold',
  name: 'RSI(14) 超买超卖',
  category: 'monitor' as const,
  paramSchema: [],
};

/** 一条结果（字段与后端 `StockScanResult` 对齐）*/
interface ResultFixture {
  symbol: string;
  name: string | null;
  close: number | null;
  changePct: number | null;
  amount: number | null;
  score: number;
  signalType: 'BUY' | 'SELL' | 'HOLD';
  details?: string;
  pluginId: string;
}

function makeResult(i: number): ResultFixture {
  return {
    symbol: `sh6000${String(i).padStart(2, '0')}`,
    name: `测试股${i}`,
    close: 10 + i / 10,
    changePct: i % 2 === 1 ? 1.25 : -0.5,
    amount: 12345678,
    score: 0.8,
    signalType: 'BUY',
    details: 'MA5>MA10>MA20',
    pluginId: 'ma_bullish_alignment',
  };
}

/** 默认返回 3 条结果 */
const DEFAULT_RESULTS: ResultFixture[] = [makeResult(1), makeResult(2), makeResult(3)];

/** 扫描响应体 */
function scanResponse(results: ResultFixture[], totalCandidates = 5363) {
  return mockResponse(
    {
      totalCandidates,
      total: results.length,
      results,
      tradeDate: '2026-10-12',
      filters: {
        assetType: 'stock',
        excludeSt: false,
        industryCode: null,
        marketCapMaxYi: null,
        minAmount: 0,
      },
    },
    { timeMs: 1234 },
  );
}

/** 默认 mock：插件列表 + 扫描结果 */
function installDefaultMock(results: ResultFixture[] = DEFAULT_RESULTS): void {
  getMock.mockImplementation((url: string) => {
    if (url === '/stockscan/plugins') {
      return Promise.resolve(mockResponse([FILTER_PLUGIN, MONITOR_PLUGIN]));
    }
    return Promise.resolve(mockResponse([]));
  });
  postMock.mockImplementation((url: string) => {
    if (url === '/stockscan') return Promise.resolve(scanResponse(results));
    if (url === '/candidates/batch') {
      return Promise.resolve(mockResponse({ added: 1, skipped: 0, duplicates: [] }, {}));
    }
    return Promise.resolve(mockResponse({ id: 1 }));
  });
}

/** 取最后一次 `POST /stockscan` 的请求体 */
function lastScanPayload(): Record<string, unknown> {
  const calls = postMock.mock.calls.filter((c) => c[0] === '/stockscan');
  return (calls[calls.length - 1]?.[1] ?? {}) as Record<string, unknown>;
}

/** 取最后一次 `POST /candidates/batch` 的请求体 */
function lastBatchPayload(): Record<string, unknown> {
  const calls = postMock.mock.calls.filter((c) => c[0] === '/candidates/batch');
  return (calls[calls.length - 1]?.[1] ?? {}) as Record<string, unknown>;
}

/** 触发一次扫描并等结果渲染出来 */
async function runScan(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByRole('option', { name: '均线多头排列' });
  await user.click(screen.getByRole('button', { name: '开始选股' }));
  await screen.findByRole('table', { name: '选股结果' });
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  installDefaultMock();
});

/* ================================================================== *
 * F-S1 · 公共过滤
 * ================================================================== */

describe('F-S1 · 公共过滤（标的类型 / 排除 ST / 行业）', () => {
  it('标的类型下拉只有 股票 / ETF / 全部，选「ETF」→ 请求带 asset_type=etf', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);

    const select = (await screen.findByLabelText('标的类型：')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['股票', 'ETF', '全部']);

    await user.selectOptions(select, 'etf');
    await user.click(screen.getByRole('button', { name: '开始选股' }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(lastScanPayload().asset_type).toBe('etf');
  });

  it('排除 ST 勾选后 → 请求带 exclude_st=true（未勾选时为 false）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);

    await screen.findByLabelText('排除 ST：');
    await user.click(screen.getByRole('button', { name: '开始选股' }));
    await waitFor(() => expect(lastScanPayload().exclude_st).toBe(false));

    await user.click(screen.getByLabelText('排除 ST：'));
    await user.click(screen.getByRole('button', { name: '开始选股' }));
    await waitFor(() => expect(lastScanPayload().exclude_st).toBe(true));
  });

  it('行业控件 **disabled** + 显式文案「行业数据源暂不可用」，且不提交 industry_code', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);

    const industry = (await screen.findByLabelText('行业：')) as HTMLSelectElement;
    expect(industry).toBeDisabled();
    expect(screen.getByText('行业数据源暂不可用')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '开始选股' }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    // 🔴 板块表 0 行 → 传 industry_code 会把结果清空 ⇒ 绝不提交
    expect(lastScanPayload()).not.toHaveProperty('industry_code');
  });

  it('最低成交额（万元）→ 提交给后端时换算成「元」', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);

    const input = (await screen.findByLabelText('最低成交额（万）：')) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '5000');
    await user.click(screen.getByRole('button', { name: '开始选股' }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(lastScanPayload().min_amount).toBe(5000 * 10000);
  });
});

/* ================================================================== *
 * F-S2 · 参数表单（schema 驱动）
 * ================================================================== */

describe('F-S2 · 参数表单由 schema 驱动（不是裸 JSON textarea）', () => {
  it('默认渲染 schema 里的字段控件（label + 控件一一关联），页面里没有 textarea', async () => {
    const { container } = renderWithRouter(<StockScan />);

    // schema 里的 number 字段渲染成 number input，且有可访问名
    const short = (await screen.findByLabelText('短期均线')) as HTMLInputElement;
    expect(short).toHaveAttribute('type', 'number');
    expect(short).toHaveValue(5);
    expect(short).toHaveAttribute('min', '2');
    expect(short).toHaveAttribute('max', '60');

    // 🔴 不是裸 JSON textarea
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('symbol / symbols（运行时注入字段）**不渲染**', async () => {
    renderWithRouter(<StockScan />);

    await screen.findByLabelText('短期均线');
    expect(screen.queryByLabelText('标的代码')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('批量标的')).not.toBeInTheDocument();
  });

  it('参数不合法时前端拦截（不���请求）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);

    const short = (await screen.findByLabelText('短期均线')) as HTMLInputElement;
    await user.clear(short);
    await user.type(short, '999');

    await user.click(screen.getByRole('button', { name: '开始选股' }));

    expect(await screen.findByText(/不能大于 60/)).toBeInTheDocument();
    expect(postMock.mock.calls.filter((c) => c[0] === '/stockscan')).toHaveLength(0);
  });

  it('切换插件 → 参数重置为新插件的默认值', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);

    const short = (await screen.findByLabelText('短期均线')) as HTMLInputElement;
    await user.clear(short);
    await user.type(short, '30');
    expect(short).toHaveValue(30);

    await user.selectOptions(screen.getByLabelText('筛选插件：'), 'ma_bullish_alignment');
    expect((await screen.findByLabelText('短期均线')) as HTMLInputElement).toHaveValue(5);
  });

  it('JSON 模式可切换；提交时 symbol / symbols 被剔除（标的域由选股路由控制）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);

    await screen.findByLabelText('短期均线');
    // 默认没有 textarea
    expect(screen.queryByLabelText('参数 JSON')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('JSON 模式（高级）'));
    const textarea = (await screen.findByLabelText('参数 JSON')) as HTMLTextAreaElement;
    // 切到 JSON 模式时把当前表单值序列化进去（含 symbol / symbols）
    expect(JSON.parse(textarea.value)).toMatchObject({ periodShort: 5 });

    // 用户在 JSON 里塞了 symbol / symbols → 提交时必须被剔除
    await user.clear(textarea);
    await user.type(textarea, '{{"periodShort": 8, "symbol": "sh600000", "symbols": "sh600001"}');
    await user.click(screen.getByRole('button', { name: '开始选股' }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const payload = lastScanPayload();
    expect(payload.params).toEqual({ periodShort: 8 });
  });
});

/* ================================================================== *
 * F-S3 · 结果上限 100
 * ================================================================== */

describe('F-S3 · 结果上限强制 ≤100（PRD §5.6）', () => {
  it('请求固定带 max_results=100，且界面上的上限控件不可编辑', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);

    const input = (await screen.findByLabelText('结果上限：')) as HTMLInputElement;
    expect(input).toHaveValue(100);
    expect(input).toHaveAttribute('max', '100');
    expect(input).toHaveAttribute('readonly');

    await user.click(screen.getByRole('button', { name: '开始选股' }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(lastScanPayload().max_results).toBe(100);
  });
});

/* ================================================================== *
 * F-S4 · 批量加入候选池
 * ================================================================== */

describe('F-S4 · 批量加入候选池（复用 T56 的批量接口）', () => {
  it('勾选单只 → 批量按钮带上该只 → POST /api/candidates/batch 载荷正确', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);
    await runScan(user);

    await user.click(screen.getByLabelText('选择 sh600001'));
    await user.click(screen.getByRole('button', { name: /加入选中/ }));

    await waitFor(() => expect(postMock.mock.calls.some((c) => c[0] === '/candidates/batch')).toBe(true));
    expect(lastBatchPayload()).toEqual({ asset_codes: ['sh600001'] });
  });

  it('「全选」勾选当前页全部结果 → 批量加入带上全部标的', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);
    await runScan(user);

    await user.click(screen.getByLabelText('全选'));
    await user.click(screen.getByRole('button', { name: /加入选中/ }));

    await waitFor(() => expect(postMock.mock.calls.some((c) => c[0] === '/candidates/batch')).toBe(true));
    expect(lastBatchPayload()).toEqual({
      asset_codes: ['sh600001', 'sh600002', 'sh600003'],
    });
  });

  it('「全部加入候选池」→ 一次提交全部结果（上限 100 条，接口单次上限也是 100）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);
    await runScan(user);

    await user.click(screen.getByRole('button', { name: /全部加入候选池/ }));

    await waitFor(() => expect(postMock.mock.calls.some((c) => c[0] === '/candidates/batch')).toBe(true));
    expect(lastBatchPayload()).toEqual({
      asset_codes: ['sh600001', 'sh600002', 'sh600003'],
    });
  });

  it('批量结果回显「已加入 N 只 / 跳过 M 只」', async () => {
    const user = userEvent.setup();
    postMock.mockImplementation((url: string) => {
      if (url === '/stockscan') return Promise.resolve(scanResponse(DEFAULT_RESULTS));
      if (url === '/candidates/batch') {
        return Promise.resolve(mockResponse({ added: 2, skipped: 1, duplicates: ['sh600002'] }));
      }
      return Promise.resolve(mockResponse({ id: 1 }));
    });
    renderWithRouter(<StockScan />);
    await runScan(user);

    await user.click(screen.getByRole('button', { name: /全部加入候选池/ }));

    expect(await screen.findByText(/已加入候选池 2 只，跳过 1 只（重复 1 只）/)).toBeInTheDocument();
  });

  it('附带缺陷：单只加入返回 409（已在候选池）→ 显示「已在候选池」而不是「加入候选失败」', async () => {
    const user = userEvent.setup();
    postMock.mockImplementation((url: string) => {
      if (url === '/stockscan') return Promise.resolve(scanResponse(DEFAULT_RESULTS));
      if (url === '/candidate') {
        return Promise.reject({
          response: { status: 409, data: { code: 'DUPLICATE', message: 'sh600001 已在 candidate 列表' } },
        });
      }
      return Promise.resolve(mockResponse({ id: 1 }));
    });
    renderWithRouter(<StockScan />);
    await runScan(user);

    const row = screen.getAllByRole('row')[1];
    await user.click(within(row).getByRole('button', { name: '加候选' }));

    expect(await screen.findByText('sh600001 已在候选池')).toBeInTheDocument();
    expect(screen.queryByText(/加入候选失败/)).not.toBeInTheDocument();
  });
});

/* ================================================================== *
 * F-S5 · 结果表列 + 分页
 * ================================================================== */

describe('F-S5 · 结果表含 名称 / 现价 / 涨跌幅 / 成交额 + 分页', () => {
  it('表头含 名称 / 现价 / 涨跌幅 / 成交额，行内渲染对应值', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);
    await runScan(user);

    const table = screen.getByRole('table', { name: '选股结果' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(['名称', '现价', '涨跌幅', '成交额（万）']));

    const firstRow = within(table).getAllByRole('row')[1];
    const cells = within(firstRow)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    // 代码 / 名称 / 现价 / 涨跌幅 / 成交额（万元）
    expect(cells[2]).toContain('sh600001');
    expect(cells[3]).toBe('测试股1');
    expect(cells[4]).toBe('10.10');
    expect(cells[5]).toBe('+1.25%');
    expect(cells[6]).toBe('1234.57');
  });

  it('缺字段时降级显示 `--`（不显示 NaN / undefined）', async () => {
    const user = userEvent.setup();
    installDefaultMock([
      {
        symbol: 'sh600009',
        name: null,
        close: null,
        changePct: null,
        amount: null,
        score: 0.5,
        signalType: 'HOLD',
        pluginId: 'ma_bullish_alignment',
      },
    ]);
    renderWithRouter(<StockScan />);
    await runScan(user);

    const firstRow = within(screen.getByRole('table', { name: '选股结果' })).getAllByRole('row')[1];
    const cells = within(firstRow)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells[3]).toBe('--');
    expect(cells[4]).toBe('--');
    expect(cells[5]).toBe('--');
    expect(cells[6]).toBe('--');
  });

  it('分页：结果超过一页时可翻页，且每页只渲染 PAGE_SIZE 行', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 25 }, (_, i) => makeResult(i + 1));
    installDefaultMock(many);
    renderWithRouter(<StockScan />);
    await runScan(user);

    expect(screen.getByText(/第 1 \/ 2 页，共 25 条/)).toBeInTheDocument();
    // 第 1 页 20 行 + 表头
    expect(screen.getAllByRole('row')).toHaveLength(21);

    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByText(/第 2 \/ 2 页，共 25 条/)).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(6);

    // 末页时「下一页」禁用
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled();
  });
});

/* ================================================================== *
 * G6.6 · 375px 无横向溢出的**结构契约**
 * ================================================================== */

describe('G6.6 · 375px 无横向溢出的结构契约', () => {
  it('结果表包在可横向滚动的 region 里（role=region + aria-label + tabindex + min-width:0）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<StockScan />);
    await runScan(user);

    const region = screen.getByRole('region', { name: '选股结果表' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect((region as HTMLElement).style.overflowX).toBe('auto');
    expect((region as HTMLElement).style.minWidth).toBe('0');
    expect(region.querySelector('table')).not.toBeNull();
  });

  it('表单行允许换行（formRowStyle 无 flexWrap 是 375px 溢出的根因之一）', async () => {
    renderWithRouter(<StockScan />);

    const label = await screen.findByLabelText('标的类型：');
    const row = label.parentElement as HTMLElement;
    expect(row.style.flexWrap).toBe('wrap');
  });
});

/* ================================================================== *
 * 插件下拉口径
 * ================================================================== */

describe('PRD §5.6 · 只列筛选（filter）类插件', () => {
  it('monitor 类插件不出现在下拉里', async () => {
    renderWithRouter(<StockScan />);

    const select = (await screen.findByLabelText('筛选插件：')) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain('均线多头排列');
    expect(labels).not.toContain('RSI(14) 超买超卖');
  });
});
