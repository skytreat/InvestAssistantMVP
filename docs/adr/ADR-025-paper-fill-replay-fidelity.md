# ADR-025 —— 纸面回放补全成交回报（`onFill` 历史回放），让纸面可与回测互校

| 项 | 值 |
|---|---|
| **状态** | ✅ **已接受（路线裁决）**（2026-11-13，owner 签字）；**实施待排期** |
| **落地（待派）** | `paper/decision.ts`（回放喂 `onFill`）+ `paper/settle.ts`（落 `exit_reason`）+ `store/paperSchema.ts`（加列 + 索引） |
| **关联文档** | `docs/audit/dualmomentum-l1-alignment.md` §9（不保真清单）、§10（方案 A 立项）、**§10.4（实施评估）**、§11.4（F-3 根因） |
| **取代** | 不取代任何 ADR。**解除** §9.3 的禁令「纸面结果不得与回测互相校验」 |
| **依赖** | 无（不依赖 ADR-022/024；对跑赢档基线无影响） |

---

## 1. 背景

### 1.1 纸面失真的机制（三层叠加）

纸面账户**有**成交历史（`paper_order` status=`filled` + `paper_position`），
但**决策阶段拿不到「成交事件」**：

1. **框架契约**：`Strategy.onFill(notice)` 是「成交后通知」回调，回测引擎会调
   （`engine.ts:604-614`），**纸面决策链路一次都不调**（`decision.ts` 内 `onFill` 出现 0 次）。
2. **数据缺口**：`FillNotice` 需要 `reason`（`'take-profit'` / `'stop-loss'` / `'momentum-decay'` / …），
   而 `paper_order` **只有 `unfilled_reason`**（未成交原因），**没有退出原因**（全仓 grep 无 `exit_reason` 列）。
3. **保守兜底**：`decision.ts:347` 回放中间日给**空组合**，最终日 T 用检查点组合。

⇒ 任何**状态依赖成交历史**的策略，其状态在纸面永远是退化值。

### 1.2 受影响的规则（DualMomentum 实例）

| 规则 | 依赖的状态 | 纸面表现 |
|---|---|---|
| 止盈（持有 ≥ 5 天 + 30%） | `entryDate` | 兜底为「今天建仓」⇒ `daysSinceEntry = 0` ⇒ **永不触发** |
| 掉出候选（持有 ≥ 5 天） | `entryDate` | 同上 ⇒ **永不触发** |
| 高水位止损（回撤 ≥ 12%） | `highWater` | 兜底 `= qfqClose` ⇒ `highDrawdown ≡ 0` ⇒ **永不触发** |
| 止损 / 止盈冷却（3 / 5 交易日） | `cooldown` | 只在 `onFill` 里写 ⇒ 恒空 Map ⇒ **永不生效** |

**不受影响**：成本止损（读 `pos.avgCost`）、超配减仓、选股与权重分配、
以及 ADR-024 的**破位切防御**（只依赖行情与当期组合 ⇒ 逐日回放可重建）。

### 1.3 §10.4 的评估结论：`onFill` 是纯通知，不需要逐日行情

`FillNotice` 只需 `{date, symbol, side, qty, price, fee, reason}`，**全部来自成交本身**
⇒ 历史回放只需**成交序列**，**不需要逐日行情重放**。
⇒ §10.3 原文担心的「逐日带成交模拟 / 长生命周期账户重放数百个交易日」**不成立**。

而成交序列**框架已经全有**：

| 事实 | 证据 |
|---|---|
| `stepBacktestDay` 返回的 `fills` **带 `reason`** | `engine.ts:604-614`；返回类型 `DecisionRecord.fills: Fill[]`（`engine.ts:100`） |
| 卖出 reason = `exitReasons[symbol]`（`take-profit`/`stop-loss`/…） | `simulator.ts:334` |
| 买入 reason = `t.reason`（`candidate-top`/`holding-retained`/…） | `simulator.ts:430` |
| 结算已拿到这些 fills | `settle.ts:367` `result.fills` |

⇒ **唯一缺口是 `exit_reason` 没落库。**

---

## 2. 决策

### 2.1 采纳 **A1 路线**：onFill 历史回放

| # | 改动 | 位置 |
|---|---|---|
| 1 | `paper_order` 加 `exit_reason TEXT`（幂等 `ALTER`，先 `PRAGMA table_info` 判存在）+ 索引 `(account_id, status)` | `store/paperSchema.ts` |
| 2 | 结算写回时把 `fill.reason` 落进 `exit_reason` | `paper/settle.ts` |
| 3 | 决策回放前，查历史 `filled` 订单（按 `trade_date` 排序）→ 构造 `FillNotice` → 喂 `strategy.onFill()` | `paper/decision.ts` |

**回放区间**：`replayStart`（= 落账起点，`decision.ts:262-264`）～ `decisionDate`，
与现有逐日 `decide()` 回放**同区间**，不额外扩窗。

### 2.2 明确不做的事

- **不改** `paper/decision.ts` 的「中间日空组合 / 最终日检查点组合」口径；
- **不改** 任何策略的 `decide()` 语义（DualMomentum 一行不动）；
- **不给旧账户补记** `exit_reason`（新建账户从第一笔成交起即有）。

