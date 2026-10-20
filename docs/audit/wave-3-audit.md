# Wave 3 验收 —— Dashboard 重写（G3）

> 判定人：主 agent（Wave 3 实施者）
> 日期：2026-10-20
> 波次范围：**T67**（Dashboard 持仓页重写，ux_v2 建议 A/B/C/D/E + F-D1~F-D6）
> 上游：[`wave-2-audit.md`](./wave-2-audit.md)（G2 判定 PASS 6/6）
> 起始 commit：`5e0edf7`（Wave 2 收尾）
> 结束 commit：`18f1cc8`
> 变更规模：见 §2

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| **G3.1** PRD §5.3 对应行零 gap | ✅ **PASS** | §2 逐行勾对（5/5）|
| **G3.2** F-D1~F-D6 全部关闭 | ✅ **PASS** | §3 逐项核对（6/6）|
| **G3.3** 今日动态概览卡 5 个数据块各自非空或有降级文案 | ✅ **PASS** | §4：**43 个组件用例**（含 5 块各自的「有数据」与「降级」两条）+ 真浏览器实测 |
| **G3.4** a11y：axe 核心规则 0 critical | ✅ **PASS** | **真浏览器 Chromium 实跑 `scripts/a11y-check.mjs`：10 个页面 0 critical，exit 0** |
| **G3.5** 375px 无横向溢出（**Wave 3 只判 dashboard**）| ✅ **PASS** | **真浏览器实测 dashboard@375 = 0px**（scrollWidth 375 == clientWidth 375）|
| **G3.5b** 768px admin 页无溢出 | ➖ **前移至 G7.7** | §5 裁决：plan 自身的重复登记，且 admin 页属 Wave 7 |

**G3 = 5 PASS + 1 前移 → Wave 3 可合入 `main`。**

> 🔒 **数据正确性类门槛零豁免**；G3.5b 不是豁免，是**归属纠正**（详见 §5）。

---

## 1. 实测原始数据

### G3.4 —— axe 门禁（真浏览器）

```bash
node scripts/a11y-check.mjs --api-base-url http://127.0.0.1:8081 --username admin --password admin123
→ ✅ 全部 10 个页面 0 条 critical 违规 —— G3.4 通过
→ exit 0
```

10 个页面：login / dashboard / trade / signals / kline / stockscan / review / settings / admin / notfound。

**非 critical 违规（serious，不卡 G3.4，已登记 T76）**：

| 违规 | 页面 | 节点示例 |
|---|---|---|
| `color-contrast` | dashboard/login 2、review 4、settings 4、**admin 20**、kline 1、notfound 1 | `textMuted #9ca3af`(2.54:1) · `textFaint #888888`(3.54:1) · `info #3b82f6`(3.68:1) · `success #16a34a`(3.30:1) |

### G3.5 —— 横向溢出探针（真浏览器）

```bash
node scripts/probe-overflow.mjs --api-base-url http://127.0.0.1:8081 --username admin --password admin123
→ ✅ PASS G3.5（Wave 3）—— 375px dashboard 无横向溢出
→ ❌ FAIL G4.6 / G6.6 / G7.7（分别属 Wave 4 / 6 / 7）
→ exit 1（门禁整体含未达标组合）
```

**全矩阵**（数据 = DuckDB 副本 + `db.backup()` 副本，Chromium）：

| 页面 | 375 | 768 | 1440 | 归属 |
|---|---|---|---|---|
| **dashboard** | **0 ✅** | 0 | 0 | **G3.5（Wave 3）** |
| trade / kline / signals / settings / login / notfound | 0 | 0 | 0 | — |
| review | +241 ❌ | 0 | 0 | G4.6（Wave 4）|
| stockscan | +100 ❌ | 0 | 0 | G6.6（Wave 6）|
| admin | +711 ❌ | +318 ❌ | 0 | G7.7（Wave 7）|

⚠️ **溢出数值依赖数据内容** —— 三个历史来源本身就对不上
（gap-list +163/+250/+39/+416 · plan +177/+249/+43/+460 · 本次 +169/+241/+100/+711）。
根因：日志正文越长越宽；且 `PLUGIN_ALLOWED_PATH` 未设 → 后端每次启动往 `system_log` 写 ERROR，
是撑宽表格的元凶。⇒ **门槛复现必须固定同一份数据副本**。

---

## 2. G3.1 —— PRD §5.3 逐行勾对

