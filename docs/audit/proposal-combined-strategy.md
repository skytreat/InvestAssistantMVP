# 组合策略（T133 / T148）方案

> 状态：方案提案，**待决策**。本文件只做设计与排期，不含实现代码。
> 关联需求：`INV-S3-18/19`（策略可组合、条件独立开关调参）、`INV-S3-23/24/25/26`（冷却、分级、Top N、快照）。
> 关联任务：`code_implementation_plan_v3.md` 的 **T133**（策略分类/组合/适用品种）与 **T148**（策略配置页 UI）。
> 关联文档：`PRD_v3.md` §4.1 ⑤、`InvestAssistantV3_NewRequirements.md` §4.2、`SDD_v3.md` §10.4。
> 起草日期：2026-11-08。

---

## 0. 结论摘要（先看这里）

| 项 | 结论 |
|---|---|
| **MVP 范围** | 一条 **AND** 组合（2 个及以上条件）、日线、同标的、只产出 **1 条合成监控信号**，写入现有 `user_strategy_signal`；复用现有插件条件计算、`persistSignals`、F1 分级、F6 冷却展示 |
| **MVP 工作量量级** | 约 **4 个 T 任务**（DDL/CRUD、组合执行器、链路接入、前端最小编辑器），不含 F2 与纸面/回测专项改造 |
| **完整版增量** | OR / 嵌套、条件级适用品种与周期、HOLD/风险条件、生成级冷却、配置版本化回放、组合评估分组、多用户隔离；再约 **6~8 个 T 任务** |
| **必须先定的决策** | D1 组合逻辑（是否 OR/嵌套）、D5 冷却到底是"生成抑制"还是"仅展示合并"、D7 回测口径、D8 是否允许 HOLD/风险条件、D9 配置变更与历史信号口径 |
| **文档与实现冲突** | `INV-S3-23` 要求"不得重复产生信号"，但当前 F6 **只在展示层合并、不抑制生成**；组合策略必须显式选一边，不能默认沿用 |

---

## 1. 需求原文依据（逐条摘录）

> 说明："已定口径"= 需求明确、可直接作为验收依据；"界面示意"= PRD 的 ASCII 原型，只能说明交互形态，不能推出组合语义；"任务验收"= 实施计划里的验收点，不是需求原文。

