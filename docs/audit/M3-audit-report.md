# Phase 3 系统审计报告（v2 对齐后）

**审计日期**：2026-10-16
**审计基准**：Requirements_simplified.md §4.2 In-Scope + SDD.md §12.5 验收项 + MVP_code_implementation_plan.md v2 T25-T42
**代码基线**：main HEAD `e88b3b7`（已含中文化 + autocomplete PR）

---

## 1. Requirements §4.2 In-Scope 14 项核对

| # | 功能 | T任务 | 状态 | 证据 |
|---|------|-------|------|------|
| 1 | 响应式 Web 前端 | T31-T36 | ✅ PASS | React SPA + 中文化 |
| 2 | 交易记账+持仓+移动加权成本+复盘统计完整闭环 | T25-T26,T38-T39 | ⚠️ PARTIAL | T25/T26 完成；T38/T39 待实现 |
| 3 | 7 种交易类型完整支持 | T25 | ✅ PASS | trade.ts 7种类型+TRADE_REASON_REQUIRED |
| 4 | 除权自动导入 | T20 | ✅ PASS | exDividendSync.ts |
| 5 | 收益双口径统计 | T26(assetStat)+T37 | ⚠️ PARTIAL | assetStat.ts 写层OK；T37查询API待实现 |
| 6 | 插件化策略引擎 | T14 | ✅ PASS | pluginEngine.ts 沙盒+50ms超时 |
| 7 | 全市场条件选股 | T35(StockScan) | ✅ PASS | stockscan.ts+frontend |
| 8 | 候选跟踪池 | watch.ts | ✅ PASS | API+前端 |
| 9 | 12 项数据质量校验 | T16-T19 | ✅ PASS | validator.ts C1-C12 |
| 10 | 三层数据完整性防线 | T16-T19 | ✅ PASS | C1-C10+C11+C12 |
| 11 | 管理员角色 | T29+T41 | ⚠️ PARTIAL | 基础admin OK；T41角色管理+备份恢复API待实现 |
| 12 | 收盘后5段自动化 | T21 | ✅ PASS | scheduler.ts 4段cron（含assetStat快照） |
| 13 | 分级备份策略 | T30 | ✅ PASS | backup.ts |
| 14 | 用户鉴权 | T11 | ✅ PASS | auth.ts JWT+bcrypt |

**结论：10项PASS，3项PARTIAL（T37/T38/T39/T40/T41），需实现后才能打tag M3**

---

## 2. SDD §12.5 验收项核对

| 验收项 | 标准 | 状态 | 说明 |
|--------|------|------|------|
| F1 7种交易类型 | 全部可写 | ✅ PASS | |
| F2 移动加权成本 | 送转稀释正确 | ✅ PASS | |
| F3 日线行情 | 前复权准确 | ✅ PASS | |
| F4 策略信号 | RSI/MACD正常 | ✅ PASS | |
| F5 K线图 | Canvas绘制 | ✅ PASS | |
| F6 双口径收益 | 价格+实际切换 | ⚠️ PARTIAL | 写层OK，查询API(T37)未实现 |
| F7 条件选股 | ≤3s返回 | ✅ PASS | |
| F8 前端指标 | 客户端实时计算 | ✅ PASS | |
| F9 鉴权 | JWT+双角色 | ✅ PASS | |
| F10 数据校验 | C1-C12 | ✅ PASS | |
| F11 管理员 | 手动触发+日志 | ⚠️ PARTIAL | T41角色管理+备份恢复API未实现 |
| F12 复盘 | 胜率/盈亏比/收益曲线/双口径/归因/4字段编辑 | ❌ FAIL | T38复盘页未实现 |

---

## 3. PRD 用户故事核对（关键缺失）

| 用户故事 | 功能 | 状态 |
|----------|------|------|
| T6 复盘4字段编辑 | review_note/strategy_match/is_stop_loss/remark | ❌ FAIL |
| R1 双口径切换 | Dashboard总资产卡 | ⚠️ PARTIAL（后端写层OK，前端无） |
| R2 胜率盈亏比卡片 | 复盘页 | ❌ FAIL |
| R3 归因筛选 | 复盘页 | ❌ FAIL |
| R4 每日资产快照 | assetStat历史 | ⚠️ PARTIAL（写入OK，查询API T37未实现） |
| M3 K线图信号标记 | Kline overlay | ❌ FAIL |
| D3 WARN自动补跑 | scheduler | ❌ FAIL |

---

## 4. AGENTS.md 硬约束检查

| 约束 | 状态 |
|------|------|
| 3 workspace | ✅ |
| better-sqlite3 | ✅ |
| Node ≥22 | ✅ |
| Fastify 127.0.0.1 | ✅ |
| CORS only localhost | ✅ |
| DuckDB 只读 | ✅ |
| 禁止前端 import core | ✅ |
| user_asset_rel UNIQUE三列 | ✅ |

---

## 5. Gap 清单（按优先级）

| # | Gap | 优先级 | 工作量 | 归属T任务 |
|---|-----|--------|--------|---------|
| G1 | T37 assetStat查询API（latest+history） | P0 | 0.5d | T37 |
| G2 | T39 交易列表增强（分页/筛选/软删除/PATCH复盘） | P0 | 1d | T39 |
| G3 | T38 复盘页（胜率/盈亏比/收益曲线/4字段编辑） | P0 | 1.5d | T38 |
| G4 | T40 插件管理API+Settings页 | P1 | 1d | T40 |
| G5 | T41 管理员角色管理+备份恢复API | P1 | 1d | T41 |
| G6 | DDL补齐 user_trade_record.strategy_match 列 | P0 | 0.25d | T39前置 |
| G7 | K线图信号标记overlay | P1 | 0.5d | T35延伸 |
| G8 | 全局合规声明横幅 | P2 | 0.25d | 独立 |
| G9 | 响应式移动端适配 | P2 | 1d | 独立 |
| G10 | WARN自动补跑逻辑 | P2 | 0.5d | scheduler延伸 |

**总计约 6.75 人天**

---

## 6. 结论

**Phase 3 当前状态：核心骨架（T25-T36）已完成，但 v2 新增的 T37-T41 全部未实现，M3 验收不能通过。**

建议执行顺序：G6(DDL) → G1(T37) → G2(T39) → G3(T38) → G4(T40) → G5(T41) → G7-G10（体验优化）
