# 组合策略（T133 / T148）方案

> 状态：方案提案（四项决策已由 owner 拍板，见 §6）。本文件只做设计与排期，不含实现代码。
> 关联需求：`INV-S3-18/19`（策略可组合、条件独立开关调参）、`INV-S3-24/25/26`（分级、Top N、快照）。
> 关联任务：`code_implementation_plan_v3.md` 的 **T133**（策略分类/组合/适用品种）与 **T148**（策略配置页 UI）。
> 关联文档：`PRD_v3.md` §4.1 ⑤、`InvestAssistantV3_NewRequirements.md` §4.2、`SDD_v3.md` §10.4。
> 起草日期：2026-11-08；**基线：`origin/main` @ 含 #119/#120/#121**（风险插件、F3 Top5、纸面 S1）。

---

## 0. 结论摘要（先看这里）

| 项 | 结论 |
|---|---|
| **MVP 范围** | 一条 **AND** 组合（2 个及以上 BUY/SELL 条件）、日线、同标的、只产出 **1 条合成监控信号**，写入现有 `user_strategy_signal`；组合强度 = 各条件 `strength` 的 **`min`**；回测走**先批量预生成信号、再跟随**；复用现有插件条件计算、`persistSignals`、F1 分级、F6 冷却展示 |
| **MVP 工作量量级** | 约 **4 个 T 任务 / 10 个 PA 子任务**（DDL+仓储、求值器、链路接入、路由/前端、适配器与测试）；回测与纸面共用同一个 `Strategy` 适配器 |
| **完整版增量** | OR / 嵌套、组合强度加权模型、配置版本化回放、组合评估分组、多用户隔离；再约 **6~8 个 T 任务** |
| **四项决策已拍板** | **D1 仅 AND（OR / 嵌套留 P1）**；**D2 strength 取各条件 min**；**D3 预生成信号 + 跟随（判据只有一份）**；**D4 历史不可变、只影响未来（版本回放 P1）** —— 含理由见 §6 |
| **其他已定口径** | F6 冷却**只在展示层合并、不抑制生成**；风险 HOLD 由 `position_risk_alert` 独立产生、**不带 `strength`**、不进 F1 分级、默认不进今日 Top5 |

---

## 1. 需求原文依据（逐条摘录）

> 说明："已定口径"= 需求或用户已明确、可直接作为验收依据；"界面示意"= PRD 的 ASCII 原型，只能说明交互形态，不能推出组合语义；"任务验收"= 实施计划里的验收点，不是需求原文。

| 编号 | 出处 | 原文 | 性质 |
|---|---|---|---|
| INV-S3-18 | `docs/client/InvestAssistantV3_NewRequirements.md` L667 | 「策略**必须可组合**（多个基础条件同时成立才出信号），而非每种组合各写一个策略」 | **已定口径**：AND 语义、禁止为组合写插件 |
| INV-S3-19 | 同文件 L668 | 「组合策略的**每个条件可独立开关与调参**」 | **已定口径** |
| INV-S3-20 | 同文件 L669 | 「策略参数**必须具名、必须声明取值范围与默认值**，禁止魔法数」 | **已定口径**：条件参数沿用 `ParamField` |
| INV-S3-21 | 同文件 L670 | 「策略的**默认参数必须来自可解释的依据**……不得凭直觉设定」 | **已定口径** |
| INV-S3-17 | 同文件 L658 | 「策略**必须声明其适用品种**（全部 / 仅股票 / 仅场内 ETF / 仅跨境 ETF / 排除跨境等）」 | **已定口径**：组合也应声明 |
| INV-S3-23 | 同文件 L679 | 「**冷却期**：同一策略 + 同一标的 + 同一方向，在 N 根 K 线内**不得重复产生信号**（N 可配置，默认 3）」 | **已定口径**；落地口径由用户明确为**展示层合并**（见下方"实现事实"） |
| INV-S3-24 | 同文件 L680 | 「信号**必须分级**（强 / 中 / 弱），默认只推送强信号」 | **已定口径** |
| INV-S3-25 | 同文件 L681 | 「每日推送**必须有 Top N 摘要**，不得把全部信号倾泻给用户」 | **已定口径**（今日 Top5 / T149） |
| INV-S3-26 | 同文件 L682 | 「信号**必须可回溯当时的输入数据**（触发时的 K 线、指标值）」 | **已定口径**：组合信号也要写快照 |
| PRD 组合示例 | `docs/client/PRD_v3.md` L338-L339 | 「MACD 金叉 + 量能确认（组合）……条件：MACD金叉 且 成交量>1.5倍」 | **界面示意**：只证明"且"是主示例 |
| PRD 编辑框 | 同文件 L342-L350 | 「组合策略：……条件 1 [MACD 金叉 ▾] …… 条件 2 [放量 ▾] …… ＋ 添加条件 适用品种 [排除跨境 ▾] 周期 [日线 ▾] 冷却 [3] 根 K 线内不重复」 | **界面示意**：有添加条件、适用品种、周期、冷却；**没有** OR、嵌套、条件级周期的表达 |
| PRD 组合规格 | 同文件 L357 | 「**组合策略** \| 多个条件开关 + 调参，**不为每种组合写插件** \| 已定」 | **已定口径**（与 INV-S3-18 同义） |
| PRD 适用品种 | 同文件 L358 | 「全部 / 仅股票 / 仅场内 ETF / 仅跨境 ETF / 排除跨境 / **排除现金类**」 | **已定口径** |
| PRD 适用周期 | 同文件 L359 | 「**日线（V3 只有日线）**」 | **已定口径** |
| PRD 冷却 | 同文件 L360 | 「**冷却期** \| N 根 K 线内同策略同标的同方向不重复」 | **已定口径**；落地为展示层合并 |
| PRD 跨境提示 | 同文件 L361、L544（U13） | 「选『仅跨境』或含跨境条件时提示……**编辑时提示一次**」 | **已定口径**（交互层） |
| PRD 分级展示 | 同文件 L380 | 「分级 \| 强 / 中 / 弱，**默认只显示强 + 今日 Top 5 摘要**」 | **已定口径**（F1/Top5 展示） |
| 任务 T133 | `docs/client/code_implementation_plan_v3.md` L159 | 验收点：「组合策略可表达『MACD金叉 且 放量』」 | **任务验收**，非需求原文 |
| 任务 T148 | 同文件 L199 | 「策略配置页 `/strategy/config`：分类、组合策略编辑器（条件开关+调参）、适用品种、冷却期」 | **排期项**，UI 落地 |

