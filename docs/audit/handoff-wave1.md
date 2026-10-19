# Wave 1 交接说明（→ 另一台机器的 OpenCode）

> 生成时间：2026-10-19
> 仓库：`D:\workspace\InvestAssistantMVP` / `skytreat/InvestAssistantMVP`
> 分支：`fix/t84-holding-sufficient`
> 状态：**工作区干净，21 个 commit 尚未 push，PR #15 仍 open**

---

## 0. 一句话现状

Wave 1 的 21 个 T 任务已在本地完成并 commit，测试全绿（backend unit 429/429、core 92/92、三处 tsc 0 错误），
但**尚未 push、尚未跑 G1~G8 gate、尚未写 `docs/audit/wave-1-audit.md`**。
下一台机器的任务是：**push → 跑 gate → 写审计文档 → 合并 PR #15 → 开始 Wave 2**。

> 🔴 **先读 §4.1 再开始** —— 本波有 **6 个任务的代码未经独立审查**（sub-agent 被取消后由主 agent
> 接手修复并提交，其中 T57 是从压扁的 10K 单行文件重建的）。「测试全绿」**不等于**「代码是对的」。
> gate 阶段的职责就是补上这双眼睛。
>
> 📌 **§4.2** 给出「agent 原始产出 → 最终实现」的**逐处改动清单**，
> 用于区分「哪些是 agent 的业务逻辑（需重点审）/ 哪些是机械修复（低风险）」。
> 注意：原始产出**未 commit，无 git diff 可查**（T57 原始版已永久丢失）——
> 这也是 §6 列出的流程缺陷，**下一波起必须先留 WIP commit**。

---

## 1. 立即要做的 3 件事

```powershell
cd D:\workspace\InvestAssistantMVP
git status                     # 应为干净
git push origin fix/t84-holding-sufficient   # 推 21 个 commit 到 PR #15
```

> ⚠️ PR #15 的 CI 状态是**旧的**（只覆盖 T84 那条 commit）。
> push 后必须**重新等 CI `build-and-test` 通过**，再进 gate。
> 顺便把 PR #15 的标题/正文从「fix(T84)」改成 Wave 1（一个 Wave 一个 PR）。

---

## 2. 已完成的 T 任务 → commit 对照表

| commit | T 任务 | 内容 |
|---|---|---|
| `7c98992` | — | **AGENTS.md 新增「注释不是规格」动作门禁**（见 §5） |
| `dd6ef6a` | T97 | C1-C12 执行参数：`EXEC_PARAMS` 常量集中、C11 抽样30/节流100ms、C12 抽样20/节流500ms/10s超时/退避200→400、429/503 跳过、连续失败≥5 整项 SKIP、总耗时 30s 上限 |
| `455dd8b` | T88 + T83 + T96 + T93 | 插件引擎计时边界（50ms 只覆盖 `execute()` 纯计算，IO 不计入）、2 个 `category:'filter'` 内置插件、RSI 双阈值 oversold/overbought、SDD §5.3 契约 7 字段补齐 |
| `1ec3661` | T51 | `fast-technical-indicators@1.1.6` 精确锁（core+backend+frontend 三处）、adapters 薄适配层、golden（movingWeightedCost 5 场景 / rsi / macd） |
| `0585ce5` | T52 | KDJ（A 股公式，K₀=D₀=50）+ 布林带，core 与前端**两份**实现，golden 逐位相等断言 |
| `6969aab` | T53 | `fq` 四值白名单（非法→400）、`ma60`、period 走 query、signals 升序、ETF 按 class 路由 |
| `2a31a99` | T50 | 候选池基准价固化 + `migrated_price_mode` |
| `4250f03` | T56 | `POST /api/candidates/batch`（上限100、事务、幂等） |
| `07aa6e3` | T54 | signals 路由加 asset_code/start_date/end_date 筛选 |
| `f6b0909` | T58 | 信号落库 `is_final=1` + `user_asset_rel` hold 关系同步（清仓软删） |
| `96efa71` | T55 | stockscan 公共过滤（asset_type/exclude_st/industry/市值）+ 修 `buildPoolQuery` 占位符错位 |
| `429f753` | T57 | `register` + `refresh`（双 token、哈希落库、轮换） |
| `3bd4818` | T94 | `POST /api/strategy/reload` 热加载插件（B-13） |
| `8ae034a` | fix(T97) | validator_deep 用例隔离外部网络（消除 15s timeout） |
| `5b0c284` | T81 | 测试隔离：`setup.ts` env 两级基线守卫 + `sequence.shuffle` + CI 守卫 |
| `7abef4a` | T91 | SDD §12.1 测试载体索引表（24 行）+ 4 个缺失测试文件 |
| `483a279` | test(T81) | 16 个测试文件的 env 逐用例还原 |
| `044c978` | T85 | C1-C12 对齐 Requirements §7（补 C4/C5，重写 3 处错位实现） |
| `4ce9e10` | T49 | `add` 交易类型（7 种类型落地） |
| `35fb863` | T87 | `trade_time` 必填 + UNIQUE 改「同日同刻」（同日分笔可追加） |
| `09d5e17` | — | 流程文档：交付单元改为「一个 Wave 一个 PR」 |
| `4fa301f` | T84 | 持仓充足性校验改时点回放（P0-13） |

