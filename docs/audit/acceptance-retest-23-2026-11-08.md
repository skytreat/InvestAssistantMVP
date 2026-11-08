# 23 条环境限制场景补测结果（2026-11-08）

> **性质**：只读补测取证 + 文档产出。未修改任何业务代码；未对 `data/business.db` 执行任何写操作。
> **前篇（不覆盖）**：
> - `docs/audit/acceptance-scenario-traceability-2026-11-06.md`（75 条溯源，41 通过 / 1 失败 / 33 未覆盖）
> - `docs/audit/acceptance-uncovered-reclassification-2026-11-07.md`（33 条再分类：6 未实现 + 27 环境限制）
> **实测基线**：`feat/acceptance-f2-signal-trade @3816dd3`（含 #120；当时 `origin/main` 为 `12cc73d`，F2 以 PR #128 未合并）

## 0. 约束与证据可信度

| 项 | 做法 | 实测读数 |
|---|---|---|
| 业务库不写 | 只读打开 `data/business.db` → `db.backup()` 热备到临时库 → 所有写操作落在临时库 | 业务库指纹前后一致：`size=14692352`、`mtime=2026-11-07T04:21:48.632Z` |
| 临时库 | `data/_tmp/retest-20261108/business-retest.db`（含 `retest_user` / `retest_empty` / `retest_admin` 三个测试账号，密码仅存于临时库） | 交易 310 笔、`user_asset_rel` hold 1 条、`system_log` 55265 条 |
| 行情库只读 | `data/quotes.duckdb` 以 `access_mode: READ_ONLY` 查询 | `raw_gbbq` / `raw_kline_daily` 可读 |
| 后端隔离 | 8080 后端使用临时库；K5 另起 51801 + 独立 `k5.db` + 独立 `BACKUP_DIR` | 端口/日志见 §9 |
| 浏览器 | Chromium 1217（headless，CDP）+ Vite 5173（proxy → 8080） | 截图/DOM 快照 26 个 |
| 结论口径 | **通过** / **失败（真缺陷 + 定位）** / **仍受限（说明缺什么）** | — |

> ⚠️ 基线说明：本轮实测运行在 `3816dd3`。该提交之后 `origin/main` 已前进（纸面账户 #122–#124），但 `docs/client/code_implementation_plan_v3.md` 在两者间**无差异**，故本文与 T135 更正对 `main` 同样适用。

---

## 1. 写库范围（9 条：8 通过 / 1 失败）

| 编号 | 场景 | 原状态 | 本轮结论 | 可复核证据（命令 / 测试 / 读数） |
|---|---|---|---|---|
| **B5** | 软删标的可见性 | ⚪ 环境限制 | **通过** | `node data/_tmp/retest-20261108/api-retest.mjs`：watch 创建 201 → 列表可见 `true` → DELETE 200 → 列表 `false`，DB `is_deleted=1`；trade 第 311 号软删后列表消失、恢复后 `is_deleted=0` |
| **B6** | 刷新一致性 | ⚪ 环境限制 | **通过** | 同一持仓两次调用结果逐字段相同（`totalQuantity=200, avgCost=30.025, totalCostBasis=6005`，`two_calls_identical=true`）；新建交易立即可见；组合汇总 `positionCount=41` |
| **C1** | 七类交易全量 | ⚪ 环境限制 | **通过**（复跑） | `api-retest-2.mjs`：buy/add/dividend/bonus/transfer/reduce/clear 七类全 201，持仓链 100→200→200→210→220→190→0 与预期逐项一致；首轮 409 系脚本与 B5 抢同一唯一键，改标的后通过 |
| **C2** | 除权表单（分红/送股/转增数值） | ⚪ 环境限制 | **通过** | 分红 `qty=200 price=1.5` 落库且 `cashReceived=300`、股数不变；送股 `qty=10 price=0`、转增 `qty=10 price=0` 原样落库；`trade_date` 可自定义 |
| **C7** | 编辑历史（复盘字段留痕） | ⚪ 环境限制 | **失败（真缺陷）** | `PATCH /api/trade/311` → **200**，`review_summary`/`remark`/`is_stop_loss` 更新成功；但传入的 `buy_reason`、`sell_reason`、`emotion_status` **落库仍为 `null`**；响应 `data=null`、无任何提示。定位 `apps/backend/src/routes/trade.ts:598` |
| **H4** | 同券商多文件批量导入（单事务） | ⚪ 环境限制 | **通过** | `POST /api/broker-import/confirm-batch` 200：国泰 ETF 成交 `125/125`、交割单 `134/134` 全插入，`rowDeduped=0`；回填 `totalNeeded=97 / matched=97 / unmatched=0` |
| **H5** | 整页确认（确认→导入） | ⚪ 环境限制 | **通过** | `confirm-final` 200：股票成交 `12/12`、交割单 `14/14`，与 `confirm-batch` 逐文件结果一致；回填 `12/12` |
| **K5** | 备份 → 修改 → 恢复回滚 | ⚪ 环境限制 | **通过** | `k5-retest.mjs`（独立 `k5.db` + 51801）：`backup` 200（`sqlite.size=14929920`、`duckdb.skipped=true`）；无 `confirm` 恢复 **400**；新建标记交易后可见；带 `confirm:true` 恢复 200 → 标记消失、`trades=7`、`safetyBackup` 落盘、system_log 留痕 |
| **K7** | 系统日志筛选 + 分页 | ⚪ 环境限制 | **通过** | 全量 `total=55275`、页 1/页 2 各 20 行且 `overlap=0`；`log_type=trade` → 14 条；`level=SUCCESS` → 9654 条；`start_date` 单日 → 10 条 |

