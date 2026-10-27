import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import BrokerImport from '../../src/pages/BrokerImport';
import BrokerReconcile from '../../src/pages/BrokerReconcile';
import { mockResponse, renderWithRouter } from '../helpers';

/**
 * V3.8 T143/T144 · 券商对账域页面级用例
 *
 * 覆盖：
 * - T143 导入向导：探测结果展示（类型/编码/行数/映射建议/警告）+ 确认导入 + 幂等提示
 * - T144 对账报告：摘要四宫格 / 差额归因（残差置顶）/ 资金校验 / 回填 / 逆回购 / 三口径
 * - T145 补录：勾选缺失行 → trade_type 可修正 → 确认（整体事务）→ 结果（成功 N / 失败 M）
 * - 权限：路由挂在 AdminGuard（页面本身不重复鉴权，路由层已拦）
 */

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock, post: postMock },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/broker/reconcile',
}));

const REPORT = {
  brokerCode: 'gt',
  coveredRange: { from: '2025-08-29', to: '2026-10-20' },
  coverageNote: '以导入流水覆盖区间为准',
  matchSummary: { factRows: 811, matched: 600, fuzzy: 10, missing: 190, extra: 11 },
  attribution: {
    repo: 30,
    cashLikeEtf: 20,
    dividend: 15,
    offExchange: 40,
    uncoveredPeriod: 5,
    caliberDiff: 8,
    residual: 120,
    order: ['residual', 'repo', 'cashLikeEtf', 'dividend', 'offExchange', 'uncoveredPeriod', 'caliberDiff'],
  },
  fundCheck: { applicable: 700, passed: 690, notApplicable: 110, byReason: { 现金分红: 110 } },
  timeBackfill: { matched: 125, lowConfidence: 2, unmatched: 3 },
  repoModel: {
    pairs: [],
    unpairedOpens: 0,
    unpairedCloses: 0,
    totalInterest: 7501.46,
    impliedAnnualRate: 2.04,
  },
  returnSummary: { risk: 1.2, cash: 0.3, total: 1.4, note: '占位口径' },
  generatedAt: '2026-10-26T05:00:00Z',
};

const DIFF_ROWS = [
  {
    id: 101,
    event_type: 'TRADE_BUY',
    raw_event_type: '买入',
    asset_code: 'sh600000',
    trade_date: '2026-09-01',
    trade_time: null,
    quantity: 100,
    amount: 1000,
    cash_flow: -1000,
    match_status: 'MISSING',
    exclude_reason: null,
    source_file: 'a.csv',
  },
  {
    id: 102,
    event_type: 'TRADE_SELL',
    raw_event_type: '卖出',
    asset_code: 'sz000001',
    trade_date: '2026-09-02',
    trade_time: '14:30:00',
    quantity: 200,
    amount: 2000,
    cash_flow: 2000,
    match_status: 'FUZZY',
    exclude_reason: null,
    source_file: 'a.csv',
  },
];

const BATCH_IMPORTED = {
  id: 9,
  broker_code: 'gt',
  file_kind: 'trade',
  file_name: 'gt-trade.csv',
  status: 'imported',
  row_total: 134,
  row_inserted: 104,
  row_deduped: 20,
  row_excluded: 10,
  created_at: '2026-10-20 10:00:00',
};

const BATCH_REVOKED = {
  ...BATCH_IMPORTED,
  id: 8,
  file_name: 'gt-settlement.csv',
  file_kind: 'settlement',
  status: 'revoked',
  row_total: 20,
  row_inserted: 15,
  row_excluded: 5,
};

let batchRows: Array<typeof BATCH_IMPORTED>;