| 编号 | 出处 | 原文 | 性质 |
|---|---|---|---|
| INV-S3-18 | `docs/client/InvestAssistantV3_NewRequirements.md` L667 | 「策略**必须可组合**（多个基础条件同时成立才出信号），而非每种组合各写一个策略」 | **已定口径**：AND 语义、禁止为组合写插件 |
| INV-S3-19 | 同文件 L668 | 「组合策略的**每个条件可独立开关与调参**」 | **已定口径** |
| INV-S3-20 | 同文件 L669 | 「策略参数**必须具名、必须声明取值范围与默认值**，禁止魔法数」 | **已定口径**：条件参数沿用 `ParamField` |
| INV-S3-21 | 同文件 L670 | 「策略的**默认参数必须来自可解释的依据**……不得凭直觉设定」 | **已定口径** |
| INV-S3-17 | 同文件 L658 | 「策略**必须声明其适用品种**（全部 / 仅股票 / 仅场内 ETF / 仅跨境 ETF / 排除跨境等）」 | **已定口径**：组合也应声明 |
| INV-S3-23 | 同文件 L679 | 「**冷却期**：同一策略 + 同一标的 + 同一方向，在 N 根 K 线内**不得重复产生信号**（N 可配置，默认 3）」 | **已定口径**；与当前 F6 实现冲突，见 §3.3 |
| INV-S3-24 | 同文件 L680 | 「信号**必须分级**（强 / 中 / 弱），默认只推送强信号」 | **已定口径** |
| INV-S3-25 | 同文件 L681 | 「每日推送**必须有 Top N 摘要**，不得把全部信号倾泻给用户」 | **已定口径**（F2/T149 范围） |
| INV-S3-26 | 同文件 L682 | 「信号**必须可回溯当时的输入数据**（触发时的 K 线、指标值）」 | **已定口径**：组合信号也要写快照 |
| PRD 组合示例 | `docs/client/PRD_v3.md` L338-L339 | 「MACD 金叉 + 量能确认（组合）……条件：MACD金叉 且 成交量>1.5倍」 | **界面示意**：只证明"且"是主示例 |
| PRD 编辑框 | 同文件 L342-L350 | 「组合策略：……条件 1 [MACD 金叉 ▾] …… 条件 2 [放量 ▾] …… ＋ 添加条件 适用品种 [排除跨境 ▾] 周期 [日线 ▾] 冷却 [3] 根 K 线内不重复」 | **界面示意**：有添加条件、适用品种、周期、冷却；**没有** OR、嵌套、条件级周期的表达 |
| PRD 组合规格 | 同文件 L357 | 「**组合策略** \| 多个条件开关 + 调参，**不为每种组合写插件** \| 已定」 | **已定口径**（与 INV-S3-18 同义） |
| PRD 适用品种 | 同文件 L358 | 「全部 / 仅股票 / 仅场内 ETF / 仅跨境 ETF / 排除跨境 / **排除现金类**」 | **已定口径** |
| PRD 适用周期 | 同文件 L359 | 「**日线（V3 只有日线）**」 | **已定口径** |
| PRD 冷却 | 同文件 L360 | 「**冷却期** \| N 根 K 线内同策略同标的同方向不重复」 | **已定口径** |
| PRD 跨境提示 | 同文件 L361、L544（U13） | 「选『仅跨境』或含跨境条件时提示……**编辑时提示一次**」 | **已定口径**（交互层） |
| PRD 分级展示 | 同文件 L380 | 「分级 \| 强 / 中 / 弱，**默认只显示强 + 今日 Top 5 摘要**」 | **已定口径**（F1/F2 展示） |
| 任务 T133 | `docs/client/code_implementation_plan_v3.md` L159 | 验收点：「组合策略可表达『MACD金叉 且 放量』」 | **任务验收**，非需求原文 |
| 任务 T148 | 同文件 L199 | 「策略配置页 `/strategy/config`：分类、组合策略编辑器（条件开关+调参）、适用品种、冷却期」 | **排期项**，UI 落地 |

**关键判定**：文档对组合**只定死了 AND**（"多个基础条件同时成立"），其余语义（OR、嵌套、跨标的、输出条数、强度合成、配置历史）**均未写**，本方案不做替用户决定。

---

## 2. 组合语义

| 维度 | 文档写了什么 | 状态 | 决策号 |
|---|---|---|---|
| 条件间逻辑 | 只有 INV-S3-18 的"同时成立"；PRD 示例为"且" | **AND 已定**；OR / 混合未写 | D1 |
| 嵌套 | 无任何文档表述 | **文档未定义** | D1 |
| 条件周期 | PRD 编辑框只有**组合级**"周期 [日线]"；V3 仅日线 | 组合级日线**已定**；条件级独立周期未写 | D2 |
| 标的范围 | 信号表按 `asset_code` 一行一条；PRD 示例的条件都作用在同一标的上 | **同标的为隐含口径**；跨标的条件未写 | D3 |
| 组合命中输出 | 文档只说"出信号"；`user_strategy_signal` 的唯一键是 `(user_id, asset_code, plugin_id, trade_date)` | **一条合成信号为最自然映射**，但文档未明说 | D4 |
| 条件开关/调参 | INV-S3-19 | **已定** | — |
| 冷却 | PRD L348/L360、INV-S3-23 | 窗口 N=3 **已定**；"生成抑制 vs 展示合并"未定 | D5 |
| 强度 | 文档未写组合强度如何合成 | **文档未定义** | D6 |
| 适用品种 | INV-S3-17、PRD L358 | 组合级**已定**；条件级是否可不同未写 | D12 |
| 组成条件是否仍单独出信号 | 文档未写 | **文档未定义** | D11 |
| HOLD / 风险条件 | 文档未写组合能否输出 HOLD | **文档未定义** | D8 |

> 明确不做推断：PRD 编辑框里没有 OR 按钮、没有括号、没有条件级周期下拉，因此**不能**据此认定"只支持 AND、只支持同周期"是需求；这些仍是待决策项。

---

## 3. 与现有能力的关系

### 3.1 可以直接复用的部分

