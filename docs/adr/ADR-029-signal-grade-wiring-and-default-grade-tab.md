# ADR-029 —— 信号定级接线补齐 + 信号页分级默认档改为「全部」

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（2026-11-14） |
| **触发** | 生产事故（arm）：信号页「持仓组 / 自选组」两 Tab 全空，而策略有效性页显示 38 条信号 |
| **落地** | ① 17:02 实时链路与 `POST /api/admin/run-signal` 补 `assignSignalGrades` / `assignSignalCooldowns`；② 前端分级默认档「强」→「全部」；③ 新增回填 CLI `assignSignalGrades.ts`（dry-run 默认） |
| **关联 ADR** | ADR-027（信号分组视图）；ADR-028（废弃 `user_asset_rel` hold 派生） |
| **技术契约** | SDD.md §5.1.2（落库 → 定级 → 冷却 三步契约） |
| **体验口径** | PRD_v3 §4.2（分级默认档） |
| **任务** | plan_v3 T157 |

## 1. 背景（取证链）

2026-11-14 生产实测：用户报「信号页持仓组和自选组都没有任何信号，但策略有效性页面有 38 条信号」。

按「先复现、后修改」的取证链逐层定位：

| 步骤 | 手段 | 实测结果 |
|---|---|---|
| ① 浏览器实况 | Playwright 打开生产 `/signals`，抓请求与响应 | 请求为 `GET /api/signal?page=1&page_size=50&**grade=strong**&dedupe=1&scope=holdings` → **0 行** |
| ② 同一后端去掉 `grade` | 直接打生产 API | `/api/signal?scope=holdings` → **38 行**（`scope=watch` → 0 行：自选只有 2 只且当日无信号，属正常） |
| ③ 生产库 | `sqlite3` 查 `user_strategy_signal` | 38 条信号 `grade` / `expires_at` / `cooldown_until` **全为 NULL**；构成：`position_risk_alert` 32 条（`sub_category='risk'`、`strength=NULL`）、`macd_cross` 5 条、`piercing_darkcloud` 1 条（后 6 条**有 strength**，却 `grade=NULL`） |
| ④ 代码定位 | grep 调用点 | `assignSignalGrades` / `assignSignalCooldowns` **只被 `signalReplay.ts`（区间回放）调用**；`scheduler.ts` 的 17:02 段与 `routes/admin.ts` 的手动触发段**都没有调** |
| ⑤ 既有测试 | 读 `f1-signal-grade.test.ts` | 只测**函数本身**，没有任何测试覆盖**调用点** ⇒ 函数有单测但没人调用（典型假绿） |

**结论**：这不是 ADR-027 分组视图的缺陷，而是**更早存在、且被分组视图放大的两个缺陷叠加**：

1. **后端缺陷**：实时链路从不写 `grade` / `expires_at` / `cooldown_until`；
2. **体验口径缺陷**：信号页分级默认档为「强」，而「强/中/弱」三档的 SQL 是 `WHERE grade = 'strong'`
   ⇒ **未分级行（监控类信号）被整档排除**，默认视图天然为空。

## 2. 决策

### 2.1 后端：三条生成链路统一「落库 → 定级 → 冷却」

1. `scheduler.ts` 的 17:02 段在 `persistSignals` 之后调用 `assignSignalGrades(tradeDate, userId)` 与
   `assignSignalCooldowns(tradeDate, userId)`；
2. `routes/admin.ts` 的 `POST /api/admin/run-signal` 同样调用（响应体附 `graded` / `cooldown_until` 供运维观测）；
3. 口径与区间回放链路**完全一致**（同函数、同 user、同 `tradeDate`、幂等）；
4. 定级只处理 `strength IS NOT NULL` 的行 —— 监控类信号**保持未分级**，不得硬塞进强/中/弱；
5. 只写 3 列，不增删信号行、不改其它列；
6. 历史缺口用 CLI `apps/backend/src/cli/assignSignalGrades.ts` 回填（默认 dry-run，`--execute` 才落库且先自动备份）；
   其预览与落库**同源**（`computeSignalGrades` 只读计算 = `assignSignalGrades` 落库结果）。

### 2.2 体验：分级默认档「强」→「全部」（owner 2026-11-14 裁决）

