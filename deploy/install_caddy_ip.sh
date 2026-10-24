#!/usr/bin/env bash
set -euo pipefail

CADDY_IP="${CADDY_IP:-$(curl -fsSL https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')}"

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

sudo mkdir -p /etc/caddy/pki
sudo openssl req -x509 -newkey rsa:2048 -keyout /etc/caddy/pki/ca.key -out /etc/caddy/pki/ca.crt -days 365 -nodes -subj "/CN=${CADDY_IP}"

cat > /etc/caddy/Caddyfile <<EOF
${CADDY_IP} {
    tls internal ${CADDY_IP}
    root * /opt/invol/IA_Prod/frontend/dist
    try_files {path} /index.html
    encode zstd gzip
    file_server
}
EOF

if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable caddy 2>/dev/null || true
    sudo systemctl start caddy 2>/dev/null || echo "Caddy start failed; you can run manually: caddy run --config /etc/caddy/Caddyfile"
else
    echo "Please run: caddy run --config /etc/caddy/Caddyfile"
fi

echo "Caddy 配置完成，可通过 https://${CADDY_IP} 访问（自签名证书，浏览器会弹出警告）"