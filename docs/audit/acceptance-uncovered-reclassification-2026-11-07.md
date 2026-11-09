# 33 条「未覆盖」再分类：未实现 vs 环境限制（2026-11-07）

> **续篇**：`docs/audit/acceptance-scenario-traceability-2026-11-06.md`（75 条场景溯源表）。
> **本轮不改判**：41 通过 / 1 失败（J3）/ 33 未覆盖 的原始结论原样保留；本文只把「33 未覆盖」再拆成两类。
> **证据基线**：`origin/main` @ `dbab762`（M4 参数寻优合并后）。本文引用的文件与 `origin/main` 逐一比对无差异；F 域复测补充的 `docs/audit/acceptance-retest-2026-11-07.md` 仅作线索，不作为证据。
> **判定方式**：静态代码检索（`grep` / `Read`），未跑测试、未启服务、未碰 `data/`。

## 1. 结论摘要

| 类别 | 条数 | 场景编号 |
|---|---|---|
| **未实现** | **6** | F1、F2、F3、F4、F6、I8 |
| **环境限制** | **27** | A5、B4、B5、B6、C1、C2、C6、C7、D4、E4、F5、G3、G6、H1、H2、H4、H5、I5、I9、K2、K3、K5、K7、K8、L2、L3、L4 |
| 合计 | 33 | — |

**对验收结论的影响（一句话）**：原先的「33 条未覆盖」应改写为「**6 条未实现 + 27 条未测**」；这 6 条不是「没测到」，而是产品/后端压根没有可验收的行为。

**口径说明**：判为「未实现」不等于该场景零代码。其中 F1/F2/F3/F4/F6 均存在部分脚手架（DDL 列、路由、页面骨架或按钮），但验收要求的关键行为缺失；本文在每行「已存在」与「缺失」两栏分别列明，避免把「有壳」误读成「已实现」。

---

## 2. 未实现（6 条）

### 2.1 逐条证据

