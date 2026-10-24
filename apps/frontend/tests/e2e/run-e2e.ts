/**
 * 前端 E2E（T77 · Wave 8）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ## 它解决什么
 *
 * `apps/frontend/tests/unit/*.test.tsx`（vitest + jsdom）覆盖了组件的**结构与逻辑**，
 * 但 jsdom **没有 layout engine、也没有真实网络** ⇒ 「点了 Tab 之后页面真的变了吗」
 * 「提交之后后端真的收到并落库了吗」这类**端到端**问题测不到。
 *
 * 本脚本在 **Chromium 真浏览器**下跑 **4 条关键路径**（PRD §5.9 的用户旅程）：
 *
 * | # | 路径 | 断言要点 |
 * |---|------|----------|
 * | 1 | **登录** | 登录表单 → `POST /api/auth/login` 的 `code === 0` → 落到仪表盘 → 会话写进 zustand `invest-user` |
 * | 2 | **持仓（双口径切换）** | 仪表盘「价格口径 / 实际口径」两个按钮 → 切换后**数值与口径说明文案都变** |
 * | 3 | **交易录入** | 顶部 **Tab 切换**（含「除权补充」次级面板）→ **操作理由必填**（缺理由时提交按钮禁用 + 红字提示）→ 提交成功 |
 * | 4 | **复盘** | **4 色 pill**（灰 / 绿 / 橙 / 红）+ 图例 → **编辑弹窗三态**（未标记 / 是 / 否）→ 保存落库 |
 *
 * ## 🔴 断言口径：T89b 起响应体**没有 `success` 字段**
 *
 * 成功判定唯一口径是 **`code === 0`**（数字 0）；错误体是 `typeof code === 'string'`。
 * 本脚本**不使用** `body.success`。
 *
 * ## 怎么跑
 *
 * 1. 起后端（**临时库**，别用开发库）：
 *    ```bash
 *    cd apps/backend
 *    SQLITE_DB_PATH=/tmp/e2e/business.db BACKUP_DIR=/tmp/e2e/backups \
 *    DUCKDB_PATH=/tmp/e2e/quotes.duckdb PORT=8081 DISABLE_CRON=1 \
 *      npx tsx src/server.ts
 *    ```
 * 2. 起前端 dev server（vite，固定 5173）：
 *    ```bash
 *    cd apps/frontend && npx vite --port 5173
 *    ```
 * 3. 跑门禁：
 *    ```bash
 *    npx tsx apps/frontend/tests/e2e/run-e2e.ts \
 *      --api-base-url http://127.0.0.1:8081 \
 *      --sqlite-path /tmp/e2e/business.db \
 *      --username e2e_user --password e2e_pass1234
 *    ```
 *
 * ## ⚠️ 收尾（AGENTS.md 四步，**必须做干净**）
 *
 * ```bash
 * # ① 杀整棵进程树（tsx / vite 的包装层 PID ≠ 监听 PID）
 * # ② 按端口强杀：8080 / 8081 / 5173~5175 / 51100~51999
 * # ③ 查不占端口的残留（tsx watch / vite）
 * # ④ 端口段 LISTEN 归零 + Step 3 无输出 = 真干净
 * ```
 *
 * 本脚本自己只负责 **playwright 会话**（`close`）与**临时目录**；
 * 后端 / vite 进程由启动者负责收尾（与 `scripts/a11y-check.mjs`、`scripts/probe-overflow.mjs` 同约定）。
 *
 * ## 依赖
 *
 * 用**全局的 `playwright-cli`**（与上面两个脚本完全一致），
 * **不往 package.json 里加 playwright 依赖**（AGENTS.md「新增 npm 依赖必须说明理由」）。
 *
 * - 已安装：`npm i -g @playwright/cli`
 * - 浏览器内核：`npx playwright install chromium`（本机 `~/.cache/ms-playwright` 已有）
 * - ⚠️ 本机默认浏览器是 `chrome`（未安装）→ 必须显式 `--browser=chromium`。
 *
 * ## 退出码
 *
 * - `0` —— 4 条路径全部 PASS
 * - `1` —— 有断言失败（打印每条失败项的实测值）
 * - `2` —— 用法错误 / 依赖缺失 / 目标站点不可达
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** playwright-cli 会话名（独立于其它脚本，避免互相干扰）*/
const SESSION = 'frontend-e2e';

