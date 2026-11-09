# K 线形态识别 —— 技术方案（双顶 / 双底 / 头肩）

**状态**：方案已定（2026-11-08），本轮落地
**定位**：**L3 契约的临时增量**。本文件是「K 线形态标注」的唯一权威口径。
**SDD 登记时点由用户统一安排**（2026-11-08 更新：PR #126/#127/#128 已合入 main `1bdd45a`，
但组合策略线也要改同一份 SDD，两边同时改会互相踩）⇒ **本轮及后续一段时间内不改 `SDD.md`**，
登记内容清单见 §13「待登记」。
**上游**：`InvestAssistantV3_NewRequirements.md` §4.1（形态类）；`PRD_v3.md`（K 线页交互，前端接入待定）。
**下游代码**：`apps/backend/src/services/patterns/`；扫描 CLI `apps/backend/src/cli/patternScan.ts`。

> 本文只定义「怎么识别、输出什么」。**不定义业务规则**（业务层仍是 Requirements 权威），
> **不定义界面**（界面在 PRD / ui-spec），也不复述这些层已有的内容。

---

## 1. 范围

### 1.1 本轮做

| 项 | 内容 | 交付物 |
|---|---|---|
| 摆动点识别 | TradingView ZigZag 口径（`depth` + `deviation`） | `services/patterns/zigzag.ts` |
| 双顶 / 双底 | 基于 ZigZag 枢轴序列 + ATR14 的动态阈值 | `services/patterns/reversal.ts` |
| 敏感性扫描 | `deviation` = 1.5 / 2 / 2.5 / 3 / 5%（真实行情，只读） | `cli/patternScan.ts` + 本文 §12 |
| 单测 | 构造序列命中、边界不误判、deviation 单调性 | `tests/unit/pattern-recognition.test.ts` |
| 头肩顶 / 头肩底 | ZigZag 连续五点 + **两点连线带斜率**颈线（口径见 §8） | `services/patterns/headShoulder.ts` + `tests/unit/head-shoulder.test.ts` |
| HTTP 接口 | `GET /api/quote/:symbol/patterns?days=`（只读，JWT） | `routes/pattern.ts` |
| 前端标注 | `APP_PATTERN` 自定义指标自绘（点标记 + 颈线 + 文字标签） | `src/indicators/klinePatterns.ts`、`chartIndicators.ts`、`components/KlineChart.tsx` |

### 1.2 本轮后续（已落地：第二阶段）

- **头肩顶 / 头肩底**：口径见 §8，**颈线用两点连线带斜率**；已实现（10 例单测）。
- **前端图上标注**：双顶/双底画到 K 线图（§7 末段）；头肩暂未上屏（后端已出结果，前端
  `mapPatternsToBars` 目前只认 `double_top` / `double_bottom`，其余 kind 静默丢弃）。

### 1.3 本轮明确不做

| 不做项 | 原因 |
|---|---|
| 三角旗形（三角收敛 / 旗形） | 边界主观，日线噪音下易过拟合（且本轮已决定不做人工标注集） |
| 圆弧底 / 圆弧顶 | 需拟合圆/曲线，日线噪音下稳定性未验证 |
| 楔形、矩形、杯柄、岛形反转 | 同上，本轮不扩形态库 |
| 分钟级形态 | 项目 Out-of-Scope（AGENTS.md） |
| 形态→信号 | 见 §10 硬约束 |

---

## 2. 数据口径

### 2.1 复权：一律前复权（qfq）

| 口径 | 是否使用 | 理由 |
|---|---|---|
| **`qfq` 前复权** | ✅ **唯一口径** | 除权缺口会在 bfq 序列里制造**假跳空**，破坏「顶—谷—顶」的几何关系；qfq 把历史价格按最新因子缩放，几何形状连续 |
| `bfq` 不复权 | ❌ | 手动画线工具用的是 bfq（人工看图不受算法阈值影响），**算法不能用** |
| `hfq` 后复权 | ❌ | 与 qfq 的形态几何等价，但数值量级与界面显示不一致，标注坐标会错位 |