---

## 2. 数据样本（7 条：6 通过 / 1 失败）

| 编号 | 场景 | 原状态 | 本轮结论 | 可复核证据 |
|---|---|---|---|---|
| **A5** | 登录过期/无效 token → `/login` 并保留原路径 | ⚪ 环境限制 | **失败（真缺陷）** | 见 §3（浏览器组实测） |
| **B4** | 新用户空态 | ⚪ 环境限制 | **通过** | API：`retest_empty` 下 holding/trades/watch/candidate 全 200 且计数 0；UI：三页空态文案齐全，0 console error、0 个 5xx |
| **C6** | 除权自动导入 | ⚪ 环境限制 | **通过** | `c6-retest.mjs`：`sh688610 @2026-10-19`（c1=2 元/10 股、c3=4 股/10 股），构造持仓 1000 股后调用 `importDividendEvents`：首次 `importedDividend=1 / importedBonus=1`，落库 `dividend qty=1000 price=0.2`、`bonus qty=400 price=0`，均 `trade_time='00:00:00'`、`is_auto_import=1`、`broker_code=null`；二次调用 `duplicatesSkipped=2`、行数不变（幂等） |
| **F5** | 策略配置读写（启用开关 / 参数） | ⚪ 环境限制 | **通过** | `GET /api/strategy/plugins` 5 个插件；`rsi_oversold` toggle 0→1 往返成功；`PUT config` 写入 `params` 后读回一致；非法 params → **400** |
| **I5** | 资金校验三态 | ⚪ 环境限制 | **通过** | `POST /api/broker-reconcile/run` 200：`fundCheck.checked=127 / hit=127 / notApplicable=0 / mismatch=[]`；另有 `skippedEvents=7` 与 `scopeNote`（仅交割侧、有成交金额的买卖/申赎参与行内自洽） |
| **I9** | 一键补录（整体事务 + 自动重跑对账） | ⚪ 环境限制 | **通过**（复跑） | `category=unmatched` 97 条 → 补录 20 条 200（`imported=20`，逐条返回 `tradeRecordId`）→ 97 降到 77；`source_broker_record_id` 已落库；重复补录 200 且 `already=20`、不新增 |
| **K2** | 日志脱敏（金额收窄 / 敏感不落日志） | ⚪ 环境限制 | **通过**（复跑） | 造 `price=1500` 交易后日志为 `录入buy sh600519 qty=10 price=****`（金额整数位 ≥4 位被遮）；`qty` 明文；扫 600 行日志 `jwt/bearer/account/pwd` 命中 **0**；ISO 日期（`fromDate=2026-10-12`）未被误遮 |

---

## 3. 浏览器（5 条：4 通过 / 2 失败）

> 命令：`CHROMIUM_BIN=…\chrome.exe npx tsx data/_tmp/retest-20261108/browser-retest.ts`
> 证据目录：`data/_tmp/retest-20261108/browser-evidence/`（26 个 png/txt/html）

