/**
 * a11y 基线用例（Wave 3 · G3.4「axe 核心规则 0 critical」）
 *
 * ## 定位
 *
 * 这是 G3.4 门槛的**可执行载体**：把「axe 核心规则 0 critical」从一句人眼检查
 * 变成一条 CI 能跑、能复现、能防回归的断言。
 *
 * Wave 3 会重写 Dashboard，但**基线先行** —— 本文件先把「现状」钉住，
 * 后续任何一次改动引入了新的 critical 违规，CI 会立刻变红。
 *
 * ## 做法
 *
 * 1. 渲染**整个 `<App />`**（不是孤立页面组件）——
 *    因为 a11y 规则（如 `region`「内容必须在 landmark 内」）
 *    依赖 App 外壳提供的 `<header>` / `<main>` / `<footer>`；
 *    只渲染页面组件会得到一堆「页面外没有 landmark」的**假违规**。
 * 2. mock 掉 `src/api/client`（**不是** mock axios）——
 *    页面拿到的仍是后端统一 envelope（`{ code, data, timestamp }`），
 *    渲染路径与线上一致。
 * 3. 对 `document.body` 跑 axe，断言 **0 条 critical**。
 *
 * ## 已知边界
 *
 * - jsdom 下不可评估的规则见 `tests/helpers/a11y.ts` 的
 *   {@link AXE_RULES_UNSUPPORTED_IN_JSDOM}（共 5 条，含 `color-contrast`）。
 *   这 5 条由真浏览器脚本 `scripts/a11y-check.mjs` 兜底（那边不关任何规则）。
 * - `/kline` 页**无法**在 jsdom 下测 —— 它用 `<canvas>` 手绘 K 线，
 *   jsdom 未实现 `getContext('2d')`（返回 `null`）→ 组件必崩。
 *   已登记为 `it.todo`，由真浏览器脚本覆盖。
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import React from 'react';
import { act, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../helpers';
import {
  runA11y,
  getA11yViolations,
  expectNoCriticalA11yViolations,
  formatA11yViolations,
  filterViolationsByImpact,
} from '../helpers/a11y';
import App from '../../src/App';
import { useUserStore } from '../../src/store/user';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

const { getMock, postMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: {
    get: getMock,
    post: postMock,
    patch: patchMock,
    put: vi.fn(),
    delete: vi.fn(),
  },
  // App.tsx 订阅「会话过期」事件；本用例不触发过期，给个空实现即可
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/',
}));

/** 造一个后端统一 envelope 的成功响应 */
function ok(data: unknown, extra?: Record<string, unknown>) {
  return { data: { code: 0, data, timestamp: '2026-10-20T00:00:00.000Z', ...(extra ?? {}) } };
}

/* ------------------------------------------------------------------ *
 * 各接口的假数据（尽量贴近真实形状，避免「空态页面」把问题藏起来）
 * ------------------------------------------------------------------ */

const POSITIONS = [
  {
    asset_code: 'sh600000',
    totalQuantity: 100,
    totalCostBasis: 500,
    avgCost: 5,
    realizedPnL: 12,
    currentPrice: 6,
    priceDate: '2026-10-17',
    marketValue: 600,
    unrealizedPnl: 100,
    unrealizedYield: 0.2,
    weight: 0.6,
  },
  {
    asset_code: 'sh510300',
    totalQuantity: 100,
    totalCostBasis: 350,
    avgCost: 3.5,
    realizedPnL: -3,
    currentPrice: 4,
    priceDate: '2026-10-17',
    marketValue: 400,
    unrealizedPnl: 50,
    unrealizedYield: 0.14,
    weight: 0.4,
  },
];

const HOLDING_SUMMARY = {
  totalMarketValue: 1000,
  totalCostBasis: 850,
  unrealizedPnl: 150,
  realizedPnL: 9,
  priceDate: '2026-10-17',
  positionCount: 2,
};

const ASSET_STAT = {
  trade_date: '2026-10-17',
  total_assets_price_yield: 0.1234,
  total_assets_actual_yield: 0.2345,
  total_profit_price: 1234.56,
  total_profit_actual: -789.01,
};