### 1.1 与本次组合方案相关的实现事实（基线 `origin/main`）

| 事实 | 证据 |
|---|---|
| 内置插件已含 `position_risk_alert`（`monitor` / `risk` / `requiresPositions=true`） | `apps/backend/src/services/pluginEngine.ts` L1160-L1170 |
| 风险插件只输出 `HOLD`，**不带 `strength`**，多规则合并为一条 | 同文件 L1286；单测 `apps/backend/tests/unit/position-risk-alert.test.ts` L6-L10、L123-L125 |
| 风险信号落库 `sub_category='risk'` 且 `strength=NULL` | 同测试 L267-L298；DDL `configStore.ts` L184、L205 |
| F1 分级只吃 `strength IS NOT NULL`，风险 HOLD 天然被排除 | `apps/backend/src/services/signalService.ts` L391-L409 |
| F6 冷却是**展示层合并去重**，不抑制生成；`cooldown_until` 只供展示判断 | 同文件 L442-L479、L510-L518（注释为用户指定口径） |
| 今日 Top5 默认排除 `sub_category='risk'`；通用 `/api/signal` 默认包含风险 | `apps/backend/src/routes/signal.ts` L292-L334、L153-L154 |
| 今日"最新一条"排除风险；Dashboard 的 Top5 传 `exclude_risk=1` | `apps/backend/src/services/todaySignals.ts` L66-L96；`apps/frontend/src/pages/Dashboard.tsx` L517 |
| 纸面 S1 只登记 `buy-and-hold` 与 `wufu-rotation`；插件策略接入属 S2 起 | `apps/backend/src/services/paper/strategies.ts` L8-L28 |

**关键判定**：
- 组合语义里**只有 AND**（"多个基础条件同时成立"）是需求定死的；OR、嵌套、跨标的、输出条数、强度合成、配置历史**需求原文未写** —— 已由 owner 拍板，见 §6。
- F6 冷却**不是待决策**：已定为展示层合并，组合沿用同一口径。
- 风险 HOLD **不是待决策**：它是独立插件、独立信号通道，不带 `strength`，与组合信号的共存方式见 §3.3。

---

## 2. 组合语义

| 维度 | 文档/已定口径 | 状态 | 决策号 |
|---|---|---|---|
| 条件间逻辑 | 只有 INV-S3-18 的"同时成立"；PRD 示例为"且" | **已定：MVP 仅 AND**；OR / 混合留 P1 | D1 已定 |
| 嵌套 | 无任何文档表述 | **文档未定义；排 P1** | D1 已定 |
| 条件周期 | PRD 编辑框只有**组合级**"周期 [日线]"；V3 仅日线 | 组合级日线**已定**；条件级独立周期未写 | 已定（V3 不做条件级周期） |
| 标的范围 | 信号表按 `asset_code` 一行一条；PRD 示例的条件都作用在同一标的上 | **同标的为隐含口径**；跨标的条件未写 | 已定（MVP 同标的；跨标的另开需求） |
| 组合命中输出 | 文档只说"出信号"；`user_strategy_signal` 唯一键是 `(user_id, asset_code, plugin_id, trade_date)` | **一条合成信号** | 已定（按唯一键一行） |
| 条件开关/调参 | INV-S3-19 | **已定** | — |
| 冷却 | PRD L348/L360、INV-S3-23 | 窗口 N=3 **已定**；**落地为展示层合并，不抑制生成** | **已定，不再决策** |
| 强度 | 文档未写组合强度如何合成 | **已定：`min(各启用条件 strength)`** | D2 已定 |
| 适用品种 | INV-S3-17、PRD L358 | 组合级**已定**；条件级不做 | **已定** |
| 组成条件是否仍单独出信号 | 文档未写 | 默认**不抑制**（各自独立） | 已定（无抑制需求；若后续要抑制另开） |
| HOLD / 风险条件 | 风险 HOLD 由独立插件产生 | **组合条件只接受 BUY/SELL 类 monitor 插件**，不把风险 HOLD 当条件 | **已定** |

> 明确不做推断：PRD 编辑框里没有 OR 按钮、没有括号、没有条件级周期下拉 —— 这些"没有"只是界面示意，不能反过来当作需求依据。**"MVP 仅 AND"与"强度取 min"是 owner 的拍板结果（§6），不是从原型反推的**。

---

## 3. 与现有能力的关系

### 3.1 可以直接复用的部分