beforeEach(() => {
  vi.clearAllMocks();
  batchRows = [{ ...BATCH_IMPORTED }, { ...BATCH_REVOKED }];
  getMock.mockImplementation((url: string) => {
    if (url === '/broker-import/batches') return Promise.resolve(mockResponse({ batches: batchRows }));
    if (url === '/broker-reconcile/latest') return Promise.resolve(mockResponse(REPORT));
    if (url === '/broker-reconcile/diff')
      return Promise.resolve(
        mockResponse(
          { rows: DIFF_ROWS, total: DIFF_ROWS.length },
          { pagination: { total: DIFF_ROWS.length } },
        ),
      );
    return Promise.reject(new Error(`unexpected get ${url}`));
  });
  postMock.mockImplementation((url: string) => {
    if (url === '/broker-import/upload')
      return Promise.resolve(
        mockResponse({
          fileKind: 'trade',
          encoding: 'utf-8',
          headerRowIndex: 0,
          columns: [],
          mappingSuggestion: { byField: { symbol: { column: 1, confidence: 'high' }, direction: null } },
          previewRows: [{ raw: 'row1' }],
          rowTotal: 134,
          warnings: [{ code: 'SENSITIVE_DROPPED', message: '已丢弃敏感列' }],
        }),
      );
    if (url === '/broker-import/confirm')
      return Promise.resolve(
        mockResponse({
          batchId: 9,
          rowTotal: 134,
          rowInserted: 104,
          rowDeduped: 20,
          rowExcluded: 10,
          duplicateFile: false,
        }),
      );
    if (url === '/broker-import/batches/9/revoke') {
      batchRows = batchRows.map((b) => (b.id === 9 ? { ...b, status: 'revoked' } : b));
      return Promise.resolve(mockResponse({ batchId: 9, affectedRows: 104 }));
    }
    if (url === '/broker-reconcile/run') return Promise.resolve(mockResponse({ ok: true }));
    if (url === '/broker-reconcile/confirm')
      return Promise.resolve(
        mockResponse({
          brokerCode: 'gt',
          imported: 1,
          already: 0,
          invalid: 1,
          rows: [{ sourceId: 102, status: 'invalid', tradeType: null, reason: '缺数量' }],
        }),
      );
    if (url === '/broker-reconcile/diff/101/match') return Promise.resolve(mockResponse({ sourceId: 101 }));
    return Promise.reject(new Error(`unexpected post ${url}`));
  });
});

describe('T143 券商导入向导 /broker/import', () => {
  it('探测 + 确认导入：类型/编码/行数/映射/警告全展示，确认后可跳对账页', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });

    // 选文件触发探测
    const input = screen.getByRole('textbox') as HTMLInputElement;
    // 页面里第一个 <input type=file> 用 label 包着，直接找 file input
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    void input;

    const file = new File(['\x00\x01fake'], 'gt-trade.csv', { type: 'text/csv' });
    await user.upload(fileInput, file as never);

    await waitFor(() => expect(screen.getByText('探测结果')).toBeInTheDocument());
    expect(screen.getByText('134')).toBeInTheDocument(); // 行数
    expect(screen.getByText('utf-8')).toBeInTheDocument();
    expect(screen.getByText('已丢弃敏感列')).toBeInTheDocument(); // 警告
    expect(screen.getByText('（未识别）')).toBeInTheDocument(); // 未命中映射列（direction=null）

    // 填券商标识 + 确认
    const codeInput = screen.getByPlaceholderText(/必填/);
    await user.type(codeInput, 'gt');
    await user.click(screen.getByRole('button', { name: /确认导入/ }));

    await waitFor(() => expect(screen.getByText('导入完成')).toBeInTheDocument());
    expect(screen.getByText('104')).toBeInTheDocument(); // rowInserted
    expect(screen.getByText('去重跳过')).toBeInTheDocument();

    // 跳转对账页
    await user.click(screen.getByRole('button', { name: /查看对账报告/ }));
    await waitFor(() => expect(postMock.mock.calls.length).toBeGreaterThanOrEqual(1));
  });

  it('导入批次：列表展示统计；撤销需二次确认，成功后刷新为已撤销', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });

    await waitFor(() => expect(screen.getByText('gt-trade.csv')).toBeInTheDocument());
    expect(screen.getByText('134 / 104 / 10')).toBeInTheDocument();
    expect(screen.getByText('已导入')).toBeInTheDocument();
    expect(screen.getByText('已撤销')).toBeInTheDocument(); // 已撤销批次不显示撤销按钮

    await user.click(screen.getByRole('button', { name: '撤销批次 #9' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/软删除该批次全部事实层记录/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '确认撤销' }));

    await waitFor(() =>
      expect(postMock.mock.calls.some((c) => String(c[0]) === '/broker-import/batches/9/revoke')).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId('batch-notice')).toHaveTextContent('已撤销批次 #9'));
    expect(screen.getAllByText('已撤销').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button', { name: '撤销批次 #9' })).not.toBeInTheDocument();
  });

  it('导入批次撤销：点「取消」不发请求', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });

    await waitFor(() => expect(screen.getByText('gt-trade.csv')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '撤销批次 #9' }));
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(postMock.mock.calls.some((c) => String(c[0]).includes('/revoke'))).toBe(false);
  });
});