**已知偏差（需在 gate 文档里如实登记）**：

1. `455dd8b` 把 T88/T83/T96/T93 合并成一条 commit。
   原因是 4 个任务在 `pluginEngine.ts` 的 `builtinPlugins` 与 `executePlugin` 两区域交织，
   `t88-plugin-timing.test.ts` 也跨 3 个任务断言，强切会产生半拉子中间提交，破坏可 revert 前提。
2. 🔴 **6 个任务的代码未经独立审查**（T51 / T52 / T53 / T55 / T57 / T94）——
   sub-agent 被取消后由主 agent 接手修复并提交，其中 T57 是从压扁的 10K 单行文件重建的。
   详见 **§4.1**，gate 必须补审。

---

## 3. 剩余任务（Wave 1 尚未完成的）

| T 任务 | 状态 | 说明 |
|---|---|---|
| **T89a + T90** | ⬜ **未做（最关键）** | 后端 envelope 统一（加 `code`/`timestamp`）+ 错误码归一 17→10 + 全部 63 处 `reply.code()` 改经 `src/lib/envelope.ts`；T90 把 15 处路由名对齐 SDD §4.4（`/api/trades`→`/api/trade`、`/api/positions`→`/api/holding`、`/api/kline/:symbol`→`/api/quote/:symbol/kline`、`/api/plugins`→`/api/strategy/plugins`、`/api/signals`→`/api/signal`、`/api/review/stats`→`/api/review/yield` 等）。**两者高度耦合，必须同批做，且必须放在所有路由任务之后**（现在就是最后时机）。 |
| **T59** | ⬜ 未做 | `GET /api/admin/system-log` 加 `start_date`/`end_date`；新增 `POST /api/admin/datacheck/trigger`（B-12 裁决以 SDD §4.4:1274 为准）。**与 T90 的改名直接冲突 → 必须并入 T90 那批一起做**。 |
| **T60** | ⬜ 未做 | 后端测试补齐 + smoke 测试 DB 隔离（`data/business.db` 已被污染：35 个 seed/int 用户、2310 条 datacheck 日志、5 笔测试交易）+ 新建 `tests/http/`（CORS/HTTPS/性能**必须真 listen**，占 51200-51999）+ 删 `smoke-m2.test.ts:50` 死常量 `TEST_PORT=51101` + `calcAllPositions` 消除 N+1 |
| T92 | ⬜ 未做 | 候选池迁移相关（见 plan §任务表），依赖 T90 收敛候选池路由归属 |

**Wave 1 剩余的必做顺序**：
```
T59 + T89a + T90（同批）→ T60 → T92 → 跑 G1~G8 → 写 docs/audit/wave-1-audit.md → 合并 PR #15
```

---

