# V3.8 验收报告（前端页面：券商域 / 组合域 / 策略域 / 联想）

> **依据**：`docs/client/code_implementation_plan_v3.md` §3（V3.8 任务卡 + PR 策略）与 §4.4/§4.5。
> **验收范围**：T142（联想增强）+ T143~T145（券商域）+ T146~T147（组合域）+ T148~T150（策略域）。
> **交付 PR**：#49（券商域）、#50（组合域）、#52（策略域）、#53（联想 + 本审计文档）。

## 1. V3.8 专属门槛（§4.4）

| 门槛项 | 判定 | 证据 |
|---|---|---|
| 每页面挂 PRD 章节验收 | **PASS** | 见 §2 页面↔PRD 映射表；每页面均有对应测试文件 |
| 联想走快照（不扫行情层） | **PASS** | `searchSymbolDict` 查 SQLite `symbol_dict`（T136 快照 + pinyin-pro）；仅快照为空时回退 DuckDB（CI 空壳场景），正常路径不扫行情层；#53 CI 绿（CI 无真库仍过） |
| 补录结果与后端事务口径一致 | **PASS** | 补录走 `POST /broker-reconcile/confirm`（T129 brokerConfirm，整体事务）；前端仅呈现「成功 N / 失败 M」，口径由后端单事务保证 |

## 2. 页面 ↔ PRD 章节 ↔ 测试映射

| 页面 | 路由 | PRD_v3 章节 | 任务 | 测试载体 |
|---|---|---|---|---|
| 导入向导 | `/broker/import` | §3.1 | T143 | `tests/unit/broker-pages.test.tsx` |
| 对账报告 | `/broker/reconcile` | §3.2 | T144 | 同上 |
| 补录对话框 | （报告页内） | §3.3 | T145 | 同上 |
| 持仓页增强 | 仪表盘/持仓 | §3.4.1 | T146 | `tests/unit/t146-holding-broker.test.ts` |
| 收益页 | `/portfolio/return` | §3.4.2 | T147 | `tests/unit/portfolio-return-page.test.tsx` |
| 策略配置 | `/strategy/config` | §4.1 | T148 | `tests/unit/strategy-pages.test.tsx` |
| 信号操作列 | `/signals` | §4.2 | T149 | `tests/unit/signals-page.test.tsx`（T149 describe） |
| 策略有效性 | `/strategy/effectiveness` | §4.3 | T150 | `tests/unit/strategy-pages.test.tsx` |
| 组合体检 | `/portfolio/risk-check` | §5.3 | T150 | 同上 |
| 复盘双 tab + 交易对 | `/review` | §5.1 | T150 | `tests/unit/review-page.test.tsx`（T150 describe） |
| 联想增强 | 交易录入等 | §2.1/§2.2 | T142 | `tests/unit/symbol-autocomplete.test.tsx`（7 用例） |

a11y 基线（G3.4 精神）：`tests/unit/a11y.test.tsx` PAGES 已含上述全部新页面，0 critical 违规。

## 3. 通用门槛（§4.5）检核

| # | 门槛 | 判定 | 证据 |
|---|---|---|---|
| G1 | 一个 T 任务一条 commit | **COND** | 券商域 #49 / 组合域 #50 / 联想 #53 均一任务一 commit；**策略域 #52 将 T148+T149+T150 合为单 commit `5ec6693`**（共享 App.tsx/_shared.tsx/a11y/side-nav 编辑无法干净拆分，commit message 已声明，回滚粒度 = 该 commit 整体 revert）。V3.8 拆 4 PR 为 plan §3 明示的 PR 策略（非违规） |
| G2 | lint + typecheck + test 全绿 | **PASS（CI 口径）** | `npm run lint` 0 错；`npm run typecheck`（core build + 三处 tsc）0 错；#52/#53 CI `build-and-test` 均 PASS（含全量 test + coverage gate）。⚠️ 本地 `npm test` 有 1 个**环境性**文件级失败：`t55-stockscan-filter.test.ts` 探针要求 `raw_tdx_blocks_member` 为空，本地 `data/quotes.mini.duckdb` 板块成员 89928 行（本地迷你库数据漂移，该文件 Wave 8 起未再改动，非 V3.8 回归）；CI 现生成迷你库板块为空 → CI 绿。按 ADR-008 三档策略，门禁以 CI 为准 |
| G3 | 每条不变量至少 1 个测试用例 | **PASS** | V3.8 前端行为断言全部落在上表测试文件；后端不变量（INV-S1~S6）载体见 SDD_v3 §12 映射（V3.4~3.7 审计已核） |
| G4 | 阶段审计文档与本波 commit 同 PR | **PASS** | 本文档（v3-8-audit.md）随 #53（V3.8 最后一个 PR）合入。⚠️ #49/#50 先行合入时本审计文档尚未落档（V3.8 拆 4 PR 所致），其门槛在各自 PR 的 CI + 代码评审中验证，本文档补全全波口径 |
| G5 | CI 通过 + Gate 全 PASS 才 squash merge | **PASS** | #52 / #53 `build-and-test` + `Coverage Gate` + `Stage 2 Lint+TS` 全 PASS |

## 4. 偏差与登记

| # | 项 | 处置 |
|---|---|---|
| D-51 | 策略域 3 个 T 任务（T148/T149/T150）合并为单 commit `5ec6693`（G1 COND） | commit message 已声明；如需回滚 = 整体 revert 该 commit |
| D-52 | 本地迷你库 `data/quotes.mini.duckdb` 板块成员非空（89928 行）→ t55 探针本地红、CI 绿 | 环境数据漂移（ADR-008 已知档位差异），非代码回归；可选修复 = 重新生成本地迷你库（V4 前清理项） |
| D-49 | （继承 V3.7 审计）T138 代码补零待与回填匹配键同口径重做 + G5 回归 | 未在本波处理，维持 V3.7 登记状态 |

## 5. 结论

**V3.8 验收判定：PASS（G1 为 COND，附 D-51/D-52 登记）**。
CI 双绿 + 专属门槛三项 PASS + 页面↔PRD↔测试映射完整。允许 squash merge #52 与 #53，V3 计划（T119~T150）至此全部合入 main。

---

## 附：V3.8a · T151 券商域增强（owner 2026-10-27 增补，PR #55）

| 门槛项 | 判定 | 证据 |
|---|---|---|
| ① 标识必填 + 自动推断 | **PASS** | 红星 + `aria-required`；`detectBrokerName`（已知清单最长匹配 + 「中文名+证券」兜底）；**脱敏样本必须推不出**（敏感边界断言，broker_parser 4 用例）；单文件+标识空时自动填入（手填优先不覆盖） |
| ② 多文件 + 不同券商分批提示 | **PASS** | 分组（手填 > 推断 > 未识别）；≥2 组 → 「分批导入」提示 + 逐组确认（组标识落库）；broker-pages 2 用例 |
| ③ 补录全选 | **PASS** | 表头「全选本页可补录」checkbox（checked/indeterminate）→ 选中当前页全部可补录行；broker-pages 1 用例 |
| 通用 G2（lint/typecheck/test） | **PASS** | 前端全量 705 passed；后端 broker 套件 26 passed；CI #55 三项全 PASS |
| G4（审计同 PR） | **PASS** | 本增补节随 #55 合入 |

**端点契约**：`POST /api/broker-import/upload` 响应 `+brokerNameHint?`（可选字段，向后兼容）。
**偏差**：无新增（T151 任务卡 + 修订记录行已登记 plan §3 / 修订记录）。