---

## 3. 代价与风险

| 代价 / 风险 | 量化 | 缓解 |
|---|---|---|
| **公共回放路径改动** | `decision.ts` 影响 wufu / combo / buy-and-hold / dualmomentum **全部** | 实测三者**都没有 `onFill`** ⇒ 喂进去没人接，行为零变化；**回归必须覆盖全部内置策略** |
| **DDL 变更** | 加 1 列 + 1 索引 | 走**幂等 `ALTER`**（只加列，不碰约束 ⇒ 不需要表重建，见 AGENTS.md 判别口诀） |
| **旧账户历史成交无 `exit_reason`** | 历史卖出重建不出「止盈还是止损」⇒ 冷却仍不对 | **新建账户不受影响**；旧账户可在切换/重建时自然过渡。**不做数据回填** |
| **性能** | 每次决策重放全部历史成交 | 跑赢档年换手 24.4 ⇒ 8 年约 400~800 笔 ⇒ 毫秒级；索引 `(account_id, status)` 兜底 |
| **回放期与结算期的职责边界** | 回放只喂 `onFill`，**不在回放期真成交** | 保持现有契约：回放期不产生订单、不动现金；仅重建状态 |

---

## 4. 被否决的备选方案

| 备选 | 否决理由 |
|---|---|
| **A2 策略状态持久化**（`paper_position` 加 `first_buy_date`/`high_water`/`cooldown_json` + 给 `Strategy` 接口加「恢复状态」钩子） | **要改公共 `Strategy` 接口** ⇒ 全部策略受影响，超出「纸面保真」的必要面；且 DDL 已定稿 ⇒ 需另开 ADR。A1 用**既有** `onFill` 契约即可达成同一目标 |
| **A3 §10 原文「全量成交模拟」**（逐日重放含行情、成交、估值） | **与结算阶段重复计算**，两套成交逻辑必然漂移；且 §10.4.1 已证「不需要逐日行情」⇒ 纯属过度工程 |
| **只给 `PositionView` 加 `openDate`**（F-3 的修法①） | `Portfolio.restore()`（`account/portfolio.ts:92-98`）从检查点恢复时把每个持仓压成**一笔合成 `buy`（`price = avgCost`）** ⇒ `openDate` 会变成**恢复日**而不是真实建仓日（源码注释已警告）。**在纸面路径上它就是错的** ⇒ 解决不了本问题 |
| **在适配器 / `decision.ts` 里打补丁**（不落库、每次现算） | `reason` 无处可取 ⇒ 无法区分止盈 / 止损 ⇒ 冷却规则仍然错。**必须落库** |
| **维持现状（方案 D）** | 双动量纸面四条规则永不触发 ⇒ 纸面与回测口径不同、不能互校 ⇒ 纸面只能「看个大概」，无法充当实盘前演练 |

---

## 5. 实施要点（落地清单）

1. **DDL**：`paper_order` 加 `exit_reason`；幂等判存在后 `ALTER TABLE ADD COLUMN`；
   补索引 `idx_paper_order_status (account_id, status)`。
2. **结算**：`settle.ts` 写回 `paper_order` 时，从 `result.fills` 按 `(symbol, side)` 匹配出 `reason` 落库；
   **未成交行** `exit_reason` 留空（与 `unfilled_reason` 语义并存，不冲突）。
3. **决策**：`decision.ts` 在 `strategy.init()` 之后、逐日 `decide()` 之前，
   按 `trade_date` 升序把历史 `filled` 订单转成 `FillNotice` 喂 `strategy.onFill()`；
   **只喂 `replayStart` 之后**的成交（与回放区间对齐）。
4. **回归**：
   - 全部内置策略的纸面决策**逐位不变**（wufu / combo / buy-and-hold）；
   - DualMomentum 纸面与回测**同参数、同区间**下判定一致（止盈/掉出候选/高水位/冷却四条恢复）；
   - 新旧账户行为差异有测试覆盖。
5. **文档回写**：§9.3 禁令解除；§9 表格标注「已修复」；§10.4 标注「已立项」。

---

## 6. 验收

| 项 | 判据 |
|---|---|
| **保真** | 同参数同区间，纸面决策的目标权重 / 退出原因与回测一致（四条 L2 规则可触发） |
| **无回归** | wufu / combo / buy-and-hold 纸面决策逐位不变 |
| **无迁移负担** | 新建账户自第一笔成交起即有 `exit_reason`；旧账户不回填、不报错 |
| **性能** | 单次决策耗时增量在毫秒级（8 年约 400~800 笔回放） |

---

## 7. 签字

| 角色 | 决定 | 日期 |
|---|---|---|
| owner（是否采纳 A1 路线、是否解除 §9.3 禁令） | ✅ **采纳 A1**（2026-11-13） | 2026-11-13 |
| 实施 agent（ADR 起草 + 待派实施） | ADR-025 已归档，实施待排期 | 2026-11-13 |

> ⚠️ **实施排期约束**：正式任务号待 `docs/client/code_implementation_plan_v3.md` 的并行分支合并后再补
> （该文件当前有其它分支在改，**不得触碰**）。
