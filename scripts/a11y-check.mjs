#!/usr/bin/env node
/**
 * a11y 真浏览器门禁脚本（G3.4「axe 核心规则 0 critical」）
 *
 * ## 它解决什么
 *
 * `apps/frontend/tests/unit/a11y.test.tsx`（vitest + jsdom）覆盖了绝大多数 a11y 规则，
 * 但 jsdom **没有 layout engine**，有 5 条规则在那边不可评估
 * （见 `apps/frontend/tests/helpers/a11y.ts` 的 `AXE_RULES_UNSUPPORTED_IN_JSDOM`，
 * 其中最重要的是 `color-contrast` —— 文字对比度）。
 *
 * 本脚本在 **Chromium 真渲染**下跑 axe，**一条规则都不关**，
 * 用来覆盖 jsdom 覆盖不到的那部分，并作为后续 Wave 的 a11y 回归门禁。
 *
 * ## 怎么跑
 *
 * 1. 起后端（提供真实数据）：
 *    ```bash
 *    # 仓库根目录；注意 .env.local 里的 SQLITE_DB_PATH 必须指向**当前用户可写**的目录
 *    npm run dev -w @invest/backend
 *    ```
 * 2. 起前端 dev server（vite，固定 5173）：
 *    ```bash
 *    npm run dev -w @invest/frontend
 *    ```
 * 3. 跑门禁：
 *    ```bash
 *    node scripts/a11y-check.mjs                       # 全部页面
 *    node scripts/a11y-check.mjs --pages dashboard,review
 *    node scripts/a11y-check.mjs --base-url http://127.0.0.1:5173
 *    ```
 *
 * ## 依赖
 *
 * 用**全局的 `playwright-cli`**（仓库的 `.claude/skills/playwright-cli` 技能用的就是它），
 * **不往 package.json 里加 playwright 依赖**（AGENTS.md「新增 npm 依赖必须说明理由」）。
 *
 * - 已安装：`npm i -g @playwright/cli`
 * - 浏览器内核：`npx playwright install chromium`（本机 `~/.cache/ms-playwright` 已有）
 * - ⚠️ 本机默认浏览器是 `chrome`（未安装）→ 必须显式 `--browser=chromium`。
 *
 * ## 退出码
 *
 * - `0` —— 全部页面 0 条 critical 违规
 * - `1` —— 存在 critical 违规（打印规则 id / 影响节点 html / 官方修复链接）
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
const AXE_MIN_JS = path.join(REPO_ROOT, 'node_modules', 'axe-core', 'axe.min.js');

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

const USAGE = `用法：
  node scripts/a11y-check.mjs [选项]

选项：
  --base-url <url>     前端 dev server 地址（默认 http://127.0.0.1:5173）
  --api-base-url <url> 把页面的 /api/* 请求改写到该地址（默认直连前端 dev server 的代理）
                       ⚠️ 用于后端不在 vite.config.ts 写死的 8080 时（如 8081 被占）
  --pages <a,b,c>      只查指定页面（页面名见下方清单；默认全部）
  --browser <name>     playwright 浏览器（默认 chromium；本机没有 chrome）
  --username <name>    登录用户名（配合 --password，用于访问受保护页面）
  --password <pass>    登录密码
  --token <jwt>        直接注入已签发的 token（跳过登录流程）
  --role <role>        注入 --token 时使用的角色（默认 user；登录时用后端返回的真实角色）
  --report <file>      把结果写成 JSON 报告文件
  --timeout <ms>       单页 axe 超时（默认 60000）
  --help               显示本帮助

退出码：0 = 无 critical 违规；1 = 有 critical 违规；2 = 用法/环境错误`;

/** 解析命令行参数 */
function parseArgs(argv) {
  const opts = {
    baseUrl: 'http://127.0.0.1:5173',
    apiBaseUrl: null,
    pages: null,
    browser: 'chromium',
    username: null,
    password: null,
    token: null,
    role: 'user',
    timeout: 60000,
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
  console.error(`[a11y-check] ❌ ${message}`);
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 页面清单 —— 从 apps/frontend/src/App.tsx 的 <Route> 解析（不硬编码）
 * ------------------------------------------------------------------ */

/**
 * 解析 `App.tsx` 里的 `<Route path="..." element={<X />} />`
 *
 * ⚠️ **不硬编码页面清单** —— 新增路由后本脚本自动覆盖，
 *    避免「加了新页面却忘了加 a11y 门禁」的盲区（与
 *    `apps/frontend/tests/unit/a11y.test.tsx` 的 PAGES 清单互为对照）。
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
const NOT_FOUND_URL = '/__a11y_unknown_route__';

/* ------------------------------------------------------------------ *
 * playwright-cli 驱动
 * ------------------------------------------------------------------ */

/** 会话名（独立于其它 playwright-cli 会话，避免互相干扰） */
const SESSION = 'a11y-check';

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

/** 注入 axe-core 到当前页面 */
function injectAxe() {
  if (
    !execFileSync('node', [
      '-e',
      `process.exit(require('fs').existsSync(${JSON.stringify(AXE_MIN_JS)}) ? 0 : 1)`,
    ])
  ) {
    fail(`找不到 ${AXE_MIN_JS} —— 请先在仓库根目录执行 npm install`);
  }
  runPlaywrightCode(
    `async page => {\n` + `  await page.addScriptTag({ path: ${JSON.stringify(AXE_MIN_JS)} });\n` + `}\n`,
  );
}

/**
 * 让页面里的 `/api/*` 请求改打到别的后端地址
 *
 * ⚠️ 为什么需要：vite 的代理 target 在 `apps/frontend/vite.config.ts` 里**写死 8080**，
 *    而 8080 常被宿主其它服务（如 llama-server）占用 → 后端只能跑在 8081。
 *    本脚本用 Playwright 的请求路由在**浏览器侧**改写目标，
 *    不需要改仓库里的 vite 配置（`vite.config.ts` 不在本任务的改动范围内）。
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

/** 执行一段 Playwright 代码（`async page => {...}`）*/
function runPlaywrightCode(source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'a11y-check-'));
  const file = path.join(dir, 'pw-code.js');
  writeFileSync(file, source, 'utf8');
  try {
    pw(['run-code', `--filename=${file}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 在页面里跑 axe，返回精简结果 */
function runAxeInPage() {
  const expr =
    `axe.run(document).then(r => JSON.stringify({` +
    `violations: r.violations.map(v => ({id: v.id, impact: v.impact, help: v.help,` +
    `description: v.description, helpUrl: v.helpUrl,` +
    `nodes: v.nodes.map(n => ({html: n.html, target: n.target}))})),` +
    `incomplete: r.incomplete.map(v => ({id: v.id, impact: v.impact, nodes: v.nodes.length})),` +
    `passes: r.passes.length` +
    `}))`;
  const raw = pw(['--raw', 'eval', expr]);
  if (!raw) return null;
  try {
    return JSON.parse(JSON.parse(raw)); // playwright-cli --raw 返回的是 JSON 字符串
  } catch (err) {
    fail(`解析 axe 结果失败：${err.message}\n原始输出：${raw.slice(0, 500)}`);
  }
  return null;
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

  const selected = opts.pages ? pages.filter((p) => opts.pages.includes(p.key)) : pages;

  if (selected.length === 0) {
    fail(
      `没有匹配到任何页面。可用页面：${pages.map((p) => p.key).join(', ')}\n` +
        `--pages 只接受页面名，不接受路径。`,
    );
  }

  console.log(`[a11y-check] 目标：${opts.baseUrl}`);
  console.log(`[a11y-check] 待检页面（${selected.length}）：${selected.map((p) => p.key).join(', ')}`);

  const base = opts.baseUrl.replace(/\/+$/, '');
  let opened = false;
  let exitCode = 0;
  try {
    pw(['open', `--browser=${opts.browser}`, base], { allowFail: true });
    opened = true;
    if (opts.apiBaseUrl) {
      rewriteApiBase(opts.apiBaseUrl);
      console.log(`[a11y-check] /api/* 已改写到 ${opts.apiBaseUrl}`);
    }
    injectAxe();

    // 登录（可选）：拿到 token 后写进 localStorage，让受保护页面真的渲染出来
    const session = resolveSession(opts, opts.apiBaseUrl ?? base);
    if (session) {
      setLocalStorage('invest-user', {
        state: {
          token: session.token,
          refreshToken: null,
          username: session.username,
          role: session.role,
        },
        version: 0,
      });
      console.log(`[a11y-check] 已注入会话（user=${session.username}, role=${session.role}）`);
    } else {
      console.warn(
        '[a11y-check] ⚠️ 未提供登录凭据（--username/--password 或 --token）——' +
          '受保护页面会跳到 /login，只检到登录页的 DOM。',
      );
    }

    let criticalCount = 0;
    const report = [];

    for (const page of selected) {
      pw(['goto', `${base}${page.path}`]);
      // 等前端路由渲染完（简单起见等一小段时间；SPA 路由切换很快）
      await sleep(600);
      // 导航后 axe 仍在（addScriptTag 注入的是当前 document，goto 会重置 → 需重新注入）
      injectAxe();

      const result = runAxeInPage();
      if (!result) {
        console.error(`[a11y-check] ❌ ${page.key}：axe 未返回结果`);
        criticalCount += 1;
        continue;
      }

      const critical = result.violations.filter((v) => v.impact === 'critical');
      const others = result.violations.filter((v) => v.impact !== 'critical');
      const incomplete = result.incomplete.filter((v) => v.impact === 'critical');

      if (critical.length === 0) {
        console.log(`[a11y-check] ✅ ${page.key}（${page.path}）：0 critical`);
      } else {
        criticalCount += critical.length;
        console.error(`[a11y-check] ❌ ${page.key}（${page.path}）：${critical.length} 条 critical`);
        for (const v of critical) {
          console.error(`   ✗ [${v.impact}] ${v.id} —— ${v.help}`);
          console.error(`     ${v.description}`);
          console.error(`     修复参考：${v.helpUrl}`);
          for (const n of v.nodes.slice(0, 5)) {
            console.error(`     - ${n.html}`);
          }
          if (v.nodes.length > 5) console.error(`     ...（另有 ${v.nodes.length - 5} 个节点）`);
        }
      }

      if (others.length > 0) {
        console.warn(
          `[a11y-check] ℹ️ ${page.key}：另有 ${others.length} 条非 critical 违规` +
            `（${others.map((v) => `${v.id}/${v.impact}`).join(', ')}）`,
        );
        for (const v of others) {
          console.warn(`     - [${v.impact}] ${v.id} × ${v.nodes.length}`);
          for (const n of v.nodes.slice(0, 3)) {
            console.warn(`       · ${n.html}`);
          }
          if (v.nodes.length > 3) console.warn(`       ...（另有 ${v.nodes.length - 3} 个节点）`);
        }
      }
      if (incomplete.length > 0) {
        console.warn(
          `[a11y-check] ℹ️ ${page.key}：${incomplete.length} 条 critical 规则「需人工复核」` +
            `（${incomplete.map((v) => v.id).join(', ')}）`,
        );
      }

      report.push({
        key: page.key,
        path: page.path,
        critical: critical.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          helpUrl: v.helpUrl,
          nodes: v.nodes.map((n) => n.html),
        })),
        other: others.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          helpUrl: v.helpUrl,
          nodes: v.nodes.map((n) => n.html),
        })),
        incompleteCritical: incomplete.map((v) => v.id),
      });
    }

    if (opts.report) {
      writeFileSync(
        opts.report,
        JSON.stringify(
          { baseUrl: opts.baseUrl, generatedAt: new Date().toISOString(), pages: report },
          null,
          2,
        ),
        'utf8',
      );
      console.log(`[a11y-check] 报告已写入 ${opts.report}`);
    }

    console.log('');
    if (criticalCount === 0) {
      console.log(`[a11y-check] ✅ 全部 ${selected.length} 个页面 0 条 critical 违规 —— G3.4 通过`);
      exitCode = 0;
    } else {
      console.log(`[a11y-check] ❌ 共发现 ${criticalCount} 条 critical 违规 —— G3.4 不通过`);
      exitCode = 1;
    }
  } finally {
    if (opened) {
      pw(['close'], { allowFail: true });
    }
  }
  process.exit(exitCode);
}

/** 等待（毫秒）*/
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 解析可用会话
 *
 * 优先级：`--token` > （`--username` + `--password`）登录。
 * 登录请求打**前端 dev server**（或 `--api-base-url`）的 `/api/auth/login`。
 *
 * @returns `{ token, username, role }`；没有凭据时返回 `null`
 */
function resolveSession(opts, base) {
  if (opts.token) {
    return { token: opts.token, username: opts.username ?? 'a11y-check', role: opts.role };
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
