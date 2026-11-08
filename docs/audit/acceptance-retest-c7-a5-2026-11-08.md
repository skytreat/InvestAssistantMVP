# C7 / A5 缺陷修复复测记录（待执行）

> **状态：待执行** —— 两个修复（PR #130）尚未合入 `main`。本文档先固化「条目清单 + 验证步骤」；**待两个修复合入 `main` 后按本文执行并回填结论**，不以修复分支的结果作为结论。
> **基线（原报告一字未改）**：`docs/audit/acceptance-retest-23-2026-11-08.md`（PR #129）。其中 C7、A5 的「失败」结论作为 2026-11-08 当时的基线**永久保留**，不因本复测而修改。

## 1. 由「失败」转为「通过」的条目

| 原报告条目 | 原报告位置 | 基线结论（保留） | 修复 PR | 复测结论 |
|---|---|---|---|---|
| **C7** 编辑历史（复盘字段留痕） | §1 写库范围 | **失败（真缺陷）** | #130 | 待执行 |
| **A5** 登录过期/无效 token → `/login` 并保留原路径 | §2 数据样本 + §3 浏览器 | **失败（真缺陷）** | #130 | 待执行 |

> 计划文档对应关系：C7 → `docs/client/code_implementation_plan_v3.md` 的 **T131**；A5 → V1 范围的 **T64**（不在 V3 任务表内）。

## 2. 修复 PR

- **PR #130**：`fix: 补测缺陷 C7/A5 修复（复盘字段持久化 + 并发 401 保留原路径）`，base `main`。含两个原子 commit（后端 C7 / 前端 A5），本 PR 完成时尚未合入。

## 3. 验证方式（合入 `main` 后执行）

前置：确认两个修复均已在 `main`；从 `main` 起临时环境执行；业务库不写（沿用原报告 §0 的只读+临时库做法）。

### 3.1 C7 —— 写入后回读一致 + 未传字段不被覆写

1. 录入一笔买入交易（独立测试库）。
2. `PATCH /api/trade/:id`，payload `{ emotion_status:'焦虑', buy_reason:'突破买入', sell_reason:'止损离场', system_followed:1 }` → 期望 `200` 且 `code=0`。
3. 回读该笔交易 → **四个字段与写入值逐字段一致**（写入后回读一致）。
4. 再 `PATCH` 仅 `{ remark:'只改备注' }` → `200`；回读其余四字段**保持原值**（未传字段不被覆写为 `null`）。
5. 反例：`PATCH /api/trade/999999999` → `404`（确实未写入时不返回 200）；`emotion_status:'非常开心'` → `400`（非法枚举不伪装成功）。

自动化命令：

```bash
npx vitest run apps/backend/tests/integration/review.test.ts --config apps/backend/vitest.config.ts --pool=forks --poolOptions.forks.singleFork=true
```

### 3.2 A5 —— 并发 401 下只重定向一次且回到原始路径，`/login` 不被写进 `from`

1. 登录后访问带 query 的受保护页（如 `/review?tab=pairs`），令 access token 失效。
2. 首屏触发多个并发请求（≥3 个 401）。
3. 断言：`location.state.from === '/review?tab=pairs'`；会话过期事件**只广播一次**；浏览器已跳 `/login` 后**迟到的 401 不得把 `from` 覆盖成 `/login`**。
4. 重新登录 → 回到 `/review?tab=pairs`。

自动化命令：

```bash
npx vitest run apps/frontend/tests/unit/sessionExpiry.test.tsx --config apps/frontend/vitest.config.ts
```

对应用例：`并发多个 401 → 只广播一次且 from 保持原始路径（绝不写入 /login）`。

## 4. H2 —— 已知未修（决定，不是遗漏）

- **现象**：样本文件名使用简称「国泰」时，解析器未命中「国泰君安证券」，导入按钮显示「未识别」并禁用。
- **不修理由**：这是券商简称别名表的命中率问题，属识别覆盖率改进，非阻断性缺陷；**已有手动兜底** —— 用户可在券商下拉手动选择「国泰君安证券」后继续导入。
- **结论**：本次**明确不修**。原报告 H2「失败」结论保留，不转「通过」。

## 5. 执行状态

- 复测：**待两个修复合入 `main` 后执行**（当前 PR #130 未合入）。
- 原报告 `docs/audit/acceptance-retest-23-2026-11-08.md` **一字未改**（含 C7 / A5 / H2 的「失败」结论）。
