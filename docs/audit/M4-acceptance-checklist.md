# Requirements §10.1 验收走查清单（T46）

> **用途**：在真实服务器（ARM 2C12G Ubuntu 24.04）上逐条执行，勾选 + 记录实测值。
> **代码基线**：main `501e56b`（M3）+ PR #4（T41⑤ 备份恢复 / seed 越权修复 / T48 smoke-m4）
> **测试基线**：270 tests 全 PASS（backend 246 + core 24）
> **执行人**：______ **执行日期**：______ **服务器**：______

**图例**：⬜ 未执行 ｜ ✅ PASS ｜ ❌ FAIL ｜ ⚠️ PARTIAL ｜ ➖ 不适用/环境受限

---

## 0. 环境准备

```bash
cd /opt/invol/InvestAssistantMVP
git log --oneline -1                      # 确认代码版本
node -v                                  # 必须 >= v22
systemctl is-active invest-assistant     # active?
systemctl is-active caddy                # active?
systemctl list-timers tdx2db-update.timer
curl -s http://127.0.0.1:8080/api/health | jq
```

| # | 检查项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| 0.1 | Node 版本 | ≥ v22 | | ⬜ |
| 0.2 | Fastify 进程 | active，监听 127.0.0.1:8080 | | ⬜ |
| 0.3 | Caddy | active，443 可访问 | | ⬜ |
| 0.4 | tdx2db timer | 已 enable，下次触发 17:00 | | ⬜ |
| 0.5 | DuckDB 行情库 | `ls -lh /opt/invol/quotes.duckdb` 有数百 MB | | ⬜ |

---

## 1. 功能验收（§10.1，11 项）

### F1 · 7 种交易类型

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"你的密码"}' | jq -r .data.token)

# 买入（7 种里 4 种需要 trade_reason）
for t in buy sell reduce clear; do
  curl -s -X POST http://127.0.0.1:8080/api/trades \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"asset_code\":\"sh600036\",\"trade_type\":\"$t\",\"trade_date\":\"2026-10-16\",\"quantity\":100,\"price\":40,\"trade_reason\":\"验收-$t\"}" | jq -c '.success'
done
# 分红/送股/转增：应自动带 trade_reason，仍可手写
for t in dividend bonus transfer; do
  curl -s -X POST http://127.0.0.1:8080/api/trades \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"asset_code\":\"sh600036\",\"trade_type\":\"$t\",\"trade_date\":\"2026-10-16\",\"quantity\":100,\"price\":1,\"trade_reason\":\"验收-$t\"}" | jq -c '.success'
done
```

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| F1.1 | buy/sell/reduce/clear | 全部 201 | | ⬜ |
| F1.2 | dividend/bonus/transfer | 全部 201 | | ⬜ |
| F1.3 | 缺 trade_reason 的 buy | 400 `TRADE_REASON_REQUIRED` | | ⬜ |
| F1.4 | 超持仓 sell | 400 `HOLDING_INSUFFICIENT` | | ⬜ |

### F2 · 移动加权成本（含送转）

要点：送股/转增后**数量增加、均价不变**；分红**不影响成本**。

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| F2.1 | 连续两次买入 | 均价 = 两次成本基合计 ÷ 总数量 | | ⬜ |
| F2.2 | 送股(bonus) | 数量↑，均价不变 | | ⬜ |
| F2.3 | 转增(transfer) | 数量↑，均价不变 | | ⬜ |
| F2.4 | 分红(dividend) | 数量与均价均不变 | | ⬜ |
| F2.5 | 卖出后 | 均价不变（Requirements §5.3#3） | | ⬜ |

> 本地已覆盖：`positionCalculator.test.ts` 5 个用例 + `smoke-m4` 交易闭环段

### F3 · 收益双口径

打开 `/review`，顶部切「价格口径 / 实际口径」；再打开 `/`，切总资产卡的口径。

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| F3.1 | 复盘页双口径 Tab | 可切换，收益率数值不同 | | ⬜ |
| F3.2 | 实际口径含分红 | 相比价格口径，分红部分被计入 | | ⬜ |
| F3.3 | Dashboard 总资产卡 | 同样可切，口径说明有文案 | | ⬜ |
| F3.4 | 收益曲线 | 月/季/年三档可切，有 SVG 曲线 | | ⬜ |

### F4 · 日线行情（抽样 10 只）

```bash
# 与第三方行情源比对，价差应 < 0.01 元
curl -s "http://127.0.0.1:8080/api/kline/sh600036?days=10" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data.klines[-1] | "\(.date) close=\(.close)"'
```

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| F4.1 | 抽样 10 只前复权收盘价 | 与第三方源价差 < 0.01 元 | | ⬜ |

> 依赖 `v_stock_qfq` 有数据。也可看 C11 的校验日志（30 只抽样）

### F5 · 除权除息

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| F5.1 | 除权后前复权价连续 | 无断崖 | | ⬜ |
| F5.2 | 自动导入分红/送股/转增 | 17:03 cron 跑完后 `user_trade_record` 有对应记录 | | ⬜ |
| F5.3 | 幂等性 | 同日重复跑不产生重复记录 | | ⬜ |

```sql
sqlite3 /opt/invol/data/business.db \
  "SELECT trade_type, COUNT(*) FROM user_trade_record WHERE is_auto_import=1 GROUP BY 1;"