describe('T144 对账报告 /broker/reconcile', () => {
  it('摘要四宫格 + 归因残差置顶 + 资金/回填/逆回购/三口径分块', async () => {
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    await waitFor(() => expect(screen.getByText(/差额归因/)).toBeInTheDocument());
    // 四宫格
    expect(screen.getByText('事实行')).toBeInTheDocument();
    expect(screen.getByText('缺失（可补录）')).toBeInTheDocument();
    // 残差置顶且非 0 醒目
    expect(screen.getByText(/残差（无法解释）/)).toBeInTheDocument();
    // 逆回购实测基线
    expect(screen.getByText(/7501\.46/)).toBeInTheDocument();
    // 三口径占位
    expect(screen.getAllByText(/占位口径/).length).toBeGreaterThan(0);
    // 差异明细行
    expect(screen.getByText('买入')).toBeInTheDocument();
    expect(screen.getByText('sh600000')).toBeInTheDocument();
  });

  it('T145 补录：勾选缺失行 → 类型可修正 → 确认 → 结果（成功 1 / 不可补 1）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    await waitFor(() => expect(screen.getByText(/差异明细/)).toBeInTheDocument());

    // 勾选缺失行 #101（FUZZY 的 #102 也可勾但数量/标的齐全；这里勾 MISSING）
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]);

    // 补录对话框出现 + 提示语
    await waitFor(() => expect(screen.getByText(/这将写入你的交易记录，可撤销/)).toBeInTheDocument());

    // trade_type 可修正：把第 1 行改成 reduce
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[selects.length - 1], 'reduce');

    // 确认补录
    await user.click(screen.getByRole('button', { name: /全部补录/ }));

    await waitFor(() => expect(screen.getByText('补录结果')).toBeInTheDocument());
    expect(screen.getByText(/成功 1 · 已存在 0 · 不可补 1/)).toBeInTheDocument();

    // postMock 收到 /confirm 且带修正后的 tradeType
    const confirmCall = postMock.mock.calls.find((c) => String(c[0]).includes('/broker-reconcile/confirm'));
    expect(confirmCall).toBeTruthy();
    expect(confirmCall?.[1].items).toEqual([{ sourceId: 101, tradeType: 'reduce' }]);
  });

  it('「已手工记录」标记：MISSING 行 → POST /diff/:id/match（业务层不动）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    await waitFor(() => expect(screen.getByText(/差异明细/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '已手工记录' }));

    await waitFor(() =>
      expect(postMock.mock.calls.some((c) => String(c[0]) === '/broker-reconcile/diff/101/match')).toBe(true),
    );
  });
});

/**
 * T151（V3.8a）券商域增强：① 券商标识必填 + 文件内容自动推断 ② 多文件 + 不同券商分批提示 ③ 补录全选
 */