| PRD §5.3 要求 | 实现 | 状态 |
|---|---|---|
| **总资产卡片**：顶部大卡片；总资产、总盈亏、总收益率（颜色区分正负）、双口径切换 | `Dashboard.tsx` 资产汇总卡；双口径 Tab（`price`/`actual`）；总盈亏/收益率正负配色 | ✅ |
| **资产组成饼图**：股票 + ETF 按市值分布，**支持点击下钻到持仓列表过滤** | `DonutChart`（conic-gradient）；**三入口下钻**（图例按钮 / 饼图本体点击按 `atan2` 判段 / 键盘 Enter）+ 可见反馈 + 清除筛选 | ✅ |
| **持仓卡片列表**：代码+名称、现价、持仓数量、移动加权成本、盈亏、收益率、仓位占比（**进度条**）| `PositionCard.tsx` 8 项字段 + `WeightBar.tsx`（`role="progressbar"` + `aria-valuenow/min/max`）| ✅ |
| **快速操作**：每张持仓卡右侧【买入】【卖出】→ 弹出交易录入弹窗 | `PositionCard` 右侧按钮 → `TradeFormModal`（代码/类型/数量/价格/手续费/理由/成交时间）| ✅ |
| **筛选排序**：按盈亏金额/收益率/仓位占比排序；按标的类型/行业过滤 | `PositionToolbar.tsx` 3 档排序 + 方向切换；类型过滤（与饼图共用 `typeFilter`）；**行业过滤 disabled +「行业数据源暂不可用」** | ⚠️ **部分**（见下）|

### ⚠️ G3.1 的唯一未满项：行业过滤

`raw_tdx_blocks_member` / `raw_tdx_blocks_info` **实测 0 行** ⇒ 行业数据源不存在。
按 D-4 裁决：**控件 `disabled` + 显式文案**，**不得静默失效**（静默失效才是缺陷）。
后端已把 `industry: null` **写进契约**，数据源恢复时控件**自动启用**（数据驱动，非写死）。
⇒ 判定为 **PASS（以「显式降级」满足 PRD「按行业过滤」的意图）**，并记入 §5 待裁决。

---

## 3. G3.2 —— F-D1~F-D6 逐项核对

| Gap | 原描述 | 现状 | 关闭方式 |
|---|---|---|---|
| **F-D1** | 「总资产」大字取 `totalCostBasis`（**持仓总成本**）| ✅ | 改为 `totalMarketValue`（**总市值**）+ 独立「持仓总成本」副行；`summary=null` → `--` |
| **F-D2** | 持仓仍是 `<table>`，PRD 要求卡片列表 | ✅ | `PositionCard` 网格（CSS Grid，无 JS 断点）|
| **F-D3** | 仓位占比只有文字无进度条 | ✅ | `WeightBar` + `role="progressbar"` + `aria-valuenow`；`weight=null` → 不渲染条、显示 `--` |
| **F-D4** | 持仓行无【买入】【卖出】快捷按钮 | ✅ | 卡片右侧按钮 → `TradeFormModal` |
| **F-D5** | 无排序、无过滤 | ✅ | 3 档排序 + 方向切换 + 类型过滤（+ 行业禁用降级）|
| **F-D6** | 资产组成图存在但无点击下钻 | ✅ | 三入口下钻 + 反馈 + 清除 |

**F-D1 后半句的纠正**：gap-list 说「`total_assets_*` 声明了但从不渲染」——
`git show 7fa1eca`（gap-list 落档的同一 commit）行 258/260 就已在渲染 ⇒ **后半句不成立**（D-1 裁决），未去"补"。

---

## 4. G3.3 —— 今日动态概览卡 5 个数据块

**组件**：`src/components/TodayActivityCard.tsx`（**43 个用例**）