> ⚠️ **与手动画线工具口径不同的原因**：人工画线靠肉眼忽略除权缺口，算法靠百分比阈值，
> 缺口会被当成真实波动（例如 10 送 3 会把价格砍 23%，直接伪造一个「跌破颈线」）。
> **后来人不要因为『手动画线是 bfq』就改这里** —— 两者服务对象不同。
>
> 取数实现：ETF 走 `v_etf_qfq` / 股票走 `v_stock_qfq`（视图取整位数不同：股票 2 位、ETF 3 位，
> 见 `marketData.ts` 的 `QFQ_ROUND_DIGITS`）。**只读**，禁止写入行情库（AGENTS.md）。

### 2.2 输入

`DailyKline[]`（`{date, open, high, low, close, volume, amount}`），**按日期升序**，
同一标的连续、无重复日期。算法只用 `high/low/close`；`volume` 本轮不参与判据。

### 2.3 只读与访问边界

- 行情库：`access_mode: READ_ONLY`，经 `queryDuckDB(Columnar)`；
- 业务库：**本轮零写入**（不建表、不写信号、不写审计日志）；
- 扫描 CLI 默认只打印结果，不落盘（`--json` 才输出到 stdout）。

---

## 3. 参数默认值与取值范围

| 参数 | 默认 | 取值范围 | 作用 | 归属 |
|---|---|---|---|---|
| `depth` | **10** | 6–20（偶数） | ZigZag 枢轴窗口；内部 `halfDepth = floor(depth/2)` = 5 根/侧 | §4 |
| `deviationPct` | **2.5%** | 1.5–5% | ZigZag 最小反向幅度；小于此值的摆动被合并 | §4 |
| `atrPeriod` | **14** | 5–30 | ATR 周期（Wilder） | §5 |
| `topTolerancePct` | **2%** | 1–3% | 双顶两顶价差上限 | §6 |
| `minSeparationBars` | **10** | 5–30 | 两顶最小间隔（bar） | §6 |
| `maxSeparationBars` | **60** | 30–120 | 两顶最大间隔（bar）；**上限必须有** | §6 |
| `valleyMinRetracePct` | **2%** | 1–5% | 中间谷最小回撤（与 1×ATR14 取较大者） | §6 |
| `valleyPositionMin/Max` | **0.2 / 0.8** | 0.1–0.9 | 谷在两顶之间的相对位置分位 | §6 |
| `confirmWindowBars` | **20** | 10–40 | 第二顶之后等待颈线确认的最大 bar 数 | §6 |
| `breakoutMinPct` | **0.5%** | 0.3–2% | 跌破/升破颈线的最小百分比幅度 | §6 |
| `breakoutAtrMult` | **0.5** | 0.3–1.5 | 跌破/升破颈线的最小 ATR 幅度 | §6 |
| `shoulderTolerancePct` | **5%** | 3–8% | 头肩两肩高度差上限（仅在 `HeadShoulderOptions` 中） | §8 |

> 所有参数集中在 `PatternOptions`，**只暴露这一层**；插件引擎、信号服务**不得引用**本模块。

---

## 4. ZigZag 摆动点口径

采用 TradingView 官方 ZigZag 库的两段式口径：**先找枢轴（pivot），再按 `deviation` 过滤**。

### 4.1 枢轴定义

`half = floor(depth/2)`（默认 `depth=10` → `half=5`）。对第 `i` 根 bar：

```
PivotHigh(i) ⟺ high[i] ≥ high[i-k] (k=1..half) 且 high[i] > high[i+k] (k=1..half)
PivotLow(i)  ⟺ low[i]  ≤ low[i-k]  (k=1..half) 且 low[i]  < low[i+k]  (k=1..half)
```

