# ADR-001：前端与后端技术选型（指标库 / 图表库 / 测试框架版本）

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（Accepted） |
| **日期** | 2026-10-17（修订同日）|
| **裁决人** | 项目所有者 |
| **关联** | 实施计划 DEC-1 / DEC-3 / DEC-11、§13.2 I-10、§4 |
| **落地任务** | T51、T52、T53、T61、T70、T86 |

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

### 2. 图表库：**选用 `klinecharts@10.1.0`**，只画不算

> ⚠️ **本决策于 2026-10-17 修订**，初版结论是「不引入第三方库，自写 Canvas + SVG」。
> 修订依据见下方「决策修订记录」。

- **核心用法：注册自定义指标，`calc` 直接返回前端预计算的值，库完全不参与计算**
  （已由 spike 实测验证，见下）。因此**不存在前后端双口径**
- 指标归属按「**参数是否可调 + 是否用于决策**」划分：
  | 图上元素 | 计算方 |
  |---|---|
  | MA(5/10/20/60) / MACD / RSI / **KDJ** | **前端**（参数固定，纯装饰）|
  | 成交量 | 后端下发原始 `volume` 字段 |
  | 信号标记 + hover 指标明细 | **后端**（插件引擎，参数每用户可调，是决策依据）|
- 信号**不能**随参数即时刷新（落库 + 每日批量判定），PRD §5.2 已相应下调
- KDJ 为何也在前端算：公式仅约 10 行；**两端同为 JavaScript（IEEE754 double），同公式同输入必然逐位相同**；
  且 KDJ 参数（N=9 / M₁=3 / M₂=3）是 A 股约定**无用户可调项**，不需要即时重算。
  代价是两份实现 → **由 T51 golden 逐位断言兜底**（这是 golden 的设计用途）

#### Spike 实测证据（2026-10-17，临时分支 `spike/klinecharts-injection`，验证后已删除）

| # | 验证项 | 结果 |
|---|---|---|
| V1 | 画 120 根真实 K 线（`sh600519` 前复权，取自本地 DuckDB）| ✅ PASS |
| V2 | 灌外部算的 MACD（dif/dea/macd）| ✅ PASS |
| V3 | 灌外部算的 RSI | ✅ PASS |
| V4 | 灌外部算的 MA（叠加主图）| ✅ PASS |
| V5 | 十字光标 / 缩放平移 / tooltip | ✅ 方法齐全（`scrollByDistance` / `zoomAtCoordinate` / `executeAction` / `subscribeAction`）|
| V6 | **库采纳的值与灌入值逐位相等** | ✅ **`EXACT_MATCH: true`** |

```
灌入: dif=-8.841362092788813  dea=-11.776046422453  macd=5.869368659328373
读回: dif=-8.841362092788813  dea=-11.776046422453  macd=5.869368659328373
```

**机制**（比预想的干净，不需要 override）：
```ts
registerIndicator({
  name: 'SPIKE_MACD',
  calc: () => PRE.map(r => ({ dif: r.dif, dea: r.dea, macd: r.macd })), // 忽略入参，返回预计算值
  figures: [{ key:'dif', ... }, { key:'dea', ... }, { key:'macd', type:'histogram' }],
})
```

⚠️ **v10 是破坏性大版本（2026-07-10），网上 9.x 教程全部作废**，实测确认：

| 9.x 写法 | v10.1 实际 |
|---|---|
| `chart.applyNewData(klines)` | ❌ 不存在 → `setDataLoader({ getBars })` + `setSymbol` + `setPeriod` + `resetData` |
| `chart.getIndicatorSeries()` | ❌ 不存在 → `getIndicators()` |
| 灌值靠 `figures` | 灌值靠 **`calc` 返回值 → `result`** |

**实测体积**：`index.esm.js` 677KB（未压缩，官方称 gzip ≈40KB）；**0 依赖**；Apache-2.0；Snyk **0 漏洞**；
周下载约 3.9 万；4.0k star。本地 SPA 不走公网，bundle 不是否决理由。

**代价**：① 十字光标/缩放/tooltip/响应式由库提供，T70 预期显著缩减；
② 多一个前端依赖，需接受 v10 API 破坏性变更（升级时须重读 CHANGELOG）；
③ KDJ 两份实现，靠 golden 保证。

### 3. 测试框架：**维持 `^2.1.0`，暂不升级**

- 升到 5.x 会导致 core / backend / frontend 三处配置分裂
- `apps/frontend` 的测试基建由 T61 建立，届时三处必须同版本

## 理由

- **同库不同实现**是「禁止跨 workspace import」约束下的唯一可行方案：
  口径一致性靠**同一个库 + 同一份 golden 数据集**在 CI 里验证，而不是靠共享代码
