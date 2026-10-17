# ADR-001：前端与后端技术选型（指标库 / 图表库 / 测试框架版本）

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（Accepted） |
| **日期** | 2026-10-17 |
| **裁决人** | 项目所有者 |
| **关联** | 实施计划 DEC-1 / DEC-3 / DEC-11、§13.2 I-10、§4 |
| **落地任务** | T51、T52、T53、T61、T86 |

---

## 背景

SDD §2.5 / §2.6 在 Phase 1 给出了选型推演，但结论基于「待验证」假设，且三个选型点与后续
实测/约束不符：

| 项 | SDD 原文结论 | 问题 |
|---|---|---|
| K 线图库 | 推荐 `klinecharts` | MVP 图表复杂度仅「K 线 + 成交量 + 副图」，不值得引入 150KB 依赖 |
| 指标库 | 推荐 `technicalindicators`（标注「需验证」） | 2024 年后活跃度存疑；npm 上有 API 兼容但性能更好的替代品 |
| 测试框架 | AGENTS.md 写「Vitest 5.x」 | 仓库实际 `^2.1.0`，DEC-3 已裁决暂不升级 |

同时存在一个架构约束：`apps/frontend` **禁止 import `packages/core`**（AGENTS.md 硬约束），
所以「前后端共用一份算法实现」这条路走不通，只能共用**同一个第三方库**。

## 决策

### 1. 指标库：`fast-technical-indicators@1.1.6`

- **版本精确锁定 `1.1.6`，禁止 `^`**
- `packages/core` 与 `apps/frontend` **各自直接依赖同一版本**，不跨 workspace 复用实现
- `packages/core` 的 `calculateRSI` / `calculateMACD` 改为**库的薄适配层**，只做两处口径变换：
  1. **数组补齐到 `closes.length`**（库的 EMA warm-up 会让输出短于输入）
  2. **MACD 柱值 `histogram × 2`**（库给国际口径，A 股通达信约定为 2 倍）
- **不实现任何 EMA / DIF / DEA 算法**

**已知缺口**：该库**没有 KDJ**；其 `Stochastic` 是美式口径（K/D 与 A 股差约 7 个点），
**不可直接用于 A 股**，须按公式自写（T52），初值口径（K₀=D₀=50）用 golden 数据集锁死。

### 2. 图表库：**不引入第三方库**，自写 Canvas + SVG

- 现有 `Kline.tsx` 已是 Canvas 实现，无需重写
- klinecharts 的 `chartOverlayConfig` 机制 → 改为**后端插件返回 `chartOverlay` 元数据**，
  前端自绘（该字段由 T93 补齐）
- 代价：十字光标 / 缩放平移需自行实现（T70）

### 3. 测试框架：**维持 `^2.1.0`，暂不升级**

- 升到 5.x 会导致 core / backend / frontend 三处配置分裂
- `apps/frontend` 的测试基建由 T61 建立，届时三处必须同版本

## 理由

- **同库不同实现**是「禁止跨 workspace import」约束下的唯一可行方案：
  口径一致性靠**同一个库 + 同一份 golden 数据集**在 CI 里验证，而不是靠共享代码
- 适配层只有 2 处形状/约定变换（数组补齐 + 柱值 ×2），不含算法实现 —— 迁移风险可控
- 引入图表库的边际收益低于其 API 变动风险与 bundle 成本
- 测试框架升版收益（性能）与破坏成本（三处配置分裂）不对等

## 后果

### 正面
- SDD §2.5 / §2.6 恢复为与技术现状一致的权威描述
- 算法口径漂移风险从「靠人工比对」降为「golden 逐位断言」

### 负面 / 代价
- 同一份适配逻辑在 core 与 frontend 各存在一份（由 golden 约束二者一致，非共享代码）
- KDJ 需手写，是唯一递归平滑指标，口径风险最高
- 图表交互需自研，T70 工作量增加

### 对真相源的影响
- ✅ **SDD §2.5 / §2.6 已回写**（本次 SDD PR）
- ⏳ 待回写：`docs/coding-standards.md:124-127` 的「klinecharts 集成规范」整段作废
- ⏳ 待回写：`docs/coding-standards.md:60` 的「Vitest 5.x」
- ⏳ 待回写：`AGENTS.md` §技术栈中对指标库的描述

## 备选方案与否决理由

| 备选 | 否决理由 |
|---|---|
| `technicalindicators` | 活跃度存疑；DEC-1 实测后选定 API 兼容且性能更好的替代品 |
| KDJ 用库的 `Stochastic` | 美式口径，与 A 股 K/D 差约 7 个点，**不能靠参数调平** |
| 前端复用 `packages/core` | 违反 AGENTS.md「前端禁止 import core」硬约束 |
| 升级 Vitest 到 5.x | 三处配置分裂，收益仅为性能 |
