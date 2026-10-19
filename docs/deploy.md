# 部署指南

服务器：OCI 云数据库 ARM 2C12G Ubuntu 24.04
代码路径：/opt/invol/InvestAssistantMVP
DuckDB 行情库：/opt/invol/quotes.duckdb
SQLite 业务库：/opt/invol/data/business.db

## 一键部署

```bash
# 需要 root 权限
sudo bash deploy/deploy.sh
```

脚本自动完成：

1. 创建 `invol` 用户和目录
2. 安装 Node.js 22
3. 安装 tdx2db 预编译二进制
4. npm ci + build backend + build frontend
5. 复制产物到 /opt/invol/dist 和 /opt/invol/frontend/dist
6. 安装 systemd units（tdx2db.service + tdx2db-update.timer + invest-assistant.service + Caddy）
7. 首次 tdx2db init（下载 hsjday.zip）

## 手动部署步骤（脚本失败时用）

### 1. Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
node -v  # v22.x
```

### 2. 目录结构

```bash
sudo useradd -r -s /bin/false invol
sudo mkdir -p /opt/invol/{data,backup,secrets,plugins/strategies,frontend/dist}
sudo chown -R invol:invol /opt/invol
```

### 3. 构建

```bash
cd /opt/invol/InvestAssistantMVP
npm ci --omit=dev
npm run build -w @invest/backend
npm run build -w @invest/frontend
sudo cp -r apps/backend/dist /opt/invol/
sudo cp -r apps/frontend/dist/* /opt/invol/frontend/dist/
```

### 4. Systemd Units

```bash
sudo cp deploy/invest-assistant.service /etc/systemd/system/
sudo cp deploy/tdx2db.service /etc/systemd/system/
sudo cp deploy/tdx2db-update.timer /etc/systemd/system/
sudo cp deploy/Caddyfile /etc/caddy/
sudo systemctl daemon-reload
sudo systemctl enable --now tdx2db-update.timer
sudo systemctl enable --now invest-assistant.service
sudo systemctl enable --now caddy
```

## Systemd 管理

### Fastify 后端

```bash
sudo systemctl status invest-assistant
sudo systemctl restart invest-assistant
sudo journalctl -u invest-assistant -f  # 实时日志
```

### DuckDB 行情更新

```bash
sudo systemctl status tdx2db-update.timer
sudo systemctl list-timers tdx2db-update.timer  # 下次触发时间
sudo journalctl -u tdx2db.service -f
```

### Caddy

```bash
sudo systemctl status caddy
sudo caddy validate --config /etc/caddy/Caddyfile  # 验证配置
sudo journalctl -u caddy -f
```

## 环境变量

.env.local 放在 /opt/invol/.env.local：

```bash
# Fastify 监听（必须 127.0.0.1，Caddy 反代）
HOST=127.0.0.1
PORT=8080

# DuckDB 路径
DUCKDB_PATH=/opt/invol/quotes.duckdb

# SQLite 业务库路径
SQLITE_DB_PATH=/opt/invol/data/business.db

# 备份目录
BACKUP_DIR=/opt/invol/backup

# 自定义插件目录（可选，默认 /opt/invol/plugins/strategies）
# 该目录必须存在且对运行用户可写；不存在时后端只记 INFO 日志跳过磁盘加载（内置插件仍可用）
# PLUGIN_ALLOWED_PATH=/opt/invol/plugins/strategies

# JWT secret（生产务必改）
JWT_SECRET=change-me-in-production
```

## 17:00-17:05 Cron 链路

```
17:00 systemd timer -> tdx2db 增量更新 DuckDB
17:01 Fastify cron -> C1-C12 数据校验
17:02 Fastify cron -> 插件信号生成（依赖 DuckDB）
17:03 Fastify cron -> 除权事件同步
17:05 Fastify cron -> 双库热备份（SQLite db.backup + DuckDB COPY TO）
```

## 回滚

```bash
cd /opt/invol/InvestAssistantMVP
git stash && git pull origin main
npm ci --omit=dev
npm run build -w @invest/backend
npm run build -w @invest/frontend
sudo cp -r apps/backend/dist /opt/invol/
sudo cp -r apps/frontend/dist/* /opt/invol/frontend/dist/
sudo systemctl restart invest-assistant
# 注意：tdx2db 是外部 Go 二进制，不随代码版本变更
```

## 故障排查

| 症状 | 可能原因 | 排查 |
|------|----------|------|
| invest-assistant 启动失败 | dist/server.js 不存在 | `ls /opt/invol/dist/` |
| Fastify 崩溃退出 | 权限问题 | `journalctl -u invest-assistant -n 50` |
| DuckDB 连接失败 | quotes.duckdb 不存在 | `ls -la /opt/invol/quotes.duckdb` |
| Caddy 502 | Fastify 没起来 | `curl http://127.0.0.1:8080/api/health` |
| SPA 首页 404 | Caddy 没配 try_files | 检查 /etc/caddy/Caddyfile 的 route /* 块 |
| /api/* 返回 SPA HTML | Caddy reverse_proxy 在 try_files 后面 | 必须 route /api/* 在前 |