- 只需 `half ≤ i ≤ n-1-half` 的 bar 可成为枢轴 → **最右侧 `half` 根永远不可能成为枢轴**（滞后来源，见 §11）。
- 等值处理：左侧允许相等、右侧要求严格更大 → 平顶/平底取**最后一个**等值极值点（确定性，可复现）。
- 同一根 bar 同时满足 High 与 Low（外包日）：取**离窗口中枢更远**的一侧；距离相等时取 High。
  该规则只影响外包日的标注点位置，不改变「顶/底」交替性质。

### 4.2 deviation 过滤（增量式）

把枢轴按 `index` 升序送入状态机：

```
last = 已接受的最后一个枢轴
for p in pivots:
  if last 不存在:            接受 p
  else if p.type == last.type:
      p 更极端（High 更高 / Low 更低）→ 替换 last；否则丢弃 p
  else:
      |p.price - last.price| / last.price ≥ deviationPct/100 → 接受 p
      否则丢弃 p（不作为枢轴输出）
```

- 这是**流式增量过滤**（不是「先全量再回删」的变体）；两者在无未来数据的前提下等价，
  且流式版本便于逐 bar 复现，**文档以此为准**。
- `deviationPct` 越大 → 被合并的小摆动越多 → ZigZag 枢轴数**单调不增**（§12 实测验证）。
- 输出：`ZigZagPoint { index, date, price, type: 'high' | 'low' }`，顶底交替（除首点外）。

### 4.3 为什么 `deviation` 从 5% 改 2.5%

TradingView 原默认 5% 面向加密/外汇的高波动量级；A 股 ETF 日线 3 年区间内单次正常回撤常在
1.5–4%，用 5% 会把绝大多数「顶—谷—顶」合并成一个摆动，**几乎凑不出形态**。选择依据是 §12 的实测扫描。

---

## 5. ATR14 口径（Wilder）

```
TR[0] = high[0] - low[0]
TR[i] = max(high[i]-low[i], |high[i]-close[i-1]|, |low[i]-close[i-1]|)
ATR[period-1] = mean(TR[0..period-1])
ATR[i] = (ATR[i-1] × (period-1) + TR[i]) / period      (i > period-1)
ATR[i] = NaN                                            (i < period-1)
```

- 用途：把「谷深 / 跌破幅度」的**绝对价格阈值**按标的波动率自适应；同一标的同一窗口内自洽。
- ATR 是**绝对价**；百分比用 `ATR[i] / 参考价` 换算，参考价在 §6 逐条注明。
- 预热不足（`i < period-1`）的 ATR 为 `NaN` → 相关判据**直接不成立**（不猜测、不补零）。

---

## 6. 双顶 / 双底判据

### 6.1 结构

在 ZigZag 序列中取连续三点：

| 形态 | 三点 | 颈线 |
|---|---|---|
| 双顶 | `High(1) → Low(谷) → High(2)` | 水平线 `N = 谷价` |
| 双底 | `Low(1) → High(峰) → Low(2)` | 水平线 `N = 峰价` |

**双顶**：`P1 = 顶1价, P2 = 顶2价, V = 谷价`；**双底**：`P1 = 底1价, P2 = 底2价, V = 峰价`。

### 6.2 判据表（双顶；双底按 §6.4 对称）

| # | 判据 | 公式 | 不成立时 |
|---|---|---|---|
| 1 | 两顶价差 | `|P2-P1| / min(P1,P2) ≤ topTolerancePct` | 丢弃 |
| 2 | 间隔 | `minSeparationBars ≤ i2 - i1 ≤ maxSeparationBars` | 丢弃（**上限必须存在**，否则隔半年的两个高点会被配成双顶） |
| 3 | 谷深 | `(min(P1,P2) - V) / min(P1,P2) ≥ max(valleyMinRetracePct, ATR14[v]/min(P1,P2))` | 丢弃 |
| 4 | 谷位 | `0.2 ≤ (v - i1) / (i2 - i1) ≤ 0.8` | 丢弃（谷太靠边 = 不是对称双顶） |
| 5 | 颈线 | 水平 `N = V` | — |
| 6 | 跌破确认 | 首个 `k ∈ (i2, i2 + confirmWindowBars]`，且 `close[k] ≤ N - penetration` | 窗口内无确认 → **不算形态**（不输出「待确认」态） |
| 7 | 跌破幅度 | `penetration = min(breakoutMinPct × N, breakoutAtrMult × ATR14[k])` | — |

