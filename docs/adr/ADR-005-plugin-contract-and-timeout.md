# ADR-005：插件契约字段、50ms 计时边界与热重载归属

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（Accepted） |
| **日期** | 2026-10-17 |
| **裁决人** | 项目所有者 |
| **关联** | 实施计划 §13.1 **B-3**（计时边界）、**B-8**（契约字段）、**B-13**（热重载归属） |
| **落地任务** | T88（**先于 T83**）、T93（与 T83/T58 同批）、T94 |
| **真相源依据** | SDD §5.3、§12.3 P3、§4.4:1267、§12.5 F8/PE6；PRD M5 |

---

## 背景

三个插件相关问题，彼此独立但同源。

### 1. 两个内置插件 100% 超时，信号 0 条（B-3）

实测 `POST /api/admin/datacheck/trigger` 的信号段返回 `{total:2, success:0, timeout:2}`，
`user_strategy_signal` **0 条**。而 RSI/MACD 的实测计算耗时只有 0.1~1ms，远在 50ms 预算内。

根因：SDD 只写「`execute()` 硬限制 50ms（Promise.race + reject）」，**未定义计时从哪开始**，
实现把 DuckDB 行情查询放进了计时窗口。

后果：**§12.5 F8「每日自动跑策略信号」与 PE6 双双不可达。**

### 2. 插件契约字段缺失近半（B-8）

SDD §5.3 开篇写「本节为插件引擎的**核心设计契约**，所有内置插件与自定义插件必须严格遵循」，
要求 `version` / `author` / `period` / `sub_category` / `complexity` / `defaultParams` / `chartOverlay`。

代码 `pluginEngine.ts:62-72` 的 `Plugin` 接口只有 5 个字段：

```ts
interface Plugin {
  id; name; description?; category: 'monitor'|'filter'; paramSchema?;
  execute(context, params): Promise<PluginSignal[] | PluginSignal>;
}
```

连带差异：`PluginSignal.signalType` 是大写且多一个 `ALERT`（SDD 无此项）；
SDD 叫 `metrics` 而代码叫 `params`；SDD 返回 `StrategySignal | null` 而代码返回数组或单对象。

### 3. `/api/strategy/reload` 被误判为 V2（B-13）

初版实施计划把「插件运行时热重载扫描自定义 `.js`」列为 Out-of-Scope，
依据是 AGENTS.md「自定义插件只能放该目录且仅限 `.js`；禁止动态 eval」。

**这是误读** —— 那三条是**路径 / 扩展名 / eval 约束，不是功能禁令**。

而实测发现底层能力**早已实装**：

| 已有 | 位置 |
|---|---|
| `PLUGIN_ALLOWED_PATH = '/opt/invol/plugins/strategies'` | `pluginEngine.ts:17` |
| `PLUGIN_FILENAME_RE`（文件名白名单） | `:185` |
| `loadPluginsFromDir()` | `:201` |
| `createPluginSandbox()`（Proxy 屏蔽 `globalThis`，`global/process/require/module/exports/fetch/XMLHttpRequest` 全置 `undefined`） | `:291` |
| `getAllPlugins()` | `:412` |

**全仓 grep「reload」零命中 —— 缺的只有 admin HTTP 路由壳。**

## 决策

### 1. 50ms 只覆盖插件自身计算，**不计行情 IO**

| 计入 50ms | 不计入 50ms |
|---|---|
| `execute()` 内的指标计算与判断 | DuckDB 日线查询 |
| | 批量取行情、构造 context |
| | 信号序列化、落库 |

实现顺序：**先批量取行情 → 构造 context → 再开始计时 → 调 `execute()`**。

**但沙盒安全约束不受影响**：插件内部死循环 / 阻塞仍必须被 `Promise.race` reject
并标记 `PLUGIN_TIMEOUT`（SDD §12.3 P3）。
**不得以「IO 不计时」为借口放宽超时保护。**

> SDD §5.3 的 `execute(dailyData, params)` 签名本身已隐含该前提 ——
> 数据是**传入的**，不是在 `execute` 内查的。

### 2. 补齐插件契约全部字段（T93）

- `Plugin` 接口补 7 个字段
- **`paramSchema` 与 `defaultParams` 的取舍一次定死**：
  `defaultParams` 为只读默认视图，`paramSchema[].default` 为实际来源，
  **禁止两处各写一份默认值**；加一致性断言防漂移
- `params` → `metrics` 统一（牵动 `signalService.ts` 落库与 T58 的 `metrics_json`）
- `signalType` 的 `ALERT`（SDD 无此项）裁决删除或补 SDD
- 加**「插件字段完备性」单测**：遍历 `getAllPlugins()` 全部插件，
  **内置与自定义走同一断言**，不得对自定义插件放宽

### 3. `/api/strategy/reload` **属 MVP**（T94）

只需补 admin 路由壳，**工作量 0.5d**（远低于初版估计的 1.5d）。
- 仅 admin 可调用 + 写 `system_log`
- **单个插件加载失败不得影响已加载插件**（逐文件 try/catch 隔离）
- **§8 Out-of-Scope 表删除该条**

路径口径：SDD §5.3 写 `/opt/invest/plugins/`，代码与 AGENTS.md 写 `/opt/invol/`
（已随本次 SDD 回写统一为 `/opt/invol/`）。

## 后果

### 正面
- F8 与 PE6 从「不可达」变为可达
- 插件契约与 SDD 一致，自定义插件有明确的字段要求
- T94 成本远低于预期（沙盒与加载器已实装）

### 负面 / 代价
- T89/T93/T94 都要改 `pluginEngine.ts`，需协调 commit 顺序（T88 → T93 → T83）
- `params` → `metrics` 改名牵动落库与前端，须与 T58 同批

### 对真相源的影响
- ✅ **SDD §5.3 已回写「50ms 计时边界」小节 + 实测数据**
- ✅ **SDD §5.3 路径已统一为 `/opt/invol/`**
- ⏳ 待回写：`docs/coding-standards.md:99,104` 的接口名（`StrategyPlugin` / `StrategySignal`）
  与返回类型（`| null`）与代码不符 —— **但 SDD 侧是正确的**，该改代码（T93）