const SIGNALS = [
  {
    id: 1,
    asset_code: 'sh600000',
    plugin_id: 'ma_cross',
    direction: 'buy',
    label: '金叉',
    strength: 0.8,
    trade_date: '2026-10-17',
    created_at: '2026-10-17 17:02:00',
  },
  {
    id: 2,
    asset_code: 'sz159915',
    plugin_id: 'rsi_revert',
    direction: 'sell',
    label: '超买',
    strength: 0.6,
    trade_date: '2026-10-17',
    created_at: '2026-10-17 17:02:00',
  },
];

const SYSTEM_LOGS = [
  {
    id: 1,
    created_at: '2026-10-17 17:02:00',
    log_type: 'datacheck',
    level: 'INFO',
    message: 'C1-C12 校验通过',
  },
];

const REVIEW_TRADES = [
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
    review_summary: '复盘摘要',
    remark: null,
    created_at: '2026-10-01 10:00:00',
  },
];

const REVIEW_STATS = {
  totalTrades: 10,
  reviewedCount: 8,
  closedCount: 4,
  winCount: 3,
  lossCount: 1,
  winRate: 0.75,
  avgWin: 100,
  avgLoss: -50,
  profitLossRatio: 2,
  totalRealizedPnl: 250,
};

const ASSET_HISTORY = [
  {
    trade_date: '2026-09-30',
    total_assets_price_yield: 0.05,
    total_assets_actual_yield: 0.06,
    total_profit_price: 500,
    total_profit_actual: 600,
  },
  {
    trade_date: '2026-10-17',
    total_assets_price_yield: 0.12,
    total_assets_actual_yield: 0.23,
    total_profit_price: 1234,
    total_profit_actual: 2000,
  },
];

const PLUGINS = [
  {
    id: 'ma_cross',
    name: '均线交叉',
    category: 'monitor',
    description: '短期均线上穿长期均线',
    paramSchema: [
      { key: 'short', label: '短期均线', type: 'number', min: 1, max: 60, default: 5, unit: '日' },
      { key: 'long', label: '长期均线', type: 'number', min: 5, max: 250, default: 20, unit: '日' },
      {
        key: 'mode',
        label: '模式',
        type: 'select',
        options: ['金叉', '死叉'],
        default: '金叉',
        required: true,
      },
      { key: 'enabled', label: '启用', type: 'boolean', default: true },
      { key: 'note', label: '备注', type: 'string' },
    ],
    enabled: 1,
    params: { short: 5, long: 20 },
  },
];

const STOCKSCAN_PLUGINS = [
  {
    id: 'ma_cross',
    name: '均线交叉',
    description: '短期均线上穿长期均线',
    category: 'filter',
    paramSchema: [{ key: 'short', label: '短期均线', type: 'number', min: 1, max: 60, default: 5 }],
  },
];

const DATACHECK_SUMMARIES = [
  { checkId: 'C1', result: 'PASS', message: 'ok', detail: null },
  { checkId: 'C2', result: 'WARN', message: 'warn', detail: 'detail text' },
];

/** 按 url 分派假数据（覆盖所有页面在挂载时会打的接口） */
function installApiMock(): void {
  getMock.mockImplementation(async (url: string) => {
    switch (url) {
      case '/holding':
        return ok(POSITIONS, { summary: HOLDING_SUMMARY });
      case '/asset-stat/latest':
        return ok(ASSET_STAT);
      case '/signal':
        return ok(SIGNALS);
      case '/admin/system-log':
        return ok(SYSTEM_LOGS, { pagination: { total: 1, totalPages: 1 } });
      case '/review/yield':
        return ok(REVIEW_STATS);
      case '/review/trades':
        return ok(REVIEW_TRADES, { pagination: { total: 1, totalPages: 1 } });
      case '/asset-stat/history':
        return ok(ASSET_HISTORY);
      case '/strategy/plugins':
        return ok(PLUGINS);
      case '/stockscan/plugins':
        return ok(STOCKSCAN_PLUGINS);
      case '/admin/datacheck/result':
        return ok(DATACHECK_SUMMARIES);
      default:
        // 未预期的接口返回空数组 —— 页面会走空态分支，不应崩溃
        return ok([]);
    }
  });
  postMock.mockResolvedValue(ok(null));
  patchMock.mockResolvedValue(ok(null));
}