| 编号 | 场景（溯源表原文摘要） | 已存在的代码 | 缺失的关键行为与证据 | 结论 |
|---|---|---|---|---|
| **F1** | 信号列表分级：强/中/弱徽章、非当日置灰 | `config/configStore.ts:187` 建了 `grade TEXT CHECK (... 'strong','medium','weak')`；`pluginEngine.ts:190` 只产出 `strength`（0–1 浮点）；`Signals.tsx:89/619` 仅按 `strength` 画进度条 | **① 分级**：`grade` 列在全仓业务代码**零写入、零读取**（`grep grade apps/backend/src` 仅命中 `configStore.ts` 的 DDL 与迁移列，`signalService.ts:89` 的 INSERT 列清单不含 `grade`）。无阈值规则、无 `strength→grade` 映射、API 无 `grade` 过滤、前端无强/中/弱 tab 或徽章。<br>**② 过期置灰**：`Signals.tsx:630` 注释明写「标灰由后端 T134 的 `expires_at` 承担」，但 `expires_at` 同样只建列（`configStore.ts:188`、迁移 `:497`），**全仓无读写**，前端也没有置灰分支。<br>**③ 计划状态**：`code_implementation_plan_v3.md:81` 把 T134 标 ✅、`:95` 把 T149（分级/过期 UI）标 ⬜ —— 实际是「DDL 完成、行为未做」。 | **未实现**（有列无逻辑） |
| **F2** | 采纳 / 忽略 / 关联交易 | `routes/signal.ts:196-215` 有 `adopt`/`ignore`；`:217-249` 有 `PATCH /api/signal/:id/link-trade`（校验归属 + 标的一致）；`Signals.tsx:630-652` 有采纳/忽略/关联按钮 | **关联链路只写不读、未闭环**：<br>① 前端 `Signals.tsx:175-187` 用 `window.prompt` 手输 `user_trade_record.id`，没有「选择已有交易」或「跳转交易录入」入口；<br>② 列表/详情**不展示** `linked_trade_id` 状态，关联成功后除一行一闪而过的 `actMsg` 外无任何可见结果（`linked_trade_id` 全仓仅出现在 `signal.ts` 与 `configStore.ts`）；<br>③ 交易录入侧没有反向自动关联逻辑（`routes/trade.ts` 无 `linked_trade_id` 写入）；<br>④ 计划 `code_implementation_plan_v3.md:185` 对 T141 的验收项写明「关联后可跳转复盘；采纳率与量化结果分开呈现」，两项均无实现。<br>（采纳/忽略本身可用，故本条是「关联链路未实现」而非全条为零。） | **未实现**（关联部分只写不读） |
| **F3** | 今日 Top 5 摘要与优先级 | `Dashboard.tsx:491` 拉 `/signal?page_size=5`，`:940` 标题为「最新信号」 | 只取**最新 5 条**，没有「今日」日期过滤、没有按 `grade/strength` 排序的优先级、没有 Top 5 摘要卡；`Signals.tsx` 无任何摘要区（`grep Top/摘要/今日` 无命中）。计划 T149（`code_implementation_plan_v3.md:95/200`）标 ⬜。 | **未实现**（仅「最近 5 条」近似物） |
| **F4** | 有效性六项：T+1/5/10、基准、扣费、胜率、采纳率、分组/导出 | `pages/StrategyEffectiveness.tsx:13` 有 T+1/T+5/T+10；`:158-171` 表格渲染；`routes/strategy.ts` 提供单信号 outcome | `StrategyEffectiveness.tsx:16` 注释自认「成本扣减与基准对比（INV-S5-*）在评估口径层（T135 后端）扩展」，但 `grep T135/benchmark/基准/扣费/winRate/adoptionRate apps/backend/src` **无业务实现**。缺：基准对比、费用扣减后的净收益、胜率、采纳率与量化结果分列、按策略/标的/周期分组下钻、CSV 导出（PRD_v3 §4.3 `:411` 要求导出）。计划 T135 标 ✅、T150 标 ⬜（`code_implementation_plan_v3.md:82/96`），与代码不一致。 | **未实现**（只有原始 outcome） |
| **F6** | 冷静期与跨境提示 | `configStore.ts:193` 建了 `cooldown_until`；`:502` 迁移列；`broker/*` 有跨境资产的内部类型 | `cooldown_until` **全仓零读写**（`grep cooldown apps/backend/src` 仅 `configStore.ts` 两处）；`StrategyConfig.tsx` 无任何跨境提示/适用品种提示（`grep 跨境` 无命中）；`snapshot_json` 同样只建列（`:189`、迁移 `:498`）无写入。缺：冷静期计算与到期提示、跨境不可用提示、信号触发快照落库。 | **未实现**（有列无逻辑） |
| **I8** | 差异明细：筛选 / 导出 / 标记已记录 | `pages/BrokerReconcile.tsx` 有分类筛选与「标记已记录/人工处理」；后端 `routes/brokerReconcile.ts` 有匹配接口 | **导出完全缺失**：`grep 导出/csv/download/text\/csv apps/frontend/src` 无命中；后端无 `Content-Disposition`/CSV 端点。PRD_v3 §3.2.1 `:226` 明写「可筛选 + 可导出」，`:411` 另列「导出 CSV ✅」。缺：导出按钮 + CSV 生成（字段顺序需与页面表格一致）。 | **未实现**（导出部分为零） |

### 2.2 编号口径提醒

用户口中的「**F6 关联链路**」在本溯源表的编号体系里对应 **F2**（F6 在本表是「冷静期与跨境提示」）。本文按表内编号判定：**F2 的关联链路未闭环**、**F6 的冷静期/跨境未实现**；两条都落在「未实现」，所以无论按哪套编号，这四条交叉结论均成立。

---

## 3. 环境限制（27 条）

> 判定标准：**功能/接口/页面已存在**，但受数据前置、写库范围、浏览器工具能力、平台能力或传输层限制，未能在 2026-11-06 验收中执行。

### 3.1 数据/样本前置（8 条）