| 能力 | 现有实现 | 复用方式 | 注意 |
|---|---|---|---|
| 条件计算 | `pluginEngine.executePlugin(plugin, params, ctx)`（`apps/backend/src/services/pluginEngine.ts` L1382-L1424） | 组合执行器对每个条件调用同一函数，**传入共享 ctx** | `executePlugin` 的 `ctx` 参数可外部注入（L1406），因此可共享批量预取的行情，不会每个条件重新查 DuckDB |
| 批量行情预取 | `executeAllPlugins` 的 `batchGetDailyRange` + `buildPluginContext`（L1822-L1825） | 组合与普通插件共用同一份预取 | 组合不要自己再循环查库 |
| 参数校验 | `validatePluginParams`（L1385） | 直接复用；条件参数沿用 `ParamField` | 满足 INV-S3-20/21 |
| 失败隔离 / 50ms | `executePlugin` 的超时与 ERROR/SKIP 语义（L1408-L1424、L1426 起） | 条件失败按"该条件本轮不成立"处理（需 D10 确认） | 不要把组合整体拖成 TIMEOUT |
| 落库 | `persistSignals`（`signalService.ts` L107-L154） | 组合产出 `PluginSignal` 后直接调用，`pluginId = 'combo:<id>'`、`pluginCategory='monitor'` | 唯一键天然去重 |
| F1 分级 | `gradeSignalStrengths` / `assignSignalGrades`（L348-L358、L379-L410） | 组合信号写 `strength` 即自动参与 | **只处理 `strength IS NOT NULL`（L386-L389）** |
| F6 冷却 | `assignSignalCooldowns`（L461-L475）、`collapseSignalsByCooldown`（L501 起） | 组合信号带 `plugin_id` 后自动参与展示合并 | 合并键是 `plugin_id|asset_code|direction`（L527） |
| 每日链路 | `scheduler.ts` L408-L454；`admin.ts` L89-L104 | 两条链路都走 `executeAllPlugins`，只需在引擎内挂一次 | 避免出现"手动触发有组合、定时没有"的漂移 |
| 回测 | `Strategy` 接口（`backtest/strategy/types.ts` L189-L200） | 新增一个"跟随组合信号"的策略适配器 | 回测不复用 DuckDB 实时查询路径，需 D7 |
| 纸面 | 当前 main 无纸面代码（`proposal-paper-account.md` 仅为规划） | 组合信号是标准 `monitor` 行，纸面若按 `category='monitor'` 读信号则零改动 | 需在纸面分支确认读取口径 |

### 3.2 不能直接复用、必须新增的部分

1. **没有组合配置表**：需求口径中的"`strategy_config`"在仓库中**不存在**（全仓检索 `strategy_config` 0 命中）。现有表是 `user_plugin_config`（`configStore.ts` L225-L233），结构为 `(user_id, plugin_id, enabled, params_json)`，只能存**单个插件的一份参数**，无法表达"条件数组 + 顺序 + 开关"。
2. **没有组合层**：`executeAllPlugins` 固定 `filter(p => p.category === 'monitor')`（L1791-L1793），插件 id 来自内置/磁盘扫描；没有"由用户配置动态生成的条件集合"这一层。
3. **没有表达式/嵌套求值器**：现有引擎只会逐个插件执行，没有 AND/OR 树、没有条件依赖。
4. **没有风险 HOLD 能力**：全仓检索 `position_risk_alert` **0 命中**（文档与代码均无）。现有相关设施只有：
   - `Plugin.requiresPositions` 与 `POSITION_UNAVAILABLE` SKIP（`pluginEngine.ts` L240、L1408-L1424）；
   - 内置插件中只有 `boll_reversion` 显式声明 `requiresPositions: false`（L794），**没有任何风险类插件**；
   - `direction` 枚举允许 `hold`（`configStore.ts` L181），但 `stockscan` 明确过滤 `signalType !== 'HOLD'`（`stockscan.ts` L432）。
   ⇒ 若组合要输出"风险 HOLD"，属于**新增能力**，不是复用；且 `position_risk_alert` 这个标识符的来源需先确认（可能来自未合入分支）。

### 3.3 与 F1 / F6 / F2 / 风险 HOLD 的相互作用

