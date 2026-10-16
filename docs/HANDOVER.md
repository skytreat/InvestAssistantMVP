# Hand-over Notes — 2026-10-16（M3 收尾后）

## 当前状态

**分支**：main，工作树干净
**测试**：backend 25 files / 215 tests + core 7 files / 24 tests = **239 tests 全 PASS**
**TypeScript**：backend `tsc --noEmit` 0 error；frontend `tsc && vite build` 全绿
**审计**：`docs/audit/M3-audit-report.md` 已更新为 M3 PASS（14/14 In-Scope、10/10 Gap 闭合）

> 本文件上一版存在于 `feat/t37-t41-review-impl2` 分支未合入 main，现已恢复到 main 并按最新进度重写。

---

## 本轮完成（G1-G10 全闭合）

| # | 任务 | 落点 |
|---|------|------|
| G6a | `strategy_match` DDL 列（原来只有 `system_followed`，语义不同导致 PATCH 500） | `configStore.ts` DDL_SQL + `_ensureTradeRecordReviewColumns()` ALTER 幂等补列；`trade.ts` / `review.ts` 筛选 + SELECT；`Review.tsx` 三态按钮改用该字段 |
| G3a | WARN/ERROR 自动补跑（PRD D3 + SDD §5.1 Step 3） | 新增 `services/quoteRerun.ts`（降级链 systemd-run → systemctl → exec → SKIP）；`scheduler.ts` 新增 `runDatacheckWithRerun`（C11/C12 不触发，C1-C10 WARN/ERROR 触发 + 二次校验）；`POST /api/admin/rerun-quotes` 手动通道 |
| G7b | Dashboard 总资产卡（双口径切换） | `Dashboard.tsx` + `GET /api/asset-stat/latest` |
| G7c | 资产组成饼图 | `Dashboard.tsx` conic-gradient 环形图（股票 vs ETF） |
| G10a | 移动端底部 TabBar | `_shared.tsx` `useIsMobile()` + `MobileTabBar`（持仓/K线/选股/复盘/设置，admin 多一个管理） |
| G10b | K线副图移动端 Tab + 画布自适应 | `Kline.tsx` `subTab` + 容器宽度跟随 |
| G5 | Settings 插件管理页 | 新增 `pages/Settings.tsx`（列表/启停/参数表单 + 范围前端预校验） |
| G8b | Admin 校验详情展开 | `Admin.tsx` 点击四色卡片展开 detail |
| G4 | 候选池 → 自选迁移 | 新增 `POST /api/candidate/:asset/promote`（幂等 + 软删恢复）+ `StockScan.tsx` 加候选/加自选按钮 |

### 顺带修掉的 8 个缺陷

见 `docs/audit/M3-audit-report.md` §6。其中值得记住的：

- **B6**：`Navbar` 少一个 `</div>`，导致 `npm run build -w @invest/frontend` 编译失败
- **B7**：`packages/core/vitest.config.ts` 缺 `root`，`npm test` 的 core 段**静默跑 0 个用例**（README 一直声称 24 tests）。已修并同步 CI
- **B1/B2**：复盘胜率恒为 100%（`SUM(CASE WHEN price>0)` 等价于"有卖出就算盈利"），盈亏比是 `winRate/50` 占位公式 → 改为按移动加权成本算每笔平仓已实现盈亏
- **B4/B5**：Dashboard 读 `p.qty`（实际 `totalQuantity`）、Admin 读 `res.data.data.rows`（实际是数组）→ 两处 UI 一直显示空白

---

## 待做（Phase 4 / T43-T48 + T-GAP-4）

| ID | 任务 | 状态 |
|----|------|------|
| T43 | systemd unit + Caddy 部署实测 | unit 文件已就位（`deploy/`），**未在真机跑过** |
| T44 | CI Pipeline | `.github/workflows/ci.yml` 已存在，本次同步了 core 测试命令 |
| T45 | Security hardening | 代码层已满足（127.0.0.1 + CORS localhost），真机验证待做 |
| T46 | Requirements §10.1 正式验收走查 | 未开始 |
| T47 | 文档补齐 | README / docs/deploy.md 已存在，验收后需同步进度 |
| T48 | `smoke-m4.test.ts` 端到端全链路 | 未开始 |
| T-GAP-4 | `docs/audit/M4-final-audit-report.md` | 未开始 |
| — | 打 tag `M3` | **待人工确认后打** |

### T48 注意点（写 smoke-m4 时踩过的坑）

- `POST /api/trades` 返回的是 `data.trade_id`（不是 `data.trade.id`）
- `POST /api/admin/backup` 在 DuckDB 数据量大时会超过 vitest 默认 15s timeout，需要显式给 timeout 或先设 `BACKUP_DIR` 到临时目录
- smoke-m2 用端口 51101、m3 用 51102，是绕过 EADDRINUSE 的 workaround；建议 smoke-m4 用 `app.inject()` 不 listen 端口（照抄 `tests/integration/_helpers.ts` 的 `createTestApp()`）

