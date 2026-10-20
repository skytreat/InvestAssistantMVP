#!/usr/bin/env node
/**
 * 横向溢出探针脚本（G3.5 / G3.5b / G4.6 / G6.6 / G7.7 共用）
 *
 * ## 它解决什么
 *
 * `docs/audit/gap-list-2026-10-17.md` 的 **F-Q12**（响应式横向溢出）与
 * `docs/client/code_implementation_plan_v2.md` §12.7 的 5 道溢出门槛
 * （G3.5 / G3.5b / G4.6 / G6.6 / G7.7）都需要**真浏览器**下测
 * `document.documentElement.scrollWidth − clientWidth`。
 *
 * - **jsdom 没有 layout engine**（`clientWidth` 恒 0、`getBoundingClientRect()` 全 0）
 *   → jsdom 只能做结构断言，**真实溢出必须靠真浏览器探针**；
 * - `scripts/a11y-check.mjs` 只跑 axe，**不含 `scrollWidth` 探测、也不切视口**
 *   → 本脚本补上这一块，且**与它共用同一套启动 / 登录 / 浏览器约定**。
 *
 * ## 判据（plan §12.7 G3.5 逐字）
 *
 * ```
 * document.documentElement.scrollWidth - document.documentElement.clientWidth <= 2
 * ```
 *
 * > ⚠️ 允许的 2px 是**浮点/亚像素容差**，不是「可以溢出 2px」的额度设计。
 *
 * ## 视口 → 门槛对应关系
 *
 * | 视口      | 宽×高        | 覆盖门槛                                    | 归属波次 |
 * |-----------|--------------|---------------------------------------------|----------|
 * | 手机 375  | 375×812      | **G3.5**(dashboard) / **G4.6**(review) / **G6.6**(stockscan) / **G7.7**(admin) | 3 / 4 / 6 / 7 |
 * | 平板 768  | 768×1024     | **G7.7**(admin) —— **G3.5b 已前移至此**（plan 自身重复登记，见下方「G3.5b」） | 7 |
 * | 桌面 1440 | 1440×900     | 无专项门槛（基线参照，F-Q12 全 0）            | —        |
 *
 * 页面清单**从 `apps/frontend/src/App.tsx` 的 `<Route path=...>` 解析**（不硬编码），
 * 与 `scripts/a11y-check.mjs` 同一套解析逻辑。
 *
 * ## G3.5b 的登记冲突（plan 自身的重复登记，不改 plan 文档）
 *
 * plan §12.7 的 G3 表里 G3.5b 写的是「768px 平板视口 admin 页无溢出」，
 * 但 **G7.7 又写了「375px + 768px admin 页均无横向溢出」**，而 admin 页属
 * **Wave 7 / T75**（Wave 3 时点该页面根本不存在）。
 * ⇒ 本脚本**按「G7.7 承接 G3.5b」登记**：G3.5b 不单独判定，只在明细里给出实测值。
 * 详见 `docs/audit/overflow-probe.md`。
 *
 * ## 怎么跑
 *
 * 1. 起后端（提供真实数据）：
 *    ```bash
 *    # 仓库根目录；.env.local 里的 SQLITE_DB_PATH 必须指向**当前用户可写**的目录
 *    # ⚠️ 宿主 8080 常被其它服务（如 llama-server）占用 → 用 8081
 *    PORT=8081 npm run dev -w @invest/backend
 *    ```
 * 2. 起前端 dev server（vite，固定 5173）：
 *    ```bash
 *    npm run dev -w @invest/frontend
 *    ```
 * 3. 跑探针：
 *    ```bash
 *    node scripts/probe-overflow.mjs --api-base-url http://127.0.0.1:8081 --username admin --password admin123
 *    node scripts/probe-overflow.mjs --viewports 375,768,1440
 *    node scripts/probe-overflow.mjs --pages dashboard,trade,review,kline,stockscan,admin
 *    node scripts/probe-overflow.mjs --report /tmp/overflow.json
 *    node scripts/probe-overflow.mjs --gate G3.5        # 只跑某一道门槛涉及的组合
 *    node scripts/probe-overflow.mjs --list-gates       # 只打印门槛矩阵
 *    ```
 *
 * ## 依赖
 *
 * 用**全局的 `playwright-cli`**（与 `scripts/a11y-check.mjs` 完全一致），
 * **不往 package.json 里加 playwright 依赖**（AGENTS.md「新增 npm 依赖必须说明理由」）。
 *
 * - 已安装：`npm i -g @playwright/cli`
 * - 浏览器内核：`npx playwright install chromium`（本机 `~/.cache/ms-playwright` 已有）
 * - ⚠️ 本机默认浏览器是 `chrome`（未安装）→ 必须显式 `--browser=chromium`。
 *
 * ## 退出码
 *
 * - `0` —— 全部「页面 × 视口」组合溢出 ≤ 2px，且**没有**「落地路径被重定向」的组合
 * - `1` —— 存在溢出（打印**最内层超宽元素**的 tag / class / 宽度，便于直接定位），
 *   或存在**无法验证**的组合（页面被重定向到别的路由 → 结果不可信 → **fail closed**）
 * - `2` —— 用法错误 / 依赖缺失 / 目标站点不可达
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(REPO_ROOT, 'apps', 'frontend');
const APP_TSX = path.join(FRONTEND_DIR, 'src', 'App.tsx');

/** 判据常量（plan §12.7 G3.5 逐字）*/
const OVERFLOW_TOLERANCE = 2;