| 编号 | 场景 | 原状态 | 本轮结论 | 关键读数 |
|---|---|---|---|---|
| **A5** | 会话过期跳登录并保留原路径 | ⚪ 环境限制 | **失败（真缺陷）** | `/review` 首屏并发 **8 个 401**；`fromTimeline`：286ms `/review, from=null` → 900ms `/login, from=/review` → **952ms `/login, from=/login`**；重新登录落 `/`（h1=仪表盘）。`/candidates` 同样 `finalFrom=/login` |
| **B4** | 新用户全空态（UI） | ⚪ 环境限制 | **通过** | 三页空态（今日暂无成交 / 候选池为空 / 暂无交易记录）；42 个 `/api` 全成功、0 console error、0 个 5xx |
| **D4** | 复盘弹窗可点开、可编辑、可保存 | ⚪ 环境限制 | **通过** | 弹窗标题「编辑复盘 — sh688610 (2026-10-19)」；`remark` 改为 `D4-retest-20261108-remark` → `PATCH /api/trade/348` **200** → 回查已持久化 → 弹窗关闭、0 报错 |
| **E4** | 改 K 线参数 → 零请求 + 本地重算 | ⚪ 环境限制 | **通过** | MA1 5→7；图例 `MA5`→`MA7`；canvas 像素重绘变化；改参期间 `/api` 请求数 **0**；120 根 K 线（sh600519） |
| **G6** | 选股筛选维度逐个 + 两两组合 | ⚪ 环境限制 | **通过** | 基线 5000/884（总数/命中）→ 排除ST **877** → 成交额≥1亿 661 → 市值≤50亿 176 → 组合 162 → 成交额+市值 **501/76** → ETF 2179/314；“生效过滤”逐项回显，无报错 |
| **H2** | 导入按钮显示实际券商名 | ⚪ 环境限制 | **失败（真缺陷）** | 上传 200；按钮文案「**确认导入【未识别】（1 个文件）**」且 `disabled=true`；`brokerCode` 输入为空、无自动填充提示 |
| **K8** | 5 个 `?tab=` 深链 | ⚪ 环境限制 | **通过** | `/admin?tab=check/trigger/backup/roles/logs` 5/5 分别只挂载对应 `admin-panel-*`，aria-selected 正确、面板文案 5/5 互异 |

> 说明：H2 并非完全阻断 —— 用户可在「券商标识」下拉手动选择后继续导入；缺的是「按文件名自动推断 + 按钮回显」。

---

## 4. 传输层（1 条：仍受限）

| 编号 | 场景 | 原状态 | 本轮结论 | 证据 |
|---|---|---|---|---|
| **L3** | CORS 仅 127.0.0.1 / HTTPS 301 | ⚪ 环境限制 | **仍受限（缺 caddy）** | `npx vitest run tests/http/cors.test.ts tests/http/https-se1.test.ts --config vitest.http.config.ts`（cwd `apps/backend`）→ **Test Files 2 passed / Tests 13 passed (13)**：`cors.test.ts` 9/9 真监听通过；`https-se1.test.ts` 4/4 **契约层**通过，但测试自身输出 `[SE1] ⚠️ 本机没有 caddy … HTTP 层（真实 301）本次未实测` |

缺什么：一个 `caddy` 可执行文件（或设 `CADDY_BIN`）。补齐后重跑 `https-se1.test.ts` 即可把 HTTP 层 301 也纳入实测。

---

## 5. G3 归位（不重跑）

G3 在再分类文档中已记「复测已通过」（证据：`docs/audit/acceptance-retest-2026-11-07.md` 第 33 行：`run` 返回 `fundCheck.skippedEvents` 结构完整、`repoModel` 与 `returnSummary` 可用）。本轮**不重跑**，仅按用户指令归位为 **通过**。

---

## 6. 失败项汇总（按严重度）

