# 部署指南

服务器：OCI 云数据库 ARM 2C12G Ubuntu 24.04

代码路径：`/opt/invol/InvestAssistantMVP`

运行目录：`/opt/invol/IA_Prod/app`（后端 dist + prod `node_modules` + `packages/core`）

DuckDB 行情库：`/opt/invol/IA_Prod/quotes.duckdb`

SQLite 业务库：`/opt/invol/IA_Prod/data/business.db`

前端静态产物：`/opt/invol/IA_Prod/frontend/dist`

> **2026-10-23 生产部署修订**
>
> - 后端不再只复制 `dist`：运行目录同时包含生产 `node_modules` 与 `packages/core/dist`，
>   避免 `ERR_MODULE_NOT_FOUND` / `@invest/core` 缺失。
> - 生产配置**只读取** `/opt/invol/IA_Prod/.env.local`，部署脚本不再用仓库内 `.env.local` 覆盖。
> - 后端/前端均先写 staging 再原子切换；健康检查失败自动回滚到 `app.old`。
> - Caddy 为可选前置依赖；未安装或未提供 `CADDY_DOMAIN` / `CADDY_EMAIL` 时跳过，不再中断部署。
> - `tdx2db.service` 的写窗口哨兵与 `ExecStopPost` 故障清理已纳入仓库。

## 前置条件

- Ubuntu 24.04，root 权限
- Node.js ≥22（脚本仅在缺失时安装 22；不会把更高版本降级）
- `tdx2db` 预编译二进制（脚本首次自动安装，可按 `TDX2DB_VERSION` 指定版本）
- 生产环境文件 `/opt/invol/IA_Prod/.env.local`（首次执行会生成模板或迁移旧配置并停止）
- Caddy（可选；需要 HTTPS 时安装，并准备域名与 ACME 邮箱）
- 如使用 Caddy：DNS 已指向服务器，80/443 已放行

## 一键部署

```bash
cd /opt/invol/InvestAssistantMVP

# 第一次执行：生成模板，或从旧 /opt/invol/.env.local 迁移后退出
sudo bash deploy/deploy.sh

# 填写生产配置（至少 JWT_SECRET；建议填 TUSHARE_TOKEN）
sudo vim /opt/invol/IA_Prod/.env.local

# 再次执行
sudo bash deploy/deploy.sh
```

需要 HTTPS 时：

```bash
sudo CADDY_DOMAIN=invest.example.com \
     CADDY_EMAIL=admin@example.com \
     bash deploy/deploy.sh
```

脚本自动完成：

1. 安装系统依赖；Node 缺失时安装 22；首次安装 tdx2db
2. 创建 `invol` 用户和 `/opt/invol/IA_Prod/{data,backup,secrets,plugins,frontend}` 目录
3. 校验 `/opt/invol/IA_Prod/.env.local`（不覆盖生产文件，不复制开发机配置）
4. `npm ci` → 根目录 `npm run build`（core → backend → frontend）→ `npm prune --omit=dev`
5. 组装 `/opt/invol/IA_Prod/app`，验证所有生产依赖（含 native 模块）可加载
6. 原子切换后端与前端产物
7. 安装 systemd units、启动 timer、首次初始化 DuckDB（如缺库）
8. 启动 Fastify 并做 `/api/health` 健康检查；失败自动回滚 `app.old`
9. Caddy 已安装且提供域名/邮箱时渲染配置并校验；否则跳过

常用选项：

```bash
# 复用已有 dist / node_modules（不重新 npm ci/build）
sudo bash deploy/deploy.sh --skip-build

# 指定 tdx2db 版本 / 校验压缩包（可选）
sudo TDX2DB_VERSION=v2026.8.12 TDX2DB_SHA256=<sha256> bash deploy/deploy.sh
```

## 目录布局

```text
/opt/invol/
├── InvestAssistantMVP/      # 代码仓库（git pull 的位置）
└── IA_Prod/                 # 生产运行根目录
    ├── app/                 # 后端运行目录（root 只读，systemd WorkingDirectory）
    │   ├── dist/            # apps/backend/dist
    │   ├── node_modules/    # 生产依赖（含 native）
    │   ├── packages/core/   # @invest/core package.json + dist
    │   └── package.json     # apps/backend/package.json（type=module）
    ├── app.old/             # 上一版本，健康检查失败时自动回滚
    ├── data/business.db     # SQLite 业务库（invol 可写）
    ├── backup/              # 17:05 备份目录（invol 可写）
    ├── plugins/strategies/  # 自定义插件（invol 可写）
    ├── secrets/             # 敏感文件（700 invol）
    ├── frontend/dist/       # Caddy 静态根
    ├── frontend/dist.old/   # 上一版本前端
    ├── quotes.duckdb        # tdx2db 写入，Fastify 只读
    ├── .tdx2db-writing      # tdx2db 写窗口哨兵（运行中存在）
    └── .env.local           # 生产环境变量（600 invol）
```

