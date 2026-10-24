#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CADDY_IP:-}" ]; then
    echo "Error: CADDY_IP environment variable is not set. Please set it and retry." >&2
    echo "Example: sudo CADDY_IP=203.0.113.10 ./deploy/install_caddy_ip.sh" >&2
    exit 1
fi

if ! command -v caddy >/dev/null 2>&1; then
    CADDY_VERSION="v2.9.2"
    ARCH="arm64"
    if [ "$(uname -m)" = "x86_64" ]; then
        ARCH="amd64"
    fi
    TMPDIR="$(mktemp -d)"
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/${CADDY_VERSION}/caddy_linux_${ARCH}.tar.gz" -o "${TMPDIR}/caddy.tar.gz"
    tar -xzf "${TMPDIR}/caddy.tar.gz" -C "${TMPDIR}" caddy
    sudo install -m755 "${TMPDIR}/caddy" /usr/local/bin/caddy
    rm -rf "${TMPDIR}"
fi

# T109：/api/* 必须独立反代到 Fastify；SPA 的 try_files 只能放在兜底 handle 内。
# 修复前把 try_files 放在站点顶层，所有 /api/* 被重写成 index.html，
# 前端登录报「网络错误」（2026-10-24 生产实测：经 Caddy 的 /api/health 返回 text/html）。
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${CADDY_IP} {
    tls internal

    handle /api/* {
        reverse_proxy 127.0.0.1:8080
    }

    handle {
        root * /opt/invol/IA_Prod/frontend/dist
        try_files {path} /index.html
        encode zstd gzip
        file_server
    }
}
EOF

if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable caddy 2>/dev/null || true
    sudo systemctl restart caddy 2>/dev/null || echo "Caddy start failed; you can run manually: caddy run --config /etc/caddy/Caddyfile"
else
    echo "Please run: caddy run --config /etc/caddy/Caddyfile"
fi

echo "Caddy 配置完成，可通过 https://${CADDY_IP} 访问（自签名证书，浏览器会弹出警告）"