| # | 严重度 | 条目 | 类型 | 结论与定位 | 影响 | 建议 |
|---|---|---|---|---|---|---|
| 1 | **高** | **C7** | **产品缺陷** | `PATCH /api/trade/:id` 白名单仅 `['review_summary','strategy_match','is_stop_loss','remark','trade_reason']`，传入 `emotion_status`/`buy_reason`/`sell_reason`/`system_followed` 被**静默丢弃**。定位 `apps/backend/src/routes/trade.ts:598` | 复盘核心字段（情绪状态、买卖理由、是否跟随系统）**无法通过 API 落库**；与计划 T131 标 ✅ 不符 | 需代码改动：把 4 个字段加入白名单并做类型/枚举校验；补齐单测 |
| 2 | **中高** | **A5** | **产品缺陷** | 每个 401 都 `logout()+emitSessionExpired(currentPath())`，无防重入/一次性锁；首个 401 已跳登录后，后续 401 取到的 `currentPath()` 变成 `/login` 并覆盖 `from`。定位 `apps/frontend/src/api/client.ts:246-248`、`apps/frontend/src/App.tsx:182-204` | 并发首屏（Dashboard/Review/Candidates 等）**全部丢失返回路径**，重登后落到首页 | 在**请求发起时**捕获路径，或在会话过期事件里「只记录首个非 `/login` 路径」；补 e2e |
| 3 | **中** | **H2** | **产品缺陷** | 券商名推断只认公司全名及其去后缀全名（`国泰君安证券`→`国泰君安`），样本文件名用简称「国泰」→ `brokerNameHint=undefined`。定位 `apps/backend/src/services/broker/brokerParser.ts:410-426` | 按钮显示「未识别」且禁用；用户需手动选券商后才可导入（不阻断，但违反验收文案要求） | 在别名表补「国泰」「国君」等常用简称；或让样本文件名与全名一致 |
| — | — | **L3** | 环境限制（非产品缺陷） | 无 `caddy` | SE1 的 HTTP 层 301 未实测 | 装 caddy 或设 `CADDY_BIN` 后重跑 |

**验收脚本自身的问题（已在过程中修复，不计入失败项）**：

| 条目 | 现象 | 根因 | 修复 |
|---|---|---|---|
| C1 | 首轮 buy/clear 409 | 与 B5 复用同一唯一键 `sh600519/2026-11-02/09:30:00`；clear 数量写成 290 而持仓仅 190 | 换标的 `sh600809`、clear 改 190 后通过 |
| C7 | 首轮 `TypeError: cannot read review_summary` | 脚本按 `trade_id` 取值链错误 | 按 `trade_reason` 定位 id=311 后通过 |
| K2 | 首轮失败 | 样本价格整数位 <4 位不触发脱敏；无含日期日志 | 造 `price=1500`、用 `signal_generate` 的 ISO 日期作为「日期不误遮」断言 |
| I9 | 首轮 `INVALID_CATEGORY`；二轮 `rows.slice is not a function` | `/diff` 合法分类只有 7 个；`data` 是 `{rows,total,page}` 而非数组 | 用 `category=unmatched` + `data.rows` 后通过 |
| C6 | `tsx` 顶层 `await` 报错 | 根 `package.json` 无 `"type":"module"`，脚本按 CJS 解析 | 包进 `async main()` 后通过 |
| 浏览器 | Chromium 临时目录 `rmSync` EPERM | Windows 文件占用 | 已捕获，不影响结论 |

---

## 7. 前后状态与通过率

### 7.1 逐条前后变化

| 编号 | 2026-11-06 原判 | 2026-11-07 再分类 | 本轮（2026-11-08） |
|---|---|---|---|
| B5 | ⚪ 未覆盖 | 环境限制 | **通过** |
| B6 | ⚪ 未覆盖 | 环境限制 | **通过** |
| C1 | ⚪ 未覆盖 | 环境限制 | **通过** |
| C2 | ⚪ 未覆盖 | 环境限制 | **通过** |
| C7 | ⚪ 未覆盖 | 环境限制 | **失败（真缺陷）** |
| H4 | ⚪ 未覆盖 | 环境限制 | **通过** |
| H5 | ⚪ 未覆盖 | 环境限制 | **通过** |
| K5 | ⚪ 未覆盖 | 环境限制 | **通过** |
| K7 | ⚪ 未覆盖 | 环境限制 | **通过** |
| A5 | ⚪ 未覆盖 | 环境限制 | **失败（真缺陷）** |
| B4 | ⚪ 未覆盖 | 环境限制 | **通过** |
| C6 | ⚪ 未覆盖 | 环境限制 | **通过** |
| F5 | ⚪ 未覆盖 | 环境限制 | **通过** |
| I5 | ⚪ 未覆盖 | 环境限制 | **通过** |
| I9 | ⚪ 未覆盖 | 环境限制 | **通过** |
| K2 | ⚪ 未覆盖 | 环境限制 | **通过** |
| D4 | ⚪ 未覆盖 | 环境限制 | **通过** |
| E4 | ⚪ 未覆盖 | 环境限制 | **通过** |
| G6 | ⚪ 未覆盖 | 环境限制 | **通过** |
| H2 | ⚪ 未覆盖 | 环境限制 | **失败（真缺陷）** |
| K8 | ⚪ 未覆盖 | 环境限制 | **通过** |
| L3 | ⚪ 未覆盖 | 环境限制 | **仍受限（缺 caddy）** |
| G3 | ⚪ 未覆盖 | 环境限制（已记复测通过） | **通过（归位，不重跑）** |

