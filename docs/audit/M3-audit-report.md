# Phase 3 系统审计报告（v2 复核更新）

**审计日期**：2026-10-16（初版）/ 2026-10-16 复核（G1-G10 全部闭合后）
**审计基准**：Requirements_simplified.md §4.2 In-Scope + SDD.md §12.5 验收项 + MVP_code_implementation_plan.md v2 T25-T42
**代码基线**：main（含 T37-T41 + G1-G10 闭合 commit）
**测试基线**：backend 25 files / 215 tests + core 7 files / 24 tests = **239 tests 全 PASS**

> ⚠️ 本次复核同时修复了一个测试基础设施 bug：`npm test` 的 core 段此前静默跑 0 个用例
> （`packages/core/vitest.config.ts` 缺 `root`，`include` 相对仓库根解析）。已修复并同步 CI。

---

## 1. Requirements §4.2 In-Scope 14 项核对

| # | 功能 | T任务 | 状态 | 证据 |
|---|------|-------|------|------|
| 1 | 响应式 Web 前端 | T31-T36,G10 | ✅ PASS | `useIsMobile` + 移动端底部 TabBar（持仓/K线/选股/复盘/设置）+ K线副图 Tab 切换 |
| 2 | 交易记账+持仓+移动加权成本+复盘统计完整闭环 | T25-T26,T38-T39,G6a | ✅ PASS | Review.tsx（双口径 Tab + 胜率/盈亏比 + 收益曲线 + 4字段编辑 + 软删除）+ positionCalculator `calcClosedTradePnLs` |
| 3 | 7 种交易类型完整支持 | T25 | ✅ PASS | trade.ts 7种类型 + TRADE_REASON_REQUIRED 前后端双重校验 |
| 4 | 除权自动导入 | T20 | ✅ PASS | exDividendSync.ts（17:03 cron，ON CONFLICT 幂等） |
| 5 | 收益双口径统计 | T26,T37,G7b | ✅ PASS | assetStat.ts 写层 → assetStat.ts 查询路由 → Dashboard 总资产卡双口径切换 → Review 页曲线切换，全链路零断点 |
| 6 | 插件化策略引擎 | T14 | ✅ PASS | pluginEngine.ts 沙盒（禁 global/process/require）+ 50ms Promise.race 硬超时 |
| 7 | 全市场条件选股 | T35 | ✅ PASS | stockscan.ts + StockScan.tsx |
| 8 | 候选跟踪池 | watch.ts,G4 | ✅ PASS | candidate CRUD + `POST /api/candidate/:asset/promote` 迁移到自选（幂等 + 软删恢复） |
| 9 | 12 项数据质量校验 | T16-T19 | ✅ PASS | validator.ts C1-C12 + Admin 四色仪表盘（可点击展开 detail） |
| 10 | 三层数据完整性防线 | T16-T19,G3a | ✅ PASS | C1-C10 内部 + C11 Tushare + C12 东财；WARN/ERROR 自动补跑行情 |
| 11 | 管理员角色 | T29+T41 | ✅ PASS | users 列表 / role 变更（禁止自降）/ 手动备份 / 备份列表 / 补跑触发 |
| 12 | 收盘后5段自动化 | T21,G3a | ✅ PASS | scheduler.ts 4 段 cron（17:01 校验+补跑 / 17:02 信号+快照 / 17:03 除权 / 17:05 备份） |
| 13 | 分级备份策略 | T30 | ✅ PASS | backup.ts 双库热备份 + 3 天保留 + OCI rclone 可选 |
| 14 | 用户鉴权 | T11 | ✅ PASS | JWT + bcrypt(12) + onRequest hook 统一拦截 |

**结论：14/14 PASS（原 10 PASS + 3 PARTIAL + 1 待定现已全部闭合）**

---

## 2. SDD §12.5 验收项核对