## 4. 待裁决 / 待取证的问题（gate 时要处理）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| A | `positionCalculator.ts:26-34` 把 `add`（加仓）映射成 **sell** → 加仓后持仓归零（实测 0 股/已实现 200，规格应为 200 股/均价 11） | T91 agent 实测 | **P0，必须本波修**。T49 已落地 `add` 类型但成本计算分支没跟上 |
| B | SDD §12.3 A5 送转股稀释后均价（期望 110 股/9.0909）全仓未实现 | T91 agent | 登记到 §13 偏差待办 |
| C | `stockscan` 逐标的执行插件时每只再查一次 DuckDB（实测 1 池 + 1 IN + 5 区间），与 SDD §5.3「1 次 IN → N 插件共享」有差距 | T91 agent | 与 T83/T55 一起复核 |
| D | `services/auth.ts:13-15` **明文兜底 JWT 密钥** → SE3 判定不通过 | T91 agent | 与 §13.4 B-6 一并裁决 |
| E | `backupDuckDB()` 的 instance 未 close（Windows 锁文件），且用 `FORMAT PARQUET` 而非 SDD 写的 `GZIP` | T91 agent | 登记偏差 |
| F | F10 `backup_restore_sqlite` / `restoreSQLiteBackup` 仍零用例 | T91 agent | 随 T60 补 |
| G | `batchGetLatestClose` 是 **ETF 盲区**（`v_stock_qfq WHERE symbol LIKE 'sh51%'` = 0 行，ETF 只在 `v_etf_qfq`）→ ETF 加候选会 404 | T50 agent 实测 | T53 已动 kline 路由但未修 `marketData.ts`，需复核 |
| H | 候选池新路由**未接线**（`routes/index.ts` 不在授权改动范围）；且 `watch.ts:17` 已注册同名 `/api/candidate` 路径 → Fastify 路由冲突 | T50 agent | **T90 必须收敛候选池路由归属**，否则 T50/T56 实际不生效 |
| I | `system_log.log_type` 无 `candidate_batch`（`configStore.ts:120` 是固定 CHECK 白名单），T56 暂用 `trigger_manual` | T50 agent | 随 T90 批次处理 |
| J | `price_mode='current'` 只落模式、没落现价（watch 侧无价格列，DB 里无处存「当前现价」） | T50 agent | 需 DDL 决策 |
| K | `calcPosition`/core 移动加权**不计 `bonus`**，而 `exDividendSync.getHoldingBeforeDate` **把 bonus 计为 +quantity** → 「清仓 100 → bonus 10」两者结论相反 | T58 agent | 需业务口径裁决（Requirements §5.1 归属） |
| L | T93 未把 `PluginSignal.signalType` 改名为 SDD §5.3 的 `direction`（改名会打断 `routes/stockscan.ts:165` / `routes/admin.ts`） | T88 批 agent | T90 批次一并裁决 |
| M | `ParamField.type` 保留了 SDD 没有的 `'integer'`；`options` 仍是 `string[]`（SDD 是 `{label,value}[]`） | T88 批 agent | 前端表单依赖现状，需裁决是否改 SDD |
| N | `signal.ts` 改升序后，`Dashboard.tsx:172` 用 `page_size=5` 无日期过滤 → 仪表盘会显示**最旧** 5 条 | T54 agent | **需确认是否回退为 DESC** |

---

## 4.1 🔴 代码审查覆盖度不足 —— 6 个任务的代码未经独立审查（gate 必须补审）

上一节的 14 项问题**全部来自 sub-agent 的自述报告**。但本波有 6 个任务是
**sub-agent 被取消后、由主 agent 接手修复并提交**的 —— 这些代码**只有一双眼睛看过**，
且部分是我在「半成品」状态下重建的。**gate 时必须补审，不要默认它们是对的。**

### 4.1.1 未经审查的 6 个任务