| 编号 | 场景 | 实现证据 | 缺什么 → 复测条件 |
|---|---|---|---|
| A5 | 登录过期跳登录并保留原路径 | `App.tsx` 订阅会话过期并带 `from` 跳 `/login`；`components/SessionExpiredBanner.tsx`；`api/client.ts` 401 刷新后广播 | 缺「token 到期后首个请求」的真实条件。**现在可复测**：把 JWT 有效期临时调短或手改 localStorage token 后触发任意请求。 |
| B4 | 新用户全空态 | `components/EmptyState.tsx`，Dashboard/Candidates/Review 等页均接入 | 缺「全新用户 + 空业务库」。**现在可复测**：用独立临时 `SQLITE_DB_PATH` 起服务并新注册用户。 |
| C6 | 除权自动导入分红/送股 | `routes/exDividend.ts` 按 `raw_gbbq` category=1 生成 `dividend/bonus/transfer`，幂等键 `(user, asset, type, date)` | 缺「持仓标的真实除权事件」。**现在可复测**：在临时库导入持有标的后手动触发除权补跑。 |
| F5 | 策略配置读写（开关/参数/品种） | `StrategyConfig.tsx` 启停开关 + `PluginParamForm`；`signalService.ts:resolveSignalSymbols` 排除现金类 | 缺「有信号可观察」的样本。**现在可复测**：跑一次插件生成后用真实信号查看配置生效。<br>**残留缺口**：PRD §4.1 的「适用品种」五档（全部/仅股票/仅 ETF/仅跨境/排除跨境）未实装，当前只有现金排除；这属 F5 内部的小缺口，不影响「配置读写」主判定。 |
| G3 | 选股上限语义（候选/命中/返回） | `routes/stockscan.ts` 返回 `totalMatched` 等分列字段；前端 `StockScan.tsx` 已按新语义展示 | 缺「真库规模」样本（迷你库 104 只无法验证上限语义）。**已具备**：真库 5,561 只；复测已通过。 |
| I5 | 买入资金校验三态 | `services/broker/brokerFundCheck.ts:35/84/103/139` 输出 `applicable/passed/notApplicable` | 缺一对「券商流水 vs 持仓」的真实样本。**现在可复测**：用已有券商文件 + 对应持仓做核对。 |
| I9 | 一键补录差距交易 | `BrokerReconcile.tsx` 补录入口 + `/api/ex-dividend/backfill` 单事务写入 | 缺「非成交事件（分红/送转/费用）」的真实差距行。**现在可复测**：需一笔真实非成交事件或手工构造临时库样本。 |
| K2 | 日志脱敏收窄 | `services/logger.ts` 的 `maskSensitive`（金额/用户标识/令牌）；PR #82 收敛过范围 | 缺含敏感字段的真实日志样本。**现在可复测**：写一条含 token/金额的系统日志后查管理员日志页。 |

### 3.2 写库范围（9 条）

> 2026-11-06 验收为保护真实 `data/business.db`，未做写操作；以下功能均已实现。

| 编号 | 场景 | 实现证据 | 缺什么 → 复测条件 |
|---|---|---|---|
| B5 | 软删除后列表不可见、可恢复/审计 | `routes/asset.ts` 查询统一 `is_deleted = 0`；`routes/trade.ts` 重新买入时恢复旧关联；`system_log` 留痕 | 缺「被软删的记录」。**现在可复测**：临时库写入后软删，再看列表与日志。 |
| B6 | 写操作后跨页刷新一致 | `Dashboard.tsx` 并行拉取 + `refreshKey` 失效重取；各页 `useEffect` 依赖刷新 | 缺写操作序列。**现在可复测**：临时库内录入交易→持仓→复盘逐页刷新。 |
| C1 | 七类交易录入 | `routes/trade.ts` 的七类枚举 + `TradeTypeTabs.tsx` 七个页签 | 缺写入。**现在可复测**：临时库逐类录入。 |
| C2 | 除权/分红/送转表单 | `pages/TradeInput.tsx` 的 `AUTO_IMPORT` 类型表单（分红/送股/转增字段） | 缺写入。**现在可复测**（同上）。 |
| C7 | 永久留痕（软删/恢复）+ 复盘字段 | 软删除 `is_deleted`；`routes/trade.ts:552` 起更新复盘字段并写 `system_log`；`AdminLogPanel` 可查 | 缺写入。**现在可复测**：临时库改复盘字段后查日志。<br>**粒度说明**：日志只记 `trade_id` 与动作，不含字段旧值/新值，属可接受的留痕粒度，不构成「未实现」。 |
| H4 | 同券商多文件全量勾选 | `BrokerImport.tsx` 全局全选 + 复用 `/api/broker-import/confirm-batch`（PR #83） | 缺「同一券商 5 个文件」样本。**现在可复测**：准备 5 份同券商流水。 |
| H5 | 整页待确认批量确认 | `BrokerImport.tsx` 逐页/整页确认分支 + 未知标的待确认流程 | 缺多页待确认数据。**现在可复测**：构造跨页未知标的。 |
| K5 | 恢复备份危险区 | `components/AdminBackupPanel.tsx:370` 手输文件名 + 二次确认；后端 `/api/admin/backup/restore` | 缺备份文件与独立测试库。**现在可复测**：仅在小体积临时库上做恢复，勿在业务库测试。 |
| K7 | 系统日志筛选 + 分页 | `components/AdminLogPanel.tsx:104-179` 日期/类型/level 三筛选 + `page/page_size`；后端支持 `log_date BETWEEN` | 缺足量日志行。**现在可复测**：临时库写入 > 20 条日志后翻页。 |

