/**
 * tests/http/https-se1.test.ts —— **SE1 验收：HTTPS 强制（HTTP 301 跳转）**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 📖 **SDD §12.5 安全验收组（权威口径，逐字照抄）**
 * ════════════════════════════════════════════════════════════════════════
 *   | SE1 | HTTPS 强制（HTTP 301 跳转）| curl http://host → Location: https:// | HTTP 自动 301 |
 *
 *   原始需求 §9（同 SDD §12.5 引用）：
 *   | SE1 | HTTP 是否强制重定向到 HTTPS？| 是 | **Caddy 配置 + curl 验证** |
 *
 * ── **口径判断（本用例最关键的一步）** ──
 *   SDD 写的机制是 **Caddy（反向代理）**，**不是 Fastify**：
 *     · `deploy/Caddyfile` 的 `:80` 站点块 → `redir https://…{uri} permanent`
 *       （**Caddy v2 的 `permanent` 快捷方式 = HTTP 301 永久重定向** —— 本用例实测确认：
 *         Caddy v2.11.7 对 `redir … permanent` 返回 `301 Moved Permanently`）
 *     · `:443` 站点块 → `reverse_proxy 127.0.0.1:8080`（Fastify **只监听 127.0.0.1**）
 *   ⇒ **Fastify 自身不做 TLS、也不发 301**（它只监听明文 127.0.0.1，由 Caddy 终结 TLS）。
 *   ⇒ 因此本用例分两层：
 *     ① **契约层（始终执行）**：断言 `deploy/Caddyfile` 里确实声明了
 *        「HTTP → HTTPS 的 301 跳转」与「/api/* 反代到 127.0.0.1:8080」；
 *     ② **HTTP 层（条件执行）**：若本机有 `caddy` 可执行文件 ⇒ **真起一个 Caddy**
 *        （用仓库里的那条 `redir` 指令原文，只把监听地址换成本地端口），
 *        再用裸 socket 打过去 ⇒ 断言 **301 + Location: https://**。
 *        没有 caddy ⇒ **skip + console.warn 留痕**（**不假绿**：日志里明写「本次未做 HTTP 层验证」）。
 *
 * ⚠️ **本机没有 caddy 时不能「降断言凑绿」** —— 契约层断言不降级，
 *    HTTP 层则如实标记为「未实测」并留痕。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, cleanupTempDir, findFreePort } from './_helpers.js';

/** 仓库里的 Caddy 配置（部署拓扑的唯一真相源） */
const CADDYFILE_PATH = path.join(REPO_ROOT, 'deploy', 'Caddyfile');

/** 找 caddy 可执行文件（env 覆盖优先，其次 PATH） */
function findCaddyBinary(): string | null {
  const fromEnv = process.env.CADDY_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const out = execFileSync('sh', ['-c', 'command -v caddy'], { encoding: 'utf8' }).trim();
    return out ? out : null;
  } catch {
    return null;
  }
}

const CADDY_BIN = findCaddyBinary();

/**
 * 解析 Caddyfile 的站点块（顶层 `{ … }`）
 *
 * ⚠️ 必须做**括号配对**（不是正则懒惰匹配）——
 *   `:443` 站点块里有嵌套的 `tls { … }` 子块 ⇒ 懒惰正则会在第一个 `}` 处截断。
 */
function parseCaddyfile(src: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    const header = (src.slice(i, open).trim().split('\n').pop() ?? '').trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') depth -= 1;
      j += 1;
    }
    blocks.set(header, src.slice(open + 1, j - 1));
    i = j;
  }
  return blocks;
}