**判据 7 的口径说明（必须保留）**：
用户口径原文是「幅度 ≥0.5% **或** 0.5×ATR14」，本实现按「**满足其一即确认**」处理，
故阈值取两者**较小值**。若后续人工标注集显示假阳性过多，可把 `penetrationMode` 改为 `'max'`（更严），
**必须同步改本节并登记台账**；不得只改代码不改文档。

### 6.3 确认的语义

- 「形态成立」= **已收盘确认**，确认 bar = `k`；不是「第二个顶出现即成立」。
- 确认窗口按**第二顶的 bar 索引**起算，含 `i2 + 20`；超过窗口一律不算（避免把 3 个月后的破位算回旧形态）。
- 同一组三点只输出**一条**标注；不因多个 breakout bar 重复输出。
- 相邻形态允许共用枢轴（例如双顶之后的双底），本轮**不做去重/合并**。

### 6.4 双底（对称）

`P1/P2` 为两底，`V` 为中间峰，颈线 `N = V`；判据 1/2/4 同式；
判据 3 改为 `(V - max(P1,P2)) / max(P1,P2) ≥ max(valleyMinRetracePct, ATR14[v]/max(P1,P2))`；
跌破改为**升破**：`close[k] ≥ N + penetration`，`penetration = min(breakoutMinPct × N, breakoutAtrMult × ATR14[k])`。

---

## 7. 输出契约（仅标注）

```ts
interface PatternAnnotation {
  kind: 'double_top' | 'double_bottom';   // 双顶/双底口径；头肩见 §8（同样结构，kind 取 head_shoulders_*）
  startIndex: number;                     // 第一个顶/底的 bar 下标
  endIndex: number;                       // 确认 bar 下标
  confirmIndex: number;                   // = endIndex（显式冗余，便于前端高亮）
  points: Array<{ role: 'first' | 'middle' | 'second'; index: number; date: string; price: number }>;
  neckline: {
    from: { index: number; price: number };
    to:   { index: number; price: number };
    slope: number;                        // 本轮双顶/双底恒为 0（水平）
  };
  breakout: { index: number; date: string; close: number; penetrationPct: number };
  metrics: {
    peakDiffPct: number;                  // 两顶/两底价差
    middleDepthPct: number;               // 谷深/峰高
    middlePositionPct: number;            // 0–100 的谷位分位
    atrPct: number;                       // 确认 bar 的 ATR14 / 颈线
    separationBars: number;
  };
}
```

- 索引是**输入 `bars` 的下标**，不是日期；前端按索引对齐 K 线，避免日期缺失（停牌）造成错位。
- 标注坐标一律用 qfq 价格；**不得**再用 bfq 重算一遍去「对齐手动画线」。

### 7.1 HTTP 实现（已落地）

`GET /api/quote/:symbol/patterns?days=120`（`routes/pattern.ts`）

| 项 | 实现 |
|---|---|
| 鉴权 | 全局 JWT（无 token → 401）；`symbol` 需匹配 `^(sh|sz|bj)\d{6}$` |
| 窗口 | `days` 取最近 N 根**日线**，clamp 10–500，默认 120 |
| 复权 | 按 `raw_symbol_class` 选 `v_stock_qfq` / `v_etf_qfq`，**只读** |
| 响应 | `{ symbol, fq: 'qfq', patterns: PatternApiDto[] }` |
| DTO 坐标 | **用日期**（`points[].date`、`neckline.fromDate/toDate`、`breakout.date`），不用 bar 下标 —— 前端要按当前周期重新映射 |
| 检测范围 | 双顶/双底 + 头肩，按 `startIndex` 升序合并输出 |

