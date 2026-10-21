#!/usr/bin/env node
/**
 * G5.6 —— K 线主图价格轴范围探针（真浏览器）
 *
 * 判据（实施计划 §12.7 G5.6 原文）：
 *   加载 120 根 K 线后读取主图 y 轴的 **min/max 标注**，
 *   断言 **max/min ≤ 3**（真实价格区间），**不得出现 0 起步**。
 *
 * 🔴 **为什么必须探针而不是单测**：
 *   历史上出现过「数值对但图是坏的」—— 后端 MA 数组的预热期用 `null` 占位，
 *   `if (!isNaN(v))` 对 `null` 返回 false（`isNaN(null) === false`）
 *   ⇒ 那些 null 进入 `Math.min` → y 轴变成 0.00~9.74，蜡烛被压到画布顶部 5%
 *   ⇒ **指标数值断言全绿，图却是坏的**（I-23）。
 *   jsdom 无 Canvas / 无 layout ⇒ 只能真浏览器读真实轴范围。
 *
 * 用法：
 *   node scripts/probe-kline-axis.mjs --api-base-url http://127.0.0.1:8081 \
 *        --username admin --password admin123
 *   node scripts/probe-kline-axis.mjs --symbols sh600000,sh510300 --report /tmp/axis.json
 *
 * 退出码：0 = 全部通过；1 = 有断言不通过；2 = 探针自身失败
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** G5.6 判据 */
const MAX_MIN_RATIO = 3;
/** 主图 y 轴下界必须 > 0（不得 0 起步）*/
const MIN_AXIS_LOWER_BOUND = 0.0001;
const DEFAULT_SYMBOLS = ['sh600000'];
const SESSION = 'probe-kline-axis';

const USAGE = [
  '用法：',
  '  node scripts/probe-kline-axis.mjs [--api-base-url <url>] [--username <u>] [--password <p>]',
  '                              [--symbols sh600000,sh510300] [--report <file>]',
  '',
  '  --api-base-url <url> 把页面的 /api/* 请求改写到该地址（默认直连 dev server 代理）',
  '  --username <u>        登录用户名（默认 admin）',
  '  --password <p>        登录密码（默认 admin123）',
  '  --symbols <a,b,c>    要探测的标的（默认 ' + DEFAULT_SYMBOLS.join(',') + '）',
  '  --report <file>       把结果写成 JSON 报告文件',
  '',
].join('\n');

function parseArgs(argv) {
  const out = {
    apiBaseUrl: null,
    username: 'admin',
    password: 'admin123',
    symbols: [...DEFAULT_SYMBOLS],
    report: null,
    base: 'http://127.0.0.1:5173',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--api-base-url') out.apiBaseUrl = argv[++i];
    else if (a === '--username') out.username = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--symbols')
      out.symbols = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      process.stderr.write('未知参数：' + a + '\n' + USAGE);
      process.exit(2);
    }
  }
  return out;
}

function fail(message) {
  process.stderr.write('[probe-kline-axis] ❌ ' + message + '\n');
  process.exit(2);
}