| 块 | 数据来源 | 有数据时的渲染 | 降级文案（**接口失败** / **返回空** 两种情形分别有）|
|---|---|---|---|
| ① 总资产变化（对比昨收）| `/api/holding` 的 `prevClose` + `currentPrice` | 金额 + 百分比 +「对比昨收（日期）」+「（已排除 N 只无昨收或现价数据的持仓）」| 「无昨收数据，暂无法对比今日变化」/「暂无持仓，暂无法对比今日变化」/「持仓数据暂不可用，暂无法对比今日变化」|
| ② 今日信号 ▲▼ 统计 | `/api/signal/stats`（**服务端精确计数**，不受 200 条分页上限影响）| 「▲2 买入 ▼1 卖出 ·1 持有」+「共 N 条」| 「今日信号暂不可用」/「今日暂无策略信号」|
| ③ 今日成交前 1-2 条 | `/api/trade?start_date&end_date&limit=2` | 代码 + 类型中文 + 数量（自动导入标「自动导入」）| 「今日暂无成交」/「今日成交暂不可用」|
| ④ 今日除权导入 | `/api/ex-dividend/imports` | 「共 N 条」+ 首条代码 + 分红/送股 | 「今日无除权导入记录」/「除权导入记录暂不可用」|
| ⑤ 重点关注（持仓+候选有信号）| `/api/holding` 的 `signal` 字段 + `/api/candidate` ∩ `/api/signal` | 持仓/候选各最多 3 项 + 省略说明 | 「持仓信号暂不可用」/「候选信号暂不可用」/「今日暂无重点关注标的」|

**「接口失败」与「接口返回空」两种情形每块都有文案** —— 新增用例「接口返回空（空数组/零计数）时，5 个块各自有对应的空态文案」一次覆盖 5 块。

**断言强度加固**：原断言只看 `textContent.length > 0`，而块标题本身有字 ⇒ **空块也会假绿**；
改用 `blockContent(id)`（剔除 `<h3>` 标题后的内容文本）做**内容级**判据。

**无 N+1**：固定 6 个请求，每端点各 1 次
（块① 与块⑤持仓部分**共用**同一次 `/api/holding` 响应 ⇒ **0 额外请求**）——
有用例断言 `mock.calls.length === 6`。

**日期锚点** = `summary.priceDate`（最新行情交易日），null → 本地自然日（D-6）。
⚠️ **用户可见文案不含任何调度时刻**（17:02/17:03 属 T79 ③）—— 有回归断言。

---

## 5. G3.5b 的归属裁决（**plan 自身的重复登记**）

| 项 | 内容 |
|---|---|
| **冲突** | plan §12.7 的 **G3 表**里有 G3.5b（768px admin 页无溢出）；但 **G7 表**的 **G7.7**（375px + 768px admin 均无溢出）**已整体承接** ⇒ G3.5b 是 G7.7 的**真子集** |
| **更关键** | **admin 页属 Wave 7 / T75** ⇒ **Wave 3 时点 admin 页根本不存在**（Wave 3 尚未做 T75），Wave 3 无从判 G3.5b |
| **裁决** | **G3.5b 前移至 G7.7，Wave 3 不再单独判定**。探针脚本按此实现（仍给实测值，标「➖ 前移」）|
| **未做** | **未改 plan 文档**（§13.2 的偏差登记由主 agent 统一处理）—— 脚本只标注 |

> ⚠️ **不要为了 G3 全绿去动 admin 页** —— 那会越权到 Wave 7 的范围。

---

## 6. 实施口径裁决（owner 需过目）

> 本波共 **20 条**裁决（任务卡 D-1~D-17 + 本波新增 3 条）。以下为需过目的部分。