| T | sub-agent 原始产出的状态 | 主 agent 接手时做了什么 | 审查风险 |
|---|---|---|---|
| T51 | 完整可用 | 仅补 `apps/backend/package.json` 依赖声明（card 验收点 4 要求三处都装） | 🟢 低。adapters 的「只做两件事」（数组补齐 + 柱值×2）是否真的没夹带第三件事，需核 |
| T52 | 完整可用 | **未改** —— 原样通过，golden 逐位相等断言直接绿 | 🟡 中。**KDJ 是唯一递归指标，core 与前端两份实现「原样入库」**。需确认两份确实同公式同初值（不是恰好在测试数据上相同） |
| T53 | 完整可用 | **未改** —— 原样通过 | 🟡 中。`fq` 四值映射 `v_stock_qfq/v_stock_bfq/v_stock_hfq/raw_kline_daily` **表名未经 DESCRIBE 实测核实**（AGENTS.md 铁律要求实测；SDD §3.3「放行可读」≠ 已知表名） |
| T55 | ⚠️ 实现有 bug | 修 `buildPoolQuery` 的 `bind()` 求值顺序错位；改 1 处错误测试断言 | 🟡 中。JOIN 的 3 张表（`raw_symbol_class` / `raw_basic_daily` / `raw_tdx_blocks_member`）列名同样是**照卡片抄的** |
| T57 | 🔴 **半成品** | **大面积重建**：文件被压成 1 行 10K 字符、缺 2 个 `}`、hook 同步（Fastify v5 挂死）、`registerUser` helper 未定义、refresh 段 5 处注册漏带 admin token | 🔴 **高**。从压扁单行重建到 367 行，测试 25/25 绿，**但断言是否覆盖 plan 第 250 行 T57 卡片要求的全部越权场景，必须逐条对照复核** |
| T94 | ⚠️ 实现可用、测试错 | 修插件 fixture 缺 `return`（`({...})` 在 IIFE 里被解析成块语句）；修 hook 同步 | 🟡 中。`reloadPluginsFromDir` 会对**每个**文件重跑 `createPluginSandbox` → 沙盒顶层代码被执行两次（副作用 + 性能），需确认是否可接受 |

### 4.1.2 必须补做的三件事

1. **对照 plan 卡片逐条核 T57 的断言覆盖度** —— 卡片要求「注册入口的越权用例必须齐
   （对应 `cba9556` 修复的同类漏洞，不得重开）」。我重建了文件，但没独立验证
   「齐」这个字。
2. **DESCRIBE 实测 T53/T55 用到的 6 个表/视图真实列名** ——
   `v_stock_qfq` / `v_stock_bfq` / `v_stock_hfq` / `raw_kline_daily` /
   `raw_symbol_class` / `raw_basic_daily` / `raw_tdx_blocks_member`。
   **AGENTS.md 已明令「实现前必须 DESCRIBE 实测」，本波这两处是照卡片抄的，属未闭环。**
3. **T52 的两份 KDJ 实现做「非测试数据」交叉验证** —— 用另一组随机行情喂给两端，
   确认逐位相等（当前只验证了 golden 那一组 221 条）。

### 4.1.3 方法论提醒

本波有 **4 次**「照抄注释/推测就动手」类缺陷（见 §5），根因是**没有独立第二双眼睛**。
本节列的 6 个任务正是在「sub-agent 产出的代码没有第二个人看过」的状态下入库的。
**gate 阶段的职责就是补上这双眼睛** —— 不要因为「测试全绿」就放行。

---

## 4.2 agent 原始产出 → 最终实现的改动点清单（逐处）

> ⚠️ **重要局限，先说清楚**：sub-agent 的原始产出**从未 commit**，因此
> **没有 git diff / `git show` 可以还原**。T57 的原始版本（10K 字符单行）**已永久丢失**。
> 下表是主 agent **逐处手工核对**后写下的改动记录 —— 它能告诉你
> 「**最终代码里哪些部分是 agent 的业务逻辑（需重点审）、哪些是机械修复（低风险）**」，
> 但**不能替代真正的 diff**。
>
> 🔴 **流程缺陷（已列入 §6 待改进）**：sub-agent 产出后**必须先 commit 原始版（WIP）**，
> 再由主 agent 修复，这样 diff 永远可查。本波没做，代价就是 T57 原始版不可恢复。

### T51 — 🟢 几乎全为 agent 原始产出

| 改动 | 性质 | 说明 |
|---|---|---|
| `apps/backend/package.json` 加 `fast-technical-indicators: 1.1.6` | **主 agent 补** | card 验收点 4 要求 core+backend+frontend 三处都声明。agent 只装了 core+frontend |
| 其余全部 | agent 原始产出 | adapters.ts、golden 4 个 JSON、rsi.ts/macd.ts 改造、index.ts 导出 |