- **不挂在 `kline` 响应上** —— kline DTO 正被画线/组合策略线改动，附加字段会扩大冲突面。
- 前端映射（`src/indicators/klinePatterns.ts`）：日期 → 当前周期桶（`bucketIndexOfDate` 二分），
  价格取**该桶聚合后的 high/low**；形态整体挂到 `confirmIndex` 那根 bar，由 `APP_PATTERN.draw` 统一收集绘制。
- 任一关键日期落在当前窗口之外 → 丢弃该条（不画残缺形态）；无形态则不画任何内容。

---

## 8. 头肩（已实现，口径已定）

| 项 | 口径 |
|---|---|
| 结构 | 头肩顶：`High(左肩) → Low(颈1) → High(头) → Low(颈2) → High(右肩)`；头肩底对称 |
| 头必须最高/最低 | `head.price > max(shoulderL, shoulderR)`（头肩底反之）；**严格**大于/小于，平头不算 |
| 两肩高度 | `|S_L - S_R| / min(S_L,S_R) ≤ shoulderTolerancePct`（默认 **5%**） |
| 两颈点距离 | `i2 - i1 ≥ minSeparationBars`（与双顶共用默认 10），避免两颈点挤在一根上导致斜率失真 |
| 右肩未破颈线 | 头肩顶要求右肩价 `≥ N(i_right)`；已破颈线视为形态已失败，不标注 |
| **颈线** | **两点连线带斜率**：`N(k) = N1.price + slope × (k - i1)`，`slope = (N2.price - N1.price) / (i2 - i1)` |
| 确认 | 首个 `k ∈ (i2, i2 + confirmWindowBars]`，`close[k] ≤ N(k) - penetration`（头肩底 `≥ N(k) + penetration`） |
| 突破阈值 | 与双顶/双底同一口径：`penetration = min(breakoutMinPct × N(k), breakoutAtrMult × ATR14[k])` |
| 输出 `kind` | `head_shoulders_top` / `head_shoulders_bottom`；`points[].role` = `left_shoulder / neck1 / head / neck2 / right_shoulder` |
| 退回条件 | 若实测显示斜率版在噪音下**明显更差**（确认数骤降或假阳性升高），可改回「两颈点水平均值」；**必须把对比数据写进本节并说明依据** |

### 8.1 实现与验证（2026-11-08）

- 代码：`services/patterns/headShoulder.ts`（`detectHeadShoulders`、`DEFAULT_HEAD_SHOULDER_OPTIONS`），
  与双顶/双底**共用同一套 ZigZag 枢轴（§4）与 ATR14（§5）**；`index.ts` 统一导出。
- 与双顶/双底一起进入 `GET /api/quote/:symbol/patterns?days=`，按 `startIndex` 排序合并输出。
- 单测 `tests/unit/head-shoulder.test.ts` **10/10 通过**：标准头肩顶、标准头肩底、头不够高、
  两肩差 > 5%、右肩已破颈线、未突破、超确认窗口、输入不足等（清单见 §12.2）。
- **未做斜率 vs 水平均值的横向实测对比**：用户已决定不做人工标注集，改为「画到图上、看图判读」，
  因此本节保留斜率版为默认，退回条件仅在后续看图反馈明显偏差时才触发（触发时必须补数据）。
- 前端本轮**不上屏头肩**（`mapPatternsToBars` 只认双顶/双底）；后端结果已可供后续接入。

---

## 9. 硬约束：形态**只做图上标注**，不进信号通道（不可协商）