| 能力 | 现有实现 | 复用方式 | 注意 |
|---|---|---|---|
| 条件计算 | `pluginEngine.executePlugin(plugin, params, ctx)`（`apps/backend/src/services/pluginEngine.ts` L1382-L1424） | 组合执行器对每个条件调用同一函数，**传入共享 ctx** | `executePlugin` 的 `ctx` 参数可外部注入（L1406），共享批量预取，不会每条件重查 DuckDB |
| 批量行情预取 | `executeAllPlugins` 的 `batchGetDailyRange` + `buildPluginContext`（L1822-L1825） | 组合与普通插件共用同一份预取 | 组合不要自己再循环查库 |
| 参数校验 | `validatePluginParams`（L1385） | 直接复用；条件参数沿用 `ParamField` | 满足 INV-S3-20/21 |
| 失败隔离 / 50ms | `executePlugin` 的超时与 ERROR/SKIP 语义（L1408-L1424） | 条件失败按"该标的本轮不成立"处理 | 不把组合整体拖成 TIMEOUT |
| 落库 | `persistSignals`（`signalService.ts` L107-L154） | 组合产出 `PluginSignal` 后直接调用，`pluginId='combo:<id>'`、`pluginCategory='monitor'`、`subCategory=NULL` | 唯一键天然去重 |
| F1 分级 | `assignSignalGrades`（L398-L440） | 组合写 `strength` 即自动参与 | **只处理 `strength IS NOT NULL`（L405-L406）** |
| F6 冷却 | `assignSignalCooldowns`（L480-L494）、`collapseSignalsByCooldown`（L520-L548） | 组合信号带 `plugin_id` 后自动参与展示合并 | 合并键是 `plugin_id|asset_code|direction`（L546）；**不抑制生成** |
| 每日链路 | `scheduler.ts` L408-L454；`admin.ts` L89-L104 | 两条链路都走 `executeAllPlugins`，只需在引擎内挂一次 | 避免"手动触发有组合、定时没有"的漂移 |
| 回测 | `Strategy` 接口（`backtest/strategy/types.ts` L189-L200） | 新增"组合信号跟随"适配器 | D3 已定：先批量预生成、再跟随，判据只有一份（§6.3） |
| 纸面 | `paper/strategies.ts` 的 `(id, version)` 注册表（L21-L44） | 组合适配器注册进 `BUILTINS` 后即可绑定纸面账户 | **纸面不直接读 `user_strategy_signal`**；S1 只有 buy-and-hold / wufu-rotation |

### 3.2 不能直接复用、必须新增的部分

1. **没有组合配置表**：需求口径中的 `strategy_config` 在仓库中**不存在**。现有表是 `user_plugin_config`（`configStore.ts` L230-L236），结构为 `(user_id, plugin_id, enabled, params_json)`，只能存单个插件的一份参数，无法表达"条件数组 + 顺序 + 开关"。
2. **没有组合层**：`executeAllPlugins` 固定 `filter(p => p.category === 'monitor')`（L1791-L1793），插件 id 来自内置/磁盘扫描；没有"由用户配置动态生成的条件集合"这一层。
3. **没有表达式/嵌套求值器**：现有引擎只会逐个插件执行，没有 AND/OR 树、没有条件依赖。
4. **风险 HOLD 不能当普通条件复用**：`position_risk_alert` 是组合级插件、只输出 `HOLD`、不带 `strength`，且读取整份持仓快照；把它放进 AND 条件会把"HOLD"当布尔量，语义错位。组合条件应限定为产出 `BUY`/`SELL` 的 monitor 插件；风险 HOLD 保持独立通道（§3.3）。

### 3.3 与 F1 / F6 / 今日 Top5 / 风险 HOLD 的相互作用

| 交互点 | 现状（含行号） | 组合接入后的影响 | 处理口径 |
|---|---|---|---|
| **F1 分级候选集** | `assignSignalGrades` 只取 `strength IS NOT NULL` 的行（`signalService.ts` L405-L406）；按**当日全部有强度信号**做分位定档（L414-L419） | 组合写 `strength` ⇒ 进入候选；不写 ⇒ `grade=NULL` ⇒ 不进强/中/弱页、不进 Top5。组合行会改变当日分位分母，**可能让原有信号降档** | 组合必须写 `strength`（D2 已定：取各条件 `min`）；**风险 HOLD 因 `strength=NULL` 天然不进候选，加入组合前后分位候选集逐行不变** |
| **F6 冷却展示** | **已定**：展示层合并去重，默认 3 根 K 线，同策略+同标的+同方向合并为一条并标注"连续第 N 日选中"；`cooldown_until` 只供展示判断，**不抑制生成**（L442-L518） | 组合信号按同一规则参与展示合并；库里仍按交易日逐条生成 | **组合沿用展示层口径**；不需要、也不应改成生成抑制 |
| **今日 Top5（F2/T149）** | `GET /api/signal/top5` 默认排除 `sub_category='risk'`（`routes/signal.ts` L292-L334）；Dashboard 传 `exclude_risk=1`（`Dashboard.tsx` L517） | 组合信号 `sub_category=NULL` ⇒ 可进 Top5；风险 HOLD 默认被排除 | 组合有 `strength`/`grade` 后自然进入候选；无需改 Top5 代码 |
| **风险 HOLD** | `position_risk_alert` 只输出 HOLD、`strength=NULL`、`sub_category='risk'`；通用信号列表默认包含、今日最新/Top5 默认排除（`todaySignals.ts` L66-L96） | 组合不产生 HOLD；组合信号与风险 HOLD 在同一信号表**分渠道共存**：组合进 F1/Top5，风险 HOLD 只在"全部信号/持仓风险区" | **已定**：组合条件不含 risk 插件；风险 HOLD 不进 F1、不进默认 Top5 |
| **信号唯一键** | `UNIQUE(user_id, asset_code, plugin_id, trade_date)`（`configStore.ts` L205） | 一个组合在同一标的同一天最多 1 条；改配置后重跑同一天会 `INSERT OR IGNORE` 跳过旧行 | D4 已定：历史不可变，`INSERT OR IGNORE` 保留当天首条 |
| **组成条件独立信号** | 现有插件各自独立落库 | 组合命中时，组成条件的单信号仍会存在；F6 只合并同 `plugin_id`，不会把组合与单条件合并 | 已定：**不抑制**组成条件；展示上可能出现"组合 + 单条件"两条，属预期 |