describe('SE1 —— HTTPS 强制（HTTP 301 跳转）', () => {
  it('契约层：deploy/Caddyfile 的 :80 站点块声明了 HTTP → HTTPS 的 permanent（=301）跳转', () => {
    const src = readFileSync(CADDYFILE_PATH, 'utf8');
    const blocks = parseCaddyfile(src);
    const httpBlock = blocks.get(':80');
    expect(httpBlock, 'Caddyfile 缺少 :80 站点块（HTTP 明文入口）').toBeDefined();

    const redirLine = (httpBlock as string)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('redir '));
    expect(redirLine, ':80 站点块缺少 redir 指令 ⇒ HTTP 不会自动 301').toBeDefined();

    // 跳转目标必须是 https
    expect(redirLine).toMatch(/redir\s+https:\/\//);
    // `permanent` = Caddy v2 的 **301** 快捷方式（`temporary` 才是 302）
    // ⚠️ 这是**实测**结论，不是文档转述：Caddy v2.11.7 对 `redir … permanent`
    //   返回 `301 Moved Permanently`（见下方 HTTP 层用例的原始响应行）。
    expect(redirLine).toMatch(/\bpermanent\b/);
    // 路径必须原样带过去（{uri} 占位符），否则 SPA 路由会丢
    expect(redirLine).toContain('{uri}');
  });

  it('契约层：:443 站点块把 /api/* 反代到 127.0.0.1:8080（Fastify 只监听本机）', () => {
    const src = readFileSync(CADDYFILE_PATH, 'utf8');
    const blocks = parseCaddyfile(src);
    const httpsBlock = blocks.get(':443');
    expect(httpsBlock, 'Caddyfile 缺少 :443 站点块').toBeDefined();
    expect(httpsBlock).toMatch(/route\s+\/api\/\*/);
    expect(httpsBlock).toMatch(/reverse_proxy\s+127\.0\.0\.1:8080/);
  });

  it('契约层：Fastify 侧**不做** TLS / 不发 301（职责在 Caddy）', () => {
    const serverSrc = readFileSync(path.join(REPO_ROOT, 'apps/backend/src/server.ts'), 'utf8');
    // 只监听 127.0.0.1（AGENTS.md 硬约束）
    expect(serverSrc).toMatch(/const HOST = '127\.0\.0\.1'/);
    // Fastify 未启用 https（TLS 终结在 Caddy）
    expect(serverSrc).not.toMatch(/\bhttps:\s*\{/);
  });
});

/**
 * HTTP 层实测：**真起一个 Caddy**（用仓库 Caddyfile 里那条 redir 指令原文）
 *
 * ⚠️ 只把**监听地址**换成本地端口（`:80` → `:51220`），
 *    `redir https://invest.example.com{uri} permanent` 这一行**逐字复制** ——
 *    测的确实是仓库声明的那条规则，而不是另写一条规则自证。
 */
describe('SE1 —— HTTP 层实测（Caddy 301）', () => {
  let caddy: ChildProcess | null = null;
  let port = 0;
  let tmpDir = '';

  beforeAll(async () => {
    if (!CADDY_BIN) return;
    port = await findFreePort(51220, 51239);
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'invest-caddy-'));

    const src = readFileSync(CADDYFILE_PATH, 'utf8');
    const blocks = parseCaddyfile(src);
    const httpBlock = blocks.get(':80') ?? '';
    const redirLine =
      httpBlock
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('redir ')) ?? '';
    // 只替换监听地址；redir 指令原文保留
    const adapted = `:${port} {\n    ${redirLine}\n}\n`;
    const cfgPath = path.join(tmpDir, 'Caddyfile');
    writeFileSync(cfgPath, adapted, 'utf8');

    caddy = spawn(CADDY_BIN, ['run', '--config', cfgPath, '--adapter', 'caddyfile'], {
      stdio: 'pipe',
    });
    // 等 Caddy 起来（最多 10s）
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const up = await new Promise<boolean>((resolve) => {
        const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
          sock.destroy();
          resolve(true);
        });
        sock.on('error', () => resolve(false));
      });
      if (up) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Caddy 未能在 10s 内启动');
  }, 30000);

  afterAll(async () => {
    if (caddy) {
      caddy.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!caddy.killed) caddy.kill('SIGKILL');
      caddy = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
    // ⚠️ 本文件**不创建 Fastify app**（起的是 Caddy）⇒ 引用计数归不了零
    //    ⇒ 必须显式清理共享的临时目录（否则 /tmp 里会留残目录）
    cleanupTempDir();
  }, 30000);

  it('HTTP → HTTPS 自动 301，且 Location 指向 https（裸 socket 真实往返）', async () => {
    if (!CADDY_BIN) {
      console.warn(
        '[SE1] ⚠️ 本机没有 caddy 可执行文件（CADDY_BIN 未设、PATH 里也没有）⇒ ' +
          '**SE1 的 HTTP 层（真实 301）本次未实测**，只跑了契约层断言。' +
          '要补齐 HTTP 层实测，请安装 caddy 或设 CADDY_BIN=<caddy 路径> 后重跑。',
      );
      return;
    }

    // 🔴 **裸 socket**（不走 fetch 的连接池）⇒ 证明 301 是**真实 TCP 服务端**返回的
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
        sock.write(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      sock.setTimeout(10_000, () => {
        sock.destroy();
        reject(new Error('裸 socket 请求超时'));
      });
      sock.on('data', (c) => {
        buf += c.toString('utf8');
      });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
    });

    const statusLine = raw.split('\r\n')[0];
    const statusCode = Number(statusLine.split(' ')[1]);
    const locationMatch = raw.match(/^location:\s*(.+)$/im);
    const location = locationMatch ? locationMatch[1].trim() : '';

    console.log(`[SE1] caddy 实测：${statusLine} → Location: ${location}（端口 ${port}）`);

    // 前置守卫：确实是一个**真在监听**的 HTTP 服务端（不是 inject 内存态）
    expect(statusLine).toMatch(/^HTTP\/1\.1 \d{3}/);
    // SDD §12.5 的硬判据：**HTTP 自动 301**（Caddy v2 的 `permanent` 快捷方式）
    expect(statusCode, `状态码 ${statusCode} 不是 301`).toBe(301);
    // 目标必须是 https
    expect(location.startsWith('https://')).toBe(true);
    // 路径要原样带过去（{uri}）
    expect(location).toContain('/api/health');
  });
});