/** 默认视口（手机 / 平板 / 桌面）*/
const DEFAULT_VIEWPORTS = [375, 768, 1440];

/** 视口宽度 → 默认高度（贴近真实设备；高度不影响横向溢出判定，但影响 100vh 类布局）*/
const DEFAULT_HEIGHTS = { 375: 812, 768: 1024, 1440: 900 };

/** 视口宽度 → 设备标签 */
const VIEWPORT_LABELS = { 375: '手机', 768: '平板', 1440: '桌面' };

/**
 * 门槛 → 覆盖的「页面 × 视口」
 *
 * ⚠️ **G3.5b 与 G7.7 重复登记** —— plan §12.7 的 G3 表里 G3.5b 写的是
 * 「768px 平板视口 admin 页无溢出」，但 G7.7 又写了「375px + 768px admin 页均无横向溢出」，
 * 且 admin 页属 **Wave 7 / T75**（Wave 3 时点根本不存在该页面）。
 * ⇒ 建议裁决：**G3.5b 前移至 G7.7**（详见 `docs/audit/overflow-probe.md`）。
 * 这里**按「G7.7 承接 G3.5b」登记**，避免同一件事被两道门槛各判一次。
 */
const GATES = [
  {
    id: 'G3.5',
    wave: 3,
    pages: ['dashboard'],
    viewports: [375],
    desc: '375px dashboard 无横向溢出',
    note:
      'plan G3.5 原文覆盖全站 6 页（dashboard/trade/review/kline/stockscan/admin）；' +
      '2026-10-18 修订后 Wave 3 **只对 dashboard 判定**，review/stockscan/admin 分别前移到 ' +
      'G4.6/G6.6/G7.7；trade/kline 未被前移 → 归 Wave 8 T78 汇总复核',
  },
  {
    id: 'G3.5b',
    wave: 7,
    pages: ['admin'],
    viewports: [768],
    desc: '768px admin 无横向溢出',
    supersededBy: 'G7.7',
    note: 'plan 自身重复登记：G7.7 已整体承接（admin 375+768）；admin 页属 Wave 7/T75',
  },
  {
    id: 'G4.6',
    wave: 4,
    pages: ['review'],
    viewports: [375],
    desc: '375px review 无横向溢出',
    movedFrom: 'G3.5',
  },
  {
    id: 'G6.6',
    wave: 6,
    pages: ['stockscan'],
    viewports: [375],
    desc: '375px stockscan 无横向溢出',
    movedFrom: 'G3.5',
  },
  {
    id: 'G7.7',
    wave: 7,
    pages: ['admin'],
    viewports: [375, 768],
    desc: '375px + 768px admin 均无横向溢出（承接 G3.5b）',
    absorbs: 'G3.5b',
    movedFrom: 'G3.5',
  },
];

/** plan G3.5 原文点名的 6 页（用于标出「无门槛归属」的页面）*/
const G3_5_ORIGINAL_PAGES = ['dashboard', 'trade', 'review', 'kline', 'stockscan', 'admin'];

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

const USAGE = `用法：
  node scripts/probe-overflow.mjs [选项]

选项：
  --base-url <url>     前端 dev server 地址（默认 http://127.0.0.1:5173）
  --api-base-url <url> 把页面的 /api/* 请求改写到该地址（默认直连前端 dev server 的代理）
                       ⚠️ 用于后端不在 vite.config.ts 写死的 8080 时（如 8081 被占）
  --pages <a,b,c>      只查指定页面（页面名见下方清单；默认全部路由）
  --viewports <w,...>  视口宽度列表（默认 375,768,1440）
  --gate <id>          只跑某一道门槛涉及的「页面 × 视口」（G3.5 / G3.5b / G4.6 / G6.6 / G7.7）
  --list-gates         只打印门槛 → 页面 × 视口 映射矩阵后退出
  --browser <name>     playwright 浏览器（默认 chromium；本机没有 chrome）
  --username <name>    登录用户名（配合 --password，用于访问受保护页面）
  --password <pass>    登录密码
  --token <jwt>        直接注入已签发的 token（跳过登录流程）
  --role <role>        注入 --token 时使用的角色（默认 user；登录时用后端返回的真实角色）
  --report <file>      把结果写成 JSON 报告文件
  --timeout <ms>       登录请求超时（默认 60000）
  --settle <ms>        每页等待数据渲染的时间（默认 1200）
  --help               显示本帮助

判据：document.documentElement.scrollWidth - document.documentElement.clientWidth <= ${OVERFLOW_TOLERANCE}
退出码：0 = 无溢出且无「被重定向」的不可信组合；1 = 有溢出或存在不可信组合；2 = 用法/环境错误`;