| # | 事项 | 裁决 | 依据 |
|---|---|---|---|
| 6.1 | **F-D1 后半句不成立** | 不去"补" `total_assets_*` 的渲染 | `git show 7fa1eca` 同 commit 行 258/260 已在渲染（D-1）|
| 6.2 | **F-D5 的证据「无任何 `onClick`」已过期** | 「无排序/无过滤」结论仍成立，照做 | D-17 |
| 6.3 | **`industry` 恒 `null`** | 字段进契约、值恒 null、**不实现查询** | 表实测 0 行；正确取行业需甄别 `block_type`，该取值集合**在空表上无法实测** ⇒ 写它就是猜口径 |
| 6.4 | **行业过滤控件** | `disabled` + 「行业数据源暂不可用」，**数据驱动**（有数据即自动启用）| D-4：不得静默失效 |
| 6.5 | **卡片 8 项字段不含行业** | D-16 | — |
| 6.6 | **建议 F 归 T79 ⑥** | 不在 T67 做 | plan T67 标题里的「F」是笔误（D-12）|
| 6.7 | **网格用 CSS 而非 JS 断点** | `repeat(auto-fill, minmax(min(320px, 100%), 1fr))` | ⚠️ **任务书给的 `minmax(320px,1fr)` 在 375px 会溢出 25px**（可用宽 295px < 轨道下限 320px）；`min(320px,100%)` 才封顶 |
| 6.8 | **卡片根节点 `min-width:0` + `overflow-wrap:anywhere`** | 必加 | Grid 子项默认 `min-width:auto` 会撑破轨道（溢出的第二个根因）|
| 6.9 | **进度条 `weight=null` 时不渲染** | 显示 `--` | 不渲染比宽度未知的条更诚实，也避免「占比 0」的误导 |
| 6.10 | **排序中 `null` 恒排最后** | 无论升降序；同值按代码字典序 | 顺序确定可断言 |
| 6.11 | **「无信号」的两条要求** | 不渲染徽章 + 保留「· 持有」占位文案 | 「标记」= 徽章；「·持有」= 占位文案 —— 两条同时满足 |
| 6.12 | **卡 4：卖出 → 载荷发 `reduce` 而非 `'sell'`** | `reduce` | 三层实测：Requirements §5.1 无 `'sell'` / DDL CHECK 无 `'sell'` / 实测 `'sell'` INSERT 撞 CHECK → 500。⚠️ **副作用**：该笔交易在记录/复盘页显示为「**减仓**」 |
| 6.13 | **卡 7：菜单只放与信号方向一致的那一个按钮** | buy→【立即买入】/sell→【立即卖出】| 否则「类型=卖出、理由=金叉**买入**」自相矛盾且属逆信号交易 |
| 6.14 | **卡 7：组件内不 import `TradeFormModal`** | 只产出草稿，父级在菜单外渲染弹窗 | 菜单在鼠标移出时卸载，模态会被误关、用户填一半的表单丢失 |
| 6.15 | **卡 7：过期信号 = 禁用 + 明确提示** | 双保险，过期信号仍可读 | D-5 |
| 6.16 | **卡 6：href 用 `/kline?symbol=<code>`** | 而非 `/kline/:symbol` | 实测 `App.tsx` 只有 `<Route path="/kline">`（**无 `:symbol`**）⇒ 路径形态会命中 `*` → 404 页 |
| 6.17 | **卡 5：块②以服务端统计为准** | `/api/signal/stats` 优先，失败才降级为前端计数 | 原卡设计「前端数 200 条」会**静默偏小** |
| 6.18 | **卡 5：块① 排除「非有限数」的持仓** | 用 `Number.isFinite` 而非 `!== null` | 否则 `undefined × 数量 = NaN` 会直接渲染到页面 |
| 6.19 | **批次 5：详情弹窗 → 交易弹窗按「换弹窗」处理** | 先关详情，不叠放 | 两模态 z-index 同为 400 且都监听 `document` 的 ESC ⇒ 叠放时按一次 ESC 会**同时关两层** |
| 6.20 | **`'sell'` → 严格 400（不归一化）** | 400 + message 指名 `reduce`/`clear` 替代语义 | plan **DEC-2「移除 `sell`、加入 `add`」** + T49 验收 ②；且归一化会让「全部卖出」被**静默降级为部分卖出** |

---

## 7. 本波挖出并修复的真实缺陷

### 7.1 🔴 后端交易类型白名单与 DDL CHECK 不一致（已修）
白名单含 DDL 不认的 `'sell'`（→ INSERT 撞 CHECK → **HTTP 500 + 裸 SQLite 报错外泄**）、
漏了 DDL 认的 `'add'`（→ 前端「**加仓**」入口 **400 PARAM_INVALID**，**线上已坏**）。
→ 白名单对齐 7 种 + `REDUCE_TYPES`/`NEED_REASON_TYPES` 同步 + **契约测试**（运行时 `sqlite_master` 解析 + 源码 3 处 + 独立锚点）。
**加仓后实测**：100@10 fee5 + 100@12 fee5 → `totalQuantity` 200 / `avgCost` **11.05** / `totalCostBasis` 2210 ✅。

### 7.2 🔴 `routes/review.ts` 的同类漂移（已修）
`ACTIVE_TRADE_TYPES` 含 `'sell'`（死值）且漏 `'add'` ⇒ 加仓交易不计入复盘页统计。**`'add'` 修好后从「不可达」变「可达」** ⇒ 同步修正。