| 交互点 | 现状（含行号） | 组合接入后的影响 | 处理建议 |
|---|---|---|---|
| **F1 分级候选集** | `assignSignalGrades` 只取 `strength IS NOT NULL` 的行（`signalService.ts` L386-L389）；按**当日全部信号**做分位定档（L348-L358） | 组合信号若不写 `strength` ⇒ `grade=NULL` ⇒ 不进"强/中/弱"页、不进 F2；若写 `strength` ⇒ 会改变当日分位分母，**可能让原有信号降档** | 组合必须写 `strength`；并把"组合行是否参与分位"列为 D6；建议组合在普通插件之后、`assignSignalGrades` 之前写入（顺序见 §5） |
| **F6 冷却展示** | 当前是**展示层合并**，不抑制生成：`assignSignalCooldowns` 注释明确"信号生成照旧一条不少"（L458-L459）；`scheduler.ts` L444 同样注明"只供展示层" | 与 `INV-S3-23`「不得重复产生信号」**语义冲突**；组合若沿用现状，只是页面合并，库里仍会每天新增；另外组合与组成条件 `plugin_id` 不同，**不会互相合并**，同一标的可能同时出现"组合信号"和"单条件信号" | D5 必须先裁决：生成抑制 / 仅展示合并；D11 决定是否抑制组成条件的独立信号 |
| **F2 今日 Top N** | `INV-S3-25` + PRD L380「默认只显示强 + 今日 Top 5」；候选来自已分级信号 | 组合有 `strength` 且被分级 ⇒ 自然进入 Top N 候选；组合越多，Top N 竞争越激烈 | 不需要改 F2 代码，但需在验收里加"组合行可出现在 Top 5"用例；F2 本身仍按独立任务做 |
| **风险 HOLD** | 无 `position_risk_alert`；无风险插件；`requiresPositions` 机制存在但无使用者；`stockscan` 丢弃 HOLD | 若组合输出 HOLD：F1 会把它当普通信号分级，F2 可能推送"HOLD"，前端信号页语义未定义 | D8：MVP 建议组合只允许 BUY/SELL；HOLD/风险条件单独立项 |
| **信号唯一键** | `UNIQUE(user_id, asset_code, plugin_id, trade_date)`（`configStore.ts` L200） | 一个组合在同一标的同一天最多 1 条；改配置后重跑同一天会 `INSERT OR IGNORE` 跳过旧行 | D9：重算/回放是否需要"覆盖旧组合信号"的语义 |

---

## 4. 数据模型

### 4.1 新增表（MVP 建议）

> 遵循项目 DDL 规则：只新增表，不改已有表约束；全部 `CREATE TABLE IF NOT EXISTS`，不引入迁移框架。

```sql
-- 组合策略主表
CREATE TABLE IF NOT EXISTS strategy_combo (
    id              TEXT PRIMARY KEY,              -- 建议 'combo_' || 递增号 或 ULID，全局唯一
    user_id         INTEGER NOT NULL,
    name            TEXT NOT NULL,                 -- 例如 "MACD金叉+量能确认"
    enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    combine_op      TEXT NOT NULL DEFAULT 'AND'    -- MVP 固定 AND；完整版扩展 AND/OR/嵌套
                    CHECK (combine_op IN ('AND', 'OR')),
    asset_scope     TEXT NOT NULL DEFAULT 'all'    -- 复用 INV-S3-17 枚举：all/stock/etf/cross_border/exclude_cross_border/exclude_cash
                    CHECK (asset_scope IN ('all','stock','etf','cross_border','exclude_cross_border','exclude_cash')),
    period          TEXT NOT NULL DEFAULT 'daily' CHECK (period IN ('daily')),
    cooldown_bars   INTEGER NOT NULL DEFAULT 3 CHECK (cooldown_bars >= 1 AND cooldown_bars <= 20),
    config_version  INTEGER NOT NULL DEFAULT 1,    -- 每次条件变更 +1（用于回放/审计）
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
    plugin_id       TEXT NOT NULL,                 -- 引用内置/磁盘插件的 id（不建 FK，插件不是表）
    enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    params_json     TEXT NOT NULL,                 -- 该条件的参数，形状 = 插件 paramSchema
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(combo_id, seq),
    FOREIGN KEY (combo_id) REFERENCES strategy_combo(id)
);
CREATE INDEX IF NOT EXISTS idx_combo_user ON strategy_combo(user_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_combo_condition ON strategy_combo_condition(combo_id, seq);
```

