/**
 * tests/http/pe1-pe3-browser.test.ts —— **PE1（首屏加载）与 PE3（K 线首渲染）真浏览器验收**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 📖 **SDD §12.5 性能验收组（权威口径，逐字照抄）**
 * ════════════════════════════════════════════════════════════════════════
 *   | PE1 | 首屏加载 ≤ 1.5s | Lighthouse Chrome DevTools | Performance 分数 ≥ 90 |
 *   | PE3 | K 线首渲染 ≤ 500ms | Chrome Performance Profiler | **FP (First Paint) ≤ 500ms** |
 *
 * ── 测量方式（**照 SDD，不自创**）──
 *   SDD 的工具是 **Chrome / Chrome DevTools**。本用例用 **CDP 直连 Chromium**，
 *   读取 **Performance API 的 paint / navigation 条目** ——
 *   这正是 Chrome DevTools 的 Performance 面板与 Lighthouse 取的**同一份数据**。
 *   ⚠️ **未测**：Lighthouse 的「Performance 分数 ≥ 90」（需要 Lighthouse 工具本身，
 *      本仓库不引入新依赖 ⇒ 该子判据**如实标记为未实测**，不假装测了）。
 *
 *   | 指标 | 口径 |
 *   |---|---|
 *   | PE1 | **FCP**（First Contentful Paint）≤ 1500ms（同时记录 LCP / load）|
 *   | PE3 | **FP**（First Paint）≤ 500ms（SDD 明确写的就是 FP）|
 *
 * ── 前置条件（缺一即 skip + 留痕，**绝不假绿**）──
 *   ① 本机有 Chromium/Chrome（`CHROMIUM_BIN` / Playwright 缓存 / PATH）
 *   ② 前端构建产物存在（`apps/frontend/dist/index.html`）—— CI 里没有 ⇒ 跳过
 *
 * ── 为什么必须「真 listen」──
 *   前端是**真浏览器**打开的：页面要经 `/api/*` 反代打后端 ⇒ 后端必须是真 socket 服务，
 *   前端的 fetch 才有真实的网络往返（`inject()` 根本不在这条链路上）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  FRONTEND_DIST,
  findChromiumBinary,
  frontendDistReady,
  launchChromium,
  measurePage,
  startFrontendServer,
  type BrowserHandle,
  type FrontendServer,
} from './_browser.js';
import { assertRealListen, createHttpApp, seedHoldings, seedUser, type HttpTestApp } from './_helpers.js';

/** SDD §12.5 PE1 门槛：首屏加载 ≤ 1.5s */
const PE1_BUDGET_MS = 1500;
/** SDD §12.5 PE3 门槛：FP ≤ 500ms */
const PE3_BUDGET_MS = 500;

const CHROMIUM_BIN = findChromiumBinary();
const DIST_READY = frontendDistReady();
/** 两个前置条件都满足才跑（否则 skip + 留痕） */
const BROWSER_READY = Boolean(CHROMIUM_BIN) && DIST_READY;

/** 测试用户 */
const TEST_UID = 95001;

let http: HttpTestApp;
let frontend: FrontendServer;
let browser: BrowserHandle;
let token = '';
let klineSymbol = '';

beforeAll(async () => {
  if (!BROWSER_READY) return;

  http = await createHttpApp({ portStart: 51300, portEnd: 51319 });
  await seedUser(TEST_UID, 'pe13_user');
  await seedHoldings(TEST_UID, ['sh600000', 'sh600519']);

  const { signToken } = await import('../../src/services/auth.js');
  token = signToken({ sub: TEST_UID, username: 'pe13_user', role: 'user' });

  // K 线页的标的：从行情库里取一只真实存在的股票
  const { queryDuckDB } = await import('../../src/db/duckdb.js');
  const rows = await queryDuckDB<{ symbol: string }>(
    `SELECT symbol FROM raw_symbol_class WHERE "class" = 'stock' ORDER BY symbol LIMIT 1`,
  );
  klineSymbol = rows[0]?.symbol ?? 'sh600000';

  // 前端静态服务（+ /api 反代，等价生产 Caddy 的两段路由）
  frontend = await startFrontendServer({
    distDir: FRONTEND_DIST,
    backendBaseUrl: http.baseUrl,
    port: 51400,
  });

  browser = await launchChromium(CHROMIUM_BIN as string);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await frontend?.close();
  await http?.close();
}, 60_000);

describe('PE1 / PE3 —— 真浏览器首屏与 K 线首渲染（SDD §12.5）', () => {
  const itBrowser = BROWSER_READY ? it : it.skip;

  if (!BROWSER_READY) {
    console.warn(
      '[PE1/PE3] ⚠️ 被**跳过**：' +
        (CHROMIUM_BIN
          ? ''
          : '本机没有 Chromium/Chrome（CHROMIUM_BIN 未设、Playwright 缓存与 PATH 里都没有）；') +
        (DIST_READY
          ? ''
          : '前端构建产物不存在（apps/frontend/dist/index.html）—— 需先 `npm run build -w @invest/frontend`；') +
        ' ⇒ PE1（1.5s）与 PE3（500ms）门槛**未在本次运行中验证**。',
    );
  }

  it('前置守卫：后端确实调用了 app.listen()（浏览器链路走的是真 socket）', async () => {
    const raw = await assertRealListen(http.app, http.port);
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
  });

  itBrowser(
    'PE1：首屏加载（FCP）≤ 1500ms',
    async () => {
      const m = await measurePage({
        browserPort: browser.port,
        url: `${frontend.url}/`,
        token,
        username: 'pe13_user',
        waitMs: 800,
      });
      console.log(
        `[PE1] 仪表盘首屏：FP=${m.firstPaint?.toFixed(0)}ms FCP=${m.firstContentfulPaint?.toFixed(0)}ms ` +
          `LCP=${m.largestContentfulPaint?.toFixed(0)}ms DCL=${m.domContentLoaded?.toFixed(0)}ms ` +
          `load=${m.loadEventEnd?.toFixed(0)}ms（控制台错误 ${m.consoleErrors} 条）`,
      );
      expect(m.firstContentfulPaint, '首屏没有产生 FCP').not.toBeNull();
      expect(
        m.firstContentfulPaint as number,
        `FCP=${m.firstContentfulPaint?.toFixed(0)}ms 超过 1500ms 门槛`,
      ).toBeLessThanOrEqual(PE1_BUDGET_MS);
    },
    120_000,
  );

  itBrowser(
    'PE3：K 线首渲染（FP）≤ 500ms',
    async () => {
      const m = await measurePage({
        browserPort: browser.port,
        url: `${frontend.url}/kline?symbol=${klineSymbol}`,
        token,
        username: 'pe13_user',
        waitMs: 1200,
      });
      console.log(
        `[PE3] K 线页（${klineSymbol}）：FP=${m.firstPaint?.toFixed(0)}ms ` +
          `FCP=${m.firstContentfulPaint?.toFixed(0)}ms LCP=${m.largestContentfulPaint?.toFixed(0)}ms ` +
          `canvas 出现=${m.canvasReady?.toFixed(0)}ms（控制台错误 ${m.consoleErrors} 条）`,
      );
      expect(m.firstPaint, 'K 线页没有产生 FP').not.toBeNull();
      expect(m.firstPaint as number, `FP=${m.firstPaint?.toFixed(0)}ms 超过 500ms 门槛`).toBeLessThanOrEqual(
        PE3_BUDGET_MS,
      );
    },
    120_000,
  );
});