```

### F6 · 数据校验 12 项

打开 `/admin`，看四色仪表盘。

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| F6.1 | C1-C10 内部一致性 | 全 PASS | | ⬜ |
| F6.2 | C11 跨源原始数据 | 差异 ≤ 3 只 | | ⬜ |
| F6.3 | C12 跨源复权数据 | 差异 ≤ 5 只 | | ⬜ |
| F6.4 | 四色显示 | PASS绿/WARN黄/ERROR红/SKIP灰 | | ⬜ |
| F6.5 | 点击卡片展开详情 | 显示 detail | | ⬜ |

### F7 · 管理员功能

```bash
# 手动触发行情更新补跑
curl -s -X POST http://127.0.0.1:8080/api/admin/rerun-quotes \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"验收手动补跑"}' | jq -c '.data | {status, method}'
```

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| F7.1 | 手动触发行情更新 | `status=SUCCESS` | | ⬜ |
| F7.2 | 查看 12 项校验日志 | system_log 可分页 + 筛选 | | ⬜ |
| F7.3 | **WARN 自动补跑** | 17:01 校验出现 WARN → 自动补跑 → 二次校验，system_log 有记录 | | ⬜ |

```sql
-- 验证 F7.3
sqlite3 /opt/invol/data/business.db \
  "SELECT log_date, log_type, level, message FROM system_log
   WHERE log_type IN ('datacheck','tdx2db_update') ORDER BY id DESC LIMIT 20;"
```

### F8 · 策略引擎

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| F8.1 | RSI/MACD 信号 | `/signals` 有记录 | | ⬜ |
| F8.2 | 超时保护 | 死循环插件被 50ms 强杀（`pluginEngine.test.ts` 已覆盖） | | ⬜ |
| F8.3 | 故障隔离 | 单插件异常不影响其他（已覆盖） | | ⬜ |
| F8.4 | 参数配置生效 | `/settings` 改 RSI 周期 → 下次信号按新参数 | | ⬜ |

### F9 · 全市场选股

打开 `/stockscan`，跑一次。

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| F9.1 | 返回耗时 | ≤ 3s（页面有耗时显示） | | ⬜ |
| F9.2 | 过滤条件生效 | 成交额下限等参数真的过滤了 | | ⬜ |
| F9.3 | 结果上限 | ≤ 100 条 | | ⬜ |
| F9.4 | 加入候选池 / 自选 | 按钮可用，迁移幂等 | | ⬜ |

### F10 · 复盘

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| F10.1 | 胜率 | 有数值或 `--`（空仓） | | ⬜ |
| F10.2 | 盈亏比 | 平均盈利/平均亏损 | | ⬜ |
| F10.3 | 收益曲线 | 月/季/年可切 | | ⬜ |
| F10.4 | 双口径切换 | 可切 | | ⬜ |
| F10.5 | 归因筛选 | 类型/符合策略/止损/日期 | | ⬜ |
| F10.6 | 4 字段编辑 | 复盘总结/符合策略/止损/备注，三态可切 | | ⬜ |

### F11 · 备份与恢复

```bash
# 备份
curl -s -X POST http://127.0.0.1:8080/api/admin/backup \
  -H "Authorization: Bearer $TOKEN" -d '{}' | jq -c '.data | {sqlite,duckdb}'
ls -lh /opt/invol/backup/