---

## 4. 数据模型

### 4.1 新增表（MVP 建议）

> 遵循项目 DDL 规则：只新增表，不改已有表约束；全部 `CREATE TABLE IF NOT EXISTS`，不引入迁移框架。

```sql
-- 组合策略主表
CREATE TABLE IF NOT EXISTS strategy_combo (
    id              TEXT PRIMARY KEY,              -- 'combo_' || 递增号 或 ULID
    user_id         INTEGER NOT NULL,
    name            TEXT NOT NULL,                 -- "MACD金叉+量能确认"
    enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    combine_op      TEXT NOT NULL DEFAULT 'AND'    -- MVP 固定 AND；完整版扩展 AND/OR
                    CHECK (combine_op IN ('AND', 'OR')),
    asset_scope     TEXT NOT NULL DEFAULT 'all'    -- INV-S3-17：all/stock/etf/cross_border/exclude_cross_border/exclude_cash
                    CHECK (asset_scope IN ('all','stock','etf','cross_border','exclude_cross_border','exclude_cash')),
    period          TEXT NOT NULL DEFAULT 'daily' CHECK (period IN ('daily')),
    cooldown_bars   INTEGER NOT NULL DEFAULT 3 CHECK (cooldown_bars >= 1 AND cooldown_bars <= 20),
    config_version  INTEGER NOT NULL DEFAULT 1,    -- 每次条件变更 +1
    is_deleted      INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);

-- 组合条件（有序）
CREATE TABLE IF NOT EXISTS strategy_combo_condition (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    combo_id        TEXT NOT NULL,
    seq             INTEGER NOT NULL,              -- 展示顺序，从 1 开始
    plugin_id       TEXT NOT NULL,                 -- 只允许产出 BUY/SELL 的 monitor 插件
    enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    params_json     TEXT NOT NULL,                 -- 形状 = 插件 paramSchema
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(combo_id, seq),
    FOREIGN KEY (combo_id) REFERENCES strategy_combo(id)
);
CREATE INDEX IF NOT EXISTS idx_combo_user ON strategy_combo(user_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_combo_condition ON strategy_combo_condition(combo_id, seq);
```

**不新增信号表、不改 `user_strategy_signal` 结构（MVP）**：组合信号复用该表，编码见 4.3；若后续需要更强可查询性，再评估加 `source_type` / `combo_id` 列（加列而非改约束）。

### 4.2 与 `strategy_config` / `user_plugin_config` 的关系

- 仓库中**不存在** `strategy_config` 或 `user_strategy_config`；需求/对话里的这个称呼对应实际表 `user_plugin_config`。
- `user_plugin_config` **不建议复用**：它是"一个插件一行参数"，无法表达有序条件数组；复用会让 `/api/strategy/plugins` 的插件列表出现"伪插件"，并与磁盘插件的 id 唯一性冲突。
- 结论：**组合配置独立建表**；`user_plugin_config` 继续只管单插件启停与参数，组合启停由 `strategy_combo.enabled` 唯一决定，避免双写。

### 4.3 组合信号在 `user_strategy_signal` 中的编码

| 字段 | 取值 | 理由 |
|---|---|---|
| `plugin_id` | `combo:<combo_id>` | 复用唯一键与 F6 合并键；无需改表 |
| `plugin_category` | `'monitor'` | CHECK 只允许 monitor/filter（L179） |
| `sub_category` | `NULL` | 组合不是风险类；避免被 Top5 的 `risk` 过滤误伤 |
| `direction` | `'buy'` / `'sell'`（**不输出 `hold`**） | 组合只做机会信号；风险 HOLD 由 `position_risk_alert` 独立负责 |
| `label` | 例如 `MACD金叉 且 放量1.5倍（组合）` | 人读标签 |
| `strength` | `min(各启用条件 strength)`（D2 已定） | **不写就不参与 F1 分级** |
| `metrics_json` | `{combo_id, matched: [...], conditions: {pluginId: metrics}}` | 满足 INV-S3-26 的"指标值" |
| `snapshot_json` | 组合配置快照 + 当日各条件输入摘要 | 配置变更后可回溯"当时用的是什么组合" |
| `origin` | `'live'` / `'replay'` | 复用现有列 |

> 组合信号与风险 HOLD 的区分只靠 `sub_category`：`NULL` = 普通机会信号（进 F1/Top5）；`'risk'` = 风险提示（不进 F1、默认不进 Top5）。

### 4.4 配置变更对历史信号的影响