**不新增信号表、不改 `user_strategy_signal` 结构（MVP）**：组合信号复用该表，编码方式见 4.3；若后续需要更强的可查询性，再在 P1 评估加 `source_type` / `combo_id` 列（加列而非改约束）。

### 4.2 与 `strategy_config` / `user_strategy_config` 的关系

- 仓库中**不存在** `strategy_config` 或 `user_strategy_config`；需求/对话里的这个称呼对应实际表 `user_plugin_config`。
- `user_plugin_config` **不建议复用**：它是"一个插件一行参数"，无法表达有序条件数组；复用会让 `/api/strategy/plugins` 的插件列表出现"伪插件"，并与磁盘插件的 id 唯一性冲突。
- 结论：**组合配置独立建表**，`user_plugin_config` 继续只管单插件启停与参数；组合的启停由 `strategy_combo.enabled` 唯一决定，避免双写。

### 4.3 组合信号在 `user_strategy_signal` 中的编码

| 字段 | 取值 | 理由 |
|---|---|---|
| `plugin_id` | `combo:<combo_id>` | 复用唯一键与 F6 合并键；无需改表；`/api/signal?plugin_id=` 可直接筛 |
| `plugin_category` | `'monitor'` | CHECK 只允许 monitor/filter（L179）；组合是每日信号，不是选股 |
| `direction` | `'buy'` / `'sell'`（MVP 不允许 `hold`，见 D8） | 与现有三向枚举兼容 |
| `label` | 例如 `MACD金叉 且 放量1.5倍（组合）` | 人读标签 |
| `strength` | 合成值（D6） | **不写就不参与 F1 分级** |
| `metrics_json` | `{combo_id, matched: [...], conditions: {pluginId: metrics}}` | 满足 INV-S3-26 的"指标值"部分；只存数值，不存凭证 |
| `snapshot_json` | 组合配置快照 + 当日各条件输入摘要 | 满足 INV-S3-26；配置变更后可回溯"当时用的是什么组合" |
| `origin` | `'live'` / `'replay'` | 复用现有列 |

> 若采用 `plugin_id` 前缀方案，前端需要在展示时把 `combo:` 前缀翻译成组合名称；后端 `/api/strategy/plugins` 需新增组合列表接口（或扩展返回），否则 UI 无法在"策略列表"里编辑组合。

### 4.4 配置变更对历史信号的影响

| 场景 | 影响 | 建议口径（待 D9 确认） |
|---|---|---|
| 用户改条件/参数 | 只影响之后的交易日；历史 `user_strategy_signal` 行**不重算、不删除** | 默认"历史不可变"，用 `snapshot_json` 回溯 |
| 同一天重跑（手动触发/回放） | 唯一键命中 ⇒ `INSERT OR IGNORE` 跳过旧行，**新配置不会覆盖当天旧组合信号** | 若要"重算当天"，需显式删除/软删当天 `combo:` 行后再写；是否允许由 D9 定 |
| 配置版本回放 | 需要按"当时版本"重放，而不是当前版本 | 用 `config_version` + `snapshot_json`；回放 API 需接受 `comboVersion` |
| 停用组合 | 后续不再生成；历史行保留 | 与"软删除"一致（AGENTS 硬约束） |

---

## 5. 实现分期

### 5.1 MVP（P0）：一条 AND 组合能配、能出信号、能被回测/纸面使用

**范围**

1. 新建 `strategy_combo` + `strategy_combo_condition`（§4.1）。
2. 组合 CRUD API：
   - `GET /api/strategy/combos`（列表 + 条件 + 启用态）
   - `POST /api/strategy/combos`（创建，2~N 个条件）
   - `PUT /api/strategy/combos/:id`（更新，`config_version+1`）
   - `PUT /api/strategy/combos/:id/toggle`
   - `DELETE /api/strategy/combos/:id`（软删）