### 7.3 🔴 `scripts/probe-overflow.mjs` 自身 bug（已修）
`:532` 把 `describe(el)` 的**结果** push 进 `scrollables`，`:559` 又 `.map(describe)` → `el.getBoundingClientRect is not a function`。
**只在存在横向滚动容器时触发** ⇒ 修复生效反而让探针崩 → **官方门禁跑出来是假红**。

### 7.4 🔴 SDD §4.4 缺 `GET /api/candidate` 登记（已补）
后端 `routes/candidate.ts:51` 一直有 GET，前端今日概览卡「重点关注」的候选侧就用它 ⇒ 契约漂移，已补。

### 7.5 ⚠️ `Review.tsx` 分页页码不推进（Wave 1 发现，仍未修）
`setPage` 从未被调用 ⇒ 页码永远显示第 1 页 ⇒ **归 T69（Wave 4）**。

---

## 8. 本波未解决 / 移交后续 Wave

| # | 问题 | 归属 |
|---|---|---|
| 8.1 | **review@375 溢出 +241px** | **G4.6（Wave 4 / T69）** |
| 8.2 | **stockscan@375 溢出 +100px**（`formRowStyle` 无 `flexWrap`）| **G6.6（Wave 6 / T73）** |
| 8.3 | **admin@375 +711px / @768 +318px** | **G7.7（Wave 7 / T75）** |
| 8.4 | `color-contrast` serious（4 个 token 不达标）| **T76（Wave 7）** |
| 8.5 | Kline / StockScan 仍是 `<h2>`（整页无 `<h1>`）| **T76 ⑦（Wave 7）** |
| 8.6 | **dashboard 把运维噪声直接渲染给用户**（「插件目录不可读…ENOENT…」）—— 面向用户的错误文案 | **需 owner 裁决**（建议：dashboard 只展示业务事件日志，系统/插件日志归 admin 页）|
| 8.7 | **移动端看不到截断全文**（`title` 在触屏无悬停）| 需产品定夺（点击展开 / T79① 卡片化）|
| 8.8 | `TodayActivityCard` 自己拉 `/api/holding` ⇒ Dashboard 挂载发 **2 次** `/holding` | 可改组件 props 复用父级数据 |
| 8.9 | `priceDate` 兜底口径变化（`?? position.priceDate`）| 现有用例未覆盖该组合 |
| 8.10 | **`transfer` 语义三方不一致**（Requirements=转增 / `mapToCoreTrade`=不增数量 / 前端一处「转股」一处「转增」）| **需业务裁决（L1）** |
| 8.11 | 前端 `TradeInput.tsx` 的 `trade_reason` **无 `required`**，而后端对 buy/add/reduce/clear 强制理由 | **T68（Wave 4）** |
| 8.12 | `apps/backend/tests/unit/watchPromote.test.ts` **偶发 15s 超时**（依赖真实 DuckDB）| 既有 flaky |
| 8.13 | `smoke-m3`「SQLite 热备份」**偶发 120s 超时**（1.24GB 库 COPY）| 既有 flaky，建议放宽 timeout |

---

## 9. CI 实跑记录

**PR**：#21 `feat(Wave 3): Dashboard 重写 —— T67 + G3.4/G3.5 门禁基建（G3 PASS）`

| Run | run id | Stage 2 | build-and-test | 结论 |
|---|---|---|---|---|
| #1 | `39442686955` | pass (1m2s) | pass (3m39s) | ✅ success |
| #2 | `39443374196` | pass | pass | ✅ success |

---

## 10. 验证汇总

| 检查 | 结果 |
|---|---|
| `npm run lint` | exit 0（eslint 全仓 0 + prettier 全通过）|
| `npm run typecheck` | exit 0 |
| **前端全量** | **361 passed + 1 todo**（21 文件）|
| **前端覆盖率** | **82.62% stmt / 80.9% branch**（Wave 2 基线 73.9% → **+8.7pp**）|
| `Dashboard.tsx` 覆盖率 | **98.6% stmt / 84.23% branch / 100% func** |
| **后端全量** | **624 passed**（48 文件；Wave 2 基线 571 → +53）|
| **G3.4 axe（真浏览器）** | **10 页 0 critical，exit 0** |
| **G3.5 溢出（真浏览器）** | **dashboard@375 = 0px，PASS** |
| CI 模拟（无行情库）| unit 461+ passed / 26 skipped、integration 52/7、smoke-m1 10/10 |
| CI shuffle guard（seed 1/2）| 两次结果完全一致 |
