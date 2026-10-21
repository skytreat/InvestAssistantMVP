/**
 * tests/http/_browser.ts —— **真浏览器**测量工具（CDP 直连，零新依赖）
 *
 * ════════════════════════════════════════════════════════════════════════
 * 📖 **为什么需要它**
 * ════════════════════════════════════════════════════════════════════════
 *   SDD §12.5 的 PE1（首屏加载 ≤1.5s）与 PE3（K 线首渲染 ≤500ms）**是浏览器级门槛**：
 *     · PE1：Lighthouse Chrome DevTools，Performance 分数 ≥ 90
 *     · PE3：Chrome Performance Profiler，**FP (First Paint) ≤ 500ms**
 *   ⇒ 它们**不能**用 `inject()` 或 `fetch()` 测（那是服务端视角，没有「渲染」这件事）。
 *   ⇒ 本文件用 **Chrome DevTools Protocol** 直连 Chromium，
 *     读取 **Performance API 的 paint / navigation 条目** ——
 *     这与 Chrome DevTools / Lighthouse 取的是**同一份数据**（`performance.getEntriesByType('paint')`）。
 *
 * ⚠️ **不引入任何 npm 依赖**（AGENTS.md「新增 npm 依赖必须说明理由」）：
 *   · CDP 走 Node **内置的全局 `WebSocket`**（Node ≥22 内置）
 *   · 静态资源服务 + /api 反代用 Node **内置 `node:http`**
 *   · 浏览器二进制**只找不装**（找不到 ⇒ skip + 留痕）
 *
 * ⚠️ **本机没有浏览器 / 没有前端构建产物时 ⇒ skip + console.warn**（绝不假绿）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { globSync } from 'node:fs';

/** 前端构建产物目录（`vite build` 的输出） */
export const FRONTEND_DIST = path.resolve(__dirname, '../../../frontend/dist');

/** Playwright 下载的 Chromium 缓存目录（常见安装位置） */
const PLAYWRIGHT_CACHE = path.join(os.homedir(), '.cache', 'ms-playwright');

/**
 * 找一个可用的 Chromium/Chrome 二进制
 *
 * 优先级：env 显式指定 → Playwright 缓存 → PATH
 */
export function findChromiumBinary(): string | null {
  for (const envKey of ['CHROMIUM_BIN', 'CHROME_BIN']) {
    const p = process.env[envKey];
    if (p && existsSync(p)) return p;
  }
  try {
    const hits = globSync(path.join(PLAYWRIGHT_CACHE, 'chromium-*', 'chrome-linux*/chrome'));
    const usable = hits.find((h) => existsSync(h));
    if (usable) return usable;
  } catch {
    /* glob 不可用则跳过 */
  }
  return null;
}

/** 前端构建产物是否就绪 */
export function frontendDistReady(): boolean {
  return existsSync(path.join(FRONTEND_DIST, 'index.html'));
}

// ──────────────────────────────────────────────────────────────────────────
// 极简 CDP 客户端（Node 内置 WebSocket）
// ──────────────────────────────────────────────────────────────────────────

interface PendingCall {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class CdpClient {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, PendingCall>();
  private handlers = new Map<string, Array<(params: any) => void>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const call = this.pending.get(msg.id);
        if (call) {
          this.pending.delete(msg.id);
          if (msg.error) call.reject(new Error(`${msg.error.message}（${msg.error.code}）`));
          else call.resolve(msg.result);
        }
        return;
      }
      const list = this.handlers.get(msg.method);
      if (list) for (const h of list) h(msg.params);
    };
  }

  static async connect(wsUrl: string): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`CDP WebSocket 连接失败：${wsUrl}`));
    });
    return new CdpClient(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: any) => void): void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** 已启动的浏览器 */
export interface BrowserHandle {
  proc: ChildProcess;
  /** CDP 端口 */
  port: number;
  close: () => Promise<void>;
}

/** 启动 headless Chromium（真浏览器） */
export async function launchChromium(binary: string): Promise<BrowserHandle> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'invest-chrome-'));
  const proc = spawn(
    binary,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'pipe' },
  );

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, 'utf8').split('\n');
      const port = Number(raw[0]);
      if (Number.isFinite(port) && port > 0) {
        return {
          proc,
          port,
          close: async () => {
            proc.kill('SIGTERM');
            await new Promise((r) => setTimeout(r, 300));
            if (!proc.killed) proc.kill('SIGKILL');
            rmSync(userDataDir, { recursive: true, force: true });
          },
        };
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill('SIGKILL');
  rmSync(userDataDir, { recursive: true, force: true });
  throw new Error('Chromium 未能在 20s 内启动（DevToolsActivePort 未生成）');
}