| 场景 | 影响 | 口径（D4 已定） |
|---|---|---|
| 用户改条件/参数 | 只影响之后的交易日；历史 `user_strategy_signal` 行**不重算、不删除** | 默认"历史不可变"，用 `snapshot_json` 回溯 |
| 同一天重跑（手动触发/回放） | 唯一键命中 ⇒ `INSERT OR IGNORE` 跳过旧行，**新配置不会覆盖当天旧组合信号** | 若要"重算当天"，需显式删除/软删当天 `combo:` 行后再写 |
| 配置版本回放 | 需要按"当时版本"重放，而不是当前版本 | 用 `config_version` + `snapshot_json` |
| 停用组合 | 后续不再生成；历史行保留 | 与软删除约束一致 |

---

## 5. 实现分期

### 5.1 MVP（P0）：一条 AND 组合能配、能出信号、能被回测/纸面使用

**范围**

1. 新建 `strategy_combo` + `strategy_combo_condition`（§4.1）。
2. 组合 CRUD API：
   - `GET /api/strategy/combos`
   - `POST /api/strategy/combos`
   - `PUT /api/strategy/combos/:id`（`config_version+1`）
   - `PUT /api/strategy/combos/:id/toggle`
   - `DELETE /api/strategy/combos/:id`（软删）
3. 组合执行器 `services/comboStrategy.ts`：
   - 读取启用组合 → 按 `asset_scope` 过滤标的 → 对每个标的、每个条件调用 `executePlugin(conditionPlugin, params, sharedCtx)`；
   - **条件候选白名单**：`category='monitor'` 且 `subCategory !== 'risk'`（排除 `position_risk_alert`）；
   - **AND**：全部启用条件都返回 `BUY` 才出 `BUY`；全部返回 `SELL` 才出 `SELL`；混合方向不出信号；
   - 输出 1 条 `PluginSignal`，`pluginId='combo:<id>'`、`subCategory=NULL`、`strength = min(各启用条件的 strength)`（D2 已定）；
   - 任一条件失败/超时 ⇒ 该标的组合本轮不成立，记 WARN，不 block 其他标的。
4. 链路接入：在 `executeAllPlugins` 的批量预取之后、返回之前执行组合（`pluginEngine.ts` L1822-L1871 区间），使 `scheduler` 与 `admin` 自动共享；组合单独计数，不改变普通插件统计口径。
5. 落库：复用 `persistSignals`；随后现有 `assignSignalGrades`、`assignSignalCooldowns` 照常执行，组合行自动参与 F1/Top5/F6。
6. 前端 MVP：在 `apps/frontend/src/pages/StrategyConfig.tsx` 增加"组合策略"区块（当前页面只按 monitor/filter 列插件，L122-L178）：
   - 列表、启用开关、编辑弹层；
   - 条件选择（仅 BUY/SELL 的 monitor 插件）、参数表单、条件开关；
   - 适用品种、周期（固定日线）、冷却（默认 3）；
   - 跨境提示沿用现有一次性提示（L44、L73、L182）。
7. 回测/纸面共用适配器：
   - 新增 `backtest/strategies/comboSignal.ts`，实现 `Strategy.decide(ctx)`；按 D3 已定口径走"历史逐日预生成组合信号 + 跟随"两段式，**回测与实盘共用同一份条件实现**，保证无前视（`types.ts` L151-L182 的 `asOf=T-1` 契约）。
   - 把该适配器注册进 `paper/strategies.ts` 的 `BUILTINS`（L21-L28），纸面账户即可绑定；**纸面 S1 不读信号表**，不能假设"写了 `user_strategy_signal` 就自动生效"。

**验收点（P0）**

| 编号 | 验收 |
|---|---|
| A1 | 配一条 `MACD金叉 AND 放量>1.5`：两条件同时成立的标的出 1 条 `BUY`；只有一条成立时 0 条 |
| A2 | 组合信号写入 `user_strategy_signal`，`plugin_id='combo:<id>'`、`sub_category=NULL`、`strength` 非空，`grade` 被 F1 回填 |
| A3 | 组合信号在同一策略+标的+方向、冷却窗口内按**展示层合并**；库里仍逐日生成（与 F6 现状一致） |
| A4 | 手动触发与 17:02 定时链路结果一致（都经过 `executeAllPlugins`） |
| A5 | 停用组合后，后续交易日不再产生新信号；历史行保留 |
| A6 | 组合行可被 `/api/signal` 查询、可参与强/中/弱筛选、可进今日 Top5 |
| A7 | 组合适配器注册后，回测与纸面都可按 `(id, version)` 解析；纸面不依赖信号表 |
| A8 | 条件参数越界/条件插件不存在/条件为 risk 插件 ⇒ 400 `PARAM_INVALID` 或创建失败，不写半成品配置 |
| A9 | **风险 HOLD 隔离**：组合上线前后，`position_risk_alert` 的 HOLD 行仍为 `strength=NULL`、不进 F1 强/中/弱、不进默认 Top5；F1 分位候选集只新增组合行，风险行逐行不变 |

**涉及文件（P0，预计 4 个 T 任务）**