/** 一条断言 */
interface E2ECheck {
  name: string;
  ok: boolean;
  detail: string | null;
}

/** 一条路径（4 条路径之一）*/
interface E2EFlow {
  name: string;
  checks: E2ECheck[];
}

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */
const USAGE = `用法：
  npx tsx apps/frontend/tests/e2e/run-e2e.ts [选项]

选项：
  --base-url <url>      前端 dev server 地址（默认 http://127.0.0.1:5173）
  --api-base-url <url>  把页面的 /api/* 请求改写到该地址（默认直连前端 dev server 的代理）
  --sqlite-path <path>  后端业务库路径（用于写「双口径资产快照」夹具）
  --username <name>     登录用户名（默认 e2e_user）
  --password <pass>     登录密码（默认 e2e_pass1234）
  --browser <name>      playwright 浏览器（默认 chromium）
  --timeout <ms>        单次请求等待超时（默认 30000）
  --report <file>       把结果写成 JSON 报告文件
  --skip-seed           不准备数据（后端已备好数据时用）
  --help                显示本帮助

退出码：0 = 4 条路径全 PASS；1 = 有断言失败；2 = 用法/环境错误`;

interface Options {
  baseUrl: string;
  apiBaseUrl: string | null;
  sqlitePath: string | null;
  username: string;
  password: string;
  browser: string;
  timeout: number;
  report: string | null;
  skipSeed: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    baseUrl: 'http://127.0.0.1:5173',
    apiBaseUrl: null,
    sqlitePath: process.env.SQLITE_DB_PATH ?? null,
    username: 'e2e_user',
    password: 'e2e_pass1234',
    browser: 'chromium',
    timeout: 30000,
    report: null,
    skipSeed: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) fail(`参数 ${arg} 缺少取值`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--base-url':
        opts.baseUrl = next();
        break;
      case '--api-base-url':
        opts.apiBaseUrl = next();
        break;
      case '--sqlite-path':
        opts.sqlitePath = next();
        break;
      case '--username':
        opts.username = next();
        break;
      case '--password':
        opts.password = next();
        break;
      case '--browser':
        opts.browser = next();
        break;
      case '--timeout':
        opts.timeout = Number(next());
        break;
      case '--report':
        opts.report = next();
        break;
      case '--skip-seed':
        opts.skipSeed = true;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`未知参数：${arg}\n\n${USAGE}`);
    }
  }
  return opts;
}