| 验收项 | 标准 | 状态 | 说明 |
|--------|------|------|------|
| F1 7种交易类型 | 全部可写 | ✅ PASS | buy/sell/reduce/clear/dividend/bonus/transfer |
| F2 移动加权成本 | 送转稀释正确 | ✅ PASS | core golden 数据集 24 tests 零误差 |
| F3 日线行情 | 前复权准确 | ✅ PASS | v_stock_qfq 只读，DuckDB 硬约束遵守 |
| F4 策略信号 | RSI/MACD正常 | ✅ PASS | 后端算好落 user_strategy_signal |
| F5 K线图 | Canvas绘制 | ✅ PASS | 主图 + MA + MACD/RSI 副图 + 信号 overlay（▲买入/▼卖出） |
| F6 双口径收益 | 价格+实际切换 | ✅ PASS | Dashboard 总资产卡 + Review 页曲线，双处可切 |
| F7 条件选股 | ≤3s返回 | ✅ PASS | 结果 ≤100，耗时前端展示 |
| F8 前端指标 | 客户端实时计算 | ⚠️ PARTIAL | 后端算好返回（AGENTS.md 禁止前端 import core，属设计意图），非浏览器本地计算 |
| F9 鉴权 | JWT+双角色 | ✅ PASS | |
| F10 数据校验 | C1-C12 | ✅ PASS | 四色仪表盘 + WARN 自动补跑 |
| F11 管理员 | 手动触发+日志 | ✅ PASS | 校验/信号/备份/补跑 4 个手动触发 + system_log 分页筛选 |
| F12 复盘 | 胜率/盈亏比/收益曲线/双口径/归因/4字段编辑 | ✅ PASS | 全部实现（本次补齐双口径 Tab + 月/季/年曲线） |

---

## 3. PRD 用户故事核对

| 用户故事 | 功能 | 状态 | 证据 |
|----------|------|------|------|
| T6 复盘4字段编辑 | review_summary/strategy_match/is_stop_loss/remark | ✅ PASS | G6a 补齐 `strategy_match` DDL 列（三态 0/1/NULL），PATCH 白名单 + 前端三态按钮 |
| R1 双口径切换 | 总资产卡 | ✅ PASS | Dashboard.tsx 口径切换按钮组 |
| R2 胜率盈亏比卡片 | 复盘页 | ✅ PASS | `GET /api/review/stats` 按移动加权成本算平仓盈亏，胜率=盈利笔数/平仓笔数，盈亏比=平均盈利/平均亏损 |
| R3 归因筛选 | 复盘页 | ✅ PASS | trade_type / strategy_match / is_stop_loss / system_followed / 日期范围 |
| R4 每日资产快照 | asset-stat 历史 | ✅ PASS | Review 页 SVG 收益曲线，月度/季度/年度分桶 |
| M3 K线图信号标记 | Kline overlay | ✅ PASS | Kline.tsx ▲绿/▼红 + plugin_id 标注 |
| D3 WARN自动补跑 | scheduler | ✅ PASS | `quoteRerun.ts` 降级链 systemd-run → systemctl → exec → SKIP；补跑后二次校验 |
| D1 12项校验仪表盘 | 四色 + 详情展开 | ✅ PASS | G8b 点击卡片展开 detail |
| G3 K线副图 | MACD/RSI | ✅ PASS | 桌面并排，移动端 Tab 切换 |

---

## 4. AGENTS.md 硬约束检查