### 3.3 浏览器工具能力（5 条）

| 编号 | 场景 | 实现证据 | 缺什么 → 复测条件 |
|---|---|---|---|
| D4 | 复盘弹窗可点性/可编辑 | `pages/Review.tsx` 编辑入口 + `components/TradeFormModal.tsx` | 缺可脚本化的点击验证（验收工具无法可靠点开动态弹窗）。**现在可复测**：Playwright 点击「编辑」断言弹窗标题与保存按钮。 |
| E4 | 改 K 线参数零请求重算 | `components/KlineParamPanel.tsx` + `KlineChart` 本地重算 | 缺网络请求观测能力。**现在可复测**：DevTools/Playwright 监听网络，改参数后断言无新请求。 |
| G6 | 选股筛选组合 | `StockScan.tsx` 筛选器 + `routes/stockscan.ts` 组合过滤 | 缺真库规模下的组合筛选样本。**已具备**：真库可复测。 |
| H2 | 按钮文案用推断券商名 | `routes/brokerImport.ts` 文件名推断 + 前端回退手填；PR #93 | 缺「文件名含券商名」的真实文件。**现在可复测**：任一带券商名的流水文件。 |
| K8 | 5 个 tab 深链可分享 | `Admin.tsx:53-55/87-89` 用 `useSearchParams` 的 `?tab=check|trigger|backup|roles|logs` | 缺深链打开能力。**现在可复测**：直接访问 `/admin?tab=logs` 等 5 个 URL。 |

### 3.4 平台/传输层（5 条）

| 编号 | 场景 | 实现证据 | 缺什么 → 复测条件 |
|---|---|---|---|
| H1 | 上传前券商预填 | `routes/brokerImport.ts` 文件名/表头推断 `broker_code`，前端预填 | 缺真实流水文件。**现在可复测**：上传任一份含券商标识的文件。 |
| K3 | 手动触发四类任务 | `routes/admin.ts` 的校验/信号/除权/备份触发端点 + `AdminTriggerPanel.tsx` | 缺 `tdx2db` + systemd + 插件目录的平台条件。**现在可复测（有限）**：开发机可用临时插件目录触发校验/信号；除权/备份需真实数据。 |
| L2 | 17:00 定时链 + 行情降级 | `services/scheduler.ts` cron 四段 + `tdx2db` 等待/降级；`DISABLE_CRON` 开关 | 缺 systemd timer 与 17:00 时点。**现在可复测（有限）**：手工调用调度入口；完整链路需 Linux 部署环境。 |
| L3 | CORS 仅 127.0.0.1 / HTTPS 301 | `apps/backend/tests/http/cors.test.ts`、`https-se1.test.ts` 已存在（真实 `listen`） | 缺「真实 listen 的 HTTP 传输层」验收；`inject()` 无法覆盖。**现在可复测**：跑 `tests/http` 两文件（需 51200-51999 端口）。 |
| L4 | DuckDB 只读约束 | `db/duckdb.ts:131` 以 `access_mode: 'READ_ONLY'` 打开 | 无用户可见入口，只能在源码/单测层验证；验收工具无法从 UI 证明「未写入」。**复测条件**：读源码 + `duckdb` 只读属性断言（无需 UI）。 |

> 27 条总数按 3.1(8) + 3.2(9) + 3.3(5) + 3.4(5) 计。

### 3.5 环境限制汇总（按限制类型）

| 限制类型 | 条数 | 编号 |
|---|---|---|
| 数据/样本前置 | 8 | A5、B4、C6、F5、G3、I5、I9、K2 |
| 写库范围（保护真实库） | 9 | B5、B6、C1、C2、C7、H4、H5、K5、K7 |
| 浏览器工具能力 | 5 | D4、E4、G6、H2、K8 |
| 平台/传输层/源码可验 | 5 | H1、K3、L2、L3、L4 |
| **合计** | **27** | — |

---

## 4. F 域四条结论交叉复核