describe('T151① 券商标识必填 + 自动推断（brokerNameHint）', () => {
  it('推断出券商名且标识框为空 → 自动填入 + 「自动推断」提示；红星必填标记存在', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/broker-import/upload')
        return Promise.resolve(
          mockResponse({
            fileKind: 'trade',
            encoding: 'utf-8',
            headerRowIndex: 5,
            columns: [],
            mappingSuggestion: { byField: {} },
            previewRows: [],
            rowTotal: 10,
            warnings: [],
            brokerNameHint: '国泰君安证券',
          }),
        );
      if (url === '/broker-import/confirm')
        return Promise.resolve(
          mockResponse({
            batchId: 9,
            rowTotal: 10,
            rowInserted: 10,
            rowDeduped: 0,
            rowExcluded: 0,
            duplicateFile: false,
          }),
        );
      return Promise.resolve(mockResponse({ ok: true }));
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], 'gt-a.csv') as never);

    // 标识框被自动填入推断券商名 + 提示文案
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/必填/) as HTMLInputElement).value).toBe('国泰君安证券'),
    );
    expect(screen.getByText(/已按文件内容自动推断/)).toBeInTheDocument();
    // 必填红星标记（label 内的 *）
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('已手填标识 → 推断不覆盖（用户输入优先）', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/broker-import/upload')
        return Promise.resolve(
          mockResponse({
            fileKind: 'trade',
            headerRowIndex: 5,
            columns: [],
            mappingSuggestion: { byField: {} },
            previewRows: [],
            rowTotal: 10,
            warnings: [],
            brokerNameHint: '华泰证券',
          }),
        );
      return Promise.resolve(mockResponse({ ok: true }));
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    // 先填标识，再传文件
    await user.type(screen.getByPlaceholderText(/必填/), 'gt');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], 'a.csv') as never);
    await waitFor(() => expect((screen.getByPlaceholderText(/必填/) as HTMLInputElement).value).toBe('gt'));
    expect(screen.queryByText(/已按文件内容自动推断/)).not.toBeInTheDocument();
  });
});

describe('T151② 多文件 + 不同券商提示分批导入', () => {
  it('两个文件推断出不同券商 → 「分批导入」提示 + 按券商分组的确认按钮', async () => {
    postMock.mockImplementation((url: string, body?: unknown) => {
      if (url === '/broker-import/upload') {
        const fn = String((body as { filename?: string })?.filename ?? '');
        return Promise.resolve(
          mockResponse({
            fileKind: 'trade',
            headerRowIndex: 5,
            columns: [],
            mappingSuggestion: { byField: {} },
            previewRows: [],
            rowTotal: 10,
            warnings: [],
            brokerNameHint: fn.startsWith('gt') ? '国泰君安证券' : '华泰证券',
          }),
        );
      }
      return Promise.resolve(
        mockResponse({ batchId: 9, rowTotal: 10, rowInserted: 10, rowDeduped: 0, rowExcluded: 0 }),
      );
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, [new File(['a'], 'gt-a.csv'), new File(['b'], 'ht-b.csv')] as never);

    // 分批导入提示 + 两个按券商分组的确认按钮
    await waitFor(() => expect(screen.getByText(/分批导入/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /确认导入【国泰君安证券】/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /确认导入【华泰证券】/ })).toBeInTheDocument();

    // 点国泰组 → 只确认该组文件（brokerCode=国泰君安证券）
    await user.click(screen.getByRole('button', { name: /确认导入【国泰君安证券】/ }));
    await waitFor(() => {
      expect(
        postMock.mock.calls.some(
          (c) =>
            String(c[0]) === '/broker-import/confirm' &&
            (c[1] as { brokerCode?: string }).brokerCode === '国泰君安证券' &&
            (c[1] as { filename?: string }).filename === 'gt-a.csv',
        ),
      ).toBe(true);
    });
  });
});

describe('T151③ 补录全选（当前页可补录行）', () => {
  it('表头「全选本页可补录」勾选 → 全部可补录行进补录队列', async () => {
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });
    // DIFF_ROWS：101=MISSING(可补录)、102=FUZZY(不可) → 全选只选 101
    await screen.findByRole('checkbox', { name: '全选本页可补录' });
    await userEvent.click(screen.getByRole('checkbox', { name: '全选本页可补录' }));
    // 行级 101 被勾选（102 无 checkbox）
    expect(screen.getByRole('button', { name: /全部补录（1 笔）/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /全部补录/ }));
    await waitFor(() => {
      expect(
        postMock.mock.calls.some(
          (c) =>
            String(c[0]) === '/broker-reconcile/confirm' &&
            JSON.stringify((c[1] as { items: unknown }).items) === JSON.stringify([{ sourceId: 101 }]),
        ),
      ).toBe(true);
    });
  });
});