/** 页面导航 + 性能条目测量结果 */
export interface PageMeasurement {
  /** FP（First Paint）—— SDD PE3 的判据口径 */
  firstPaint: number | null;
  /** FCP（First Contentful Paint） */
  firstContentfulPaint: number | null;
  /** LCP（ Largest Contentful Paint） */
  largestContentfulPaint: number | null;
  /** DOMContentLoaded */
  domContentLoaded: number | null;
  /** load 事件 */
  loadEventEnd: number | null;
  /** 首个可用 canvas 的出现时刻（补充指标） */
  canvasReady: number | null;
  /** 页面标题 */
  title: string;
  /** 抓到的控制台错误数 */
  consoleErrors: number;
}

/**
 * 打开一个页面并采集性能条目
 *
 * @param url 要访问的地址
 * @param token 登录后放进 localStorage 的 JWT（前端用 zustand persist 存在 `invest-user`）
 * @param waitMs 导航后额外等待的时间（等首屏数据渲染完）
 */
export async function measurePage(opts: {
  browserPort: number;
  url: string;
  token?: string;
  username?: string;
  waitMs?: number;
}): Promise<PageMeasurement> {
  // 取一个 page target
  const listRes = await fetch(`http://127.0.0.1:${opts.browserPort}/json/list`);
  const targets = (await listRes.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) throw new Error('没有找到可用的 page target');

  const client = await CdpClient.connect(page.webSocketDebuggerUrl);
  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Log.enable').catch(() => {});

    let consoleErrors = 0;
    client.on('Log.entryAdded', (params: any) => {
      if (params?.entry?.level === 'error') consoleErrors += 1;
    });
    client.on('Runtime.exceptionThrown', () => {
      consoleErrors += 1;
    });

    // 注入 localStorage（前端会话：zustand persist，key = 'invest-user'）
    const initScript = `
      try {
        ${
          opts.token
            ? `localStorage.setItem('invest-user', JSON.stringify({
                 state: { token: ${JSON.stringify(opts.token)}, refreshToken: null, username: ${JSON.stringify(
                   opts.username ?? 'pe_user',
                 )}, role: 'user' },
                 version: 0,
               }));`
            : ''
        }
        window.__probeCanvasReady = null;
        (function poll() {
          const c = Array.from(document.querySelectorAll('canvas')).find(
            (x) => x.width > 0 && x.height > 0,
          );
          if (c) { window.__probeCanvasReady = performance.now(); return; }
          requestAnimationFrame(poll);
        })();
      } catch (e) {}
    `;
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });

    const loaded = new Promise<void>((resolve) => {
      client.on('Page.loadEventFired', () => resolve());
    });
    await client.send('Page.navigate', { url: opts.url });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 30_000))]);
    await new Promise((r) => setTimeout(r, opts.waitMs ?? 500));

    const expr = `(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paints = {};
      for (const p of performance.getEntriesByType('paint')) paints[p.name] = p.startTime;
      let lcp = null;
      for (const e of performance.getEntriesByType('largest-contentful-paint')) lcp = e.startTime;
      return {
        firstPaint: paints['first-paint'] ?? null,
        firstContentfulPaint: paints['first-contentful-paint'] ?? null,
        largestContentfulPaint: lcp,
        domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
        loadEventEnd: nav ? nav.loadEventEnd : null,
        canvasReady: window.__probeCanvasReady ?? null,
        title: document.title,
      };
    })()`;
    const res = await client.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
    const value = (res?.result?.value ?? {}) as Omit<PageMeasurement, 'consoleErrors'>;
    return { ...value, consoleErrors };
  } finally {
    client.close();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 前端静态服务 + /api 反代（等价于生产 Caddy 的两段路由）
// ──────────────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 已启动的前端静态服务 */
export interface FrontendServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * 起一个「静态资源 + /api 反代」的服务器
 *
 * ⚠️ 口径对齐生产（Caddy）：`route /api/* { reverse_proxy … }` 在前，
 *   `route /* { try_files {path} /index.html }`（SPA history 兜底）在后。
 */
export async function startFrontendServer(opts: {
  distDir: string;
  backendBaseUrl: string;
  port: number;
}): Promise<FrontendServer> {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const reqUrl = req.url ?? '/';
        if (reqUrl.startsWith('/api')) {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = chunks.length ? Buffer.concat(chunks) : undefined;
          const method = (req.method ?? 'GET').toUpperCase();
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers[k] = v;
          }
          const upstream = await fetch(new URL(reqUrl, opts.backendBaseUrl), {
            method,
            headers,
            body: method === 'GET' || method === 'HEAD' ? undefined : body,
          });
          const outHeaders: Record<string, string> = {};
          upstream.headers.forEach((v, k) => {
            outHeaders[k] = v;
          });
          res.writeHead(upstream.status, outHeaders);
          res.end(Buffer.from(await upstream.arrayBuffer()));
          return;
        }

        const pathOnly = reqUrl.split('?')[0];
        let filePath = path.join(opts.distDir, pathOnly === '/' ? 'index.html' : pathOnly);
        if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
          filePath = path.join(opts.distDir, 'index.html');
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
        res.end(readFileSync(filePath));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(err));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${opts.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
