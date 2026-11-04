# 开放项清单（生成物）

> ⚠️ **本文件由 `npm run docs:gen` 生成，禁止手改**。每条**只链接**到卡或来源章节，**零复述**（ADR-018 D4）。
> 「开放决策未上浮」由 `docs-lint --check` 兜底（ADR-018 D6）。

## 1. 活跃任务卡

| ID | 标题 | 优先级 | 决策依据 |
|---|---|---|---|
| [D-32](./tasks/v3/D-32.md) | t55「真实 DuckDB 数据」板块表前置断言过期（断言 0 行 vs 实测 89928 行） | P2 | [来源](./audit/v3-pending-decisions.md) |
| [D-37](./tasks/v3/D-37.md) | 推导回放的起点与期前持仓口径（SDD_v3 §9.3 未定义） | P2 | [来源](./audit/v3-pending-decisions.md) |
| [D-38](./tasks/v3/D-38.md) | 单行判定异常分支（buy 且 balance_after < quantity）保守判 buy | P2 | [来源](./audit/v3-pending-decisions.md) |
| [D-49](./tasks/v3/D-49.md) | T138 字段归一化（INV-S2-14/15/17~20/52）代码补零改动已回退，待重做 + G5 回归 | P1 | [来源](./audit/v3-pending-decisions.md) |

## 2. 开放偏差（plan_v2 §13）

| ID | 摘要 | 备注 |
|---|---|---|
| I-2 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-7 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-9 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-12 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-13 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-15 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-16 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-17 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-19 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-20 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-21 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-22 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-23 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-24 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-25 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-27 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-28 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-29 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-31 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-32 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-35 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-36 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| S-3 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| S-7 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| S-9 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| B-3 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| B-6 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| B-9 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| B-10 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| B-11 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| B-12 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| B-4 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| B-7 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| B-8 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| B-13 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| B-15 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |
| I-34 | 见来源原文 | [docs/client/code_implementation_plan_v2.md](./client/code_implementation_plan_v2.md) |

## 3. 开放决策（v3-pending-decisions）

| ID | 事项 | 备注 |
|---|---|---|
| D-1 | V3 任务编号（撞 v2 T100~T111） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-3 | V3.1 样本文件 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-4 | V3 第一个 PR 的范围 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-6 | 文档 PR（#25）的验收落档名 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-10 | 「同日先送股后分红」的实现层（T119） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-10b | `PositionResult.cashReceived` 为必填（非 SDD §8.4 的「可选字段」） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-11 | SDD_v3 §8.5 原文「删除 getHoldingBeforeDate 中 bonus → +quantity 分支」不执行 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-12 | T120 资产分类不新增管理 API 端点（SDD §9 无独立端点） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-13 | 逆回购品种段实测确认（V3-B5/Q2 关闭） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-14 | 货币 ETF near_par 阈值重定义（推翻 SDD 原文「最新价贴近 100」） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-15 | xlsx 读取零新依赖 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-16 | fileKind 判定打分制（SDD §3.2 特征表扩展） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-19 | 上传通道 = base64 JSON（不引入 @fastify/multipart） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-20 | 回填 L1「稳定标识（成交编号=合同序号）」通道暂缓 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-21 | 去重/回填的「方向」按事件语义判定，不得用 cash_flow 符号 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-22 | 货币 ETF 申赎子事件腿别：退款=流入（卖出侧）/ 扣款=流出（买入侧） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-23 | 逆回购隐含年化口径 = 本金×天数加权（1.44%），非规格 2.04%（日均口径） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-24 | 逆回购配对 = 金额带 [0.995,1.02] + 最小差值贪心 + 同开仓日 2~3 笔合并收回拆分（v2） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-25 | `/api/broker-reconcile/latest` 按需重算，不建报告表 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-26 | T126 returnSummary = 两口径占位（现金类=逆回购利息；货币 ETF 市值收益需行情上下文未计），严格三口径归 T132 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-32 | t55「真实 DuckDB 数据」板块表前置断言过期（断言 0 行，实测真库板块表现在 89928 行） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-34 | T128 物理形态三处自决（SDD 留白期未钉死） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-37 | 推导回放的起点 = 事实层该标的在该券商的导入首行，期前持仓（手工/覆盖区间之外）不并入回放 frame | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-38 | 单行判定的异常分支：买 & `balance_after < quantity`（余额少于成交量）保守判 `buy`（建仓） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-40 | 交易对配对算法：按标的分桶→时间排序；buy/add 合并开仓；reduce/clear 生成 closed pair（部分平仓保留剩余）；bonus 摊薄数量；末尾未平仓单独 open 组 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-41 | 三口径收益率现金类收益 = cash ETF 市值变动 + 逆回购配对利息；repo 在途头寸不并入 MV；broker 维度筛选可选 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-45 | manual_sheet 三方对账（INV-S2-45~47）判定 V4 候选（owner 2026-10-26 裁决） | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
| D-49 | T138 字段归一化（INV-S2-14/15/17~20/52）：代码补零改动已回退 | [docs/audit/v3-pending-decisions.md](./audit/v3-pending-decisions.md) |