/** 打印错误并退出（码 2 = 用法/环境错误）*/
function fail(message: string): never {
  console.error(`[frontend-e2e] ❌ ${message}`);
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * playwright-cli 驱动（与 scripts/a11y-check.mjs 同款）
 * ------------------------------------------------------------------ */

/** 执行 playwright-cli，返回 stdout（trim 后）*/
function pw(args: string[], { allowFail = false } = {}): string {
  try {
    return execFileSync('playwright-cli', ['-s=' + SESSION, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err) {
    if (allowFail) return '';
    const detail = err as { stderr?: string; message?: string };
    const stderr = detail.stderr ? String(detail.stderr) : '';
    fail(`playwright-cli ${args.join(' ')} 执行失败：\n${stderr || detail.message || String(err)}`);
  }
}

/** playwright-cli 是否可用 */
function ensurePlaywrightCli(): void {
  try {
    execFileSync('playwright-cli', ['--version'], { stdio: 'ignore' });
  } catch {
    fail(
      '找不到 playwright-cli。请先安装：\n' +
        '  npm i -g @playwright/cli\n' +
        '并确保浏览器内核已就绪：\n' +
        '  npx playwright install chromium',
    );
  }
}

/**
 * 执行一段 Playwright 代码（`async page => {...}`），返回其返回值（JSON）
 *
 * ⚠️ playwright-cli 的 `run-code` 只接受**一段代码** ⇒ 4 条路径必须**放在同一次调用**里跑
 *   （浏览器侧的 `page.route` 处理器闭包只活在 playwright-cli 的 Node 进程里，
 *   跨调用无法共享状态 —— 实测 `globalThis` 不跨 `run-code` 调用保留）。
 */
function runPlaywrightCode(source: string): E2EFlow[] | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'frontend-e2e-'));
  const file = path.join(dir, 'pw-code.js');
  writeFileSync(file, source, 'utf8');
  try {
    const raw = pw(['--raw', 'run-code', `--filename=${file}`]);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as E2EFlow[];
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 让页面里的 `/api/*` 请求改打到别的后端地址
 *
 * ⚠️ 为什么需要：vite 的代理 target 在 `apps/frontend/vite.config.ts` 里**写死 8080**，
 *    而 8080 常被宿主其它服务占用 → 后端只能跑在 8081。
 *    与 `scripts/a11y-check.mjs` 的 `rewriteApiBase` 同款做法（浏览器侧改写，不改仓库配置）。
 *
 * ⚠️ **响应体必须原样透传**：把 fetch 到的 body fulfill 回去，
 *    否则页面的 axios 拿不到 JSON（`code` 判定会全挂）。
 */
function rewriteApiBase(apiBaseUrl: string): void {
  const apiRoot = apiBaseUrl.replace(/\/+$/, '') + '/api/';
  runPlaywrightCode(
    `async page => {\n` +
      `  await page.route('**/api/**', async (route) => {\n` +
      `    const target = route.request().url().replace(/^https?:\\/\\/[^/]+\\/api\\//, ${JSON.stringify(apiRoot)});\n` +
      `    const response = await route.fetch({ url: target });\n` +
      `    const text = await response.text();\n` +
      `    await route.fulfill({ status: response.status(), headers: response.headers(), body: text });\n` +
      `  });\n` +
      `  return true;\n` +
      `}\n`,
  );
}

/* ------------------------------------------------------------------ *
 * 数据准备（夹具）
 * ------------------------------------------------------------------ */

/** 夹具结果 */
interface SeedResult {
  userId: number;
  username: string;
  tradeIds: number[];
  snapshotWritten: boolean;
}

/** 调后端 API（返回 `{ status, body }`）*/
async function callApi(
  apiBase: string,
  p: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const resp = await fetch(`${apiBase.replace(/\/+$/, '')}${p}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = (await resp.json()) as Record<string, unknown>;
  return { status: resp.status, body };
}

/**
 * 准备 E2E 需要的业务数据
 *
 * ⚠️ **为什么大部分走 API、只有快照直连 SQLite**：
 * - 交易 / 复盘字段：走真实 API（与用户操作同一条路）；
 * - **双口径资产快照**（`user_asset_stat`）：写入方是 **17:02 cron**
 *   （`services/scheduler.ts` → `insertAssetStatSnapshots`），**没有任何 HTTP 端点**能触发它
 *   ⇒ E2E 只能直连业务库写这行夹具。
 *
 * 产出的数据刻意覆盖**复盘 4 色**：
 * | 交易 | 复盘字段 | 颜色档 |
 * |---|---|---|
 * | buy sh600519 | 无 | 灰（未复盘）|
 * | buy sh600036 | review_summary + strategy_match=1 | 橙（主观决策）|
 * | add sh600036 | is_stop_loss=1 | 红（止损）|
 * | reduce sh600036 | 无 | 灰（未复盘）← E2E 第 4 步改它 |
 * | dividend sh600036 | system_followed=1 | 绿（系统信号）|
 */
async function prepareData(
  apiBase: string,
  username: string,
  password: string,
  sqlitePath: string | null,
): Promise<SeedResult> {
  // ① 注册（库里 0 用户 ⇒ 首个用户自动 admin，SDD §4.4 的 bootstrap 路径）
  let token = '';
  let userId = 0;
  const reg = await callApi(apiBase, '/api/auth/register', {
    method: 'POST',
    body: { username, password },
  });
  if (reg.status === 201 && reg.body.code === 0) {
    const data = reg.body.data as { token: string; user: { id: number } };
    token = data.token;
    userId = data.user.id;
  } else {
    // 已经有这个用户（复跑）→ 直接登录
    const login = await callApi(apiBase, '/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    if (login.status !== 200 || login.body.code !== 0) {
      fail(
        `准备数据失败：注册 ${reg.status}/${String(reg.body.code)}，登录 ${login.status}/${String(login.body.code)}`,
      );
    }
    const data = login.body.data as { token: string; user: { id: number } };
    token = data.token;
    userId = data.user.id;
  }

  // ② 交易（买入 / 加仓 / 减仓 / 分红）
  const trades: Array<Record<string, unknown>> = [
    {
      asset_code: 'sh600519',
      trade_type: 'buy',
      trade_date: '2026-01-06',
      trade_time: '09:00:01',
      quantity: 800,
      price: 5,
      trade_reason: 'E2E 建仓',
    },
    {
      asset_code: 'sh600036',
      trade_type: 'buy',
      trade_date: '2026-01-05',
      trade_time: '09:00:02',
      quantity: 1000,
      price: 10,
      fee: 5,
      trade_reason: 'E2E 建仓',
    },
    {
      asset_code: 'sh600036',
      trade_type: 'add',
      trade_date: '2026-01-10',
      trade_time: '09:00:03',
      quantity: 500,
      price: 12,
      trade_reason: 'E2E 加仓',
    },
    {
      asset_code: 'sh600036',
      trade_type: 'reduce',
      trade_date: '2026-02-10',
      trade_time: '09:00:04',
      quantity: 400,
      price: 15,
      fee: 2,
      trade_reason: 'E2E 减仓',
    },
    {
      asset_code: 'sh600036',
      trade_type: 'dividend',
      trade_date: '2026-03-01',
      trade_time: '09:00:05',
      quantity: 1500,
      price: 0.5,
      system_followed: 1,
    },
  ];
  const tradeIds: number[] = [];
  for (const t of trades) {
    const res = await callApi(apiBase, '/api/trade', { method: 'POST', body: t, token });
    if (res.status === 201 && res.body.code === 0) {
      const data = res.body.data as { trade_id: number };
      tradeIds.push(data.trade_id);
      continue;
    }
    // 🔴 **幂等**：同一批夹具重复跑时，唯一索引会挡下重复交易（409 TRADE_DUPLICATE）
    //   ⇒ 退回「按标的 + 类型查已有那笔」，让脚本可以**反复跑**（门禁脚本必须可重入）。
    if (res.status === 409) {
      const list = await callApi(
        apiBase,
        `/api/trade?asset_code=${String(t.asset_code)}&trade_type=${String(t.trade_type)}`,
        { token },
      );
      const rows = list.body.data as Array<{ id: number }>;
      const hit = rows.find((r) => r.id !== undefined);
      if (hit) {
        tradeIds.push(hit.id);
        continue;
      }
    }
    fail(`准备数据失败：交易 ${String(t.trade_type)} ${res.status}/${String(res.body.code)}`);
  }

  // ③ 复盘字段（橙档 / 红档）
  const patches: Array<{ id: number; payload: Record<string, unknown> }> = [
    { id: tradeIds[1], payload: { review_summary: 'E2E 复盘：建仓理由成立', strategy_match: 1 } },
    {
      id: tradeIds[2],
      payload: { review_summary: 'E2E 复盘：止损离场', strategy_match: 1, is_stop_loss: 1 },
    },
  ];
  for (const p of patches) {
    const res = await callApi(apiBase, `/api/trade/${p.id}`, { method: 'PATCH', body: p.payload, token });
    if (res.status !== 200 || res.body.code !== 0) {
      fail(`准备数据失败：复盘 PATCH ${res.status}/${String(res.body.code)}`);
    }
  }

  // ④ 双口径资产快照（**只能直连业务库** —— 写入方是 17:02 cron，无 HTTP 端点）
  let snapshotWritten = false;
  if (sqlitePath) {
    const db = new Database(sqlitePath);
    try {
      const tradeDate = new Date().toISOString().slice(0, 10);
      db.prepare(
        `INSERT OR REPLACE INTO user_asset_stat
           (user_id, trade_date, total_assets_price_yield, total_assets_actual_yield,
            total_profit_price, total_profit_actual)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(userId, tradeDate, 0.3, 0.4375, 1200, 1750);
      snapshotWritten = true;
    } finally {
      db.close();
    }
  }

  return { userId, username, tradeIds, snapshotWritten };
}

/* ------------------------------------------------------------------ *
 * 页面侧代码（playwright `async page => {...}`）
 * ------------------------------------------------------------------ */

/**
 * 4 条路径的执行体
 *
 * ⚠️ 所有断言都用 `check(name, ok, detail)` 收集，**不抛异常** ——
 *   一条路径里某个断言失败不应中断后面的路径（要一次性看到全部问题）。
 *
 * @param base 前端 dev server 地址
 * @param username 登录用户名
 * @param password 登录密码
 */
function pageFlows(base: string, username: string, password: string): string {
  return `async page => {
  const results = [];
  let current = null;
  const check = (name, ok, detail) => { current.checks.push({ name, ok: !!ok, detail: detail ?? null }); };
  const begin = (name) => { current = { name, checks: [] }; results.push(current); };

  /** 读「标签 div 的前一个兄弟 div」—— Dashboard 的指标值 / 标签是同父级的两个 div */
  const metricValue = async (label) => {
    const el = page.getByText(label, { exact: true }).first();
    return await el.evaluate((node) => node.previousElementSibling?.textContent?.trim() ?? null);
  };

  /* ── 路径 1：登录 ───────────────────────────────────────────── */
  begin('路径 1 · 登录');
  await page.goto(${JSON.stringify(base + '/login')}, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-input-username', { timeout: 15000 });
  check('登录页渲染（用户名输入框存在）', true);
  check('隐私声明常驻（PRD §5.9）', (await page.locator('[data-testid="privacy-notice"]').count()) === 1);

  await page.fill('#login-input-username', ${JSON.stringify(username)});
  await page.fill('#login-input-password', ${JSON.stringify(password)});
  const statPromise = page.waitForResponse((r) => r.url().includes('/api/asset-stat/latest'), { timeout: 30000 }).catch(() => null);
  const [loginResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/login'), { timeout: 30000 }),
    page.click('form button[type=submit]'),
  ]);
  const loginBody = await loginResponse.json();
  // 🔴 T89b：成功判定唯一口径 code === 0
  check('POST /api/auth/login → code === 0', loginBody.code === 0, 'code=' + JSON.stringify(loginBody.code));
  check('登录响应体没有 success 字段（T89b）', !('success' in loginBody));

  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  check('登录后跳离 /login', !new URL(page.url()).pathname.startsWith('/login'), page.url());

  const stored = await page.evaluate(() => localStorage.getItem('invest-user'));
  let parsed = null;
  try { parsed = JSON.parse(stored ?? 'null'); } catch { parsed = null; }
  check('会话写入 zustand localStorage（invest-user）', !!parsed && !!parsed.state && !!parsed.state.token);
  check('localStorage 里的角色是 admin（首个注册用户）', parsed?.state?.role === 'admin', 'role=' + parsed?.state?.role);

  const statResponse = await statPromise;
  if (statResponse) {
    const statBody = await statResponse.json();
    check('GET /api/asset-stat/latest → code === 0', statBody.code === 0, 'code=' + JSON.stringify(statBody.code));
  } else {
    check('GET /api/asset-stat/latest 发出过', false, '未捕获到该请求');
  }

  /* ── 路径 2：持仓（双口径切换）────────────────────────────────── */
  begin('路径 2 · 持仓双口径切换');
  const priceBtn = page.getByRole('button', { name: '价格口径' });
  const actualBtn = page.getByRole('button', { name: '实际口径' });
  check('仪表盘渲染双口径按钮', (await priceBtn.count()) === 1 && (await actualBtn.count()) === 1);

  const priceProfit = await metricValue('总盈亏');
  const priceYield = await metricValue('总收益率');
  const priceHint = await page.getByText(/价格口径：纯价格涨跌/).count();
  check('初始为价格口径（口径说明文案在）', priceHint === 1, 'hintCount=' + priceHint);

  await actualBtn.click();
  await page.waitForTimeout(300);
  const actualProfit = await metricValue('总盈亏');
  const actualYield = await metricValue('总收益率');
  const actualHint = await page.getByText(/实际口径：含分红等现金流/).count();
  check('切到实际口径后口径说明文案切换', actualHint === 1, 'hintCount=' + actualHint);
  check('切到实际口径后「总盈亏」数值变化', actualProfit !== priceProfit, priceProfit + ' → ' + actualProfit);
  check('切到实际口径后「总收益率」数值变化', actualYield !== priceYield, priceYield + ' → ' + actualYield);

  await priceBtn.click();
  await page.waitForTimeout(200);
  check('切回价格口径后数值复原', (await metricValue('总盈亏')) === priceProfit);

  /* ── 路径 3：交易录入（Tab 切换 + 理由必填）──────────────────── */
  begin('路径 3 · 交易录入');
  await page.goto(new URL('/trade', page.url()).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="trade-tab-buy"]', { timeout: 15000 });

  for (const t of ['buy', 'add', 'reduce', 'clear', 'exdividend']) {
    check('Tab 存在：' + t, (await page.locator('[data-testid="trade-tab-' + t + '"]').count()) >= 1);
  }
  check('初始选中「买入」', (await page.locator('[data-testid="trade-tab-buy"]').getAttribute('aria-selected')) === 'true');

  await page.locator('[data-testid="trade-tab-add"]').click();
  check('切到「加仓」后 aria-selected 跟随', (await page.locator('[data-testid="trade-tab-add"]').getAttribute('aria-selected')) === 'true');
  check('「买入」已取消选中', (await page.locator('[data-testid="trade-tab-buy"]').getAttribute('aria-selected')) === 'false');

  await page.locator('[data-testid="trade-tab-exdividend"]').click();
  await page.waitForTimeout(200);
  check('「除权补充」展开次级面板', (await page.locator('[data-testid="trade-exdividend-panel"]').count()) === 1);
  for (const t of ['dividend', 'bonus', 'transfer']) {
    check('次级面板含类型：' + t, (await page.locator('[data-testid="trade-tab-' + t + '"]').count()) === 1);
  }
  // ⚠️ 「除权补充」本身只是**展开**次级面板；真正选中某个除权类型要再点一次具体类型
  //    （次级面板里的按钮用 aria-pressed 暴露选中态，主 Tab 用 aria-selected —— 见 TradeTypeTabs.tsx）
  await page.locator('[data-testid="trade-tab-dividend"]').click();
  await page.waitForTimeout(300);
  check('选中「分红」后 aria-pressed=true', (await page.locator('[data-testid="trade-tab-dividend"]').getAttribute('aria-pressed')) === 'true');
  check('选中除权类型后「除权补充」Tab 呈激活态', (await page.locator('[data-testid="trade-tab-exdividend"]').getAttribute('aria-selected')) === 'true');
  const exReason = await page.inputValue('#trade-input-reason');
  check('除权类型的理由由系统固化（不可编辑）', exReason.startsWith('人工补充 - '), exReason);
  check('除权类型的理由框只读', (await page.getAttribute('#trade-input-reason', 'readonly')) !== null);
  const exReasonHint = await page.locator('[data-testid="trade-reason-hint"]').innerText();
  check('除权类型的理由提示说明「由系统固化」', exReasonHint.includes('由系统固化'), exReasonHint);

  await page.locator('[data-testid="trade-tab-buy"]').click();
  await page.waitForTimeout(200);
  check('切回「买入」后理由被清空', (await page.inputValue('#trade-input-reason')) === '');

  await page.fill('#trade-input-symbol', 'sh600519');
  await page.fill('#trade-input-quantity', '100');
  await page.fill('#trade-input-price', '6');
  await page.waitForTimeout(300);
  const submit = page.locator('form button[type=submit]');
  check('缺操作理由时提交按钮禁用', await submit.isDisabled());
  const reasonHint = await page.locator('[data-testid="trade-reason-hint"]').innerText();
  check('缺操作理由时给出必填提示', reasonHint.includes('操作理由必填'), reasonHint);

  await page.fill('#trade-input-reason', 'E2E 端到端买入');
  await page.waitForTimeout(200);
  check('补上理由后提交按钮可用', !(await submit.isDisabled()));

  const [tradeResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/trade') && r.request().method() === 'POST', { timeout: 30000 }),
    submit.click(),
  ]);
  const tradeBody = await tradeResponse.json();
  check('POST /api/trade → code === 0', tradeBody.code === 0, 'code=' + JSON.stringify(tradeBody.code));
  check('交易响应体没有 success 字段（T89b）', !('success' in tradeBody));
  await page.waitForTimeout(400);
  const successText = await page.getByText(/提交成功/).count();
  check('页面显示提交成功提示', successText >= 1, 'count=' + successText);

  /* ── 路径 4：复盘（三态弹窗 + 4 色 pill）────────────────────── */
  begin('路径 4 · 复盘');
  await page.goto(new URL('/review', page.url()).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="review-legend-stopLoss"]', { timeout: 15000 });

  for (const key of ['stopLoss', 'systemSignal', 'manualDecision', 'unreviewed']) {
    check('图例含色块：' + key, (await page.locator('[data-testid="review-legend-' + key + '"]').count()) === 1);
  }
  const pillCounts = {};
  for (const key of ['stopLoss', 'systemSignal', 'manualDecision', 'unreviewed']) {
    pillCounts[key] = await page.locator('[data-testid="review-tag-' + key + '"]').count();
  }
  check('4 色 pill 全部出现（红 / 绿 / 橙 / 灰）',
    pillCounts.stopLoss >= 1 && pillCounts.systemSignal >= 1 && pillCounts.manualDecision >= 1 && pillCounts.unreviewed >= 1,
    JSON.stringify(pillCounts));

  // 编辑弹窗：挑一行「未复盘」的交易
  const greyPill = page.locator('[data-testid="review-tag-unreviewed"]').first();
  const row = greyPill.locator('xpath=ancestor::tr');
  // 记下这一行的标的代码 —— 保存后按它定位同一行（列表顺序会变，不能用行号）
  const rowCode = (await row.locator('td').nth(1).innerText()).trim();
  await row.getByRole('button', { name: '编辑复盘' }).click();
  await page.waitForSelector('[role=dialog]', { timeout: 10000 });
  check('编辑复盘弹窗打开（role=dialog）', (await page.locator('[role=dialog]').count()) === 1);

  const triNone = page.locator('[data-testid="tri-state-review-edit-strategy-match-label-none"]');
  const triYes = page.locator('[data-testid="tri-state-review-edit-strategy-match-label-1"]');
  const triNo = page.locator('[data-testid="tri-state-review-edit-strategy-match-label-0"]');
  check('三态按钮齐备（未标记 / 是 / 否）',
    (await triNone.count()) === 1 && (await triYes.count()) === 1 && (await triNo.count()) === 1);

  await triYes.click();
  check('点「是」后 aria-pressed=true', (await triYes.getAttribute('aria-pressed')) === 'true');
  check('点「是」后「未标记」不再选中', (await triNone.getAttribute('aria-pressed')) === 'false');
  await triNo.click();
  check('点「否」后 aria-pressed 转移', (await triNo.getAttribute('aria-pressed')) === 'true');
  check('点「否」后「是」不再选中', (await triYes.getAttribute('aria-pressed')) === 'false');
  await triYes.click();

  await page.fill('#review-edit-summary', 'E2E 复盘：三态改为「是」');
  const [patchResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/trade/') && r.request().method() === 'PATCH', { timeout: 30000 }),
    page.getByRole('button', { name: '保存' }).click(),
  ]);
  const patchBody = await patchResponse.json();
  check('PATCH /api/trade/:id → code === 0', patchBody.code === 0, 'code=' + JSON.stringify(patchBody.code));
  check('复盘响应体没有 success 字段（T89b）', !('success' in patchBody));

  await page.waitForTimeout(600);
  // ⚠️ **按标的代码定位同一行**（不能用「橙 pill 计数变多」—— 重复跑时计数不再变化）
  const newRow = page.locator('tr').filter({ hasText: rowCode }).first();
  const tagKey = await newRow.locator('[data-testid^="review-tag-"]').getAttribute('data-tag-key');
  check('保存后该行变为「主观决策」（橙）pill', tagKey === 'manualDecision', 'tagKey=' + tagKey + ' 行=' + rowCode);

  return results;
}`;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  ensurePlaywrightCli();

  const base = opts.baseUrl.replace(/\/+$/, '');
  const apiBase = (opts.apiBaseUrl ?? base).replace(/\/+$/, '');

  // 目标站点可达性
  try {
    const resp = await fetch(`${base}/login`, { method: 'GET' });
    if (!resp.ok) fail(`前端 dev server 返回 ${resp.status}（${base}）`);
  } catch (err) {
    fail(`前端 dev server 不可达（${base}）：${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`[frontend-e2e] 前端：${base}`);
  console.log(`[frontend-e2e] 后端：${apiBase}`);

  // ── 夹具：准备数据 ──
  if (!opts.skipSeed) {
    console.log('[frontend-e2e] 准备数据（注册 + 交易 + 复盘字段 + 双口径快照）…');
    const seed = await prepareData(apiBase, opts.username, opts.password, opts.sqlitePath);
    console.log(
      `[frontend-e2e] 数据就绪：user=${seed.username} userId=${seed.userId} 快照=${seed.snapshotWritten ? '已写入' : '未写入（缺 --sqlite-path）'}`,
    );
  }

  let opened = false;
  let exitCode = 0;
  const report: Record<string, unknown> = {
    baseUrl: base,
    apiBaseUrl: apiBase,
    generatedAt: new Date().toISOString(),
    flows: [],
  };
  try {
    pw(['open', `--browser=${opts.browser}`, `${base}/login`], { allowFail: true });
    opened = true;
    // ⚠️ 必须在任何 API 请求之前装好路由改写
    rewriteApiBase(apiBase);
    console.log(`[frontend-e2e] /api/* 已改写到 ${apiBase}`);

    const flows = runPlaywrightCode(pageFlows(base, opts.username, opts.password));
    if (!flows || flows.length === 0) {
      fail('页面代码没有返回预期结果（4 条路径的结果数组）');
    }
    report.flows = flows;

    let failed = 0;
    for (const flow of flows) {
      console.log('');
      console.log(`── ${flow.name} ──`);
      for (const c of flow.checks) {
        if (c.ok) {
          console.log(`  ✅ ${c.name}${c.detail !== null ? ` （${c.detail}）` : ''}`);
        } else {
          failed += 1;
          console.error(`  ❌ ${c.name}${c.detail !== null ? ` （实测：${c.detail}）` : ''}`);
        }
      }
    }
    console.log('');
    if (failed === 0) {
      console.log('[frontend-e2e] ✅ 4 条路径全部 PASS —— T77 前端 E2E 通过');
    } else {
      console.error(`[frontend-e2e] ❌ 共 ${failed} 条断言失败 —— T77 前端 E2E 不通过`);
      exitCode = 1;
    }
  } finally {
    if (opened) pw(['close'], { allowFail: true });
  }

  if (opts.report) {
    writeFileSync(opts.report, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[frontend-e2e] 报告已写入 ${opts.report}`);
  }
  process.exit(exitCode);
}

await main();