合计：**19 通过 / 3 失败 / 1 仍受限**。

### 7.2 通过率（75 条全量）

| 状态 | 原有（2026-11-06） | 更新后（2026-11-08） |
|---|---|---|
| 通过 | 41 | **60**（41 + 19） |
| 失败 | 1（J3） | **4**（J3 + C7 + A5 + H2） |
| 未覆盖 / 未复验 | 33 | **11** |
| 合计 | 75 | 75 |

- 未覆盖 11 的构成：`F1/F2/F3/F6/I8` 已实现但本轮未复验（5）＋ `F4` 仍未实现（1）＋ `H1/K3/L2/L4` 未在 23 条范围内（4）＋ `L3` 仍受限（1）。
- **全量通过率：60 / 75 = 80.0%**（原 41 / 75 = 54.7%）。

### 7.3 通过率（原 48 条口径，排除 27 条环境限制）

| 状态 | 原有 | 更新后 |
|---|---|---|
| 通过 | 41 | 41 |
| 失败 | 1 | 1 |
| 未覆盖 | 6（F1/F2/F3/F4/F6/I8） | 6（F1/F2/F3/F6/I8 已实现待复验 + F4 未实现） |
| 合计 | 48 | 48 |

- **原 48 口径通过率：41 / 48 = 85.4%**（本轮补测的 23 条全部属「环境限制」，不进入该口径）。
- 参考口径（不计入本轮实测）：若把 `F1/F2/F3/F6/I8` 的代码核验结果计入通过，则为 **46 / 48 = 95.8%**；该数字**不属于实测通过率**，仅用于说明 48 口径的上限。

---

## 8. 对既有文档结论的修订

1. **6 条「未实现」的现状已变化**（再分类文档基于 `dbab762`）：
   - `F1/F3/F6/I8`：已由 `09e05b9`（#120）实现（分级写入/今日 Top5/冷却展示/CSV 导出）。
   - `F2`：已由 `3816dd3` 实现（录入可选关联 + `trade_status` 派生）。
   - `F4`：**仍未实现**（仅有 T+1/T+5/T+10 原始涨跌幅，见 §9 T135 更正）。
   - 上述 5 条「已实现」均**未在本轮复验**，故仍列「未覆盖/未复验」，不擅自改为通过。
2. **T135 标记更正**：计划文档中标 ✅ 的 T135 已改为「⚠️ 部分」，并逐项注明扣费 / 基准 / 胜率 / 分组下钻 / CSV 导出未实现及依据；该更正为**独立 commit**，便于回退。
3. **H2 的失败依据补充**：不只看按钮文案，还确认了「可手动选择券商后继续」，避免把可用性缺陷误报为阻断性缺陷。

---

## 9. 证据落盘与不提交说明

以下均在 `data/_tmp/retest-20261108/`（`data/` 已被 `.gitignore` 忽略，**不进入 PR**）：

| 文件 | 内容 |
|---|---|
| `api-results.json` / `api-results-2.json` / `api-results-3.json` | 写库与数据样本逐条读数（含复跑） |
| `k5-results.json` | K5 备份/恢复读数 |
| `c6-results.json` | C6 除权导入读数 |
| `browser-results.json` | 浏览器 6 条断言与读数 |
| `browser-evidence/` | 26 个截图 / DOM 快照 |
| `*.mjs` / `*.ts` | 补测脚手架（`seed.mjs`、`api-retest*.mjs`、`k5-*.mjs`、`c6-*.ts`、`browser-retest.ts` 等） |
| `backend.log` / `backend-k5.log` | 两个隔离后端日志 |

后台服务已按 `AGENTS.md` 四步收尾（端口 8080/5173/51801 归零，无 `tsx watch` 残留）。