3. 组合执行器 `services/comboStrategy.ts`：
   - 读取启用组合 → 按 `asset_scope` 过滤标的 → 对每个标的、每个条件调用 `executePlugin(conditionPlugin, params, sharedCtx)`；
   - **AND**：全部启用条件都返回 `BUY` 才出 `BUY`；全部返回 `SELL` 才出 `SELL`（混合方向按 D4/D1 处理）；
   - 输出 1 条 `PluginSignal`，`pluginId='combo:<id>'`，`strength` 按 D6；
   - 任一条件失败：按 D10（默认"本轮该标的组合不成立"，记 WARN，不 block 其他标的）。
4. 链路接入：在 `executeAllPlugins` 的批量预取之后、返回之前执行组合（`pluginEngine.ts` L1822-L1871 区间），使 `scheduler` 与 `admin` 自动共享；不改变现有 `monitorPlugins` 的统计口径（组合单独计数）。
5. 落库：复用 `persistSignals`；随后现有 `assignSignalGrades`、`assignSignalCooldowns` 照常执行（`scheduler.ts` L427-L454），组合行自动参与 F1/F6。
6. 前端 MVP：在 `apps/frontend/src/pages/StrategyConfig.tsx` 增加"组合策略"区块（当前页面只按 monitor/filter 列插件，L122-L178）：
   - 列表、启用开关、编辑弹层；
   - 条件选择（仅 monitor 插件）、参数表单（复用 `paramSchema`）、条件开关；
   - 适用品种、周期（固定日线）、冷却（默认 3）；
   - 跨境提示沿用现有 F6/U13 的一次性提示（`StrategyConfig.tsx` L44、L73、L182）。
7. 回测/纸面可用（最小口径）：
   - **回测**：新增一个"组合信号跟随"适配器（`backtest/strategies/comboSignal.ts`），实现 `Strategy.decide(ctx)`：在 `asOf` 日用 `series/bars` 重算组合条件 → 产生目标仓位；或采用"先按历史日期预生成组合信号，再跟随"的两段式（D7）。两种都必须保证无前视（`types.ts` L151-L182 的 `asOf=T-1` 契约）。
   - **纸面**：组合信号是标准 `monitor` 行；纸面若按 `user_strategy_signal` + `category='monitor'` 读取，则**无需改纸面代码**（需在纸面分支确认；当前 main 无纸面实现）。

**验收点（P0）**

| 编号 | 验收 |
|---|---|
| A1 | 配一条 `MACD金叉 AND 放量>1.5`，在构造的行情里"两条件同时成立"的标的出 1 条 `BUY`；只有一条成立时 0 条 |
| A2 | 组合信号写入 `user_strategy_signal`，`plugin_id='combo:<id>'`，`strength` 非空，`grade` 被 F1 回填 |
| A3 | 同一组合+标的+方向在冷却窗口内重复触发时，按 D5 的口径表现一致（生成抑制或展示合并） |
| A4 | 手动触发与 17:02 定时链路结果一致（都经过 `executeAllPlugins`） |
| A5 | 停用组合后，后续交易日不再产生新信号；历史行保留 |
| A6 | 组合行可被 `/api/signal` 查询、可在信号页展示、可参与"强/中/弱"筛选 |
| A7 | 回测适配器在同一区间、同一配置下可复现组合信号，且无 T 日未来数据 |
| A8 | 条件参数越界/条件插件不存在 ⇒ 400 `PARAM_INVALID` 或组合创建失败，不写入半成品配置 |

**涉及文件（P0，预计 4 个 T 任务）**

| 层 | 文件 | 改动 |
|---|---|---|
| DB | `apps/backend/src/config/configStore.ts` | 新增两张表 + 索引（幂等） |
| 服务 | 新增 `apps/backend/src/services/comboStrategy.ts` | 组合 CRUD 读取、条件求值、AND 聚合、信号合成 |
| 引擎 | `apps/backend/src/services/pluginEngine.ts` | 在批量执行后调用组合执行器（共享 `ctx`）；可选导出条件插件查找函数 |
| 路由 | 新增 `apps/backend/src/routes/combo.ts` 或在 `routes/plugin.ts` 扩展 | 组合 CRUD + toggle |
| 回测 | 新增 `apps/backend/src/services/backtest/strategies/comboSignal.ts` | `Strategy` 适配器 |
| 前端 | `apps/frontend/src/pages/StrategyConfig.tsx` | 组合区块 + 编辑弹层 |
| 测试 | `apps/backend/tests/unit/comboStrategy.test.ts`、`tests/integration/combo.test.ts`、`apps/frontend/tests/unit/strategy-pages.test.tsx` | AND 聚合、落库、分级、冷却、UI |