| 约束 | 落地方式 |
|---|---|
| **不写信号表** | 不触碰 `user_strategy_signal`（及任何信号/回放表） |
| **不输出 `direction`** | `PatternAnnotation` 无方向字段；不产生 buy/sell 语义 |
| **不参与 F1 分级** | 形态结果不进入 `signalService` 的任何评分输入 |
| **不进 Top5** | 不进入候选/信号排序 |
| **不进 paper 账户** | 不下单、不建仓、不改账户 |
| **不触发 cron / 校验** | 不在 17:01–17:05 任务链中调用 |
| **不被插件引擎引用** | `pluginEngine.ts` 不 import 本模块；形态类插件（吞没/星线/刺透）维持原状 |
| **不改 `klineTrades` / 信号接口** | 本轮不改 `routes/signal.ts`、`signalService.ts`、`pluginEngine.ts`（PR #127/#128 正在合） |

> ⚠️ **与 V3 Requirements §4.1 的差异登记**：Requirements 把「双底」列为**形态类信号**的典型。
> 本轮形态识别**故意不产生信号** —— 先验证几何识别质量，再决定是否接入信号体系。
> 该差异**不修改 V3 文档**，记在 §13「待登记 / 待裁决」。

---

## 10. 滞后说明（如实写明，不包装成「实时识别」）

| 环节 | 滞后 |
|---|---|
| 枢轴确认 | 需要右侧 `halfDepth = 5` 根已收盘 bar → 第二个顶的「点」本身滞后 **5 根** |
| 形态确认 | 第二顶之后还需**收盘跌破颈线** → 常见再等 **1–3 根**，最迟 `confirmWindowBars = 20` 根 |
| **合计** | **典型 6–8 根**；最坏 `5 + 20 = 25` 根 |

- 含义：图上标注是**事后几何确认**，不是「顶一出现就提示」。
- 任何界面文案**不得**写「实时识别 / 即时形态」；如需提示，必须写明「基于已收盘 bar 的确认」。
- 算法**不做未来数据回填**（不使用 `i+half` 之后的 bar 去修改 `i` 之前的形态）；逐 bar 复现时，
  在第 `t` 根只能看到 `t - half` 及更早的枢轴。

---

## 11. 敏感性扫描口径与结果

### 11.1 扫描口径（固定，便于复现）

| 项 | 取值 |
|---|---|
| 行情源 | 本地真库（`DUCKDB_PATH`，只读）；`class='etf'` 的 `v_etf_qfq` |
| 区间 | `from = 2023-01-01`，`to = 行情库最新交易日` |
| 标的过滤 | 窗口内日线 ≥ 120 根（保证 ATR / 枢轴预热） |
| 参数 | 除 `deviationPct` 外全部取 §3 默认值 |
| 计数 | 双顶 / 双底 / 合计 / 有形态标的数 / ZigZag 枢轴总数 |
| deviation | 1.5 / 2 / 2.5 / 3 / 5（%）各自独立跑 |

> 说明：扫描是**开发期实测**，不进入 CI（依赖 1.24 GB 真库，CI 无行情数据）。
> 复现命令：`npx tsx --env-file=../../.env.local src/cli/patternScan.ts --class etf --from 2023-01-01`（在 `apps/backend` 下）。

### 11.2 实测结果（2026-11-08，本地真库 `data/quotes.duckdb`，只读）

命令：
`npx tsx --env-file=../../.env.local src/cli/patternScan.ts --class etf --from 2023-01-01`

环境：`class='etf'`，区间 `2023-01-01 ~ 2026-11-06`（库内最新交易日），窗口内 ≥120 根的标的 **1988 只**，
其余参数取 §3 默认值，扫描耗时 **894 ms**（不含行情取数）。

| `deviation` | 双顶 | 双底 | 合计 | 有形态标的数 | ZigZag 枢轴数 |
|---|---|---|---|---|---|
| **1.5%** | 6858 | 5000 | **11858** | 1849 | 125732 |
| **2.0%** | 6847 | 4955 | **11802** | 1847 | 122665 |
| **2.5%**（选定） | 6453 | 4417 | **10870** | 1831 | 117798 |
| **3.0%** | 5868 | 3852 | **9720** | 1821 | 111180 |
| **5.0%** | 3073 | 1772 | **4845** | 1613 | 79028 |