/* ------------------------------------------------------------------ *
 * 页面清单
 * ------------------------------------------------------------------ */

/** 一个待检页面 */
interface PageCase {
  /** 页面 key（用例名 / 基线表 key） */
  readonly key: string;
  /** 路由路径（登录态由 `useUserStore` 决定） */
  readonly path: string;
  /** 是否需要 admin 角色 */
  readonly admin?: boolean;
}

/**
 * 待检页面清单
 *
 * ⚠️ 与 `src/App.tsx` 的路由一一对应 —— 新增页面时**必须**在这里补一条，
 * 否则 G3.4 会出现「新增页面逃过门禁」的盲区。
 *
 * ⚠️ `/kline` 不在此列 —— 它用 `<canvas>` 手绘，jsdom 无 `getContext('2d')` → 组件必崩
 *    （见文件末尾的 `it.todo`），由真浏览器脚本 `scripts/a11y-check.mjs` 覆盖。
 */
const PAGES: PageCase[] = [
  { key: 'login', path: '/login' },
  { key: 'dashboard', path: '/' },
  { key: 'trade', path: '/trade' },
  { key: 'signals', path: '/signals' },
  { key: 'stockscan', path: '/stockscan' },
  { key: 'candidates', path: '/candidates' },
  { key: 'review', path: '/review' },
  { key: 'settings', path: '/settings' },
  { key: 'admin', path: '/admin', admin: true },
  { key: 'notfound', path: '/__a11y_unknown_route__' },
];

/**
 * 各页面的「已知违规基线」
 *
 * 实测（2026-10-20）：**全部为空** —— 现有页面在 jsdom 下 0 违规（critical 与其它等级都是 0）。
 *
 * 用途：任何等级的新违规都会让对应的 `全量违规基线` 断言变红，
 * 迫使「要么修、要么显式登记 + 写明所属 Wave」，不允许静默通过。
 *
 * 格式：`[规则 id, impact, 首个影响节点的 html 片段]`
 */
const KNOWN_VIOLATIONS: Record<string, ReadonlyArray<readonly [string, string, string]>> = {
  login: [],
  dashboard: [],
  trade: [],
  signals: [],
  stockscan: [],
  candidates: [],
  review: [],
  settings: [],
  admin: [],
  notfound: [],
};

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

/**
 * 渲染指定路由并等页面把异步数据渲染完
 *
 * ⚠️ 必须用 `act` 包住「等 Promise 结算」这一步 ——
 *    否则 React 会警告 "An update to X inside a test was not wrapped in act(...)"，
 *    而且 `React.lazy` 的 Admin 页会报 "A suspended resource finished loading inside a test"。
 */
