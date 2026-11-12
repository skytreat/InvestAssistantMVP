#!/usr/bin/env node
// systemd OnFailure 告警脚本：把异常 unit 名推送到企业微信群机器人。
//
// 只用于「Fastify 进程本身挂了」这类应用层无法自救的场景；
// 行情链路失败（tdx2db / C1-C12）由 Fastify cron 在 17:01 判定后推送，避免重复。
//
// 安全：webhook URL 只从环境变量读取，不打印；退出码恒为 0，告警失败不影响 systemd 状态。

import { hostname as getHostname } from 'node:os';

const WEBHOOK_HOST = 'qyapi.weixin.qq.com';
const TIMEOUT_MS = 5_000;

const unit = process.argv[2] || 'unknown';
const hostname = getHostname();
const url = (process.env.WECOM_WEBHOOK_URL || '').trim();

function fail(message) {
  console.error(`[invest-alert] ${message}`);
  process.exit(0);
}

if (!url) fail('WECOM_WEBHOOK_URL 未配置，跳过告警');

let parsed;
try {
  parsed = new URL(url);
} catch {
  fail('WECOM_WEBHOOK_URL 不是合法 URL，跳过告警');
}
if (parsed.protocol !== 'https:' || parsed.hostname !== WEBHOOK_HOST) {
  fail('WECOM_WEBHOOK_URL 不是企业微信官方地址，跳过告警');
}

const when = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const content = [
  'InvestAssistant 服务异常',
  `单元：${unit}`,
  `主机：${hostname}`,
  `时间：${when}`,
  `请登录服务器执行 systemctl status ${unit} 查看详情`,
].join('\n');

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.errcode !== 0) {
    console.error(
      `[invest-alert] 企业微信返回异常: http=${res.status} errcode=${body?.errcode ?? 'unknown'}`,
    );
  }
} catch (err) {
  console.error(`[invest-alert] 发送失败: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