| 层 | 文件 | 改动 |
|---|---|---|
| DB | `apps/backend/src/config/configStore.ts` | 新增两张组合表 + 索引（幂等） |
| 服务 | 新增 `apps/backend/src/services/comboStrategy.ts` | 组合 CRUD 读取、条件求值、AND 聚合、信号合成 |
| 引擎 | `apps/backend/src/services/pluginEngine.ts` | 批量执行后调用组合执行器（共享 `ctx`） |
| 路由 | 新增 `apps/backend/src/routes/combo.ts` 或扩展 `routes/plugin.ts` | 组合 CRUD + toggle |
| 回测/纸面 | 新增 `apps/backend/src/services/backtest/strategies/comboSignal.ts`；改 `services/paper/strategies.ts` | 适配器 + 注册表 |
| 前端 | `apps/frontend/src/pages/StrategyConfig.tsx` | 组合区块 + 编辑弹层 |
| 测试 | `tests/unit/comboStrategy.test.ts`、`tests/integration/combo.test.ts`、`apps/frontend/tests/unit/strategy-pages.test.tsx` | AND 聚合、落库、分级、冷却、风险隔离、UI |

### 5.2 完整版（P1）

| 能力 | 增量 | 决策状态 |
|---|---|---|
| OR / 混合逻辑 | `combine_op` 扩展；UI 增加逻辑选择；求值器支持 OR | D1 已定：MVP 仅 AND，OR 排 P1 |
| 嵌套 | 条件树（表达式 JSON）或"子组合"引用；求值器递归 | D1 已定：嵌套排 P1 |
| 组合强度模型 | 加权平均 / 命中占比等可选模型（需先有业务依据） | D2 已定：MVP 取 min；加权属 P1 可选 |
| 配置版本化回放 | 回放按 `config_version` / `snapshot_json` 重放 | D4 已定：历史不可变，版本回放排 P1 |
| 评估分组 | 有效性页按"组合"分组（SDD_v3 §10.4 维度） | — |
| 多用户 | 组合按 `user_id` 隔离执行；当前 `executeAllPlugins` 是单用户口径 | — |
| 策略列表统一 | 组合以"虚拟策略"出现在 `/api/strategy/plugins`，与插件列表同构 | — |

**完整版工作量量级：约 6~8 个 T 任务**（不含今日 Top5/T149、T148 全量 UI 的独立排期）。

### 5.3 明确不在本方案范围

- 今日 Top5（F2/T149）本身仍按独立任务实现；本方案只保证组合信号**能被 Top5 消费**（`sub_category=NULL` + `strength` + `grade`）。
- 风险类插件 `position_risk_alert` 不改动；组合不产出 HOLD，风险 HOLD 继续走独立信号通道。
- 分钟线、盘中组合、自动交易：Out-Scope。
- 复杂形态（双顶/头肩/三角旗形等）不放进插件层，也不成为组合条件；按既有口径留在 `Strategy` 层配合仓位管理。

---

## 6. 已定口径（owner 已拍板，不再列为待决策）

> 2026-11-08 owner 拍板。以下四项直接作为 T133 / T148 与 PA 任务的验收依据，实现不得再按其他口径分叉。

### 6.1 D1 组合逻辑：MVP 只做 AND

| 项 | 内容 |
|---|---|
| 口径 | MVP **只做 AND**：所有启用条件同向成立才产出 1 条信号；**OR、嵌套（条件树）全部留 P1** |
| 理由 | ① INV-S3-18 原文即"多个基础条件同时成立"，AND 是需求唯一写死的逻辑；② PRD 组合编辑框只表达"且"，没有 OR/括号；③ AND 的求值器、UI、测试矩阵最小，可先把"配置 → 信号 → 分级 → 冷却 → Top5 → 回测/纸面"整链跑通 |
| 落地 | `combine_op` 字段保留（CHECK 限 `AND`/`OR`），但 MVP 写入与校验只接受 `AND`；求值器不实现 OR 分支；UI 不出现逻辑切换控件 |
| 明确不做 | 不实现 OR 求值、不实现括号/嵌套、不实现"子组合引用"；这些需求出现前不加代码 |

### 6.2 D2 组合强度：取各条件 strength 的 min

| 项 | 内容 |
|---|---|
| 口径 | 组合 `strength = min(所有启用条件的 strength)` —— **最弱一环决定整体可信度** |
| 理由 | ① 语义一致：AND 要求全部成立，整体可信度不应高于最弱条件；② 可解释：能够指认是哪一条拖低了强度；③ 零参数：min 不需权重配置，避免 INV-S3-21"默认参数必须有依据"的举证负担；④ 稳定：MVP 没有可信的权重来源 |
| 明确不做 | **不用加权平均、不用命中条件数占比**；两者留 P1 作为可选模型，且必须先给出业务依据 |
| 注意 | 组合行写 `strength` ⇒ 进入 F1 当日分位候选集，**会改变当日分位分母**；验收需对比"有/无组合"的档位分布（§8） |

### 6.3 D3 回测口径：先批量预生成信号，再跟随

| 项 | 内容 |
|---|---|
| 口径 | 回测**先按历史交易日批量预生成组合信号**（与实盘同一套条件实现、同一套 AND + min 求值），再由 `Strategy.decide()` **跟随已生成的信号** |
| 理由 | ① **判据只有一份**：回测不在 `decide()` 内重写条件，避免"回测一套、实盘一套"的算法漂移；② 无前视可控：预生成阶段显式按 `asOf=T-1` 截断，跟随阶段只读 `<= asOf` 的信号；③ 可复现：两侧吃同一份信号口径，差异只来自成交/仓位假设 |
| 允许的例外 | 预生成结果可落临时缓存（不必进业务表），但**不得使用与实盘不同的判据**；性能不足时优化预生成，不改判据 |
| 明确不做 | 不允许"回测内部重算条件"作为第二套实现；不做分钟级/盘中回测 |

### 6.4 D4 配置变更与历史：历史不可变，只影响未来

