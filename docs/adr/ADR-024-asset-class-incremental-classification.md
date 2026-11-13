# ADR-024 —— asset_class 增量初判（新标的补齐 + 冷却期改判 + 手工录入触发）

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（2026-11-13，owner 拍板「一次改好」+ 生产默认 `execute`） |
| **落地** | 本次 PR-1：`assetClass.ts` / `assetClassSync.ts` / `routes/trade.ts` / `cli/assetClassSync.ts` / `deploy/invest-assistant.service` |
| **关联偏差** | §13.2 **I-41**（新增） |
| **关联文档** | SDD_v3 §2.3（初判触发口径增补）、`docs/deploy.md`（回填步骤） |
| **取代** | 取代 T120 补线的「表非空即跳过」门槛（`runAssetClassSyncIfNeeded` 旧实现）；不取代 ADR-016 的现金类建模语义 |

---

## 1. 背景

### 1.1 生产 `asset_class` 0 行 ⇒ 现金类排除整体失效

- `runInitialClassification()`（`assetClass.ts`）在 T120 定义后**全仓无调用点**；
- T120 补线（`assetClassSync.ts`）设了 `ASSET_CLASS_SYNC_MODE` 三档开关，但**默认 `dry-run`（不写库）**，
  且调用点只有券商导入（`brokerReconcile.ts` `imported>0`）；
- 生产环境从未设过 `execute` ⇒ **`asset_class` 表 0 行**（2026-11-13 实测）；
- 后果：`getAssetClass()` 对全部标的回落 `risk` ⇒ 逆回购 / 货币 ETF 被计进风险资产分母、
  参与信号与集中度（ADR-016 建模语义在生产上不生效）。

### 1.2 旧门槛「表非空即跳过」⇒ 即使设了 execute 也只在第一次有写入

`runAssetClassSyncIfNeeded()` 旧实现：`SELECT COUNT(*) FROM asset_class` 非 0 即 return null。
⇒ 第一次导入写完 42 个标的后，**之后新出现的任何标的都不再初判**（例如新上市的货币 ETF），
且**已判 `default`（证据不足）的行永不复查**（新标的攒够 120 根 K 线后本可改判 cash）。

### 1.3 全量重扫不可行（成本闸门）

`collectClassifyInputs` 每个标的要 2 次 DuckDB IN 查询（窗口统计 + 名称）。业务标的 42 个时
CLI 全量 dry-run 实测 **7.3s**；若每次券商导入 / 手工录入都全量重扫，行情层查询量随标的数线性放大，
而 K 线按日更新——**7 天内复查没有新证据**。

## 2. 决策

1. **候选集合（`selectClassifyCandidates`）取代「表非空即跳过」**：
   - 无 `asset_class` 行 ⇒ `reason='new'`（必须判一次）；
   - `source='rule'` 且 `rule_hit='default'`（证据不足）**且** `updated_at` 早于冷却期
     （`RECHECK_COOLDOWN_DAYS=7`）⇒ `reason='retry'`（可改判）；
   - `source='manual'` 与终态判定（`TERMINAL_RULE_HITS = repo_code / cash_etf_name / cash_etf_near_par`）
     ⇒ **永不候选**。
   - 候选为空 ⇒ 直接返回，不扫行情层。
2. **写入口径（`runInitialClassification` ADR-024 版）**：
   - 无记录 ⇒ INSERT（`source='rule'`）；
   - `source='manual'` ⇒ 永不覆盖（人工修正优先，rule_hit 保留可回溯）；
   - 终态判定 ⇒ 不动；
   - `rule/default` 行 ⇒ **允许改判**：本次判 cash ⇒ `UPDATE asset_class, rule_hit`；
     仍 default ⇒ 仅刷新 `updated_at`（「已复查」冷却标记，**不计入 written**）。
3. **触发点扩展**：手工录入成交（`POST /api/trade`）同样 `void runAssetClassSyncIfNeeded(db, log)`
   —— 手工录入的标的（可能正是逆回购/货币 ETF）与券商导入同等待遇；异步不阻塞响应，候选为空时内部跳过。