**审查重点**：`adapters.ts` 是否真的「只做两件事」（数组补齐 + 柱值×2），有没有夹带第三件事。

### T52 — 🟢 全为 agent 原始产出（主 agent 未改一行）

**审查重点**：两份 KDJ 是否同公式同初值。用 golden 之外的随机行情交叉验证（§4.1.2 第 3 条）。

### T53 — 🟢 全为 agent 原始产出（主 agent 未改一行）

**审查重点**：6 个表/视图名未经 DESCRIBE 实测（§4.1.2 第 2 条）。

### T55 — 🟡 2 处改动

| # | 位置 | agent 原始 | 最终 | 性质 |
|---|---|---|---|---|
| 1 | `stockscan.ts:193` + `:215` | `SELECT ${bind(view)} AS src_view` | 新增 `const srcViewPlaceholder = bind(view);`（提前到 `conditions` 之前），SQL 改用 `${srcViewPlaceholder}` | **主 agent 修 bug**（真 bug：参数与 `?` 错位 → DuckDB `INTEGER -> DATE`） |
| 2 | `t55-stockscan-filter.test.ts` | `expect(filtered.length).toBeLessThan(base.length)` | 删除该断言，改为注释说明「LIMIT 5000 饱和时条数不变，只能断言结果里不含 ST 名称」 | **主 agent 修错误断言**（agent 写的断言在 LIMIT 饱和时永远不成立） |

**审查重点**：JOIN 的 3 张表列名（`raw_symbol_class.is_st` / `raw_basic_daily.totalmv` /
`raw_tdx_blocks_member`）是照卡片抄的，未经实测。

### T57 — 🔴 改动最多（从半成品重建）

| # | 位置 | agent 原始 | 最终 | 性质 |
|---|---|---|---|---|
| 1 | **整个文件结构** | **141 行，其中第 140 行是 10 047 字符的单行**（压扁，3 个 describe 挤在一起） | **418 行**，按语句边界重新拆行 + 补 2 个缺失的 `}` + 拆开被吞在行尾的 it 闭合 | **主 agent 重建** |
| 2 | `makeApp()` 的 hook | `app.addHook('onRequest', (request) => {...})` —— **同步** | 改为 `async (request) => {...}` | **主 agent 修 bug**（Fastify v5 同步 hook → 请求永挂，`inject()` 15s timeout） |
| 3 | `registerUser` helper | **未定义**（被调用但没写） | 补上，并加 `token` 参数 | **主 agent 补** |
| 4 | `bootstrapAdminToken()` | 不存在 | 新增 | **主 agent 补** |
| 5 | refresh 段 6 处注册 | 匿名 `registerRaw(app, {...})` | 全部加 `bootstrapAdminToken()` | **主 agent 修**（ConfigStore 单例 + 同一临时库 → 前一个 describe 的用户可见 → 匿名注册被正确拒 403 REGISTERISTRATION_CLOSED） |
| 6 | `registerRaw` 调用跨行格式 | `{...}\n});` | `{...}, token)\n);` | 格式随 #5 一并调整 |
| 7 | `auth.ts` 实现 | agent 原始产出 | **未改** | — |

**审查重点（最高）**：`auth.ts` 是 agent 原始产出、主 agent 一行未改，
而测试是主 agent 重建的 —— **测试可能只是在验证 agent 的实现，而不是验证卡片要求**。
必须对照 plan 第 250 行 T57 卡片逐条核（§4.1.2 第 1 条）。

### T94 — 🟡 2 处改动

| # | 位置 | agent 原始 | 最终 | 性质 |
|---|---|---|---|---|
| 1 | `t94-strategy-reload.test.ts` 的 `VALID_PLUGIN_JS` | `({ id: ..., execute: ... })` | `return ({ id: ..., execute: ... })` | **主 agent 修**（裸 `({...})` 在沙盒的 `return (function(){...})()` 里被解析成**块语句** → 返回 undefined） |
| 2 | 同文件 `env_leak.js` / `require_fs.js` fixture | 同样是裸 `({...})` | 同样加 `return` | **主 agent 修** |
| 3 | 同文件 `makeApp()` 的 hook | 同步 | `async` | **主 agent 修 bug**（同 T57 #2） |
| 4 | `strategy.ts` 实现 | agent 原始产出 | **未改** | — |