## 环境变量

生产文件固定为 `/opt/invol/IA_Prod/.env.local`：

```bash
# JWT 签名密钥（必填；生成：openssl rand -hex 32）
JWT_SECRET=<64位随机十六进制>

# Tushare API Token（C11/C12 校验使用）
TUSHARE_TOKEN=<token>

SQLITE_DB_PATH=/opt/invol/IA_Prod/data/business.db
DUCKDB_PATH=/opt/invol/IA_Prod/quotes.duckdb
BACKUP_DIR=/opt/invol/IA_Prod/backup

# 可选
# PLUGIN_ALLOWED_PATH=/opt/invol/IA_Prod/plugins/strategies
# TDX2DB_WRITE_SENTINEL=/opt/invol/IA_Prod/.tdx2db-writing
# ENABLE_QUOTE_BACKUP=false
# LOG_LEVEL=info

# Fastify 固定监听 127.0.0.1，仅端口可改
PORT=8080
```

> `HOST` 不是有效配置项：`apps/backend/src/server.ts` 固定监听 `127.0.0.1`。
> 不要把仓库内开发用 `.env.local` 复制到生产。
> `deploy.sh` 会拒绝 `SQLITE_DB_PATH` / `DUCKDB_PATH` / `BACKUP_DIR` 不在
> `/opt/invol/IA_Prod` 下的配置，避免旧路径下误建空库。

## 从旧目录迁移（`/opt/invol` → `/opt/invol/IA_Prod`）

首次切到 `IA_Prod` 时，如果脚本发现旧库仍在 `/opt/invol/data/business.db`、
`/opt/invol/business.db`、`/opt/invol/quotes.duckdb` 或
`/opt/invol/data/quotes.duckdb`，而新目录还没有对应文件，会**停止并提示迁移**，
不会创建空库覆盖。

如果旧生产配置在 `/opt/invol/.env.local`，第一次执行部署脚本会先把它复制到
`/opt/invol/IA_Prod/.env.local` 并改写路径，然后退出。核对配置后，停服迁移数据：

```bash
sudo systemctl stop invest-assistant.service tdx2db-update.timer tdx2db.service

sudo install -d -o invol -g invol -m 750 \
  /opt/invol/IA_Prod/data \
  /opt/invol/IA_Prod/backup \
  /opt/invol/IA_Prod/plugins/strategies
sudo install -d -o invol -g invol -m 700 /opt/invol/IA_Prod/secrets

# SQLite（连同 -wal / -shm）与 DuckDB（连同 .wal）一起迁移
sudo mv /opt/invol/data/business.db* /opt/invol/IA_Prod/data/
# 若旧业务库在 /opt/invol/business.db，则改为：
# sudo mv /opt/invol/business.db* /opt/invol/IA_Prod/data/
sudo mv /opt/invol/quotes.duckdb* /opt/invol/IA_Prod/
# 若旧行情库在 data/ 下，则改为：sudo mv /opt/invol/data/quotes.duckdb* /opt/invol/IA_Prod/

# 备份、插件、secrets：先复制并核对，确认后再清理旧副本
sudo cp -a /opt/invol/backup/. /opt/invol/IA_Prod/backup/
sudo cp -a /opt/invol/plugins/strategies/. /opt/invol/IA_Prod/plugins/strategies/
sudo cp -a /opt/invol/secrets/. /opt/invol/IA_Prod/secrets/

sudo chown -R invol:invol /opt/invol/IA_Prod/{data,backup,plugins,secrets}
sudo chmod 600 /opt/invol/IA_Prod/data/business.db* /opt/invol/IA_Prod/quotes.duckdb*
```

迁移完成后重新执行 `sudo bash deploy/deploy.sh`。旧目录建议保留一段时间，
确认新目录数据完整、服务正常后再清理。

## Systemd 管理

### Fastify 后端

```bash
sudo systemctl status invest-assistant
sudo systemctl restart invest-assistant
sudo journalctl -u invest-assistant -f

# 健康检查（端口默认读 /opt/invol/IA_Prod/.env.local 的 PORT）
bash deploy/healthcheck.sh
```