- 适配层只有 2 处形状/约定变换（数组补齐 + 柱值 ×2），不含算法实现 —— 迁移风险可控
- 测试框架升版收益（性能）与破坏成本（三处配置分裂）不对等
- **图表库（本轮修订）**：现有 `Kline.tsx` 465 行只有蜡烛图 + MACD/RSI/MA 的**绘制**，
  T70 要求的十字光标 / 缩放平移 / hover tooltip / 响应式 / KDJ 副图 **全部为 0 命中**。
  「已有 Canvas 实现无需重写」经实测**不成立** —— 自研交互约 1.5 人天且易出边界 bug
  （v10.0.4 一次就修了 6 个拖拽/缩放/十字线状态 bug）。引入库把这部分交出去是划算的

## 后果

### 正面
- SDD §2.5 / §2.6 恢复为与技术现状一致的权威描述
- 算法口径漂移风险从「靠人工比对」降为「golden 逐位断言」
- **图表交互（十字光标 / 缩放 / tooltip / 响应式）不再自研**，T70 工作量预期从 2.0d 降至 ~0.8d

### 负面 / 代价
- 同一份适配逻辑在 core 与 frontend 各存在一份（由 golden 约束二者一致，非共享代码）
- **KDJ 两份实现**（core 手写 + 前端手写），由 T51 golden 逐位断言兜底
- **多一个前端依赖**（`klinecharts@10.1.0`），需接受 v10 的破坏性 API 变更，升级时须重读 CHANGELOG
- 引入 `fast-technical-indicators@1.1.6` **尚未落地**（不在任何 package.json），现为 T51 前置

### 对真相源的影响
- ✅ **SDD §2.5 已回写**（图表库由「自写 Canvas」改为「klinecharts@10.1.0」，含 v10 API 变更清单）
- ✅ **SDD §2.6 已回写**（`fast-technical-indicators@1.1.6` 落实为选用，并标注「尚未安装」）
- ✅ **PRD §5.2 已回写**（「调参后图和信号即时刷新」下调为「图即时 / 信号下次调度生效」）
- ⏳ 待回写：`docs/coding-standards.md:124-127` 的「klinecharts 集成规范」整段作废
- ⏳ 待回写：`docs/coding-standards.md:60` 的「Vitest 5.x」
- ⏳ 待回写：`AGENTS.md` §技术栈中对指标库的描述

## 决策修订记录

| 日期 | 修订 | 原因 |
|---|---|---|
| 2026-10-17 | 初版：图表库**不引入第三方库**，自写 Canvas + SVG | 初版理由：① MVP 图表复杂度可控，不值得引入 150KB 依赖；② 避免 API 变动风险；③ 依赖表已增一项 |
| **2026-10-17** | **图表库修订为选用 `klinecharts@10.1.0`**（只画不算） | **初版三条理由经实测两条不成立**：<br>① 「150KB」—— 实测 gzip ≈40KB、0 依赖，本地 SPA 不走公网，**bundle 不是理由**<br>② 「现有 Kline.tsx 已是 Canvas 实现，无需重写」—— 实测该文件 465 行里**十字光标 / 缩放 / tooltip / KDJ / 响应式全部 0 命中**，T70 要求全缺，**恰是要自研最易出 bug 的 1.5 人天**<br>③ 「API 变动风险」—— 方向反了：风险在**升级与抄 9.x 教程**（v10 是破坏性大版本），不在使用；用 `registerIndicator` + 自定义 `calc` 反而彻底避开内置指标的口径问题<br>**关键验证**：spike 实测 `V6_EXACT_MATCH: true`，证明「库只渲染、值由前端灌入」可行 → **不存在双口径**<br>配套裁决：指标归属按「参数是否可调 + 是否用于决策」划分（KDJ 亦归前端，由 T51 golden 兜底）；PRD §5.2 调参即时刷新相应下调 |

## 备选方案与否决理由

| 备选 | 否决理由 |
|---|---|
| `technicalindicators` | 活跃度存疑；DEC-1 实测后选定 API 兼容且性能更好的替代品 |
| KDJ 用库的 `Stochastic` | 美式口径，与 A 股 K/D 差约 7 个点，**不能靠参数调平** → 改为手写（core + 前端两份，靠 golden）|
| KDJ 走后端算、只放 payload | 2026-10-17 讨论后否决：公式仅约 10 行；**两端同为 JavaScript，同公式同输入必然逐位相同**；且 KDJ 参数固定无用户可调项，不需要即时重算。混合来源反而多一条数据通路 |
| 前端复用 `packages/core` | 违反 AGENTS.md「前端禁止 import core」硬约束 |
| 升级 Vitest 到 5.x | 三处配置分裂，收益仅为性能 |
| **引入 klinecharts 但用其内置指标** | 🔴 **会造出「后端 core 算一套 + 前端库算一套」的双口径** —— 与当初否决 `technicalindicators` 同类问题。自定义 `calc` 灌值可完全规避 |