**审查重点**：`reloadPluginsFromDir` 对**每个**文件重跑 `createPluginSandbox` →
沙盒顶层代码被执行两次（副作用 + 性能），是否可接受需确认。

---

## 5. 已固化进 AGENTS.md 的铁律（务必遵守）

`7c98992` 新增了 **「注释不是规格。改动既有代码前，先证明『现状是错的』」** 门禁：

1. **复现** —— 写一个会失败的测试，或跑一条命令让错误现象可见
2. **定位** —— 找**权威来源**（真实 API 响应 / DB 实测 / SDD 章节），**不是代码注释**
3. **注释与行为不一致时，先怀疑注释**

**推论**：
- 权威来源只有**实测**。第三方 API 的字段序**一律以真实响应为准**，不以注释或记忆为准。
- 「报告疑似缺陷」与「动手修改」之间**必须插入取证步骤**。sub-agent 只被允许**报告**疑似问题，不允许顺手改；主 agent 采信前必须自己复现。

**当天 4 次同类错误的实测案例**（`validator.ts` 东财字段序）：
- 代码注释写 `"2024-01-02,10.50,10.60,10.40,10.55"` → 读作 `日期,开,高,低,收` → 收盘在 `parts[4]`
- sub-agent 据此报告「`parts[2]` 是 bug」
- **实测**（2026-10-17 真实响应）：`2026-10-12,1262.95,1288.00,1288.00,1261.00`
  → `fields2=f51..f61` 中 **f53=收盘** 即 `parts[2]`=1288.00，与本地 DuckDB `close=1288` 吻合
  → **代码正确，注释错误**
- 主 agent 采信报告去改注释，**误删 `const parts = ...` 代码行**，引入真实缺陷，被 typecheck + 9 个测试抓到

**本波还踩到的同类坑**（都已在 commit 里修正，勿重犯）：
- `buildPoolQuery`：`${bind(view)}` 在模板串里才求值，晚于 `conditions` 里的 `bind(tradeDate)`
  → params 顺序与 `?` 出现顺序错位 → `k.date = ?` 收到整数 → DuckDB 报 `Unimplemented type for cast (INTEGER -> DATE)`
- `createPluginSandbox`：源码被包成 `return (function(){ <src> })()`，**裸 `({...})` 会被解析成块语句**返回 undefined
  → 插件测试 fixture 必须写 `return ({...})`
- **Fastify v5 的 hook runner 只在 hook 返回 thenable（或用 3 参数 `done`）时才继续**：
  同步 `app.addHook('onRequest', (req) => {...})` → 请求**永远挂起**，`app.inject()` 永不 resolve（表现为 15s timeout）
  → 生产代码 `routes/index.ts:29` 用的是 `async`，是对的；**测试里手写的 hook 必须也是 `async`**
- PowerShell 里 commit message 含 `->` 会被当重定向解析 → 用 `git commit -F <file>` 写长 message

---

## 6. 本波用过的并行 lane 划分（可复用）

文件冲突矩阵决定了唯一可行的并行方式 —— **按文件归属切 lane**：

```
冲突簇（必须串行，同一 lane 内）
  pluginEngine.ts      : T88 / T83 / T96 / T93
  validator.ts         : T97
  core indicators      : T51 -> T52
  routes/*             : T50 / T53 / T54 / T55 / T56 / T57 / T92 / T94 / T89a / T90
  signalService.ts     : T58 / T93
  logger.ts            : T59
```

**经验**：
- sub-agent 只做实现与测试，**不要 git add/commit/push** —— 并行 agent 共用工作区会抢 git 锁；
  由主 agent 按 T 顺序统一提交
- **sub-agent 被取消时，它写的代码通常还在工作区里**（本波 Lane A/D 被取消后，
  T51/T52/T53/T55/T57/T94 的代码全部已写完，只是没汇报）。取消后先 `git status` 盘点，
  再决定是接手还是重派