---

## 已知限制 / 技术债

1. **`(ConfigStore as any)._instance = null`** — 10+ 个测试文件用此 hack。建议给 ConfigStore 加 `_testReset()`（JSDoc 标注仅测试用）
2. **smoke-m2/m3 端口 workaround** — 见上
3. **DuckDB 锁竞争** — `queryDuckDB` 有 5 次重试，CI 偶发间歇失败（依赖环境负载）
4. **F8 前端指标客户端计算 = PARTIAL** — AGENTS.md 硬性禁止前端 import core，指标统一后端算。是设计意图不是缺陷，但 SDD §12.5 写的是"客户端实时计算"，审计里已标注
5. **`assetStat.ts` 的 `getTotalDividends`** — `bonus/transfer` 的 `price*quantity` 语义存疑（送转股 price=0 不计入分红总额，但送转带来的市值增量当前未计入 `actual_yield`，可能低估 actual 口径）
6. **vitest 跑得慢** — backend 215 tests 约 120s，主要是 `runAllChecks` 真连 DuckDB（admin/validator/smoke 系列各 2-5s）。CI 也在跑这些，注意超时
7. **`GH_TOKEN` 有 repo scope 可绕过 branch protection** — HANDOVER 遗留提醒，token 建议人工撤销或降权

---

## 关键文件路径

```
docs/
  HANDOVER.md                      — 本文件
  client/
    Requirements_simplified.md     — 业务规则权威源
    PRD.md                         — 用户体验权威源
    SDD.md                         — 工程落地权威源
    MVP_code_implementation_plan.md — v2 任务拆解（T1-T48 + T-GAP-1~4）
  audit/
    M3-audit-report.md             — Phase 3 审计（已 PASS）
  coding-standards.md
  deploy.md

apps/backend/src/
  routes/
    trade.ts        — 交易 CRUD + 分页/筛选/软删除/PATCH + /api/positions(enrich)
    review.ts       — 复盘统计（胜率/盈亏比）+ 复盘列表
    assetStat.ts    — 双口径快照查询（latest/history）
    admin.ts        — 手动触发（校验/信号/备份/补跑）+ 角色管理
    plugin.ts       — 插件列表/参数/启停
    watch.ts        — watch/candidate CRUD + promote 迁移
    kline.ts        — K线 + MACD/RSI/MA + 信号
  services/
    quoteRerun.ts   — G3a 行情补跑降级链（新建）
    positionCalculator.ts — 持仓聚合 + calcClosedTradePnLs（胜率数据源）
    validator.ts    — C1-C12
    pluginEngine.ts — 沙盒 + 50ms 超时
    scheduler.ts    — 4 段 cron + runDatacheckWithRerun
    assetStat.ts    — 双口径快照写入
    backup.ts       — 双库热备份
  config/configStore.ts — DDL + 单例 + 幂等补列

apps/frontend/src/
  pages/
    _shared.tsx     — Navbar + MobileTabBar + useIsMobile + 共享样式
    Dashboard.tsx   — 总资产卡(双口径) + 饼图 + 持仓明细
    Review.tsx      — 双口径 Tab + 收益曲线 + 胜率/盈亏比 + 4字段编辑
    Settings.tsx    — 插件管理（新建）
    Admin.tsx       — 四色校验 + 详情展开 + 手动触发 + 日志
    Kline.tsx       — 主图+副图（移动端 Tab）+ 信号 overlay
    TradeInput.tsx / Signals.tsx / StockScan.tsx / Login.tsx
```

---

## 下一步建议

1. **打 tag `M3`** — 审计报告已 PASS，等人工 review
2. **T43 部署实测** — `sudo bash deploy/deploy.sh` 在服务器上跑一遍，重点验 tdx2db init + systemd timer + Caddy
3. **T46 Requirements §10.1 验收走查** — 逐条跑，产出 PASS 记录
4. **T48 smoke-m4** — 参考 `tests/integration/_helpers.ts` 的 `createTestApp()`，避免端口冲突
5. **T-GAP-4 最终审计 + tag M4**

## 环境注意

- `.env.local` 的 `SQLITE_DB_PATH` 指向生产路径，测试自动降级到 `/tmp`
- DuckDB：`data/quotes.duckdb`（本地，~空）vs 生产 783MB
- `npm test` = backend（`--pool=forks --poolOptions.forks.singleFork=true`，防 DuckDB 锁竞争）+ core
- 端口段：Fastify 8080 / Vite 5173 / smoke-m1 51100 / 预留 51200-51999