# 恢复（破坏性，务必 confirm）
curl -s -X POST "http://127.0.0.1:8080/api/admin/backup/business.db.2026-10-16/restore" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"confirm":true}' | jq -c '.data'
```

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| F11.1 | SQLite 备份 | 生成 `business.db.YYYY-MM-DD`，非 0 字节 | | ⬜ |
| F11.2 | DuckDB 备份 | 生成 `v_stock_qfq.YYYY-MM-DD.parquet` | | ⬜ |
| F11.3 | 完整性检查 | 恢复后关键表齐全、业务数据可读 | | ⬜ |
| F11.4 | 恢复可验证 | 恢复后能查到备份时刻的数据 | | ⬜ |
| F11.5 | 安全备份 | 自动生成 `.pre-restore-*` | | ⬜ |
| F11.6 | 路径穿越防护 | 非法文件名被拒（403/400） | | ⬜ |
| F11.7 | 保留策略 | 只留 3 天 | | ⬜ |
| F11.8 | OCI 远程上传 | 若已配 rclone，`ENABLE_OCI_BACKUP=true` 可上传；未配则本地保留即可 | | ⬜ |

---

## 2. 性能验收（§10.2，6 项）

在浏览器 DevTools / `curl -w` 实测，填入**实测毫秒数**。

| # | 验收项 | 标准 | 实测(ms) | 结论 |
|---|--------|------|---------|------|
| P1 | 首屏加载 | ≤ 1500ms | | ⬜ |
| P2 | API 常规（/api/positions） | ≤ 200ms | | ⬜ |
| P3 | 选股 | ≤ 3000ms | | ⬜ |
| P4 | 信号生成 | ≤ 20000ms | | ⬜ |
| P5 | 数据校验 | ≤ 60000ms | | ⬜ |
| P6 | K 线首渲染 | ≤ 500ms | | ⬜ |

```bash
curl -o /dev/null -s -w '%{time_total}\n' \
  -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/positions
```

**⚠️ 提前预警**：本地 `smoke-m4` 里手动备份耗时约 **26s**（DuckDB 821MB 导出 parquet）。
如果 P4/P5 超标，先看是不是 DuckDB 体量或机器规格问题，而不是代码。

---

## 3. 安全验收（§10.3，6 项）

```bash
# 3.2 仅开放必要端口
ss -tlnp | grep -E ':(80|443|8080|5173)\b'

# 3.3 密码不明文
sqlite3 /opt/invol/data/business.db "SELECT username, password_hash FROM user_account LIMIT 3;"

# 3.4 文件权限隔离
ls -l /opt/invol/data/business.db /opt/invol/secrets/

# 3.5 管理员鉴权双重检查（普通用户 token）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/admin/users   # 无 token → 401

# 3.6 日志脱敏
sqlite3 /opt/invol/data/business.db \
  "SELECT COUNT(*) FROM system_log WHERE detail LIKE '%ghp_%' OR message LIKE '%admin123%';"
```

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| S1 | HTTPS 强制 | HTTP 请求重定向到 HTTPS（301/308） | | ⬜ |
| S2 | 服务端口 | 仅 80/443 对外；8080 仅监听 127.0.0.1 | | ⬜ |
| S3 | 密码安全 | bcrypt hash，无明文 | | ⬜ |
| S4 | 数据库权限 | business.db / secrets 权限隔离，非 world-readable | | ⬜ |
| S5 | 管理员鉴权 | 无 token → 401；普通用户 → 403 | | ⬜ |
| S6 | 日志脱敏 | system_log 无明文 token/密码 | | ⬜ |

**必查的回归项（PR #4 修的漏洞）**：

```bash
# 这条现在必须返回 403 —— 修复前是 201 并返回 admin token
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/auth/seed \
  -H 'Content-Type: application/json' -d '{"username":"sneak_admin","password":"whatever"}'
```

| # | 回归项 | 期望 | 实测 | 结论 |
|---|--------|------|------|------|
| S7 | seed 越权 | **403**（修复前 201） | | ⬜ |

---

## 4. 合规验收（§10.4，1 项）

| # | 验收项 | 标准 | 实测 | 结论 |
|---|--------|------|------|------|
| C1 | 全局标注 | 「本工具不构成投资建议，数据仅供参考」常驻每一页 | | ⬜ |

---

## 5. 验收结论

| 分类 | 项数 | PASS | PARTIAL | FAIL | 免检 |
|------|------|------|---------|------|------|
| 功能 §10.1 | 11 | | | | 0 |
| 性能 §10.2 | 6 | | | | 0 |
| 安全 §10.3 | 6+1 | | | | 0 |
| 合规 §10.4 | 1 | | | | 0 |
| **合计** | **24+1** | | | | **0** |

**验收人签字**：______ **日期**：______

**遗留问题**：

| # | 问题 | 严重度 | 归属 |
|---|------|--------|------|
| | | | |

---

## 附：T-GAP-4 最终审计需要补的内容

跑完上面这份后，还需在审计报告里补：

- [ ] Out-Scope 功能确认未偷跑（无分钟K / 无小程序 / 无云函数 / 无下单 / 无 VM2）
- [ ] 备份恢复完整流程记录（备份 → 破坏 → 恢复 → 数据一致性）
- [ ] 定时任务 17:00-17:05 全链路实际触发记录
- [ ] CI Pipeline 全绿截图/链接
- [ ] tag `M4` + 合并 main