**选 2.5% 的依据（用上表数据，不用主观描述）**：

1. **5% 不可用**：合计从 2.5% 的 10870 掉到 4845（**-55.4%**），ZigZag 枢轴从 117798 掉到 79028（-32.9%）
   —— 大量有效摆动被合并，「几乎凑不出形态」与预期一致。
2. **1.5% 的增量主要是噪音**：相对 2.5%，合计只多 **9.1%**（+988 条），但枢轴多 **6.7%**（+7934 个）；
   阈值越低，越小的摆动也会成为枢轴和形态候选，判据更容易被日常噪音触发，故不取 1.5%。
3. **2% 与 3% 夹住 2.5% 且变化平缓**：2%→2.5% 合计 -7.9%，2.5%→3% -10.6%，说明 2.5% 处在「形态数随阈值
   平缓下降」的区间，不是断崖点；选它既保留足够样本（10870 条），又比 1.5% 少收噪音。
4. **双顶/双底比例稳定**：1.5/2/2.5 三档双顶占比分别为 57.8% / 58.0% / 59.4%，说明口径没有偏袒某一形态。

> ⚠️ 计数口径：同一 ZigZag 序列允许相邻形态共用枢轴（§6.3），本轮**不做去重**；
> 因此「条数」是候选标注数，不是独立形态数。各阈值下口径一致，横向可比。
> ⚠️ 该扫描是开发期实测，**不进 CI**（依赖 1.24 GB 真库）；CI 无行情数据时跳过。

---

## 12. 单测清单

### 12.1 双顶 / 双底（`tests/unit/pattern-recognition.test.ts`，15 例）

| 用例 | 断言 |
|---|---|
| 构造双顶序列 | 命中 1 条 `double_top`，points/neckline/confirmIndex 正确 |
| 构造双底序列 | 命中 1 条 `double_bottom` |
| 两顶价差 ≈2%（1.9998%，闭区间上沿） | 命中 |
| 两顶价差 2.1% | 不命中 |
| 两顶间隔恰好 10 / 60 | 命中；9 / 61 不命中 |
| 谷深 2.02% / 1.92% | 前者命中、后者不命中 |
| 谷位 0.2 / 0.8 / 0.167 / 0.867 | 0.2 与 0.8 命中；两端越界不命中 |
| 未跌破颈线 / 跌破但幅度不足 | 不命中 |
| 收盘价**恰好接触**颈线（跌破幅度 0） | 不命中（必须真正跌破） |
| 确认发生在第 21 根 | 不命中（超窗口） |
| `deviation` 1.5→5% | 形态数量单调不增（构造序列） |
| 输入不足（< 2×half+1 根） | 返回空数组，不抛错 |

### 12.2 头肩（`tests/unit/head-shoulder.test.ts`，10 例，全通过）

| 用例 | 断言 |
|---|---|
| 标准头肩顶序列 | ZigZag 出 5 个枢轴且高低交替 |
| 标准头肩顶命中 | 五点 role 正确、颈线斜率向下、收盘跌破确认 |
| 头与左肩同高 | 不命中（头必须严格最高） |
| 两肩高度差 > 5% | 不命中 |
| 右肩已跌到颈线下方 | 结构不成立，不命中 |
| 收盘始终在颈线上方 | 未突破，不命中 |
| 跌破发生在确认窗口之后 | 不命中（超 `confirmWindowBars`） |
| 标准头肩底命中 | 镜像结构、颈线斜率向上、收盘升破确认 |
| 头肩底收盘始终在颈线下方 | 未升破，不命中 |
| 输入不足（< 2×half+1 根） | 返回空数组，不抛错 |

### 12.3 前端标注（`apps/frontend/tests/unit/`）

- 既有 K 线图用例已适配新增 `patterns` 字段（`kline-chart-a11y` / `kline-overlay-toolbar`），
  保证 `buildChartBars` 契约变更后仍全量通过。