| 项 | 内容 |
|---|---|
| 口径 | 组合配置（条件、参数、开关、适用品种、冷却）变更**只影响变更之后的交易日**；历史 `user_strategy_signal` 行**不重算、不覆盖、不删除** |
| 理由 | ① 信号是"当时判据下的证据"，改配置即改写历史等于伪造回溯；② 唯一键 `(user_id, asset_code, plugin_id, trade_date)` 下重跑当天只能 `INSERT OR IGNORE`，天然保留首条；③ 复盘需要"当时用了什么配置"，由 `config_version` + `snapshot_json` 提供 |
| 落地 | 每次条件/参数变更 `config_version+1`，并把变更时的组合配置写入信号 `snapshot_json`；同一天重跑命中唯一键即跳过 |
| P1 | **配置版本化回放**：按 `config_version` 选择历史版本重放，排 P1；MVP 不提供"按旧版本重算历史"的入口 |
| 明确不做 | 不提供"覆盖当天旧信号"的常规路径；若未来要"修正配置并重算"，须另开需求并显式软删当天 `combo:` 行 |

### 6.5 其他已定口径（此前已确认）

| 事项 | 已定口径 |
|---|---|
| F6 冷却 | **展示层合并去重**：同策略+同标的+同方向、默认 3 根 K 线合并为一条并标注"连续第 N 日选中"；`cooldown_until` 只供展示判断，**不抑制信号生成**；组合沿用 |
| 风险 HOLD | 由 `position_risk_alert` 独立产生，`sub_category='risk'`、`strength=NULL`；**不进 F1 分级、默认不进今日 Top5**；组合不产出 HOLD、条件白名单排除 risk 插件 |
| 组合输出 | 同标的、日线、一条合成信号（唯一键一行） |
| 适用品种 | 组合级声明（INV-S3-17），不做条件级 |
| 条件失败 | 该标的组合本轮不成立，记 WARN，不影响其他标的 |
| 组成条件独立信号 | 不抑制；组合与单条件各自独立落库/展示 |
| 组合 id 编码 | `plugin_id='combo:<id>'`，`sub_category=NULL`（实现细节） |

---

## 7. 实现任务拆分（PA-xx）

> 交付单元仍按「一个 T 任务一条 commit」；PA 是 T133 / T148 内部可独立提交的子任务。
> ⚠️ **公共文件** = `pluginEngine.ts`、`routes/signal.ts`、`signalService.ts`、`SDD.md`。
> `#126` / `#127` / `#128` 正在合并且会改其中三个（`pluginEngine.ts`、`routes/signal.ts`、`SDD.md`），故
> **PA-01 ~ PA-05 可立即做（新增文件为主，不碰公共文件）；PA-06 ~ PA-10 暂缓**，等三个 PR 合完再开。

### 7.1 可立即做（仅新增文件）

| 编号 | 任务 | 新增/改动文件 | 依赖 | 验收点 |
|---|---|---|---|---|
| **PA-01** | 组合配置表 DDL（**独立文件**，先不改 `configStore.ts`） | 新增 `apps/backend/src/config/comboSchema.ts`：导出 `ensureComboTables(db)`，内含 `strategy_combo` / `strategy_combo_condition` + 索引（§4.1） | 无 | `:memory:` 重复调用幂等；非法 `combine_op` / `asset_scope` 被 CHECK 拒绝；索引存在；不改 `user_strategy_signal` 结构 |
| **PA-02** | 组合配置仓储（纯 SQL 封装） | 新增 `apps/backend/src/services/comboRepo.ts`：CRUD、条件有序读写、软删、`config_version+1` | PA-01 | CRUD 往返一致；`seq` 重排不冲突；软删后查询不可见；版本号单调递增；全部 prepared statement |
| **PA-03** | 组合求值模块（纯逻辑：AND + min） | 新增 `apps/backend/src/services/comboEvaluator.ts`：`evaluateCombo(conditions, results)`，输出方向与 `strength=min` | 无（纯函数） | 全 BUY→BUY；全 SELL→SELL；混合方向→不成立；空条件→不成立；任一条件 SKIP/ERROR→该标的本轮不成立；`min` 取最弱；不读库、不碰插件上下文 |
| **PA-04** | Strategy 适配器骨架（信号跟随） | 新增 `apps/backend/src/services/backtest/strategies/comboSignal.ts`：实现 `Strategy` 接口，依赖注入"信号源"（读 `<= asOf` 的预生成信号） | PA-03 | `asOf=T-1` 不读当日；`(id, version)` 可解析；用假信号源的纯单测可跑通；**暂不注册 `paper/strategies.ts`** |
| **PA-05** | 单测（新增测试文件） | 新增 `tests/unit/comboSchema.test.ts`、`tests/unit/comboRepo.test.ts`、`tests/unit/comboEvaluator.test.ts`、`tests/unit/comboSignal.test.ts` | PA-01 ~ PA-04 | 全部在 `MARKET_DATA_MODE=mini` 下通过、不依赖真库；逐条覆盖 §6.1 ~ §6.4；不占端口（`singleFork=true`） |

### 7.2 暂缓（会碰公共文件或与在途 PR 冲突）