### 5.2 完整版（P1）

| 能力 | 增量 | 依赖决策 |
|---|---|---|
| OR / 混合逻辑 | `combine_op` 扩展；UI 增加逻辑选择；求值器支持 OR | D1 |
| 嵌套 | 条件树（表达式 JSON）或"子组合"引用；求值器递归 | D1 |
| 条件级适用品种/周期 | 条件维度增加 scope；V3 只有日线，周期扩展属 V4 | D2/D12 |
| 生成级冷却 | `cooldown_bars` 真正抑制写入（与 INV-S3-23 对齐），或保留展示层并修订需求 | D5 |
| 组合强度模型 | 可配置 min / 加权 / 命中比例 | D6 |
| 风险 HOLD | 组合允许 HOLD；需要持仓上下文与风险条件；F1/F2/前端语义 | D8 |
| 配置版本化回放 | 回放按 `config_version` / `snapshot_json` 重放 | D9 |
| 组成条件去重 | 组合命中时是否抑制组成条件的独立信号 | D11 |
| 评估分组 | 有效性页按"组合"分组（SDD_v3 §10.4 维度） | — |
| 多用户 | 组合按 `user_id` 隔离执行；当前 `executeAllPlugins` 是单用户口径 | — |
| 策略列表统一 | 组合以"虚拟策略"出现在 `/api/strategy/plugins`，与插件列表同构 | D10 |

**完整版工作量量级：约 6~8 个 T 任务**（不含 F2、T148 全量 UI、风险 HOLD 独立立项）。

### 5.3 明确不在本方案范围

- F2「今日 Top 5 摘要」本身仍按 T149/独立任务实现；本方案只保证组合信号**能被 F2 消费**（有 `strength`、有 `grade`）。
- 纸面账户代码不在当前 main（仅 `proposal-paper-account.md` 规划）；本方案只定义信号契约，不实现纸面。
- 分钟线、盘中组合、自动交易：Out-Scope。

---

## 6. 待决策清单

> 每条给出可选口径与建议；**建议不等于决定**，需 owner 确认后写入 T 任务。

| 编号 | 问题 | 可选口径 | 建议 | 影响面 |
|---|---|---|---|---|
| **D1** | 条件间逻辑是否只支持 AND | A. 仅 AND（MVP）；B. AND/OR 可切换；C. 任意嵌套表达式 | **A 先做 MVP，B 作为 P1，C 暂缓** | UI、求值器、测试矩阵 |
| **D2** | 条件是否允许独立周期 | A. 组合级统一周期（V3 只有日线）；B. 条件级周期（需分钟线，Out-Of-Scope） | **A** | 数据窗口、引擎 |
| **D3** | 条件是否允许跨标的 | A. 同标的（所有条件作用于当前 `asset_code`）；B. 允许指数/其他标的作为条件 | **A**；B 需要新的上下文与缓存键 | 引擎、数据、性能 |
| **D4** | 命中后输出几条信号 | A. 一条合成信号；B. 每个条件各一条 + 组合标记 | **A**；B 会污染 F1 分母与 F6 合并 | 信号表、F1/F6/F2 |
| **D5** | 冷却语义 | A. 生成级抑制（符合 INV-S3-23）；B. 仅展示合并（与现 F6 一致）；C. 组合生成抑制、单插件保持展示合并 | **A 或 C**；必须显式选，不能默认 | 与现有 F6 代码冲突 |
| **D6** | 组合强度如何合成 | A. `min(各条件 strength)`（保守）；B. 加权平均；C. 命中条件数占比 | **A 为 MVP 默认**，B 作为可配置 P1 | F1 分位、F2 排序 |
| **D7** | 回测口径 | A. 组合条件在 `decide(ctx)` 内重算；B. 先按历史日预生成信号，再"信号跟随"；C. 不做回测，仅纸面 | **B**（复用同一套条件实现、避免两套算法漂移）；A 作为性能优化 | 回测精度、无前视 |
| **D8** | 组合是否允许 HOLD / 风险条件 | A. MVP 仅 BUY/SELL；B. 允许 HOLD（风险提醒）；C. 风险条件单独立项 | **A**；B/C 需先确认 `position_risk_alert` 来源与 F1/F2 语义 | 风险能力、前端 |
| **D9** | 配置变更与历史/回放 | A. 历史不可变，只影响未来；B. 重算当天并覆盖；C. 按 `config_version` 重放 | **A 为默认，C 为 P1**；B 仅在明确"修正配置"场景开放 | 唯一键、回放、审计 |
| **D10** | 条件执行失败如何处理 | A. 该标的组合本轮不成立（保守）；B. 忽略失败条件（危险）；C. 整条组合 ERROR | **A**，并写 WARN/系统日志 | 可用性、可观测性 |
| **D11** | 组合命中是否抑制组成条件的独立信号 | A. 不抑制（各自独立）；B. 抑制组成条件（避免重复展示）；C. 仅前端合并 | **A 为 MVP**；B 需与 F6/D5 一起定 | 展示重复、F2 |
| **D12** | 适用品种放在组合级还是条件级 | A. 组合级（INV-S3-17 最小满足）；B. 组合级 + 条件级覆盖 | **A** | 配置复杂度 |
| **D13** | 组合 id 编码 | A. `plugin_id='combo:<id>'`（MVP）；B. 新增 `source_type/combo_id` 列 | **A**；B 作为 P1 若查询/统计需要 | 表结构、API |