| 约束 | 状态 | 验证方式 |
|------|------|----------|
| 3 workspace（packages/core + apps/backend + apps/frontend） | ✅ | `npm workspaces list` |
| 零新增 workspace | ✅ | 无新增 |
| better-sqlite3 同步 API + WAL/busy_timeout/foreign_keys | ✅ | configStore.test.ts |
| Node ≥22，禁止 Bun | ✅ | package.json engines |
| Fastify 仅监听 127.0.0.1 | ✅ | server.ts + deploy unit |
| CORS 仅 127.0.0.1 | ✅ | |
| DuckDB 只读，写入仅 tdx2db | ✅ | 新增 `batchGetLatestClose` 仅 SELECT；补跑走外部 Go 二进制 |
| 批量查询 1 次 IN 查询，禁止逐标的循环 | ✅ | `/api/positions` 用 `batchGetLatestClose`（ROW_NUMBER 窗口函数，1 次查询） |
| DuckDB 按需 open/close，不常驻 | ✅ | queryDuckDB 封装 |
| 插件 50ms 硬超时 + 沙盒禁 global/process/require | ✅ | pluginEngine.test.ts |
| user_asset_rel UNIQUE 三列 | ✅ | watchPromote.test.ts 验证 watch/candidate 独立共存 |
| 全部业务记录软删除，禁止物理删除 | ✅ | is_deleted 列 + DELETE 路由 + restore 路由 |
| 禁止前端 import packages/core | ✅ | 前端只 fetch /api/* |
| DDL 用 CREATE TABLE IF NOT EXISTS，无 schema_migrations | ✅ | 存量库用 ALTER ADD COLUMN 幂等补列，非迁移框架 |
| SQL 全部预编译参数化 | ✅ | 无字符串拼接用户输入 |
| Token/凭证不落明文日志 | ✅ | |
| HOLDING_INSUFFICIENT 业务错误码 | ✅ | trade.test.ts |
| Out-Scope 未偷跑 | ✅ | 无分钟K / 无小程序 / 无云函数 / 无交易下单 / 无 VM2 |

---

## 5. 原 Gap 清单闭合情况

| # | Gap | 优先级 | 状态 | 闭合方式 |
|---|-----|--------|------|----------|
| G1 | T37 assetStat 查询API（latest+history） | P0 | ✅ 已闭合 | `routes/assetStat.ts`（既有 commit 1f99502） |
| G2 | T39 交易列表增强（分页/筛选/软删除/PATCH） | P0 | ✅ 已闭合 | `routes/trade.ts` + `review.test.ts` |
| G3 | T38 复盘页 | P0 | ✅ 已闭合 | Review.tsx 本次补齐双口径 Tab + 收益曲线 |
| G4 | T40 插件管理API + Settings页 | P1 | ✅ 已闭合 | `routes/plugin.ts` + 新增 `pages/Settings.tsx` |
| G5 | T41 管理员角色管理 + 备份 API | P1 | ✅ 已闭合 | `routes/admin.ts`（既有 commit 00a3349） |
| G6 | DDL 补 `strategy_match` 列 | P0 | ✅ 已闭合 | 本次：`DDL_SQL` + `_ensureTradeRecordReviewColumns()` ALTER 幂等补列 |
| G7 | K线图信号标记 overlay | P1 | ✅ 已闭合 | 既有 commit 6c2c8b6 |
| G8 | 全局合规声明 + 校验仪表盘 | P2 | ✅ 已闭合 | 既有 6c2c8b6 + 本次 G8b 详情展开 |
| G9 | 响应式移动端适配 | P2 | ✅ 已闭合 | 本次：`useIsMobile` + MobileTabBar + K线副图 Tab + 画布自适应宽度 |
| G10 | WARN 自动补跑 | P2 | ✅ 已闭合 | 本次：`services/quoteRerun.ts` + `runDatacheckWithRerun` + `POST /api/admin/rerun-quotes` |

**10/10 Gap 闭合**

---

## 6. 本次修复的附带缺陷（非 Gap 清单内）

| # | 缺陷 | 影响 | 修复 |
|---|------|------|------|
| B1 | `review.ts` 胜率统计用 `SUM(CASE WHEN price>0)`，等价于"有卖出就算盈利" | 胜率恒等于 100%，PRD §5.5 完全失真 | 改用 `calcClosedTradePnLs` 按移动加权成本算每笔平仓已实现盈亏 |
| B2 | 盈亏比用 `winRate/50` 估算 | 纯占位公式 | 改为 平均盈利 / \|平均亏损\|，无亏损时返回 null（前端显示 `--`，不用 Infinity） |
| B3 | `review.ts` / `trade.ts` 的 `has_review` 筛选把 `system_followed` 当"已复盘" | 归因统计口径错误 | 改为 `strategy_match`，与 Requirements §5.2 的"是否符合交易系统"对齐 |
| B4 | Dashboard 持仓表读 `p.qty`（API 返回 `totalQuantity`） | 数量列永远显示 undefined | 修正字段名并补齐 T33 完整列（现价/市值/浮盈/收益率/仓位占比） |
| B5 | `Admin.tsx` 日志表读 `res.data.data.rows`（API 返回数组） | 系统日志表永远空白、分页数恒 0 | 改为读 `res.data.data` + `res.data.pagination.total` |
| B6 | `_shared.tsx` Navbar 缺一个 `</div>` | **TS 编译失败**，`npm run build -w @invest/frontend` 挂掉 | 补齐标签并重构为响应式导航 |
| B7 | `packages/core/vitest.config.ts` 缺 `root` | `npm test` 的 core 段静默跑 0 个用例（README 声称 24 tests） | 加 `root: __dirname`，同步 CI 命令 |
| B8 | 5 处 TS 类型错误（plugin.username / DailyKline 未导出 / PluginSignal.label / CheckSummary.message） | `tsc --noEmit` 不干净 | 全部修复，后端 typecheck 现为 0 error |

---

## 7. 结论

**Phase 3（M3）：14/14 In-Scope PASS，F1-F12 验收项 11 PASS + 1 PARTIAL（F8 属设计意图），10/10 Gap 闭合，239 tests 全绿。**

剩余 PARTIAL 说明：
- **F8 前端指标客户端实时计算**：SDD/AGENTS.md 明确禁止前端 import `@invest/core`，指标统一后端算好返回。这是架构硬约束导致的**有意偏离**，非缺陷。若后续 V2 要做浏览器端实时指标，需要先修改 AGENTS.md 硬约束。

**待 Phase 4（T43-T48 + T-GAP-4）：**
- systemd/Caddy 部署实测（deploy 脚本已就位，未在真机跑）
- Requirements §10.1 正式验收走查
- `smoke-m4.test.ts` 端到端全链路验收
- M4 最终审计报告