function pw(args, { allowFail = false } = {}) {
  try {
    return execFileSync('playwright-cli', ['-s=' + SESSION, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (allowFail) return '';
    fail('playwright-cli ' + args.join(' ') + ' 执行失败：\n' + (err.stderr || err.message));
    return '';
  }
}

/** 与 pw 同款，但把失败原因带回来（诊断用）*/
function pwDiag(args) {
  try {
    return {
      out: execFileSync('playwright-cli', ['-s=' + SESSION, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      err: '',
    };
  } catch (err) {
    return { out: '', err: String(err.stderr || err.message).slice(0, 300) };
  }
}

function ensurePlaywrightCli() {
  try {
    execFileSync('playwright-cli', ['--version'], { stdio: 'ignore' });
  } catch {
    fail('找不到 playwright-cli。请先安装：\n  npm i -g @playwright/cli && npx playwright install chromium');
  }
}

/**
 * 把源码交给 playwright-cli 执行。
 *
 * 🔴 **格式要求**：run-code --filename= 要的是**箭头函数**（async page => { … }），
 * **不是顶层语句** —— 写顶层 const/await 会报 SyntaxError（2026-10-20 实测）。
 */
function runPlaywrightCode(source) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kline-axis-'));
  const file = path.join(dir, 'code.js');
  const body = source.indexOf('async page =>') >= 0 ? source : 'async page => {\n' + source + '\n}';
  writeFileSync(file, body, 'utf8');
  try {
    return pw(['run-code', '--filename=' + file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setViewport(width, height) {
  runPlaywrightCode('await page.setViewportSize({ width: ' + width + ', height: ' + height + ' });');
}

/** 读主图 y 轴范围（依赖 DEV 模式暴露的 window.__investKlineChart）*/
const READ_AXIS_EXPR = [
  '(function () {',
  '  var chart = window.__investKlineChart;',
  "  if (!chart) return { error: 'window.__investKlineChart 未暴露（需 dev server）' };",
  '  // ⚠️ **getYAxes 必须传 filter 对象**（v10 的签名是 (filter: YAxisFilter) => YAxis[]）：',
  '  //   无参调用会读 undefined.paneId → **抛 TypeError**（2026-10-20 实测踩到）。',
  "  //   paneId='candle_pane' = 主图（其余是副图窗格）。",
  "  var axes = chart.getYAxes ? chart.getYAxes({ paneId: 'candle_pane' }) : null;",
  "  if (!axes || !axes.length) return { error: 'getYAxes({paneId:candle_pane}) 返回空' };",
  '  var a = axes[0];',
  '  var range = a.getRange ? a.getRange() : null;',
  '  var candles = chart.getDataList ? chart.getDataList() : null;',
  '  return {',
  '    from: range ? range.from : null,',
  '    to: range ? range.to : null,',
  '    realFrom: range ? range.realFrom : null,',
  '    realTo: range ? range.realTo : null,',
  '    barCount: candles ? candles.length : null,',
  "    firstDate: candles && candles.length ? String(candles[0].date || '') : null,",
  "    lastDate: candles && candles.length ? String(candles[candles.length - 1].date || '') : null,",
  '  };',
  '})()',
].join('\n');

/**
 * 读一次 y 轴范围。
 *
 * ⚠️ `playwright-cli --raw eval` 的输出形态**取决于表达式返回什么**：
 *   返回**对象** → 输出该对象（单次 JSON.parse 即可）
 *   返回**字符串** → 输出该字符串的 JSON 字面量（需二次 parse）
 * ⇒ 两种都兼容。
 */
function readAxis() {
  const r = pwDiag(['--raw', 'eval', READ_AXIS_EXPR]);
  const raw = r.out;
  if (!raw || !raw.trim()) {
    return { error: 'eval 失败：' + (r.err || '(无 stderr)') };
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) return { error: 'eval 返回无法解析：' + raw.slice(0, 200) };
  const body = raw.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    try {
      return JSON.parse(JSON.parse(body));
    } catch {
      return { error: 'eval 返回无法解析：' + raw.slice(0, 200) };
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  ensurePlaywrightCli();

  process.stdout.write('[probe-kline-axis] 目标：' + opts.base + '\n');
  process.stdout.write('[probe-kline-axis] 标的：' + opts.symbols.join(', ') + '\n');
  process.stdout.write(
    '[probe-kline-axis] 判据：max/min ≤ ' + MAX_MIN_RATIO + ' 且 y 轴下界 > ' + MIN_AXIS_LOWER_BOUND + '\n',
  );
  if (opts.apiBaseUrl) {
    process.stdout.write('[probe-kline-axis] /api/* 已改写到 ' + opts.apiBaseUrl + '\n');
  }

  pw(['open', '--browser=chromium', opts.base], { allowFail: true });

  // ⚠️ **改写 /api + 登录 + 注入 localStorage 必须在同一次 run-code 里完成**（2026-10-20 实测）：
  //   分步做时，中间那次导航会打到 vite 代理写死的 8080（宿主 llama-server）⇒ 500
  //   ⇒ api/client.ts 的 401 拦截器触发 logout() ⇒ **token 被清空** ⇒ 后续全部 401。
  const apiBase = opts.apiBaseUrl ?? '';
  const apiRoot = apiBase ? apiBase.replace(/\/+$/, '') + '/api/' : '';
  const oneShot = [
    'const apiRoot = ' + JSON.stringify(apiRoot) + ';',
    'if (apiRoot) {',
    '  // ⚠️ **必须用锚定开头的正则替换，不能用 slice(indexOf)**（2026-10-20 实测踩坑）：',
    '  //   slice 会把前端的**源文件** /src/api/client.ts 也当成 API 路径改写到后端',
    '  //   ⇒ 后端对该路径返回 401 ⇒ 前端模块加载失败 ⇒ **白屏**（探针看到 canvases=0）。',
    '  //   锚定 ^https?://[^/]+/api/ 只匹配真正的 API 端点。',
    '  //   （与 scripts/probe-overflow.mjs / scripts/a11y-check.mjs 逐字同源。）',
    "  await page.route('**/api/**', async (route) => {",
    '    const target = route.request().url().replace(/^https?:\\/\\/[^/]+\\/api\\//, apiRoot);',
    '    const response = await route.fetch({ url: target });',
    '    await route.fulfill({ response });',
    '  });',
    '}',
    "const res = await fetch(apiRoot + 'auth/login', {",
    "  method: 'POST', headers: { 'Content-Type': 'application/json' },",
    '  body: JSON.stringify({ username: ' +
      JSON.stringify(opts.username) +
      ', password: ' +
      JSON.stringify(opts.password) +
      ' }),',
    '});',
    'const j = await res.json();',
    'const sess = j.data || {};',
    "if (!sess.token) throw new Error('登录失败：' + JSON.stringify(j).slice(0, 200));",
    'const payload = JSON.stringify({',
    '  state: { token: sess.token, refreshToken: sess.refresh_token || null,',
    '           username: sess.user && sess.user.username, role: sess.user && sess.user.role },',
    '  version: 0,',
    '});',
    'await page.evaluate("localStorage.setItem(\'invest-user\', " + JSON.stringify(payload) + ")");',
  ].join('\n');
  runPlaywrightCode(oneShot);
  setViewport(1440, 900);

  const results = [];
  let failed = 0;
  let lastRaw = '(未取到)';

  for (const symbol of opts.symbols) {
    pw(['goto', opts.base + '/kline?symbol=' + encodeURIComponent(symbol)]);
    let axis = { error: '未就绪' };
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      axis = readAxis();
      lastRaw = JSON.stringify(axis).slice(0, 200);
      if (!axis.error && axis.barCount > 0) break;
    }

    const row = { symbol };
    Object.assign(row, axis);
    if (axis.error || !axis.barCount) {
      row.pass = false;
      row.reason = axis.error || 'K 线未加载';
      failed += 1;
    } else {
      const from = Number(axis.from);
      const to = Number(axis.to);
      const ratio = from > 0 ? to / from : Infinity;
      const startsAtZero = !(from > MIN_AXIS_LOWER_BOUND);
      row.ratio = Number.isFinite(ratio) ? Number(ratio.toFixed(4)) : null;
      row.startsAtZero = startsAtZero;
      row.pass = row.ratio !== null && row.ratio <= MAX_MIN_RATIO && !startsAtZero;
      if (!row.pass) {
        row.reason = startsAtZero
          ? 'y 轴从 0 起步（from=' + from + '）'
          : 'max/min = ' + row.ratio + ' > ' + MAX_MIN_RATIO;
        failed += 1;
      }
    }
    results.push(row);
    const mark = row.pass ? '✅' : '❌';
    process.stdout.write(
      '  ' +
        mark +
        ' ' +
        symbol +
        '  from=' +
        axis.from +
        ' to=' +
        axis.to +
        '  max/min=' +
        (row.ratio ?? '—') +
        '  bars=' +
        (axis.barCount ?? '—') +
        '  ' +
        (axis.firstDate ?? '') +
        '~' +
        (axis.lastDate ?? '') +
        '  ' +
        (row.reason ?? '') +
        '\n',
    );
  }

  if (failed > 0) {
    process.stderr.write('[probe-kline-axis] 诊断：最后一次 eval 结果 = ' + lastRaw + '\n');
  }
  pw(['close'], { allowFail: true });

  if (opts.report) {
    writeFileSync(opts.report, JSON.stringify({ results, maxMinRatio: MAX_MIN_RATIO }, null, 2));
    process.stdout.write('[probe-kline-axis] 报告已写入 ' + opts.report + '\n');
  }

  if (failed > 0) {
    process.stderr.write('[probe-kline-axis] ❌ ' + failed + '/' + results.length + ' 个标的不满足 G5.6\n');
    process.exit(1);
  }
  process.stdout.write('[probe-kline-axis] ✅ 全部 ' + results.length + ' 个标的满足 G5.6\n');
  process.exit(0);
}

await main();