- 信号页分级 tab **默认选中「全部」**（强 / 中 / 弱 / 已过期仍可手动切）；
- 理由：① 监控类信号按设计无强度 ⇒ 恒未分级 ⇒ 「强/中/弱」三档**永远看不到它们**；
  ② 生产 38 条信号里 32 条是监控类（浮亏触止损），默认取「强」⇒ 信号页（含 ADR-027 两 Tab）全空，
  与策略有效性页（无分级过滤，显示 38 条）口径打架；
  ③ ADR-027 分组视图的产是「每只持仓标的今天有什么结论」，而**监控类信号才是持仓级结论**；
- PRD_v3 §4.2 已同步修订（「默认只显示强」→「默认显示全部」）。

### 2.3 回归门槛：补「调用点」测试

- `apps/backend/tests/unit/signalGradeWiring.test.ts`：捕获并**真实执行** 17:02 的 `signal-generate` cron 任务体
  （`AsyncTask.executeAsync()`），断言当日信号拿到 `grade` / `expires_at` / `cooldown_until`；
- `apps/backend/tests/integration/signalGradeWiring.test.ts`：走**真实 HTTP**（`app.inject()` → `POST /api/admin/run-signal`），
  断言同样的三列被写入；
- 已实测：撤销本次修复后这 5 个用例**全部变红**，修复后全绿 ⇒ 测试确实能抓住该类回归。

## 3. 后果

**正面**

- 信号页默认视图恢复可用：分组视图（ADR-027）两 Tab 不再是空的；
- 「强/中/弱」三档**第一次真正有数据**（交易类信号有了分位档位与有效期）；
- 冷却窗口 `cooldown_until` 落库 ⇒ F6 展示层合并去重的判据与「连续第 N 日」标注有依据；
- 三条生成链路（实时 / 手动 / 回放）口径统一，不再有「回放有档、实时没档」的分叉；
- 回填 CLI 复用同一函数 ⇒ 生产补历史不会与在线口径漂移。

**负面 / 代价**

- 默认档由「强」变「全部」⇒ 首屏信号条数变多（生产实测 38 条 vs 1 条），用户需自行切档过滤；
- 监控类信号**永远不会**出现在强/中/弱三档（这是既定口径，不是本次引入）；
- `expires_at` / `cooldown_until` 依赖**交易日历**（行情库）；行情库不可用时退化为纯工作日推算（既有兜底）。

## 4. 备选方案与否决理由

| 方案 | 否决理由 |
|---|---|
| 只改前端默认档（保留「强」） | 治标不治本：交易类信号（`macd_cross` 等）仍无 `grade`，「强」档永远为空；且 PRD 原规格「默认只显示强」失去事实基础 |
| 只改后端接线（保留默认「强」） | 修完后默认视图仅 1 条（38 条中仅 1 条满足绝对分值强档），持仓组视图仍然近乎为空 ⇒ 事故现象基本复现 |
| 给监控类信号也定档（用绝对阈值兜底） | 违反「无强度不定档」既定口径，且会让 risk 类信号被误读为「强信号」；ADR-027 的综合结论也不允许 HOLD 计票 |
| 在前端做分组过滤（不下推 `scope`） | 与 ADR-027 SDD_v3 §10.4.4 契约冲突（组集合在后端算，1 次 IN 查询） |
| 改 `GET /api/signal` 的 `grade` 语义（把未分级并入「强」） | 破坏 F1 分级语义（PRD §4.2「强/中/弱」是强度分位），且会让 Top5 摘要口径混乱 |

## 5. 验证

- 后端：`signalGradeWiring`（unit 4 + integration 2）全绿；撤销修复即红（已实测）；
- 后端既有受影响用例：`f1-signal-grade` / `signalSubCategory` / `integration/admin` / `t58-signal-persist` 全绿；
- 前端：`signals.test.tsx` / `signals-page.test.tsx` 全绿（默认档断言已同步为「不带 grade 参数」）；
- `npm run typecheck` 全绿；`eslint` 对改动文件无告警；
- 生产验证（部署后）：`GET /api/signal?scope=holdings` 返回条数 = 生产信号条数（不再是 0）。

## 6. 后续（不在本次范围）

- 生产历史信号（2026-11-12 / 11-13）用 CLI 回填 `grade` / `expires_at` / `cooldown_until`（一次性运维动作）；
- 组合信号（`plugin_id='combo:<id>'`）的定档口径（是否参与分位）尚未定义 —— 见 ADR-027 §6 与 plan_v2 I-42 关联项；
- 「已清仓」组是否需要（I-42）仍待 owner 裁决。