/** 解析命令行参数 */
function parseArgs(argv) {
  const opts = {
    baseUrl: 'http://127.0.0.1:5173',
    apiBaseUrl: null,
    pages: null,
    viewports: null,
    gate: null,
    listGates: false,
    browser: 'chromium',
    username: null,
    password: null,
    token: null,
    role: 'user',
    timeout: 60000,
    settle: 1200,
    report: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) {
        fail(`参数 ${arg} 缺少取值`);
      }
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
      case '--pages':
        opts.pages = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--viewports':
        opts.viewports = next()
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0);
        break;
      case '--gate':
        opts.gate = next().trim().toUpperCase();
        break;
      case '--list-gates':
        opts.listGates = true;
        break;
      case '--browser':
        opts.browser = next();
        break;
      case '--username':
        opts.username = next();
        break;
      case '--password':
        opts.password = next();
        break;
      case '--token':
        opts.token = next();
        break;
      case '--role':
        opts.role = next();
        break;
      case '--report':
        opts.report = next();
        break;
      case '--timeout':
        opts.timeout = Number(next());
        break;
      case '--settle':
        opts.settle = Number(next());
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

/** 打印错误并退出（码 2 = 用法/环境错误） */
function fail(message) {
  console.error(`[probe-overflow] ❌ ${message}`);
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 页面清单 —— 从 apps/frontend/src/App.tsx 的 <Route> 解析（不硬编码）
 * ------------------------------------------------------------------ */

/**
 * 解析 `App.tsx` 里的 `<Route path="..." element={<X />} />`
 *
 * ⚠️ **与 `scripts/a11y-check.mjs` 同一套解析逻辑**（刻意保持一致：
 *    两个门禁脚本对「有哪些页面」的认知必须相同，否则一个绿一个红没法互相印证）。
 */
function parseRoutes(appTsxPath) {
  let src;
  try {
    src = execFileSync(
      'node',
      ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(appTsxPath)}, 'utf8'))`],
      {
        encoding: 'utf8',
      },
    );
  } catch (err) {
    fail(`读不到 ${appTsxPath}：${err.message}`);
  }

  const routes = [];
  // 匹配 <Route ... /> 自闭合标签（含跨行）
  const tagRe = /<Route\b([\s\S]*?)\/>/g;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const attrs = m[1];
    const pathMatch = /\bpath="([^"]*)"/.exec(attrs);
    const elMatch = /\belement=\{<\s*([A-Za-z0-9_]+)/.exec(attrs);
    if (!pathMatch) continue; // 布局路由（无 path）不单独成页
    routes.push({
      path: pathMatch[1],
      component: elMatch ? elMatch[1] : 'Unknown',
    });
  }
  if (routes.length === 0) fail(`未能从 ${appTsxPath} 解析出任何 <Route path="...">`);
  return routes;
}

/** 路由路径 → 页面 key（`/` → dashboard，`/trade` → trade，`*` → notfound）*/
function routeKey(routePath, component) {
  if (routePath === '*') return 'notfound';
  const seg = routePath.split('/').filter(Boolean)[0];
  if (seg) return seg.toLowerCase();
  // 根路径按组件名命名（Dashboard → dashboard）
  return component.replace(/Route$/, '').toLowerCase();
}

/** 404 路由（`path="*"`）没有真实 URL —— 用一个不存在的路径触发 */
const NOT_FOUND_URL = '/__probe_unknown_route__';

/* ------------------------------------------------------------------ *
 * playwright-cli 驱动
 * ------------------------------------------------------------------ */

/** 会话名（独立于 a11y-check 的会话，避免互相干扰） */
const SESSION = 'probe-overflow';

/** 执行 playwright-cli，返回 stdout（trim 后）*/
function pw(args, { allowFail = false } = {}) {
  try {
    return execFileSync('playwright-cli', ['-s=' + SESSION, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err) {
    if (allowFail) return '';
    const stderr = err.stderr ? String(err.stderr) : '';
    fail(`playwright-cli ${args.join(' ')} 执行失败：\n${stderr || err.message}`);
  }
  return '';
}

/** playwright-cli 是否可用 */
function ensurePlaywrightCli() {
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

/** 执行一段 Playwright 代码（`async page => {...}`）*/
function runPlaywrightCode(source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'probe-overflow-'));
  const file = path.join(dir, 'pw-code.js');
  writeFileSync(file, source, 'utf8');
  try {
    pw(['run-code', `--filename=${file}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 让页面里的 `/api/*` 请求改打到别的后端地址
 *
 * ⚠️ 与 `scripts/a11y-check.mjs` 的 `rewriteApiBase` **逐字同源**：
 *    vite 的代理 target 在 `apps/frontend/vite.config.ts` 里**写死 8080**，
 *    而 8080 常被宿主其它服务（如 llama-server）占用 → 后端只能跑在 8081。
 *    用 Playwright 的请求路由在**浏览器侧**改写目标，不需要改仓库里的 vite 配置。
 */
function rewriteApiBase(apiBaseUrl) {
  const apiRoot = apiBaseUrl.replace(/\/+$/, '') + '/api/';
  runPlaywrightCode(
    `async page => {\n` +
      `  await page.route('**/api/**', async (route) => {\n` +
      `    const target = route.request().url().replace(/^https?:\\/\\/[^/]+\\/api\\//, ${JSON.stringify(apiRoot)});\n` +
      `    const response = await route.fetch({ url: target });\n` +
      `    await route.fulfill({ response });\n` +
      `  });\n` +
      `}\n`,
  );
}

/**
 * 设置视口
 *
 * 优先用 playwright-cli 的 `resize`（内部走 `Page.setViewportSize`）；
 * 若结果与目标宽度不符（不同版本行为不一致），退回 `run-code` 显式调 `page.setViewportSize`。
 */
function setViewport(width, height) {
  pw(['resize', String(width), String(height)], { allowFail: true });
  const actual = Number(pw(['--raw', 'eval', 'window.innerWidth'], { allowFail: true }));
  if (Number.isFinite(actual) && actual > 0 && actual !== width) {
    runPlaywrightCode(
      `async page => {\n` + `  await page.setViewportSize({ width: ${width}, height: ${height} });\n` + `}\n`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 页面内探针（横向溢出测量 + 超宽元素定位）
 * ------------------------------------------------------------------ */

/**
 * 浏览器侧表达式：测量 `scrollWidth / clientWidth` 差值，并找出**最内层**超宽元素
 *
 * 设计要点：
 * 1. **判据只用 plan §12.7 的原文公式**（`scrollWidth - clientWidth <= 2`）；
 * 2. **超宽元素定位**：只报告「没有被祖先的横向滚动/裁剪容器兜住」的元素，
 *    否则 `overflow-x:auto` 表格里的列会被误报成元凶；
 * 3. **最内层**：若一个超宽元素的**后代**也超宽，只报后代（真正的「哪一格/哪一列撑宽了」）；
 * 4. **表格上下文**：超宽元素若在 `<table>` 里，额外给出「表格总宽 / 列数 / 问题列表头」，
 *    让开发者一眼知道是「9 列表格共 544px」而不是只看到「溢出了 169px」；
 * 5. 额外输出**横向滚动容器**清单 —— 用来区分
 *    「作者已用滚动容器兜底（页面不溢出）」与「页面真的溢出」。
 *
 * ⚠️ `window.innerWidth - clientWidth` 是**垂直滚动条宽度**（headless Chromium 下为 0，
 *    因为 playwright 默认带 `--hide-scrollbars`）→ 用来排除「正好铺满视口宽」的误报。
 */
const PROBE_EXPR = `(function () {
  var de = document.documentElement;
  var clientWidth = de.clientWidth;
  var scrollWidth = de.scrollWidth;
  var innerWidth = window.innerWidth;
  var gutter = innerWidth - clientWidth;
  var body = document.body;

  function clippedByAncestor(el) {
    var p = el.parentElement;
    while (p && p !== body && p !== de) {
      var ox = window.getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
      p = p.parentElement;
    }
    return false;
  }

  /** 超宽元素若在表格里 → 给出「表格总宽 / 列数 / 问题列表头」*/
  function tableContext(el) {
    if (!el.closest) return null;
    var t = el.closest('table');
    if (!t) return null;
    var headRow = t.querySelector('thead tr');
    var heads = headRow ? headRow.querySelectorAll('th') : [];
    var idx = -1;
    var row = el.parentElement;
    if (row && row.children) {
      for (var i = 0; i < row.children.length; i++) {
        if (row.children[i] === el) { idx = i; break; }
      }
    }
    var r = t.getBoundingClientRect();
    return {
      tableWidth: Math.round(r.width),
      tableRight: Math.round(r.right),
      columnCount: heads.length || null,
      columnIndex: idx >= 0 ? idx : null,
      columnHeader:
        idx >= 0 && idx < heads.length ? (heads[idx].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24) : null
    };
  }

  function describe(el) {
    var r = el.getBoundingClientRect();
    var cls = (el.getAttribute('class') || '').trim();
    var chain = [];
    var node = el;
    var depth = 0;
    while (node && node !== body && depth < 4) {
      var tag = node.tagName ? node.tagName.toLowerCase() : '?';
      var first = (node.getAttribute && node.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean)[0];
      chain.unshift(first ? tag + '.' + first : tag);
      node = node.parentElement;
      depth++;
    }
    return {
      selectorPath: chain.join(' > '),
      tag: el.tagName.toLowerCase(),
      className: cls,
      id: el.id || null,
      inlineMinWidth: (el.style && el.style.minWidth) || null,
      inlineMaxWidth: (el.style && el.style.maxWidth) || null,
      width: Math.round(r.width),
      left: Math.round(r.left),
      right: Math.round(r.right),
      overflowBy: Math.round(r.right - clientWidth),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      table: tableContext(el)
    };
  }

  var all = Array.prototype.slice.call(document.querySelectorAll('*'));
  var offenders = [];
  var scrollables = [];

  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    var cs = window.getComputedStyle(el);
    var selfScrollable = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    if (selfScrollable && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
      scrollables.push(el);
      // ⚠️ 滚动容器**自身**若已越过视口右边缘，它仍是溢出元凶 → 继续走下面的判定
    }
    // 越过「内容区 + 滚动条」边界才算真超宽（排除正好铺满视口的元素）
    if (rect.right > clientWidth + gutter + 1 && !clippedByAncestor(el)) {
      offenders.push(el);
    }
  }

  var inner = offenders.filter(function (el) {
    return !offenders.some(function (other) { return other !== el && el.contains(other); });
  });

  return JSON.stringify({
    landedPath: location.pathname,
    landedHash: location.hash,
    title: document.title,
    innerWidth: innerWidth,
    clientWidth: clientWidth,
    scrollWidth: scrollWidth,
    overflow: scrollWidth - clientWidth,
    bodyScrollWidth: body ? body.scrollWidth : null,
    bodyOverflow: body ? body.scrollWidth - clientWidth : 0,
    textLength: body ? (body.innerText || '').replace(/\\s+/g, ' ').trim().length : 0,
    offenderCount: inner.length,
    offenders: inner.slice(0, 12).map(describe),
    scrollableCount: scrollables.length,
    scrollableContainers: scrollables.slice(0, 5).map(describe)
  });
})()`;

/** 在页面里跑一次探针，返回结构化结果 */
function measure() {
  const raw = pw(['--raw', 'eval', PROBE_EXPR], { allowFail: true });
  if (!raw) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  // playwright-cli --raw 返回的是 JSON 编码后的值；表达式本身返回的是 JSON 字符串 → 再解一层
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

/**
 * 等布局稳定后再测
 *
 * ⚠️ 页面数据是异步到达的（持仓 / 信号 / 日志），立刻测量会漏掉「数据渲染后才撑宽」的情况。
 * 策略：先等 `--settle` 毫秒让首屏数据到位，再**连续采样直到 scrollWidth 连续两次相同**
 *      （= 布局已稳定），取**最后一次**（数据最全）。
 *      上限 `--settle + 8s`，避免页面有动画时死等。
 */
async function measureStable(settleMs) {
  await sleep(settleMs);
  const deadline = Date.now() + 8000;
  let last = null;
  let prevWidth = -1;
  let stableHits = 0;
  while (Date.now() < deadline) {
    const cur = measure();
    if (!cur) {
      await sleep(400);
      continue;
    }
    last = cur;
    if (cur.scrollWidth === prevWidth) {
      stableHits += 1;
      if (stableHits >= 1) break; // 连续两次一致 → 布局已稳定
    } else {
      stableHits = 0;
      prevWidth = cur.scrollWidth;
    }
    await sleep(400);
  }
  return last;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  ensurePlaywrightCli();

  const routes = parseRoutes(APP_TSX);
  const allPages = routes.map((r) => ({
    key: routeKey(r.path, r.component),
    path: r.path === '*' ? NOT_FOUND_URL : r.path,
    component: r.component,
    routePath: r.path,
  }));

  // 去重（同一 key 可能出现多次）
  const seen = new Set();
  const pages = allPages.filter((p) => {
    if (seen.has(p.key)) return false;
    seen.add(p.key);
    return true;
  });

  if (opts.listGates) {
    printGateMap(pages);
    process.exit(0);
  }

  // 门槛过滤（--gate）
  let gate = null;
  if (opts.gate) {
    gate = GATES.find((g) => g.id === opts.gate);
    if (!gate) {
      fail(`未知门槛 ${opts.gate}。可用门槛：${GATES.map((g) => g.id).join(', ')}`);
    }
  }

  let selected = opts.pages ? pages.filter((p) => opts.pages.includes(p.key)) : pages;
  if (gate) selected = selected.filter((p) => gate.pages.includes(p.key));

  if (selected.length === 0) {
    fail(
      `没有匹配到任何页面。可用页面：${pages.map((p) => p.key).join(', ')}\n` +
        `--pages 只接受页面名，不接受路径。`,
    );
  }

  let viewports = opts.viewports ?? DEFAULT_VIEWPORTS;
  if (gate) {
    const gateViewports = gate.viewports.filter((w) => viewports.includes(w));
    viewports = gateViewports.length > 0 ? gateViewports : gate.viewports;
  }
  if (viewports.length === 0) fail('没有可用的视口');

  console.log(`[probe-overflow] 目标：${opts.baseUrl}`);
  console.log(`[probe-overflow] 待检页面（${selected.length}）：${selected.map((p) => p.key).join(', ')}`);
  console.log(
    `[probe-overflow] 视口：${viewports
      .map((w) => `${w}×${DEFAULT_HEIGHTS[w] ?? 900}${VIEWPORT_LABELS[w] ? `(${VIEWPORT_LABELS[w]})` : ''}`)
      .join(' / ')}`,
  );
  console.log(
    `[probe-overflow] 判据：document.documentElement.scrollWidth - document.documentElement.clientWidth <= ${OVERFLOW_TOLERANCE}`,
  );

  const base = opts.baseUrl.replace(/\/+$/, '');
  let opened = false;
  let exitCode = 0;
  try {
    pw(['open', `--browser=${opts.browser}`, base], { allowFail: true });
    opened = true;
    if (opts.apiBaseUrl) {
      rewriteApiBase(opts.apiBaseUrl);
      console.log(`[probe-overflow] /api/* 已改写到 ${opts.apiBaseUrl}`);
    }

    // 登录（可选）：拿到 token 后写进 localStorage，让受保护页面真的渲染出来
    const session = resolveSession(opts, opts.apiBaseUrl ?? base);
    if (session) {
      setLocalStorage('invest-user', {
        state: {
          token: session.token,
          refreshToken: session.refreshToken ?? null,
          username: session.username,
          role: session.role,
        },
        version: 0,
      });
      console.log(`[probe-overflow] 已注入会话（user=${session.username}, role=${session.role}）`);
    } else {
      console.warn(
        '[probe-overflow] ⚠️ 未提供登录凭据（--username/--password 或 --token）——' +
          '受保护页面会跳到 /login，只检到登录页的 DOM（会被判为「不可信」并 exit 1）。',
      );
    }

    const results = [];

    for (const viewportWidth of viewports) {
      const viewportHeight = DEFAULT_HEIGHTS[viewportWidth] ?? 900;
      setViewport(viewportWidth, viewportHeight);

      for (const page of selected) {
        // ⚠️ `/login` 在已登录时会被重定向到 `/`（`pages/Login.tsx` 的 useEffect），
        //    所以登录页必须在**注入会话之前**测 —— 否则量到的是 dashboard。
        if (page.key === 'login' && session) {
          pw(['localstorage-clear'], { allowFail: true });
        }

        pw(['goto', `${base}${page.path}`], { allowFail: true });
        const measured = await measureStable(opts.settle);

        if (!measured) {
          console.error(`[probe-overflow] ❌ ${page.key} @${viewportWidth}：探针未返回结果`);
          results.push({
            page: page.key,
            path: page.path,
            viewportWidth,
            viewportHeight,
            error: 'probe returned no result',
            overflow: null,
            pass: false,
          });
          exitCode = 1;
          continue;
        }

        const overflow = measured.overflow;

        // 落地路径与预期不符 → 说明被重定向了（登录态缺失 / 权限不足），结果不可信
        // ⚠️ 404 路由用的是虚构路径（`/__probe_unknown_route__`），本身就是「落地路径」，不算重定向
        const expectedPath = page.path === NOT_FOUND_URL ? null : page.path;
        const redirected = expectedPath !== null && measured.landedPath !== expectedPath;

        // ⚠️ **fail closed**：被重定向的组合不是「无溢出」，而是「根本没量到那一页」。
        //    若按 0 溢出计 PASS，门禁会出现假绿（没登录时全站都「通过」）。
        const pass = overflow <= OVERFLOW_TOLERANCE && !redirected;
        if (!pass) exitCode = 1;

        results.push({
          page: page.key,
          path: page.path,
          viewportWidth,
          viewportHeight,
          landedPath: measured.landedPath,
          redirected,
          clientWidth: measured.clientWidth,
          scrollWidth: measured.scrollWidth,
          overflow,
          bodyScrollWidth: measured.bodyScrollWidth,
          textLength: measured.textLength,
          pass,
          offenderCount: measured.offenderCount,
          offenders: measured.offenders,
          scrollableCount: measured.scrollableCount,
          scrollableContainers: measured.scrollableContainers,
        });

        // 还原登录页的会话（后续页面仍需登录态）
        if (page.key === 'login' && session) {
          setLocalStorage('invest-user', {
            state: {
              token: session.token,
              refreshToken: session.refreshToken ?? null,
              username: session.username,
              role: session.role,
            },
            version: 0,
          });
        }
      }
    }

    printMatrix(results, viewports, selected);
    printRawValues(results);
    printGateMap(pages, results);

    // 逐条门槛判定
    const gateVerdicts = GATES.map((g) => {
      const covered = results.filter(
        (r) => g.pages.includes(r.page) && g.viewports.includes(r.viewportWidth),
      );
      const failed = covered.filter((r) => !r.pass);
      const overflowFailed = covered.filter((r) => r.overflow !== null && r.overflow > OVERFLOW_TOLERANCE);
      // ⚠️ G3.5b 已被 G7.7 整体承接 → **不单独判定**（否则同一件事被两道门槛各判一次）
      const verdict = g.supersededBy
        ? '➖ 前移（不单独判定）'
        : covered.length === 0
          ? '➖ 本次未测'
          : failed.length === 0
            ? '✅ PASS'
            : '❌ FAIL';
      return {
        gate: g.id,
        wave: g.wave,
        desc: g.desc,
        supersedes: g.supersededBy ?? null,
        absorbs: g.absorbs ?? null,
        movedFrom: g.movedFrom ?? null,
        measured: covered.length,
        verdict,
        failures: failed.map(
          (r) =>
            `${r.page}@${r.viewportWidth} ` +
            (r.redirected ? `被重定向到 ${r.landedPath}（结果不可信）` : `溢出 ${r.overflow}px`),
        ),
        overflowFailures: overflowFailed.map((r) => `${r.page}@${r.viewportWidth} 溢出 ${r.overflow}px`),
      };
    });

    console.log('');
    console.log('[probe-overflow] 门槛判定：');
    for (const g of gateVerdicts) {
      console.log(`  ${g.verdict} ${g.gate}（Wave ${g.wave}）—— ${g.desc}`);
      if (g.supersedes) console.log(`      ↳ 已被 ${g.supersedes} 承接 → 建议前移，不单独判定`);
      if (g.movedFrom) console.log(`      ↳ 自 ${g.movedFrom} 前移而来`);
      for (const f of g.failures) console.log(`      ↳ ${f}`);
    }

    // 失败详情：给出可定位的超宽元素
    const failures = results.filter((r) => !r.pass);
    if (failures.length > 0) {
      console.log('');
      console.log('[probe-overflow] 溢出明细（超宽元素定位）：');
      for (const f of failures) {
        if (f.redirected) {
          console.error(
            `  ❌ ${f.page}（${f.path}）@${f.viewportWidth}px：落地路径是 ${f.landedPath}（预期 ${f.path}）` +
              `—— 被重定向，**该页根本没被量到**，判 FAIL（fail closed）`,
          );
          continue;
        }
        console.error(
          `  ❌ ${f.page}（${f.path}）@${f.viewportWidth}px：溢出 ${f.overflow}px` +
            `（scrollWidth=${f.scrollWidth} / clientWidth=${f.clientWidth}）`,
        );
        if (f.textLength !== undefined && f.textLength < 60) {
          console.error(
            `     ⚠️ 页面可见文本仅 ${f.textLength} 字 —— 疑似空态/错误态，溢出数值可能偏小（不足以据此判 PASS）`,
          );
        }
        const groups = groupOffenders(f.offenders ?? []);
        if (groups.length === 0) {
          console.error('     （未能定位到超宽元素 —— 可能是 body 本身的宽度被撑开）');
        }
        for (const g of groups) {
          console.error(
            `     · <${g.tag}${g.className ? ` class="${g.className}"` : ''}>` +
              ` 宽 ${g.width}px  右边缘 ${g.right}px  超出 ${g.overflowBy}px${g.count > 1 ? `  ×${g.count}` : ''}`,
          );
          console.error(`       路径：${g.selectorPath}`);
          if (g.table) {
            console.error(
              `       表格：总宽 ${g.table.tableWidth}px / ${g.table.columnCount ?? '?'} 列` +
                (g.table.columnHeader ? ` / 问题列「${g.table.columnHeader}」` : ''),
            );
          }
          if (g.inlineMinWidth) console.error(`       inline min-width：${g.inlineMinWidth}`);
          if (g.inlineMaxWidth) console.error(`       inline max-width：${g.inlineMaxWidth}`);
          if (g.text) console.error(`       文本：${g.text}`);
        }
        if (f.scrollableCount) {
          console.error(
            `     ℹ️ 该页有 ${f.scrollableCount} 个横向滚动容器（已用 overflow-x 兜底，页面仍溢出）`,
          );
        }
      }
    }

    if (opts.report) {
      writeFileSync(
        opts.report,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            baseUrl: opts.baseUrl,
            apiBaseUrl: opts.apiBaseUrl,
            criterion: `document.documentElement.scrollWidth - document.documentElement.clientWidth <= ${OVERFLOW_TOLERANCE}`,
            viewports: viewports.map((w) => ({
              width: w,
              height: DEFAULT_HEIGHTS[w] ?? 900,
              label: VIEWPORT_LABELS[w] ?? null,
            })),
            results,
            gates: gateVerdicts,
          },
          null,
          2,
        ),
        'utf8',
      );
      console.log(`[probe-overflow] 报告已写入 ${opts.report}`);
    }

    console.log('');
    if (exitCode === 0) {
      console.log(
        `[probe-overflow] ✅ 全部 ${results.length} 个「页面 × 视口」组合无横向溢出（≤ ${OVERFLOW_TOLERANCE}px）`,
      );
    } else {
      const bad = failures.length;
      const overflowBad = failures.filter((r) => !r.redirected).length;
      console.log(
        `[probe-overflow] ❌ ${bad}/${results.length} 个组合未通过（其中溢出 ${overflowBad} 个、被重定向 ${bad - overflowBad} 个）—— 门禁不通过`,
      );
    }
  } finally {
    if (opened) {
      pw(['close'], { allowFail: true });
    }
  }
  process.exit(exitCode);
}

/**
 * 把「最内层超宽元素」按 (tag + class + 宽度 + 文本 + 问题列) 归并
 *
 * ⚠️ admin 页有 5766 条系统日志 → 同一形态的 `<td>` 会出现几十次；
 *    不归并的话明细会淹没真正有用的信息。
 */
function groupOffenders(offenders) {
  const groups = new Map();
  for (const o of offenders) {
    const key = [o.tag, o.className, o.width, o.text, o.table ? `${o.table.columnIndex}` : ''].join('|');
    const hit = groups.get(key);
    if (hit) {
      hit.count += 1;
      continue;
    }
    groups.set(key, { ...o, count: 1 });
  }
  return [...groups.values()];
}

/** 打印「页面 × 视口」溢出矩阵 */
function printMatrix(results, viewports, pages) {
  console.log('');
  console.log('[probe-overflow] 溢出矩阵（页面 × 视口 → 溢出像素数；≤ 2 视为通过）：');
  const cell = (pageKey, w) => {
    const r = results.find((x) => x.page === pageKey && x.viewportWidth === w);
    if (!r) return '—';
    if (r.overflow === null || r.overflow === undefined) return 'ERR';
    if (r.redirected) return '跳转❌';
    return r.pass ? String(r.overflow) : `${r.overflow} ❌`;
  };
  const width = Math.max(6, ...pages.map((p) => p.key.length));
  let header = '  ' + '页面'.padEnd(width, ' ');
  for (const w of viewports) header += `  ${String(w).padStart(6)}px`;
  console.log(header);
  console.log('  ' + '-'.repeat(width + 2 + viewports.length * 9));
  for (const p of pages) {
    let line = '  ' + p.key.padEnd(width, ' ');
    for (const w of viewports) line += `  ${cell(p.key, w).padStart(6)}`;
    console.log(line);
  }
}

/** 打印原始数值（scrollWidth / clientWidth / 差值）—— Wave 门槛要的「实测原始数据」 */
function printRawValues(results) {
  console.log('');
  console.log('[probe-overflow] 原始数值（scrollWidth / clientWidth → 差值）：');
  for (const r of results) {
    const mark = r.pass ? ' ' : '❌';
    const detail = r.redirected ? `（被重定向到 ${r.landedPath}）` : '';
    console.log(
      `  ${mark} ${r.page}@${r.viewportWidth}：${r.scrollWidth} / ${r.clientWidth} → ${r.overflow}px${detail}`,
    );
  }
}

/**
 * 打印「门槛 → 页面 × 视口」映射矩阵
 *
 * @param results 若给出，则附上每道门槛的实测判定
 */
function printGateMap(pages, results = null) {
  console.log('');
  console.log('[probe-overflow] 门槛矩阵：');
  for (const g of GATES) {
    const combos = g.pages.flatMap((p) => g.viewports.map((v) => `${p}@${v}`));
    const marks = combos.map((c) => {
      if (!results) return c;
      const r = results.find((x) => `${x.page}@${x.viewportWidth}` === c);
      if (!r) return `${c}(未测)`;
      if (r.redirected) return `${c}(跳转)`;
      return `${c}(${r.overflow}px${r.pass ? '' : '❌'})`;
    });
    console.log(`  ${g.id}（Wave ${g.wave}）→ ${marks.join(' / ')} —— ${g.desc}`);
    if (g.supersededBy)
      console.log(
        `      ↳ plan 重复登记：已被 ${g.supersededBy} 承接，建议前移（见 docs/audit/overflow-probe.md）`,
      );
    if (g.movedFrom) console.log(`      ↳ 自 ${g.movedFrom} 前移而来`);
    if (g.note) console.log(`      ↳ ${g.note}`);
  }

  // plan G3.5 原文的六页里，哪些没有落到任何一道门槛上
  const covered = new Set(GATES.flatMap((g) => g.pages));
  const uncovered = G3_5_ORIGINAL_PAGES.filter((p) => !covered.has(p));
  const extra = pages.filter((p) => !G3_5_ORIGINAL_PAGES.includes(p.key)).map((p) => p.key);
  console.log('');
  console.log(
    `  · plan G3.5 六页清单中**无门槛归属**：${uncovered.length > 0 ? uncovered.join(' / ') : '（无）'}` +
      `（trade/kline 未被前移 → 归 Wave 8 T78 汇总复核）`,
  );
  console.log(`  · plan 六页清单之外、本脚本一并扫描的页面：${extra.join(' / ') || '（无）'}`);
}

/** 等待（毫秒）*/
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 解析可用会话
 *
 * ⚠️ 与 `scripts/a11y-check.mjs` 的 `resolveSession` **同一套约定**：
 *   优先级 `--token` > （`--username` + `--password`）登录；
 *   登录请求打**前端 dev server**（或 `--api-base-url`）的 `/api/auth/login`。
 *
 * @returns `{ token, refreshToken, username, role }`；没有凭据时返回 `null`
 */
function resolveSession(opts, base) {
  if (opts.token) {
    return {
      token: opts.token,
      refreshToken: null,
      username: opts.username ?? 'probe-overflow',
      role: opts.role,
    };
  }
  if (!opts.username || !opts.password) return null;

  const body = JSON.stringify({ username: opts.username, password: opts.password });
  const script = `
    fetch(${JSON.stringify(base + '/api/auth/login')}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: ${JSON.stringify(body)},
    })
      .then((r) => r.json())
      .then((j) => {
        const s = (j && j.data) || {};
        process.stdout.write(JSON.stringify({
          token: String(s.token || ''),
          refreshToken: s.refresh_token ? String(s.refresh_token) : null,
          username: (s.user && s.user.username) || ${JSON.stringify(opts.username)},
          role: (s.user && s.user.role) || 'user',
        }));
      })
      .catch(() => process.stdout.write(''));
  `;
  let out;
  try {
    out = execFileSync('node', ['-e', script], { encoding: 'utf8', timeout: opts.timeout }).trim();
  } catch (err) {
    fail(`登录请求失败：${err.message}`);
  }
  if (!out) fail('登录失败 —— 未拿到 token（检查用户名/密码与后端是否已启动）');
  try {
    const parsed = JSON.parse(out);
    if (!parsed.token) fail('登录响应里没有 token');
    return parsed;
  } catch (err) {
    fail(`解析登录响应失败：${err.message}`);
  }
  return null;
}

/** 写 localStorage（zustand persist 的 key 是 `invest-user`）*/
function setLocalStorage(key, value) {
  pw(['localstorage-set', key, JSON.stringify(value)]);
}

await main();