async function renderRoute(page: PageCase): Promise<void> {
  useUserStore.setState({
    token: 'test-token',
    username: 'a11y-tester',
    role: page.admin ? 'admin' : 'user',
    refreshToken: null,
  });

  renderWithRouter(<App />, { initialEntries: [page.path] });

  // 冲刷页面挂载后发出的所有请求（mock 是 async 的，状态更新发生在 act 之外）
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('a11y 基线 · G3.4（axe 核心规则 0 critical）', () => {
  beforeAll(() => {
    /**
     * jsdom 不加载 `index.html` —— `<html lang>` 与 `<title>` 都是默认值。
     * 这里**照抄** `index.html` 的真实值，
     * 让 `html-has-lang` / `document-title` 这两条「文档级」规则也能被真实评估。
     */
    document.documentElement.setAttribute('lang', 'zh-CN');
    document.title = 'InvestAssistant';
  });

  beforeEach(() => {
    installApiMock();
  });

  for (const page of PAGES) {
    describe(`页面 ${page.key}（${page.path}）`, () => {
      it('无 critical 级 a11y 违规（G3.4 门禁）', async () => {
        await renderRoute(page);

        const result = await runA11y(document.body);
        await expectNoCriticalA11yViolations(result);
      });

      it('全量违规基线未漂移（任何等级）', async () => {
        await renderRoute(page);

        const result = await runA11y(document.body);
        const actual = filterViolationsByImpact(result.violations, 'all').map((v) => [
          v.id,
          v.impact ?? 'unknown',
          v.nodes[0]?.html ?? '',
        ]);

        expect(actual).toEqual([...KNOWN_VIOLATIONS[page.key]]);
      });

      /**
       * 标题层级：**有且仅有 1 个 `<h1>`**（T76 ⑦ · Wave 7 卡 5）
       *
       * ⚠️ axe 的 `page-has-heading-one` 是 **moderate** 级（不进 G3.4 的 critical 门禁），
       *    但它同样是真缺陷 —— 读屏用户靠 h1 定位页面，层级缺失会让他们「不知道自己在哪」。
       *    `/kline` 曾长期是 `<h2>`（本卡已改成 `<h1>`），故在此钉死断言防回归。
       *
       * ⚠️ `/kline` 页在 jsdom 里跑不了（canvas）→ 由真浏览器脚本覆盖，见文件末尾的 `it.todo`。
       */
      it('标题层级：有且仅有 1 个 <h1>（T76 ⑦）', async () => {
        await renderRoute(page);

        // Admin 是 `React.lazy` 异步 chunk —— 等它渲染出来再断言
        await waitFor(() => {
          expect(document.querySelectorAll('h1').length).toBeGreaterThan(0);
        });
        expect(document.querySelectorAll('h1')).toHaveLength(1);
      });
    });
  }

  /**
   * `/kline` 无法在 jsdom 下测 —— 它用 `<canvas>` 手绘 K 线 + MACD/RSI 副图，
   * jsdom 未实现 `HTMLCanvasElement.getContext('2d')`（返回 `null`）→ 组件必崩。
   *
   * ⇒ 登记为 `todo`，由真浏览器脚本 `scripts/a11y-check.mjs`（Chromium 真渲染）覆盖。
   */
  it.todo('K 线页（/kline）的 a11y —— jsdom 无 canvas 实现，改由真浏览器脚本覆盖');

  it('文档级语义（html[lang] / title）与 index.html 一致', async () => {
    /**
     * 单独跑一次「整篇文档」范围的 axe ——
     * `html-has-lang` / `document-title` 只在 context 含 `<html>` 时才会被评估，
     * 而逐页断言用的 context 是 `document.body`。
     */
    const result = await runA11y(document);
    const critical = filterViolationsByImpact(result.violations, 'critical');
    expect(formatA11yViolations(critical)).toBe('（无违规）');
  });

  /**
   * 🔴 **反证（negative control）** —— 门禁本身必须被验证过
   *
   * 只断言「0 critical」无法区分两种情况：
   * - (a) 页面真的干净；
   * - (b) axe 根本没跑到东西（比如 context 传错、规则被全关、axe 静默失败），
   *       于是「0 条违规」是**假绿**。
   *
   * ⇒ 本用例**故意**往 DOM 里塞一个已知 critical 级违规
   * （`<img>` 缺 `alt` → axe `image-alt`，impact = critical），
   * 断言门禁**必须报错**；移除后再断言恢复绿色。
   *
   * ⚠️ **不改 `src/`** —— 违规节点在测试运行时注入 DOM，测完即移除。
   */
  it('反证（negative control）：注入已知 critical 违规后，门禁断言必须失败', async () => {
    // 注入一个没有 alt 的 <img> → axe `image-alt`（impact: critical）
    const broken = document.createElement('img');
    broken.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==');
    document.body.appendChild(broken);

    try {
      const result = await runA11y(document.body);
      const critical = filterViolationsByImpact(result.violations, 'critical');
      expect(critical.map((v) => v.id)).toContain('image-alt');

      // 门禁断言必须抛错，且错误信息里能看出是哪条规则
      await expect(expectNoCriticalA11yViolations(result)).rejects.toThrow(/image-alt/);

      // 公开 API `getA11yViolations` 也必须能独立取到 critical 违规（默认只返回 critical）
      const viaApi = await getA11yViolations(document.body);
      expect(viaApi.map((v) => v.id)).toContain('image-alt');
    } finally {
      broken.remove();
    }

    // 移除违规节点后必须恢复绿色（证明刚才的红是「注入」造成的，不是环境问题）
    const restored = await runA11y(document.body);
    await expectNoCriticalA11yViolations(restored);
  });
});