| 编号 | 任务 | 新增/改动文件 | 依赖 | 验收点 | 公共文件 |
|---|---|---|---|---|---|
| **PA-06** | 接入每日链路 | ⚠️ 改 `apps/backend/src/services/pluginEngine.ts`：`executeAllPlugins` 批量预取后调用组合求值（共享 `ctx`） | PA-02 / PA-03 + **#126-128 合并** | 手动触发与 17:02 定时结果一致；普通插件统计口径不变；条件失败隔离 | ⚠️ `pluginEngine.ts` |
| **PA-07** | 组合 CRUD 路由 | 新增 `apps/backend/src/routes/combo.ts` + 注册（`app.ts` / `routes/index.ts` 视现状）；**不扩展 `routes/signal.ts`** | PA-02 | create / list / update / toggle / delete 全链路；非法条件 400 `PARAM_INVALID`；软删不物理删 | ⚠️ 若必须改 `routes/signal.ts` 则等合并；注册点也可能与他 PR 冲突 |
| **PA-08** | 前端组合配置区块 | 改 `apps/frontend/src/pages/StrategyConfig.tsx`；新增 `apps/frontend/src/components/ComboEditor.tsx` | PA-07 | 条件增删/开关/调参、适用品种、固定日线、冷却默认 3；跨境提示一次；risk 插件不出现在条件候选 | 非四公共文件，但需与 T148 UI 排期协调 |
| **PA-09** | 纸面注册适配器 | 改 `apps/backend/src/services/paper/strategies.ts`：`BUILTINS` 增加组合适配器 | PA-04 | 纸面可绑定并按 `(id, version)` 解析；**不改纸面账户 / 盈亏口径**；不假设"写信号表即生效" | 非四公共文件，但需与纸面 PR 协调 |
| **PA-10** | 契约与计划更新 | ⚠️ 改 `docs/client/SDD.md`（V3 契约若落 `SDD_v3.md` 同样暂缓）；改 `docs/client/code_implementation_plan_v3.md`（T133 / T148 的 PA 登记） | PA-01 ~ PA-09 定稿 + **三 PR 合并** | SDD 只写契约（表 / 接口 / 信号编码），不复述业务理由；计划只写任务与依赖 | ⚠️ `SDD.md` / `SDD_v3.md`、计划文件 |

> `signalService.ts` **预计不需要改**：组合复用 `persistSignals`、`assignSignalGrades`、`assignSignalCooldowns` 的既有入口（只调用、不改实现）。若实现中发现必须改，按公共文件暂缓处理。

---

## 8. 风险与回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| F1 分位漂移 | 组合行加入当日强度集合，可能让原有信号降档 | D2 已定 min（§6.2）；验收对比"有/无组合"的分级分布 |
| 风险 HOLD 混入机会信号 | 若组合条件误选 risk 插件，会把 HOLD 当布尔条件 | 条件白名单排除 `sub_category='risk'`；A9 专门验收 |
| 重复展示 | 组合信号与组成条件信号在信号页并存 | 已定不抑制；F6 合并键按 `plugin_id`，不会互相合并 |
| 性能 | N 条件 × M 标的，若每条件重复查库会放大 | 共享 `executeAllPlugins` 的预取 `ctx`；条件级 50ms 预算复用 `executePlugin` |
| 回测前视 | 组合在回测中若直接读实时库 | 走 `asOf` 锁定终点（`executeAllPlugins` L1819-L1825、`StrategyContext` L151-L182） |
| 配置漂移 | 改配置后无法解释历史信号 | `config_version` + `snapshot_json`；历史行不重算 |
| 纸面未接入 | 误以为写信号表就自动进纸面 | 必须注册 `paper/strategies.ts` 的 `BUILTINS`；A7 验收 |
| 回滚 | 组合出问题需快速停用 | `enabled=0` 立即停止后续生成；历史行保留；不需要删表 |

---

## 9. 参考索引

| 内容 | 位置 |
|---|---|
| 组合不变量 | `docs/client/InvestAssistantV3_NewRequirements.md` L667-L668（INV-S3-18/19） |
| 信号生命周期 | 同文件 L672-L683（INV-S3-22~27） |
| PRD 组合编辑框 | `docs/client/PRD_v3.md` L326-L361 |
| PRD 信号分级 | 同文件 L363-L384 |
| 任务 T133/T148 | `docs/client/code_implementation_plan_v3.md` L159、L199 |
| 插件引擎契约 | `apps/backend/src/services/pluginEngine.ts` L198-L242、L1382-L1424、L1785-L1871 |
| 风险插件 | 同文件 L1160-L1300（HOLD 分支 L1286） |
| 风险插件单测 | `apps/backend/tests/unit/position-risk-alert.test.ts` L6-L10、L123-L125、L267-L298 |
| 信号落库/分级/冷却 | `apps/backend/src/services/signalService.ts` L88-L154、L391-L440、L442-L548 |
| 信号表 DDL | `apps/backend/src/config/configStore.ts` L174-L205 |
| 插件配置表 DDL | 同文件 L230-L236 |
| Top5 风险过滤 | `apps/backend/src/routes/signal.ts` L292-L334；`todaySignals.ts` L66-L96；`Dashboard.tsx` L517 |
| 每日链路 | `apps/backend/src/services/scheduler.ts` L408-L454 |
| 插件配置 API | `apps/backend/src/routes/plugin.ts` L64-L160 |
| 回测策略接口 | `apps/backend/src/services/backtest/strategy/types.ts` L189-L200 |
| 纸面策略注册表 | `apps/backend/src/services/paper/strategies.ts` L21-L44 |
| 纸面方案（规划） | `docs/audit/proposal-paper-account.md` |
| 策略目录盘点（规划） | `docs/audit/proposal-strategy-catalog-plan.md` |
