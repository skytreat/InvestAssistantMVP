import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T109 回归：Caddy IP 安装脚本必须把 `/api/*` 独立反代到 Fastify。
 *
 * 2026-10-24 生产实测：脚本把 `try_files {path} /index.html` 放在站点顶层，
 * `/api/*` 被 SPA 兜底吞掉 → 前端登录报「网络错误」。
 * 这里做静态契约断言（无需 caddy 二进制）。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '../../../../deploy/install_caddy_ip.sh');

describe('T109 Caddy IP 安装脚本', () => {
  it('包含 /api/* 独立反代，且 try_files 只出现在兜底 handle 内', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');

    expect(src).toMatch(/handle\s+\/api\/\*\s*\{/);
    expect(src).toMatch(/reverse_proxy\s+127\.0\.0\.1:8080/);

    const apiHandleIdx = src.indexOf('handle /api/*');
    const tryFilesIdx = src.indexOf('try_files {path}');
    expect(apiHandleIdx, '缺少 handle /api/*').toBeGreaterThanOrEqual(0);
    expect(tryFilesIdx, '缺少 try_files').toBeGreaterThan(apiHandleIdx);
  });

  it('CADDY_IP 必填，且用 sudo tee 写配置（非 root 用户也可执行）', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/CADDY_IP/);
    expect(src).toMatch(/CADDY_IP.*not set|not set.*CADDY_IP/s);
    expect(src).toMatch(/sudo tee\s+\/etc\/caddy\/Caddyfile/);
  });
});