---

## 7. 风险与回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| F1 分位漂移 | 组合行加入当日强度集合，可能让原有信号降档 | 明确组合是否参与分位（D6）；在验收里对比"有/无组合"的分级分布 |
| 重复展示 | 组合信号与组成条件信号在信号页并存 | D11；F6 合并键按 `plugin_id`，不会自动合并不同 id |
| 需求与实现冲突 | `INV-S3-23` 要求抑制，F6 只做展示 | D5 必须显式裁决；文档与代码二选一，不静默 |
| 性能 | N 条件 × M 标的，若每条件重复查库会放大 | 共享 `executeAllPlugins` 的预取 `ctx`；条件级 50ms 预算复用 `executePlugin` |
| 回测前视 | 组合在回测中若直接读实时库 | 走 `asOf` 锁定终点（`executeAllPlugins` L1819-L1825、`StrategyContext` L151-L182） |
| 配置漂移 | 改配置后无法解释历史信号 | `config_version` + `snapshot_json`；历史行不重算 |
| 回滚 | 组合出问题需快速停用 | `enabled=0` 立即停止后续生成；历史行保留；不需要删表 |

---

## 8. 参考索引

| 内容 | 位置 |
|---|---|
| 组合不变量 | `docs/client/InvestAssistantV3_NewRequirements.md` L667-L668（INV-S3-18/19） |
| 信号生命周期 | 同文件 L672-L683（INV-S3-22~27） |
| PRD 组合编辑框 | `docs/client/PRD_v3.md` L326-L361 |
| PRD 信号分级 | 同文件 L363-L384 |
| 任务 T133/T148 | `docs/client/code_implementation_plan_v3.md` L159、L199 |
| 插件引擎契约 | `apps/backend/src/services/pluginEngine.ts` L198-L242、L1382-L1424、L1785-L1871 |
| 信号落库/分级/冷却 | `apps/backend/src/services/signalService.ts` L88-L154、L348-L410、L455-L537 |
| 信号表 DDL | `apps/backend/src/config/configStore.ts` L174-L205 |
| 插件配置表 DDL | 同文件 L225-L233 |
| 每日链路 | `apps/backend/src/services/scheduler.ts` L408-L454 |
| 插件配置 API | `apps/backend/src/routes/plugin.ts` L64-L160 |
| 回测策略接口 | `apps/backend/src/services/backtest/strategy/types.ts` L189-L200 |
| 纸面方案（仅规划） | `docs/audit/proposal-paper-account.md` |
| 策略目录盘点（规划） | `docs/audit/proposal-strategy-catalog-plan.md` |