| 主张 | 复核结果 | 关键证据 |
|---|---|---|
| F1 分级未实现 | **成立** | `grade` 列仅 DDL（`configStore.ts:187`），业务代码零读写；INSERT 不含 `grade`（`signalService.ts:89`）；前端只有 `strength` 进度条（`SignalStrength.tsx`），无强/中/弱筛选。 |
| F3 今日 Top 5 未实现 | **成立** | Dashboard 仅取最新 5 条（`Dashboard.tsx:491/940`），无今日过滤、无优先级排序、无摘要卡；T149 标 ⬜。 |
| F4 有效性六项未实现 | **已不成立（2026-11-09 更新）** | Step A/B/C 已合入：扣费 `#136`/`#137`、基准 / 胜率 / 分组下钻 / CSV 导出 `#137`、采纳率 `#141`；代码位置 `services/strategyEffectiveness.ts`（`computeFees:179`、`summarizeHorizon:545`、`GROUP_BYS:35`、`buildEffectivenessCsv:991`、`summarizeAdoption:333`）。原判据（`StrategyEffectiveness.tsx:13/158-171`、注释 `:16`）已过期。 |
| 「关联链路」未实现 | **成立**（本表编号为 **F2**） | `PATCH /link-trade` 只写 `linked_trade_id`（`signal.ts:217-249`）；前端 prompt 手输（`Signals.tsx:175-187`），不展示、不跳转、无反向关联；T141 验收项「关联后可跳转复盘」未做。 |
| F6 冷静期/跨境（补充复核） | **成立** | `cooldown_until` 仅 DDL（`configStore.ts:193/502`），零读写；无跨境提示（`StrategyConfig.tsx` 无相关文案）。 |

**计划状态漂移（2026-11-09 部分关闭）**：`:82` 的 T135 已于 2026-11-09 置 ✅ 并写明六项落地 PR（Step A `#136` / Step B `#137` / Step C `#141`），本条漂移**已关闭**；`:81` 的 T134（过期/冷却/分级/快照四项只有 DDL）、`:87` 的 T141（只落地路由、缺跳转）、T149/T150 标记偏差**仍存在**，不在本轮范围。

> 注：§5 的合计口径（41/48、41/75 等）仍为 2026-11-07 基线，未因 F4 完成而重算。

---

## 5. 对验收结论的影响

1. **不能再说「33 条未覆盖」**：其中 **6 条（F1、F2、F3、F4、F6、I8）是产品缺口**，应计入「未实现」，不能与环境限制混为一谈。
2. **可测已测口径**：75 条中，已知结论为 41 通过 / 1 失败 / 6 未实现；对「已判定」的 48 条，通过率 **85.4%**（41/48）。剩余 27 条仍未验证。
3. **F 域实际交付度**：F 域 6 条中 5 条未实现（F1、F2、F3、F4、F6），F5 仅「配置读写」可用；即使信号样本补齐，F 域也无法整体判通过。
4. **非 F 域唯一真实缺口是 I8**（差异明细导出）；其余 13 条非 F 域未覆盖项均为环境限制，条件具备即可复测。
5. **对发布判断的影响**：若把 6 条未实现按「不通过」计，整体通过率为 **41/75 = 54.7%**；若不把未测计入分母，则为 **41/48 = 85.4%**。对外汇报必须显式区分这两个口径，避免用 41/75 掩盖 27 条未测、或用 85.4% 掩盖 6 条未实现。

---

## 6. 判定方法与可复现检索

```text
# 1) 确认四个生命周期列是否有业务读写（仅 DDL 命中 = 未实现）
grep -rn "grade|cooldown_until|expires_at|snapshot_json" apps/backend/src

# 2) 确认信号 INSERT 列清单不含 grade/expires_at/snapshot_json
sed -n '80,100p' apps/backend/src/services/signalService.ts

# 3) 确认关联只写不读
grep -rn "linked_trade_id|link-trade" apps

# 4) 确认前端无分级/Top5
grep -rn "强信号|弱信号|top5|Top 5|优先级" apps/frontend/src

# 5) 确认有效性页无基准/扣费/导出
grep -rn "benchmark|基准|扣费|胜率|采纳率|导出" apps/frontend/src/pages/StrategyEffectiveness.tsx apps/backend/src/routes/strategy.ts

# 6) 确认差异页无导出
grep -rn "csv|导出|download" apps/frontend/src/pages/BrokerReconcile.tsx apps/backend/src/routes/brokerReconcile.ts

# 7) 确认环境限制项的实装存在（抽样）
grep -rn "maskSensitive" apps/backend/src/services/logger.ts
grep -rn "READ_ONLY" apps/backend/src/db/duckdb.ts
```

**边界**：本文只读代码与文档；未修改 `apps/`、`packages/`、`data/`；未运行测试、未启动服务；结论可随代码变化失效，复核时以 `origin/main` 最新提交为准。