4. **生产默认落库**：`deploy/invest-assistant.service` 增加
   `Environment=ASSET_CLASS_SYNC_MODE=execute`（owner 拍板：默认 dry-run 等于永远 0 行，
   现金类排除在生产上不生效 ⇒ 默认必须是 execute；dry-run 仍是代码默认值，拼错/未设不会误伤开发机）。
5. **CLI 审计**：`cli/assetClassSync.ts` 默认只扫候选（增量），`--all` 全量审计；
   `--execute` 前自动 `db.backup`。

## 3. 后果

**正面**

- 生产 `asset_class` 回填后，现金类判定（信号域排除、收益分母、集中度）自动生效；
- 新上市货币 ETF 攒够 K 线后 7 天内可改判 cash（旧实现永远停在 default=risk）；
- 手工录入路径与导入路径口径一致（旧实现手工录入不触发初判）。

**负面 / 代价**

- 每次导入/录入多一次 `asset_class` 全表 + 业务表读（毫秒级，SQLite）；行情层扫描只在候选非空时发生；
- 改判是**单向风险侧**：cash→default 不会发生（default 复查只会改成 cash 或保持），
  但若行情数据异常导致某风险标的被误判 cash，需 `setManualClass` 手工纠正（既有通道不变）。
- REPO_CODES 盲区（204005/006/009、131812~131818，行情层无 K 线）不在规则覆盖范围，
  样本若再出现走 `setManualClass` 手工补 cash（V3-B5 既有登记，本次不扩规则）。

## 4. 备选方案与否决理由

| 方案 | 否决理由 |
|---|---|
| 维持「表非空即跳过」+ 生产设 execute | 第一次写入后永远不再补新标的/复查 default；新上市货币 ETF 永久 risk |
| 每次导入全量重扫 | 行情层查询随标的数线性放大，且 7 天内无新证据（K 线日更）；纯成本无收益 |
| 给 asset_class 表加 `last_check_at` 列（改 DDL） | 表重建路径（AGENTS DDL 判据）成本高于直接复用既有 `updated_at` 列做冷却标记；`updated_at` 语义上就是「最近一次判定/刷新」 |
| 默认 dry-run 不动生产 env | 生产 `asset_class` 恒 0 行，现金类排除整体失效——即现状的缺陷本身 |

## 5. 验证

- 单测：`apps/backend/tests/unit/assetClassSync.test.ts`（18 用例）：
  - `selectClassifyCandidates`：空表全 new / 冷却期内不候选 / 冷却期外 retry / manual 与终态永不候选；
  - execute：首次写入 4 条；立即重跑 0 写入、default 行仅刷新 `updated_at`；
    冷却期外 rule/default 行改判 cash（UPDATE）；manual 行不被改判覆盖；
  - `runAssetClassSyncIfNeeded`：候选为空 ⇒ null（不扫行情层）；出现新业务标的 ⇒ 补判 1 条（旧版漏判场景）；
- 单测：`asset_class.test.ts`：重跑时 rule/default 行进 `refreshed`（原断言「全部 skipped」已按 ADR-024 语义更新）；
- 集成：`trade.test.ts` 新增「POST /api/trade 触发 `runAssetClassSyncIfNeeded`」（spy）；
- 本地 CLI：`npx tsx src/cli/assetClassSync.ts`（dry-run，42 标的，7.3s）行为不变；
- 生产回填一次性操作（`docs/deploy.md`）：
  1. 部署本 PR 后重启服务（`ASSET_CLASS_SYNC_MODE=execute` 生效）；
  2. 首跑 `npx tsx src/cli/assetClassSync.ts --execute` 全量回填（自动 backup）；
  3. REPO_CODES 盲区若出现在业务样本中，用 `setManualClass` 手工补 cash。

## 6. 后续（不在本次范围）

- REPO_CODES / CASH_ETF_NAME_KEYWORDS 清单随品种增减需人工维护（行情层实测 + owner 确认）；
- 若 `asset_class` 行数增长到使冷却期复查明显变慢，可把 `selectClassifyCandidates`
  的候选判定下沉为单条 SQL（当前 JS 层过滤，表小无压力）。
