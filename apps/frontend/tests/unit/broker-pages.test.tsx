import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import BrokerImport from '../../src/pages/BrokerImport';
import BrokerReconcile from '../../src/pages/BrokerReconcile';
import { mockErrorResponse, mockResponse, renderWithRouter } from '../helpers';

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
  fundCheck: {
    checked: 148,
    hit: 145,
    notApplicable: 3,
    skippedEvents: 12,
    mismatch: [
      { id: 1, category: 'fee_conflict' },
      { id: 2, category: 'unknown' },
    ],
    scopeNote: '仅交割单、买卖/申赎系事件参与校验',
  },
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
    // I8：CSV 导出（responseType=blob）→ 直接给 Blob + Content-Disposition
    if (url === '/broker-reconcile/diff/export')
      return Promise.resolve({
        data: new Blob(['\uFEFFid,事件'], { type: 'text/csv' }),
        headers: {
          'content-disposition': 'attachment; filename="broker-reconcile-gt-unmatched-20261107.csv"',
        },
      });
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
    if (url === '/broker-import/confirm-batch')
      return Promise.resolve(
        mockResponse({
          files: [
            {
              filename: 'gt-trade.csv',
              batchId: 9,
              rowTotal: 134,
              rowInserted: 104,
              rowDeduped: 20,
              rowExcluded: 10,
              duplicateFile: false,
            },
          ],
          backfill: { updated: 0 },
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

  /**
   * owner 报障 2026-11-05：输入「华宝」后按钮仍显示「未识别」。
   * 默认 upload mock 无 brokerNameHint（= 表头首行的成交流水，如华宝成交单）：
   * 未填标识时按分组名显示「未识别」，填了标识后必须切换为该标识。
   */
  it('无券商推断时，填券商标识后按钮标签切换为该标识', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], 'hb-trade.xls') as never);
    await waitFor(() => expect(screen.getByText('探测结果')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /确认导入【未识别】/ })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/必填/), '华宝');
    expect(screen.getByRole('button', { name: /确认导入【华宝】/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /确认导入【未识别】/ })).not.toBeInTheDocument();
  });

  /** UX-04：按钮文案统一用**实际券商编码**（落库值），不再让推断名盖过用户填写的标识。 */
  it('UX-04：手填标识后按钮文案使用实际券商编码（不写死）', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/broker-import/upload')
        return Promise.resolve(
          mockResponse({
            fileKind: 'trade',
            encoding: 'utf-8',
            headerRowIndex: 0,
            columns: [],
            mappingSuggestion: { byField: {} },
            previewRows: [],
            rowTotal: 671,
            warnings: [],
            brokerNameHint: '华宝证券',
          }),
        );
      return Promise.resolve(mockResponse({ ok: true }));
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], '20261020_华宝成交.xls') as never);
    await waitFor(() => expect(screen.getByText('探测结果')).toBeInTheDocument());

    // 单文件 + 标识为空 ⇒ 自动填入推断名，按钮显示推断名
    expect((screen.getByPlaceholderText(/必填/) as HTMLInputElement).value).toBe('华宝证券');
    expect(screen.getByRole('button', { name: /确认导入【华宝证券】/ })).toBeInTheDocument();

    // 手改成实际编码（如 'hb'）后，按钮必须显示实际编码
    const codeInput = screen.getByPlaceholderText(/必填/) as HTMLInputElement;
    await user.clear(codeInput);
    await user.type(codeInput, 'hb');
    expect(screen.getByRole('button', { name: /确认导入【hb】/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /确认导入【华宝证券】/ })).not.toBeInTheDocument();
  });

  it('UX-04：URL brokerCode 预填券商下拉；界面「事实层」无星号字面量', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/broker-import/upload')
        return Promise.resolve(
          mockResponse({
            fileKind: 'trade',
            encoding: 'utf-8',
            headerRowIndex: 0,
            columns: [],
            mappingSuggestion: { byField: {} },
            previewRows: [],
            rowTotal: 10,
            warnings: [],
            brokerNameHint: '华宝证券',
          }),
        );
      return Promise.resolve(mockResponse({ ok: true }));
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, {
      initialEntries: ['/broker/import?brokerCode=hb'],
    });

    expect((screen.getByPlaceholderText(/必填/) as HTMLInputElement).value).toBe('hb');
    expect(screen.getByText(/已从对账页预填，可修改/)).toBeInTheDocument();

    // 已有标识 → 推断名不覆盖；按钮用实际编码
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], 'hb-trade.csv') as never);
    await waitFor(() => expect(screen.getByText('探测结果')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /确认导入【hb】/ })).toBeInTheDocument();

    // UX-04：星号字面量已移除，保留正常中文文案
    expect(screen.queryByText(/\*\*事实层\*\*/)).not.toBeInTheDocument();
    expect(screen.getByText(/导入只落事实层，不会自动写入交易记录/)).toBeInTheDocument();
  });

  it('未知标的整批拒绝：显示 422 文案，不出现「导入完成」或半批次结果', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/broker-import/upload')
        return Promise.resolve(
          mockResponse({
            fileKind: 'trade',
            encoding: 'utf-8',
            headerRowIndex: 0,
            columns: [],
            mappingSuggestion: { byField: {} },
            previewRows: [],
            rowTotal: 3,
            warnings: [],
          }),
        );
      if (url === '/broker-import/confirm-batch')
        return Promise.reject(
          mockErrorResponse(
            422,
            'UNKNOWN_ASSET_CODES',
            '标的代码不存在，本次未导入任何数据：gt-trade.csv: sh999999。请核对代码后重新导入。',
          ),
        );
      return Promise.resolve(mockResponse({ ok: true }));
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], 'gt-trade.csv') as never);
    await waitFor(() => expect(screen.getByText('探测结果')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/必填/), 'gt');
    await user.click(screen.getByRole('button', { name: /确认导入/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('sh999999');
    expect(alert.textContent).toContain('本次未导入任何数据');
    expect(screen.queryByText('导入完成')).not.toBeInTheDocument();
  });

  it('未知标的（200 + pending_unknown_assets）→ 展示待确认列表，跳过后可完成落库', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/broker-import/upload')
        return Promise.resolve(
          mockResponse({
            fileKind: 'trade',
            encoding: 'utf-8',
            headerRowIndex: 0,
            columns: [],
            mappingSuggestion: { byField: {} },
            previewRows: [],
            rowTotal: 3,
            warnings: [],
          }),
        );
      if (url === '/broker-import/confirm-batch')
        return Promise.resolve(
          mockResponse({
            files: [],
            pending_unknown_assets: [
              { filename: 'gt-trade.csv', assetCodes: ['sh999999'], assetNames: ['未知股'] },
            ],
          }),
        );
      if (url === '/broker-import/confirm-final')
        return Promise.resolve(
          mockResponse({
            files: [
              {
                filename: 'gt-trade.csv',
                batchId: 9,
                rowTotal: 3,
                rowInserted: 2,
                rowDeduped: 0,
                rowExcluded: 1,
                duplicateFile: false,
              },
            ],
            backfill: { updated: 0 },
          }),
        );
      return Promise.resolve(mockResponse({ ok: true }));
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], 'gt-trade.csv') as never);
    await waitFor(() => expect(screen.getByText('探测结果')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/必填/), 'gt');
    await user.click(screen.getByRole('button', { name: /确认导入/ }));

    // 不再误显示「导入完成」，而是待用户确认是否跳过
    const pending = await screen.findByTestId('pending-unknown-assets');
    expect(pending.textContent).toContain('未知股(sh999999)');
    expect(screen.queryByText('导入完成')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /跳过这些标的并导入/ }));

    await waitFor(() => expect(screen.getByText('导入完成')).toBeInTheDocument());
    const finalCall = postMock.mock.calls.find((c) => String(c[0]) === '/broker-import/confirm-final');
    expect(finalCall).toBeTruthy();
    expect((finalCall?.[1] as { skipUnknownAssetCodes?: string[] }).skipUnknownAssetCodes).toEqual([
      'sh999999',
    ]);
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

  it('UX-15：批次表状态/券商筛选 + 分页（前端过滤，不改后端接口）', async () => {
    batchRows = Array.from({ length: 25 }, (_, i) => ({
      ...BATCH_IMPORTED,
      id: i + 1,
      broker_code: i % 2 === 0 ? 'gt' : 'hb',
      status: i % 5 === 0 ? 'revoked' : 'imported',
      file_name: `f${i + 1}.csv`,
    }));
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });

    await waitFor(() => expect(screen.getByText('f1.csv')).toBeInTheDocument());
    // 默认 20 条/页
    expect(screen.getAllByRole('row')).toHaveLength(21);
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getAllByRole('row')).toHaveLength(6); // 剩余 5 条 + 表头

    // 状态筛选：只保留已导入（i%5===0 的 5 条已撤销被排除）
    await user.selectOptions(screen.getByLabelText('按状态筛选批次'), 'imported');
    expect(screen.getAllByRole('row')).toHaveLength(21);
    expect(screen.queryByText('f1.csv')).not.toBeInTheDocument();

    // 券商筛选：hb → 只剩 hb 的已导入批次
    await user.selectOptions(screen.getByLabelText('按券商筛选批次'), 'hb');
    expect(screen.getAllByRole('row')).toHaveLength(11);
    expect(screen.getByText('f2.csv')).toBeInTheDocument();
    expect(screen.queryByText('f3.csv')).not.toBeInTheDocument();

    // 空结果给出明确文案（没有 pending 批次）
    await user.selectOptions(screen.getByLabelText('按状态筛选批次'), 'pending');
    await user.selectOptions(screen.getByLabelText('按券商筛选批次'), 'hb');
    expect(screen.getByText('当前筛选条件下没有批次')).toBeInTheDocument();
  });

  it('UX-15：本次刚导入的批次行高亮标记', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], 'gt-trade.csv') as never);
    await waitFor(() => expect(screen.getByText('探测结果')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/必填/), 'gt');
    await user.click(screen.getByRole('button', { name: /确认导入/ }));

    await waitFor(() => expect(screen.getByText('导入完成')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('batch-highlight-9')).toBeInTheDocument());
    expect(screen.getByText('本次导入')).toBeInTheDocument();
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
    // UX-05：资金校验按后端真实字段（checked/hit/notApplicable/skippedEvents/mismatch）
    expect(screen.getByText(/校验范围 148 行/)).toBeInTheDocument();
    expect(screen.getByText(/公式命中 145/)).toBeInTheDocument();
    expect(screen.getByText(/失配 2/)).toBeInTheDocument();
    expect(screen.getByText(/费用口径不符 1 · 分红 0 · 口径未知 1/)).toBeInTheDocument();
    expect(screen.getByText(/仅交割单、买卖\/申赎系事件参与校验/)).toBeInTheDocument();
    // UX-11：归因表带单位列（caliberDiff 是「条」，其余是「元」）
    expect(screen.getByText('单位')).toBeInTheDocument();
    expect(screen.getByText('条')).toBeInTheDocument();
    expect(screen.getAllByText('元').length).toBeGreaterThan(0);
    // UX-11：摘要补出疑似口径
    expect(screen.getByText(/含疑似 10/)).toBeInTheDocument();
  });

  it('口径纠偏：归因卡片展示 nonReconciled；逆回购行显示「归因（不补录）」且无「已手工记录」', async () => {
    const REPO_ROW = {
      id: 201,
      event_type: 'REPO',
      raw_event_type: '逆回购',
      asset_code: 'sh204001',
      trade_date: '2026-09-05',
      trade_time: null,
      price: null,
      quantity: 0,
      amount: 20000,
      cash_flow: 20000,
      match_status: 'MISSING',
      exclude_reason: null,
      source_file: 'repo.csv',
    };
    getMock.mockImplementation((url: string) => {
      if (url === '/broker-import/batches') return Promise.resolve(mockResponse({ batches: batchRows }));
      if (url === '/broker-reconcile/latest')
        return Promise.resolve(
          mockResponse({
            ...REPORT,
            matchSummary: { ...REPORT.matchSummary, nonReconciled: 387 },
          }),
        );
      if (url === '/broker-reconcile/diff')
        return Promise.resolve(mockResponse({ rows: [REPO_ROW] }, { pagination: { total: 1 } }));
      return Promise.reject(new Error(`unexpected get ${url}`));
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    await waitFor(() => expect(screen.getAllByText('归因（不补录）').length).toBeGreaterThanOrEqual(2));
    // 卡片标签 + 明细状态各出现一次
    expect(screen.getByText('387')).toBeInTheDocument();

    // 切到「逆回购」分类：行状态不应再显示原始 MISSING，也不该出现「已手工记录」
    await user.selectOptions(screen.getAllByRole('combobox')[1], 'repo');
    await waitFor(() => expect(screen.getByText('sh204001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '已手工记录' })).not.toBeInTheDocument();
    expect(screen.queryByText('MISSING')).not.toBeInTheDocument();
  });

  it('无对账数据（404 BROKER_NO_DATA）→ 展示后端文案与空状态，不残留旧报告', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/broker-import/batches') return Promise.resolve(mockResponse({ batches: batchRows }));
      if (url === '/broker-reconcile/latest')
        return Promise.reject(
          mockErrorResponse(404, 'BROKER_NO_DATA', '该券商无已导入事实层记录（请先完成导入）'),
        );
      if (url === '/broker-reconcile/diff')
        return Promise.resolve(mockResponse({ rows: [] }, { pagination: { total: 0 } }));
      return Promise.resolve(mockResponse({ ok: true }));
    });
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('该券商无已导入事实层记录');
    expect(screen.getByText(/请先在「券商文件导入」完成导入/)).toBeInTheDocument();
    expect(screen.queryByText(/差额归因/)).not.toBeInTheDocument();
    // UX-01：空态自带「导入文件」入口（与工具栏按钮文案区分，避免同名按钮）
    expect(screen.getByRole('button', { name: '去导入文件' })).toBeInTheDocument();
  });

  it('A 券商有报告 → 切到 B 券商无数据 → 旧报告不残留，空态可直达导入', async () => {
    batchRows = [...batchRows, { ...BATCH_IMPORTED, id: 7, broker_code: 'hb', file_name: 'hb-trade.xls' }];
    const user = userEvent.setup();
    getMock.mockImplementation((url: string, config?: { params?: { brokerCode?: string } }) => {
      if (url === '/broker-import/batches') return Promise.resolve(mockResponse({ batches: batchRows }));
      if (url === '/broker-reconcile/latest') {
        if (config?.params?.brokerCode === 'hb')
          return Promise.reject(
            mockErrorResponse(404, 'BROKER_NO_DATA', '该券商无已导入事实层记录（请先完成导入）'),
          );
        return Promise.resolve(mockResponse(REPORT));
      }
      if (url === '/broker-reconcile/diff')
        return Promise.resolve(
          mockResponse({ rows: DIFF_ROWS }, { pagination: { total: DIFF_ROWS.length } }),
        );
      return Promise.resolve(mockResponse({ ok: true }));
    });
    renderWithRouter(<BrokerReconcile />, {
      initialEntries: ['/broker/reconcile?brokerCode=gt'],
    });

    await waitFor(() => expect(screen.getByText(/差额归因/)).toBeInTheDocument());
    expect(screen.getByText('事实行')).toBeInTheDocument();

    // 从 gt 切到无数据的 hb
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'hb');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('该券商无已导入事实层记录');
    // 旧报告（摘要/归因/差异）必须全部消失
    expect(screen.queryByText(/差额归因/)).not.toBeInTheDocument();
    expect(screen.queryByText('事实行')).not.toBeInTheDocument();
    expect(screen.queryByText(/差异明细/)).not.toBeInTheDocument();
    expect(screen.getByText(/请先在「券商文件导入」完成导入/)).toBeInTheDocument();
  });

  it('券商下拉排除已撤销批次与未识别编码，标签带批次文件名（Q8）', async () => {
    batchRows = [
      ...batchRows,
      { ...BATCH_IMPORTED, id: 6, broker_code: 'hb', file_name: 'hb-trade.xls', status: 'revoked' },
      { ...BATCH_IMPORTED, id: 5, broker_code: '未识别', file_name: 'unknown.xls' },
    ];
    renderWithRouter(<BrokerReconcile />, {
      initialEntries: ['/broker/reconcile?brokerCode=gt'],
    });

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'gt（gt-trade.csv）' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('option', { name: /hb-trade\.xls/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /未识别/ })).not.toBeInTheDocument();
  });

  it('差异查询失败 → 显式报错并可重试，不再静默显示「无」', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/broker-import/batches') return Promise.resolve(mockResponse({ batches: batchRows }));
      if (url === '/broker-reconcile/latest') return Promise.resolve(mockResponse(REPORT));
      if (url === '/broker-reconcile/diff') return Promise.reject(new Error('Network Error'));
      return Promise.resolve(mockResponse({ ok: true }));
    });
    renderWithRouter(<BrokerReconcile />, {
      initialEntries: ['/broker/reconcile?brokerCode=gt'],
    });

    await waitFor(() => expect(screen.getByText(/差额归因/)).toBeInTheDocument());
    expect(await screen.findByText(/差异明细加载失败/)).toBeInTheDocument();
    expect(screen.getByText('加载失败（可点上方重试）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: '无' })).not.toBeInTheDocument();
  });

  it('「重新对账」成功 → 显示「对账已刷新」提示（不再是红色错误样式）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });
    await waitFor(() => expect(screen.getByText(/差额归因/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '重新对账' }));
    await waitFor(() => expect(screen.getByText('对账已刷新')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  it('「已手工记录」标记：MISSING 行 → 先确认再 POST /diff/:id/match（业务层不动）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    await waitFor(() => expect(screen.getByText(/差异明细/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '已手工记录' }));

    // UX-02：先弹确认，取消不发请求
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(postMock.mock.calls.some((c) => String(c[0]) === '/broker-reconcile/diff/101/match')).toBe(false);

    // 再次点击并确认后才调接口
    await user.click(screen.getByRole('button', { name: '已手工记录' }));
    await user.click(screen.getByRole('button', { name: '确认标记' }));
    await waitFor(() =>
      expect(postMock.mock.calls.some((c) => String(c[0]) === '/broker-reconcile/diff/101/match')).toBe(true),
    );
  });

  it('UX-02：标记成功后从待补录选中集合移除，并显示可见成功提示', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    await waitFor(() => expect(screen.getByText(/差异明细/)).toBeInTheDocument());
    // 勾选缺失行 → 待补录面板出现
    await user.click(screen.getAllByRole('checkbox')[0]);
    await waitFor(() => expect(screen.getByText(/全部补录（1 笔）/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '已手工记录' }));
    await user.click(screen.getByRole('button', { name: '确认标记' }));

    await waitFor(() => expect(screen.getByText(/已将事实行 #101 标记为已手工记录/)).toBeInTheDocument());
    // 已从选中集合移除（面板消失），避免同一事实行被再次补录
    expect(screen.queryByText(/全部补录（1 笔）/)).not.toBeInTheDocument();
  });

  it('UX-06：摘要两种口径有说明，「多余」下钻按当前券商过滤并分页', async () => {
    const trades = [
      ...Array.from({ length: 25 }, (_, i) => ({
        id: i + 1,
        asset_code: `sh${600000 + i}`,
        trade_type: 'buy',
        trade_date: '2026-09-01',
        quantity: 100,
        price: 10,
        broker_code: 'gt',
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: 26 + i,
        asset_code: `sz${1 + i}`,
        trade_type: 'sell',
        trade_date: '2026-09-02',
        quantity: 200,
        price: 20,
        broker_code: 'hb',
      })),
    ];
    getMock.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/broker-import/batches') return Promise.resolve(mockResponse({ batches: batchRows }));
      if (url === '/broker-reconcile/latest') return Promise.resolve(mockResponse(REPORT));
      if (url === '/broker-reconcile/diff')
        return Promise.resolve(
          mockResponse({ rows: DIFF_ROWS, total: DIFF_ROWS.length }, { pagination: { total: 2 } }),
        );
      if (url === '/trade') {
        // 后端按 broker_code 精确过滤（is_deleted=0 由 SQL 保证），前端只透传参数
        const bc = config?.params?.broker_code;
        const page = Number(config?.params?.page ?? 1);
        const limit = Number(config?.params?.limit ?? 50);
        const filtered = trades.filter((t) => t.broker_code === bc);
        return Promise.resolve(
          mockResponse(filtered.slice((page - 1) * limit, page * limit), {
            pagination: { total: filtered.length, totalPages: Math.ceil(filtered.length / limit) },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected get ${url}`));
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    await waitFor(() => expect(screen.getByText(/差额归因/)).toBeInTheDocument());
    expect(screen.getByTestId('summary-caliber').textContent).toContain('去重计数');
    expect(screen.getByText(/摘要「缺失 \/ 多余」按「标的 × 日期」去重计数/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /多余/ }));
    const panel = await screen.findByTestId('extra-drilldown');
    expect(panel.textContent).toContain('broker_code = gt');
    // 过滤条件走服务端（broker_code 透传），不在前端拉全量再筛
    expect(
      getMock.mock.calls.some(
        (c) => (c[1] as { params?: Record<string, unknown> })?.params?.broker_code === 'gt',
      ),
    ).toBe(true);
    // 只显示 gt 的 25 条；hb 的 3 条被过滤掉
    expect(panel.textContent).toContain('sh600000');
    expect(panel.textContent).not.toContain('sz1');

    // 25 条 > 20/页 → 分页可用，第二页显示剩余的 gt 记录
    expect(panel.textContent).not.toContain('sh600024');
    await user.click(within(panel).getByRole('button', { name: '下一页' }));
    expect(panel.textContent).toContain('sh600024');
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
      if (url === '/broker-import/confirm-batch')
        return Promise.resolve(
          mockResponse({
            files: [
              {
                filename: 'gt-a.csv',
                batchId: 9,
                rowTotal: 10,
                rowInserted: 10,
                rowDeduped: 0,
                rowExcluded: 0,
                duplicateFile: false,
              },
            ],
            backfill: { updated: 0 },
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
  it('两个文件推断出不同券商 → 分批导入提示 + 禁用跨券商确认 + 移除后可确认', async () => {
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
        mockResponse({
          files: [
            {
              filename: 'gt-a.csv',
              batchId: 9,
              rowTotal: 10,
              rowInserted: 10,
              rowDeduped: 0,
              rowExcluded: 0,
            },
          ],
          backfill: { updated: 0 },
        }),
      );
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, [new File(['a'], 'gt-a.csv'), new File(['b'], 'ht-b.csv')] as never);

    // 跨券商限制提示 + 两个按券商分组的确认按钮
    await waitFor(() => expect(screen.getByText(/不支持跨券商批量导入/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /确认导入【国泰君安证券】/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /确认导入【华泰证券】/ })).toBeInTheDocument();

    // 填券商标识 → 仍因多券商冲突禁用 → 点击国泰组不发请求
    await user.type(screen.getByPlaceholderText(/必填/), '国泰君安证券');
    expect(screen.getByRole('button', { name: /确认导入【国泰君安证券】/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /确认导入【国泰君安证券】/ }));
    expect(postMock.mock.calls.some((c) => String(c[0]) === '/broker-import/confirm-batch')).toBe(false);

    // 移除华泰文件 → 冲突解除 → 清理历史调用 → 确认国泰文件
    await user.click(screen.getByRole('button', { name: /移除 ht-b.csv/ }));
    await waitFor(() => {
      // 等待移除完成：文件列表应只剩 gt-a.csv
      const btn = screen.getByRole('button', { name: /确认导入【国泰君安证券】/ });
      expect(btn).toBeEnabled();
    });
    postMock.mockClear();
    const btn = screen.getByRole('button', { name: /确认导入【国泰君安证券】/ });
    await user.click(btn);
    await waitFor(() => {
      expect(
        postMock.mock.calls.some((c) => {
          if (String(c[0]) !== '/broker-import/confirm-batch') return false;
          const body = c[1] as { brokerCode?: string; files?: Array<{ filename?: string }> };
          return (
            body.brokerCode === '国泰君安证券' &&
            body.files?.length === 1 &&
            body.files[0]?.filename === 'gt-a.csv'
          );
        }),
      ).toBe(true);
      // 华泰文件不应在请求中
      expect(
        postMock.mock.calls.some((c) =>
          ((c[1] as { files?: Array<{ filename?: string }> })?.files ?? []).some(
            (f) => f.filename === 'ht-b.csv',
          ),
        ),
      ).toBe(false);
    });
  });
});

/**
 * owner 报障 2026-11-06：导入页原先**每页各一个「全部导入」按钮**（逐券商/逐页点确认），
 * 需要一个顶部全局勾选项，勾上后一次性导入这份文件的全部页。
 *
 * 后端契约（routes/brokerImport.ts）：confirm-batch 单次仅接受**一个** brokerCode + ≤5 文件，
 * 未知标的返回 200 + pending_unknown_assets，必须由用户显式选择「跳过」（confirm-final）。
 */
describe('全局「全部导入（所有页）」勾选', () => {
  const TWO_FILES = ['hb-trade.xls', 'hb-settle.xls'];

  /** 同券商两文件（无 brokerNameHint，与华宝成交单一致）+ 可配置交付结果 */
  function mockTwoFileUpload(
    opts: {
      confirmBatch?: unknown;
      confirmFinal?: unknown;
    } = {},
  ) {
    postMock.mockImplementation((url: string) => {
      if (url === '/broker-import/upload')
        return Promise.resolve(
          mockResponse({
            fileKind: 'trade',
            encoding: 'gb18030',
            headerRowIndex: 0,
            columns: [],
            mappingSuggestion: { byField: {} },
            previewRows: [],
            rowTotal: 717,
            warnings: [],
          }),
        );
      if (url === '/broker-import/confirm-batch')
        return Promise.resolve(
          mockResponse(
            opts.confirmBatch ?? {
              files: TWO_FILES.map((filename, i) => ({
                filename,
                batchId: 20 + i,
                rowTotal: 717,
                rowInserted: 717,
                rowDeduped: 0,
                rowExcluded: 21,
              })),
              backfill: { updated: 0 },
            },
          ),
        );
      if (url === '/broker-import/confirm-final')
        return Promise.resolve(
          mockResponse(
            opts.confirmFinal ?? {
              files: [
                {
                  filename: 'hb-trade.xls',
                  batchId: 30,
                  rowTotal: 717,
                  rowInserted: 715,
                  rowDeduped: 0,
                  rowExcluded: 23,
                },
              ],
              skippedUnknownAssets: 2,
            },
          ),
        );
      return Promise.reject(new Error(`unexpected post ${url}`));
    });
  }

  async function uploadTwo(user: ReturnType<typeof userEvent.setup>) {
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, TWO_FILES.map((n) => new File(['x'], n)) as never);
    await waitFor(() => expect(screen.getAllByText('探测结果').length).toBe(2));
  }

  it('勾选后隐藏逐页确认按钮，一次提交全部文件；成功后恢复逐页模式', async () => {
    mockTwoFileUpload();
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    await uploadTwo(user);
    await user.type(screen.getByPlaceholderText(/必填/), '华宝');

    // 勾选前：逐页按钮，无全局按钮
    expect(screen.getByRole('button', { name: /确认导入【华宝】（2 个文件）/ })).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-all-confirm')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('bulk-all-checkbox'));

    // 勾选后：逐页按钮隐藏，只剩全局按钮
    expect(screen.queryByRole('button', { name: /确认导入【华宝】（2 个文件）/ })).not.toBeInTheDocument();
    const bulkBtn = screen.getByTestId('bulk-all-confirm');
    expect(bulkBtn).toHaveTextContent('全部导入【华宝】（2 个文件，所有页）');

    await user.click(bulkBtn);
    await waitFor(() => expect(screen.getByText('导入完成')).toBeInTheDocument());

    // 只发一次 confirm-batch，且 files 覆盖全部页
    const batchCalls = postMock.mock.calls.filter((c) => String(c[0]) === '/broker-import/confirm-batch');
    expect(batchCalls.length).toBe(1);
    const body = batchCalls[0][1] as { brokerCode?: string; files?: Array<{ filename?: string }> };
    expect(body.brokerCode).toBe('华宝');
    expect(body.files?.map((f) => f.filename)).toEqual(TWO_FILES);

    // 成功后自动收起开关 → 逐页按钮恢复（避免二次点击重复提交）
    expect(screen.getByRole('button', { name: /确认导入【华宝】（2 个文件）/ })).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-all-confirm')).not.toBeInTheDocument();
  });

  it('取消勾选恢复逐页模式（不提交任何请求）', async () => {
    mockTwoFileUpload();
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    await uploadTwo(user);
    await user.type(screen.getByPlaceholderText(/必填/), '华宝');

    const checkbox = screen.getByTestId('bulk-all-checkbox') as HTMLInputElement;
    await user.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(screen.getByTestId('bulk-all-confirm')).toBeInTheDocument();

    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(screen.queryByTestId('bulk-all-confirm')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /确认导入【华宝】（2 个文件）/ })).toBeInTheDocument();
    expect(postMock.mock.calls.some((c) => String(c[0]) === '/broker-import/confirm-batch')).toBe(false);
  });

  it('批量模式不可用时显示原因，并保留逐页确认入口（不把入口全部藏掉）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], 'gt-trade.csv') as never);
    await waitFor(() => expect(screen.getByText('探测结果')).toBeInTheDocument());

    // 未填券商标识 → 全局批量不可用
    await user.click(screen.getByTestId('bulk-all-checkbox'));
    expect(screen.getByRole('alert')).toHaveTextContent('请先填写券商标识');
    expect(screen.getByTestId('bulk-all-confirm')).toBeDisabled();
    // 逐页按钮仍渲染（此处同样因缺标识禁用），避免勾选后所有导入入口消失
    expect(screen.getByRole('button', { name: /确认导入/ })).toBeInTheDocument();
  });

  it('多券商互斥：勾选后提示不可跨券商单批，全局按钮禁用', async () => {
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
      return Promise.reject(new Error(`unexpected post ${url}`));
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, [new File(['a'], 'gt-a.csv'), new File(['b'], 'ht-b.csv')] as never);
    await waitFor(() => expect(screen.getAllByText('探测结果').length).toBe(2));
    await user.type(screen.getByPlaceholderText(/必填/), '国泰君安证券');

    await user.click(screen.getByTestId('bulk-all-checkbox'));
    expect(screen.getByText(/所选文件属于不同券商/)).toBeInTheDocument();
    expect(screen.getByTestId('bulk-all-confirm')).toBeDisabled();
  });

  it('全量导入遇到未知标的：仍弹显式确认，不自动跳过，也不自动写库', async () => {
    mockTwoFileUpload({
      confirmBatch: {
        pending_unknown_assets: [
          { filename: 'hb-trade.xls', assetCodes: ['sh589720'], assetNames: ['某某ETF'] },
        ],
      },
    });
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    await uploadTwo(user);
    await user.type(screen.getByPlaceholderText(/必填/), '华宝');

    await user.click(screen.getByTestId('bulk-all-checkbox'));
    await user.click(screen.getByTestId('bulk-all-confirm'));

    // 未知标的卡片出现（含代码），且**没有**自动调用 confirm-final
    await waitFor(() => expect(screen.getByTestId('pending-unknown-assets')).toBeInTheDocument());
    expect(screen.getByTestId('pending-unknown-assets')).toHaveTextContent('sh589720');
    expect(screen.queryByText('导入完成')).not.toBeInTheDocument();
    expect(postMock.mock.calls.some((c) => String(c[0]) === '/broker-import/confirm-final')).toBe(false);

    // 只有用户显式点「跳过」才提交 confirm-final，并携带 skipUnknownAssetCodes
    await user.click(screen.getByRole('button', { name: /跳过这些标的并导入/ }));
    await waitFor(() => expect(screen.getByText('导入完成')).toBeInTheDocument());
    const finalBody = postMock.mock.calls.find(
      (c) => String(c[0]) === '/broker-import/confirm-final',
    )?.[1] as {
      brokerCode?: string;
      skipUnknownAssetCodes?: string[];
    };
    expect(finalBody.brokerCode).toBe('华宝');
    expect(finalBody.skipUnknownAssetCodes).toEqual(['sh589720']);
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

describe('跨页全选（全选全部页可补录）', () => {
  const makeRow = (id: number, over: Record<string, unknown> = {}) => ({
    ...DIFF_ROWS[0],
    id,
    asset_code: `sh${600000 + id}`,
    ...over,
  });

  /** /diff 按页返回给定行；total 决定跨页全选是否继续翻页 */
  function mockDiffPages(pages: Array<Array<ReturnType<typeof makeRow>>>, total: number) {
    getMock.mockImplementation((url: string, config?: { params?: Record<string, number | string> }) => {
      if (url === '/broker-import/batches') return Promise.resolve(mockResponse({ batches: batchRows }));
      if (url === '/broker-reconcile/latest') return Promise.resolve(mockResponse(REPORT));
      if (url === '/broker-reconcile/diff') {
        if (config?.params?.category !== 'unmatched')
          return Promise.resolve(mockResponse({ rows: [], total: 0 }, { pagination: { total: 0 } }));
        const p = Number(config?.params?.page ?? 1);
        return Promise.resolve(mockResponse({ rows: pages[p - 1] ?? [], total }, { pagination: { total } }));
      }
      return Promise.reject(new Error(`unexpected get ${url}`));
    });
  }

  /** confirm 返回本批条数；/run 为补录后的刷新兜底 */
  function mockConfirmOk() {
    postMock.mockImplementation((url: string, body?: { items?: unknown[] }) => {
      if (url === '/broker-reconcile/confirm')
        return Promise.resolve(
          mockResponse({
            brokerCode: 'gt',
            imported: body?.items?.length ?? 0,
            already: 0,
            invalid: 0,
            rows: [],
          }),
        );
      return Promise.resolve(mockResponse({ ok: true }));
    });
  }

  it('跨页拉全当前分类的可补录行，一次确认提交所有页', async () => {
    mockDiffPages(
      [
        [
          makeRow(101),
          makeRow(102, { match_status: 'FUZZY' }), // 疑似匹配不可补录
          makeRow(103, { asset_code: null }), // 缺标的不可补录
        ],
        [makeRow(104), makeRow(105)],
      ],
      201,
    );
    mockConfirmOk();
    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    await screen.findByRole('checkbox', { name: '全选全部页可补录' });
    await user.click(screen.getByRole('checkbox', { name: '全选全部页可补录' }));

    // 3 笔可补录行来自第 1、2 页
    expect(
      await screen.findByRole('button', { name: /全部补录（3 笔）/ }, { timeout: 3000 }),
    ).toBeInTheDocument();
    const diffP2 = getMock.mock.calls.filter(
      (c) =>
        String(c[0]) === '/broker-reconcile/diff' &&
        (c[1] as { params?: { page?: number } })?.params?.page === 2,
    );
    expect(diffP2.length).toBeGreaterThan(0);
    expect((diffP2[0][1] as { params?: { category?: string } }).params?.category).toBe('unmatched');

    await user.click(screen.getByRole('button', { name: /全部补录（3 笔）/ }));
    await waitFor(() => {
      const call = postMock.mock.calls.find((c) => String(c[0]) === '/broker-reconcile/confirm');
      expect((call?.[1] as { items: unknown }).items).toEqual([
        { sourceId: 101 },
        { sourceId: 104 },
        { sourceId: 105 },
      ]);
    });
  });

  it('跨页选中超过 500 笔时按 500 笔/批自动分批提交', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => makeRow(1000 + i));
    mockDiffPages([rows.slice(0, 200), rows.slice(200, 400), rows.slice(400)], 501);
    mockConfirmOk();
    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    await screen.findByRole('checkbox', { name: '全选全部页可补录' });
    await user.click(screen.getByRole('checkbox', { name: '全选全部页可补录' }));

    const confirmBtn = await screen.findByRole('button', { name: /全部补录（501 笔）/ }, { timeout: 5000 });
    await user.click(confirmBtn);

    const result = await screen.findByTestId('confirm-batch-result', {}, { timeout: 5000 });
    expect(result).toHaveTextContent('成功 501');
    const calls = postMock.mock.calls.filter((c) => String(c[0]) === '/broker-reconcile/confirm');
    expect(calls).toHaveLength(2);
    expect((calls[0][1] as { items: unknown[] }).items).toHaveLength(500);
    expect((calls[1][1] as { items: unknown[] }).items).toHaveLength(1);
  });
});

/**
 * 非成交族（转入 / 送股 / 现金分红）回归：
 * 旧实现里它们既不在 unmatched（只含成交族）也无独立分类 ⇒ 页面看不到、勾不到，每次导入都会漏补录。
 * INV-S2-33 要求非成交事件**永远由人工确认**，不能静默自动写库，所以这里只做「可见 + 可勾选 + 提示入口」。
 */
describe('非成交族可见性与补录（转入 / 送股 / 分红）', () => {
  const NONTRADE_ROWS = [
    {
      id: 201,
      event_type: 'TRANSFER_IN',
      raw_event_type: '调帐转入',
      asset_code: 'sh600000',
      trade_date: '2026-05-10',
      trade_time: null,
      quantity: 100,
      amount: null,
      cash_flow: 0,
      match_status: 'MISSING',
      exclude_reason: null,
      source_file: 'nt.csv',
    },
    {
      id: 202,
      event_type: 'DIVIDEND_BONUS',
      raw_event_type: '送股',
      asset_code: 'sh600000',
      trade_date: '2026-05-11',
      trade_time: null,
      quantity: 50,
      amount: null,
      cash_flow: 0,
      match_status: 'MISSING',
      exclude_reason: null,
      source_file: 'nt.csv',
    },
    {
      id: 203,
      event_type: 'DIVIDEND_CASH',
      raw_event_type: '现金红利',
      asset_code: 'sh600000',
      trade_date: '2026-05-12',
      trade_time: null,
      quantity: 0, // 现金分红无股数，只有现金流
      amount: 12.5,
      cash_flow: 12.5,
      match_status: 'MISSING',
      exclude_reason: null,
      source_file: 'nt.csv',
    },
  ];

  function mockWithPending(pendingNonTrade: number) {
    getMock.mockImplementation((url: string, config?: { params?: { category?: string } }) => {
      if (url === '/broker-import/batches') return Promise.resolve(mockResponse({ batches: batchRows }));
      if (url === '/broker-reconcile/latest')
        return Promise.resolve(mockResponse({ ...REPORT, pendingNonTrade }));
      if (url === '/broker-reconcile/diff') {
        const rows = config?.params?.category === 'nonTrade' ? NONTRADE_ROWS : DIFF_ROWS;
        return Promise.resolve(
          mockResponse({ rows, total: rows.length }, { pagination: { total: rows.length } }),
        );
      }
      return Promise.resolve(mockResponse({ ok: true }));
    });
  }

  it('有未补录的非成交事件 → 顶部数量提示，点击直达 nonTrade 分类', async () => {
    mockWithPending(3);
    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    const pending = await screen.findByTestId('non-trade-pending');
    expect(pending).toHaveTextContent('有 3 笔非成交事件');
    expect(pending).toHaveTextContent('尚未补录到交易记录');

    await user.click(screen.getByRole('button', { name: /去补录（3 笔）/ }));

    // 切到 nonTrade 分类 + 中文说明（三类非成交事件不是未知成交）
    await waitFor(() => expect(screen.getByTestId('non-trade-note')).toBeInTheDocument());
    expect(screen.getByTestId('non-trade-note').textContent).toContain('现金分红');
    expect(screen.getByText('现金红利')).toBeInTheDocument(); // 表格「事件」列展示 raw_event_type
    // 分类选择器 = nonTrade（券商选择器在前）
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('nonTrade');
  });

  it('quantity=0 的现金分红也可勾选（以现金流为门槛），且类型固定不可修正', async () => {
    mockWithPending(3);
    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });
    await screen.findByTestId('non-trade-pending');
    await user.click(screen.getByRole('button', { name: /去补录（3 笔）/ }));
    await waitFor(() => expect(screen.getByText('现金红利')).toBeInTheDocument());

    // checkbox：2 个表头（本页 / 全部页）+ 3 行；按行 aria-label 精确定位
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    expect(screen.getByRole('checkbox', { name: '选择补录 #201' })).toBeEnabled();
    const cash = screen.getByRole('checkbox', { name: '选择补录 #203' });
    expect(cash).toBeEnabled();
    await user.click(cash);

    // 补录对话框：现金分红按 dividend 固定类型，不提供成交族下拉
    expect(await screen.findByTestId('fixed-type-203')).toHaveTextContent('现金分红');
    // 用行级对话框按钮的精确文案，避免与警示条上的「一键全部补录（3 笔）」同匹配
    await user.click(screen.getByRole('button', { name: /^全部补录（1 笔）/ }));
    const confirmCall = postMock.mock.calls.find((c) => String(c[0]).includes('/broker-reconcile/confirm'));
    expect(confirmCall?.[1].items).toEqual([{ sourceId: 203 }]);
  });

  it('无此类事件时不显示提示（负例）', async () => {
    mockWithPending(0);
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });
    await waitFor(() => expect(screen.getByText(/差额归因/)).toBeInTheDocument());
    expect(screen.queryByTestId('non-trade-pending')).not.toBeInTheDocument();
    expect(screen.queryByText(/未补录到交易记录/)).not.toBeInTheDocument();
  });

  it('导入完成卡片提示非成交事件需去对账页补录（不静默写库）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<BrokerImport />, { initialEntries: ['/broker/import'] });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], 'gt-trade.csv') as never);
    await waitFor(() => expect(screen.getByText('探测结果')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/必填/), 'gt');
    await user.click(screen.getByRole('button', { name: /确认导入/ }));
    await waitFor(() => expect(screen.getByText('导入完成')).toBeInTheDocument());
    expect(screen.getByText(/若本批含/)).toBeInTheDocument();
    expect(screen.getByText(/缺失未匹配（非成交族）/)).toBeInTheDocument();
  });
});

/**
 * 一键全部补录（owner 要求）：
 * 把「当前所有待补录的非成交事件」一次提交，但仍是**显式人工确认**（点按钮 → 弹窗列条数与构成 → 确认才发请求）。
 * 后端路径：复用 POST /broker-reconcile/confirm，按 500 条/批分批（每批整体事务，跨批可能部分成功）。
 */
describe('一键全部补录（非成交族）', () => {
  const makeRow = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    event_type: 'DIVIDEND_CASH',
    raw_event_type: '现金红利',
    asset_code: 'sh600000',
    trade_date: '2026-05-12',
    trade_time: null,
    quantity: 0,
    amount: 12.5,
    cash_flow: 12.5,
    match_status: 'MISSING',
    exclude_reason: null,
    source_file: 'nt.csv',
    ...over,
  });

  /** /diff 按 page/pageSize 切片；/latest 的 pendingNonTrade 由参数决定 */
  function mockPending(rows: Array<ReturnType<typeof makeRow>>, pendingNonTrade: number) {
    getMock.mockImplementation((url: string, config?: { params?: Record<string, number | string> }) => {
      if (url === '/broker-import/batches') return Promise.resolve(mockResponse({ batches: batchRows }));
      if (url === '/broker-reconcile/latest')
        return Promise.resolve(mockResponse({ ...REPORT, pendingNonTrade }));
      if (url === '/broker-reconcile/diff') {
        if (config?.params?.category !== 'nonTrade')
          return Promise.resolve(
            mockResponse(
              { rows: DIFF_ROWS, total: DIFF_ROWS.length },
              {
                pagination: { total: DIFF_ROWS.length },
              },
            ),
          );
        const p = Number(config?.params?.page ?? 1);
        const size = Number(config?.params?.pageSize ?? 200);
        return Promise.resolve(
          mockResponse(
            { rows: rows.slice((p - 1) * size, p * size), total: rows.length },
            {
              pagination: { total: rows.length },
            },
          ),
        );
      }
      return Promise.resolve(mockResponse({ ok: true }));
    });
  }

  it('点按钮 → 弹确认框（条数+构成）→ 确认后一次提交全部待补录行', async () => {
    const rows = [
      makeRow(201, { event_type: 'TRANSFER_IN', quantity: 100, amount: null, cash_flow: 0 }),
      makeRow(202, { event_type: 'DIVIDEND_BONUS', quantity: 50, amount: null, cash_flow: 0 }),
      makeRow(203),
    ];
    mockPending(rows, 3);
    postMock.mockResolvedValue(
      mockResponse({ brokerCode: 'gt', imported: 3, already: 0, invalid: 0, rows: [] }),
    );

    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    await user.click(await screen.findByTestId('one-click-backfill'));
    const dialog = await screen.findByTestId('one-click-dialog');
    expect(dialog).toHaveTextContent('一键补录：3 笔');
    expect(dialog).toHaveTextContent('转入/转增（transfer） 1 笔');
    expect(dialog).toHaveTextContent('送股（bonus） 1 笔');
    expect(dialog).toHaveTextContent('现金分红（dividend） 1 笔');

    await user.click(screen.getByRole('button', { name: /确认补录（3 笔）/ }));

    const confirmCalls = postMock.mock.calls.filter((c) => String(c[0]) === '/broker-reconcile/confirm');
    expect(confirmCalls).toHaveLength(1);
    expect((confirmCalls[0][1] as { items: unknown }).items).toEqual([
      { sourceId: 201 },
      { sourceId: 202 },
      { sourceId: 203 },
    ]);
    expect(await screen.findByTestId('one-click-result')).toHaveTextContent('成功 3');
  });

  // CI 上 jsdom + 501 行渲染 + 分批请求链路曾 6.5s 超时（2026-11-11 run 43135122262 / 43135843654）；
  // 本用例是 501→2 批的机制验证（与用例数无关），给 30s 宽限消除 flaky，不是掩盖真实慢逻辑
  it('超过 500 条自动分批（501 → 2 次请求，500 + 1）', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => makeRow(1000 + i));
    mockPending(rows, 501);
    postMock.mockImplementation((url: string, body?: { items: unknown[] }) => {
      if (url === '/broker-reconcile/confirm')
        return Promise.resolve(
          mockResponse({
            brokerCode: 'gt',
            imported: body?.items.length ?? 0,
            already: 0,
            invalid: 0,
            rows: [],
          }),
        );
      return Promise.resolve(mockResponse({ ok: true }));
    });

    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });
    await user.click(await screen.findByTestId('one-click-backfill'));
    await screen.findByTestId('one-click-dialog');
    expect(screen.getByTestId('one-click-dialog')).toHaveTextContent('一键补录：501 笔');
    await user.click(screen.getByRole('button', { name: /确认补录（501 笔）/ }));

    await waitFor(
      () => {
        const calls = postMock.mock.calls.filter((c) => String(c[0]) === '/broker-reconcile/confirm');
        expect(calls).toHaveLength(2);
        expect((calls[0][1] as { items: unknown[] }).items).toHaveLength(500);
        expect((calls[1][1] as { items: unknown[] }).items).toHaveLength(1);
      },
      { timeout: 30_000 },
    );
  }, 30_000);

  it('部分失败：第 2 批报错仍保留成功结果，并给出批次原因', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => makeRow(2000 + i));
    mockPending(rows, 501);
    let callNo = 0;
    postMock.mockImplementation((url: string, body?: { items: unknown[] }) => {
      if (url === '/broker-reconcile/confirm') {
        callNo += 1;
        if (callNo === 2)
          return Promise.reject(mockErrorResponse(409, 'CONFIRM_CONFLICT', '事务冲突，已回滚'));
        return Promise.resolve(
          mockResponse({
            brokerCode: 'gt',
            imported: body?.items.length ?? 0,
            already: 0,
            invalid: 0,
            rows: [],
          }),
        );
      }
      return Promise.resolve(mockResponse({ ok: true }));
    });

    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });
    await user.click(await screen.findByTestId('one-click-backfill'));
    await screen.findByTestId('one-click-dialog');
    await user.click(screen.getByRole('button', { name: /确认补录（501 笔）/ }));

    const result = await screen.findByTestId('one-click-result');
    expect(result).toHaveTextContent('成功 500');
    expect(result).toHaveTextContent('失败批次 1');
    expect(result).toHaveTextContent('第 2 批');
  });

  it('未知标的（asset_code=null）也提交，由后端逐条返回不可补原因并展示', async () => {
    const rows = [
      makeRow(301),
      makeRow(302, { asset_code: null, quantity: 100, amount: null, cash_flow: 0 }),
    ];
    mockPending(rows, 2);
    postMock.mockResolvedValue(
      mockResponse({
        brokerCode: 'gt',
        imported: 1,
        already: 0,
        invalid: 1,
        rows: [{ sourceId: 302, status: 'invalid', tradeType: null, reason: '缺少标的代码' }],
      }),
    );

    const user = userEvent.setup();
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });
    await user.click(await screen.findByTestId('one-click-backfill'));
    await screen.findByTestId('one-click-dialog');
    await user.click(screen.getByRole('button', { name: /确认补录（2 笔）/ }));

    const result = await screen.findByTestId('one-click-result');
    expect(result).toHaveTextContent('不可补 1');
    expect(result).toHaveTextContent('#302：缺少标的代码');
  });

  it('无待补录时（pendingNonTrade=0）不显示一键按钮', async () => {
    mockPending([makeRow(401)], 0);
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });
    await screen.findByText(/差额归因/);
    expect(screen.queryByTestId('one-click-backfill')).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * I8 · 差异明细 CSV 导出（PRD_v3 §3.2.1 / §4.3）
 * ------------------------------------------------------------------ */

describe('I8 差异明细导出', () => {
  it('导出按钮按「当前券商 + 当前分类」请求 CSV，并触发浏览器下载', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:i8');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });
    await screen.findByText('差异明细（2）');
    await user.click(screen.getByTestId('diff-export-csv'));

    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith('/broker-reconcile/diff/export', {
        params: { brokerCode: 'gt', category: 'unmatched' },
        responseType: 'blob',
      }),
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(clickSpy).toHaveBeenCalled();
    expect(await screen.findByText(/已导出「缺失未匹配（成交族）」明细（2 条）/)).toBeInTheDocument();

    clickSpy.mockRestore();
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  });

  it('当前分类无差异时导出按钮禁用（不产生空文件）', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/broker-import/batches') return Promise.resolve(mockResponse({ batches: [] }));
      if (url === '/broker-reconcile/latest') return Promise.resolve(mockResponse(REPORT));
      if (url === '/broker-reconcile/diff')
        return Promise.resolve(mockResponse({ rows: [], total: 0 }, { pagination: { total: 0 } }));
      return Promise.reject(new Error(`unexpected get ${url}`));
    });
    renderWithRouter(<BrokerReconcile />, { initialEntries: ['/broker/reconcile?brokerCode=gt'] });

    await screen.findByText('差异明细（0）');
    expect(screen.getByTestId('diff-export-csv')).toBeDisabled();
  });
});