- 前端映射纯函数（`mapPatternsToBars` / `toPatternGeometry`）**暂无独立单测**；当前以真实浏览器目视验收：
  `sz000001` 图上出现虚线颈线、三处圆点与「双顶」文字标签，切换标的/周期后重算重绘。

---

## 13. 待定 / 待登记（不阻塞本轮）

| 项 | 状态 | 说明 |
|---|---|---|
| **人工标注集** | **已裁决：不做**（2026-11-08 用户决定） | 改为把形态画到 K 线图上由使用者目视判读；阈值仍取本文件默认值，**不作「已校准」表述** |
| **SDD 登记** | **待登记（时点由用户统一安排）** | PR #126/#127/#128 虽已合入 main，但组合策略线同期要改 SDD，**禁止两边并行改同一份 SDD**；登记内容清单见 §13.1 |
| **前端标注接入** | **已落地** | 基于 `feat/kline-overlay-tools` head `d221dec`（PR #133）；`APP_PATTERN` 自定义指标自绘，见 §7.1 |
| **HTTP 接口** | **已实现** | `GET /api/quote/:symbol/patterns?days=`，见 §7.1 |
| **头肩实现** | **已实现** | 斜率颈线 + 与双顶/双底共用枢轴/ATR，10 例单测通过，见 §8.1 |
| **头肩上屏** | 待后续 | 后端已出结果；前端 `mapPatternsToBars` 目前只认双顶/双底 |
| **V3 口径差异** | 待裁决 | Requirements §4.1 把双底列为信号；本轮只标注（见 §9） |

### 13.1 SDD 待登记内容清单（登记时照抄，不要重写口径）

> 登记位置建议：`SDD_v3.md` §0.1（V3 修改/新增清单）+ §9（API 契约）+ §12（测试映射）。
> **本清单只列「要登记什么」，具体措辞以本文对应章节为准（引用不复述）。**

| # | 要登记的内容 | 权威出处 |
|---|---|---|
| 1 | 模块与导出契约：`services/patterns/{zigzag,atr,reversal,headShoulder,index}.ts`，`buildZigZag` / `detectDoubleTopBottom` / `detectHeadShoulders` / `PatternAnnotation` 形状 | 本文 §4、§7、§8 |
| 2 | 参数默认值与范围（`depth=10`、`deviationPct=2.5%` 等 13 项，含 `shoulderTolerancePct`） | 本文 §3 |
| 3 | 数据口径：只用 qfq；行情库只读；业务库零写入 | 本文 §2 |
| 4 | 硬约束：不写信号表 / 无 direction / 不进 F1 / 不进 Top5 / 不进 paper / 不被插件引擎引用 | 本文 §9 |
| 5 | 滞后声明（典型 6–8 根、最坏 25 根；不得表述为实时） | 本文 §10 |
| 6 | API（**已实现**）：`GET /api/quote/:symbol/patterns?days=`（JWT；`days` clamp 10–500、默认 120；响应 `{symbol, fq:'qfq', patterns: PatternApiDto[]}`，坐标用日期不用下标；不并入 `kline` 响应） | 本文 §7.1 |
| 7 | DDL：**无新增表、无迁移**（纯计算 + 只读行情） | 本文 §2.3 |
| 8 | 测试映射：`tests/unit/pattern-recognition.test.ts`（15 例）+ `tests/unit/head-shoulder.test.ts`（10 例）；扫描 CLI 为开发期实测、**不进 CI**；前端映射暂无独立单测 | 本文 §12、§11.1 |
| 9 | 性能门槛（登记前需实测）：单标的 ≤1400 根 bar 的「ZigZag + 双顶双底 + 头肩」识别耗时上限（建议 ≤50ms） | 待实测 |
| 10 | 未实现项：头肩上屏（前端指标只认双顶/双底）、三角旗形 / 圆弧底（本轮不做） | 本文 §1.2、§1.3 |