### DuckDB 行情更新

```bash
sudo systemctl status tdx2db-update.timer
sudo systemctl list-timers tdx2db-update.timer
sudo journalctl -u tdx2db.service -f
```

`tdx2db.service` 在写库前后创建/删除 `/opt/invol/IA_Prod/.tdx2db-writing`；
`ExecStopPost` 在 tdx2db 失败时也会清理哨兵，避免 Fastify 永久等待写窗口。

### Caddy

```bash
sudo systemctl status caddy
sudo caddy validate --config /etc/caddy/Caddyfile
sudo journalctl -u caddy -f
```

脚本只在 Caddy 已安装且提供 `CADDY_DOMAIN` / `CADDY_EMAIL` 时渲染
`deploy/Caddyfile` 并重启 Caddy。`deploy/Caddyfile` 是模板，不能直接复制使用。

## 17:00-17:05 Cron 链路

```text
17:00 systemd timer -> tdx2db 增量更新 DuckDB
17:01 Fastify cron -> C1-C12 数据校验
17:02 Fastify cron -> 插件信号生成（依赖 DuckDB）
17:03 Fastify cron -> 除权事件同步
17:05 Fastify cron -> 热备份（SQLite 恒常执行；DuckDB COPY TO 受 ENABLE_QUOTE_BACKUP 控制）
```

Fastify 在 17:00 窗口内检测到哨兵后会释放 DuckDB 读连接；外部写完成后惰性重建。
Node 自己触发补跑时走 `rerunQuoteUpdate()` 的主动让锁路径（ADR-012）。

## 升级与回滚

正常升级：拉取代码后直接执行 `sudo bash deploy/deploy.sh`。脚本会构建新产物，
切换后端目录并重启；健康检查失败会自动恢复 `app.old`。

手工回滚：

```bash
sudo systemctl stop invest-assistant
sudo rm -rf /opt/invol/IA_Prod/app
sudo mv /opt/invol/IA_Prod/app.old /opt/invol/IA_Prod/app
sudo systemctl start invest-assistant
sudo journalctl -u invest-assistant -n 50 --no-pager
```

前端回滚：

```bash
sudo rm -rf /opt/invol/IA_Prod/frontend/dist
sudo mv /opt/invol/IA_Prod/frontend/dist.old /opt/invol/IA_Prod/frontend/dist
sudo systemctl restart caddy
```

tdx2db 是外部 Go 二进制，不随代码版本变化；升级需手动替换
`/usr/local/bin/tdx2db` 后重启 timer。

## 故障排查

| 症状 | 可能原因 | 排查 |
|------|----------|------|
| `ERR_MODULE_NOT_FOUND` | `/opt/invol/IA_Prod/app` 缺少 node_modules 或 core | `ls /opt/invol/IA_Prod/app/node_modules/fastify`；重新执行部署（不要用 `--skip-build` 除非产物完整） |
| 后端启动失败 | `.env.local` 缺失/权限错 | `ls -l /opt/invol/IA_Prod/.env.local`；`journalctl -u invest-assistant -n 50` |
| 健康检查失败 | 端口被占 / SQLite 不可写 | `curl http://127.0.0.1:8080/api/health`；检查 `PORT`、`data/` 权限 |
| DuckDB 连接失败 | 行情库不存在 / 权限错 | `ls -l /opt/invol/IA_Prod/quotes.duckdb`；确认属主 `invol` 且模式 `600` |
| 备份任务失败 | `/opt/invol/IA_Prod/backup` 不可写 | `sudo -u invol touch /opt/invol/IA_Prod/backup/.probe` |
| 行情接口一直提示更新中 | 哨兵残留 | `ls -l /opt/invol/IA_Prod/.tdx2db-writing`；查看 `journalctl -u tdx2db`，确认无 tdx2db 运行后可手动删除 |
| Caddy 502 | Fastify 没起来 | `curl http://127.0.0.1:8080/api/health` |
| SPA 首页 404 | Caddy root / try_files 错 | `caddy validate --config /etc/caddy/Caddyfile`；检查 `/opt/invol/IA_Prod/frontend/dist/index.html` |
| `/api/*` 返回 SPA HTML | Caddy 路由顺序错 | `handle /api/*` 必须放在兜底 `handle` 之前 |
| 定时任务未运行 | timer 未启用 | `systemctl is-enabled tdx2db-update.timer`；`systemctl list-timers` |