- 长提示词不会被取消（第一次是额度问题，第二次是人工取消）
- Windows 换行：agent 用脚本写文件可能把 `\n` 吞掉 → 出现「整个文件压成一行」；
  恢复办法是按语句边界重新拆行，再用 `tsc` 定位缺哪个括号

### 🔴 待改进的流程缺陷（本波踩到，代价已付）

**sub-agent 产出后没有先 commit 原始版（WIP），导致原始产出不可 diff。**
本波 T57 的 agent 原始版（10 047 字符单行）**已永久丢失**，无法 `git show` 还原，
只能靠 §4.2 的人工记录。

**下一波的正确做法**：
```
1. sub-agent 产出（不改 git）
2. 主 agent 立刻 git add + commit -m "wip(T57): agent 原始产出"   ← 关键：先留档
3. 主 agent 修复 → git commit --amend 或追加一条 fix commit
4. 审查时用 git show / git diff 直接对比两版
```
代价是多一条 commit；但换来的是**任何时候都能回答「这一行是谁写的、为什么改」**。
本波「一个 T 一条 commit」的规则与此冲突时，**留档优先** —— 留档 commit 可在 gate 后 squash。

---

## 7. 端口与环境（AGENTS.md 硬约束，跨机器仍适用）

| 用途 | 端口 |
|---|---|
| Fastify 后端默认 | 8080 |
| Vite dev server | 5173 |
| smoke-m1 / m3 | 51100 / 51102 |
| `tests/http/`（CORS/HTTPS/性能，**必须真 listen**） | 51200-51999 |

**收尾四步**（顺序不可跳过）：杀进程树 → 按端口段强杀 → 查 `tsx watch` 残留 → 端口 LISTEN 归零且无残留。
**验收标准：LISTEN = 0 且第三步无输出**（只满足前者不算收尾完成）。

**起服务必须用隔离库**：`.env.local` 无 `SQLITE_DB_PATH`，可直接覆盖
（范式见 `apps/backend/tests/integration/_helpers.ts:17-21`：`mkdtempSync` + 覆盖 `SQLITE_DB_PATH` + `(ConfigStore as any)._instance = null`）。
⚠️ `data/business.db` **已被污染**（35 个 seed_/int_ 用户、2310 条 datacheck 日志、5 笔测试交易）——
T60 要修 smoke 隔离，但**现在不要直接删**，先备份确认。

---

## 8. 本地验证基线（交接时的健康状态）

```
apps/backend/tests/unit   34 文件  429/429 通过   (含 sequence.shuffle)
packages/core             11 文件   92/92 通过
tsc --noEmit              backend / core / frontend 三处均 0 错误
```

> 注：`apps/backend` 全量（含 integration + smoke）在本波早前跑过 525/525（当时 1 个 timeout 已修）。
> 接手后建议先跑一次 `npm test`（约 5-6 分钟）建立新基线。

---

## 9. 关键路径速查

| 用途 | 路径 |
|---|---|
| 业务规则唯一真相源 | `docs/client/Requirements_simplified.md` |
| 用户视角需求 | `docs/client/PRD.md` |
| 技术契约唯一权威 | `docs/client/SDD.md` |
| 任务拆解 + Wave gate | `docs/client/code_implementation_plan_v2.md`（T49-T98，§12 gate，§13 偏差待办） |
| 决策归档 | `docs/adr/`（已接受 8 份，索引 `docs/adr/README.md`） |
| 六层追溯矩阵 | `docs/traceability.md` |
| 行情层真实 schema | `docs/tdx2db_schema.md`（**实现前必须 `DESCRIBE` 实测**） |
| Wave 审计落档 | `docs/audit/wave-N-audit.md`（**无文件 = 未执行 = FAIL**） |
| 编码规则 | `AGENTS.md`（本波新增「注释不是规格」门禁） |

**运行命令**：
```powershell
npm test                                                  # backend + core
npx tsc --noEmit -p apps/backend/tsconfig.json
npx vitest run apps/backend --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true
npx vitest run packages/core --config packages/core/vitest.config.ts
```
