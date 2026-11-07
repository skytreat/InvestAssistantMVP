# 内置策略库盘点与「每类一个代表」规划

> 性质：盘点 + 规划（只读产物）。**未改代码、未改 `data/` 下任何文件、未推送。**
> 盘点日期：2026-11-07
> 口径来源：`InvestAssistantV3_NewRequirements.md` §4.1（六分类，权威）、`PRD_v3.md:356`（分类 ✅）、`SDD.md` §5.3/§5.6、`Requirements_simplified.md` §5.5
> 代码来源：`apps/backend/src/services/pluginEngine.ts`（线上信号插件）、`apps/backend/src/services/backtest/`（回测策略）

---

## 0. 结论摘要

1. 系统里「策略」实际是**两个不同层的对象**，盘点必须分开：
   - **线上信号插件（`Plugin`）**：4 个内置，全部可跑、可配参、有单测；`monitor` 类 2 个可落信号，`filter` 类 2 个**不落信号**。
   - **回测策略（`Strategy`）**：2 个，`ref-buy-and-hold`（基准）与 `wufu-rotation`（五福轮动 v5.2）；**仅 CLI 可用，无 API/无 UI**。
2. 按 V3 §4.1 六分类：**只有 2 类「已就绪」**（动量、趋势），**1 类「需完善」**（量价），**3 类完全空缺**（波动率、形态、风险）。
3. 结论一句话：**接口能跑，但「每类一个够格的代表」目前只兑现了 2/6**；缺的不是代码框架，而是 3 个类别的策略本体 + 1 个落库/回测能力的补齐。

---

## 1. 盘点方法与登记处

| 对象 | 注册/加载入口 | 当前数量 |
|---|---|---|
| 线上插件（内置） | `pluginEngine.ts:241-244` 注释 + 各 `id:` 定义；`getAllPlugins()` 合并内置与磁盘 | **4** |
| 线上插件（磁盘自定义） | `pluginEngine.ts:28` `PLUGIN_ALLOWED_PATH`（默认 `/opt/invol/IA_Prod/plugins/strategies`）→ `loadPluginsFromDir():644` | **0**（本机实测日志 `ENOENT: scandir 'D:\opt\invol\IA_Prod\plugins\strategies'`） |
| 回测策略 | `backtest/strategies/` + CLI `backtest/cli.ts` 选择 `--strategy` | **2** |

> 判定：**磁盘插件目录在开发机不可读，当前「系统内置策略库」= 4 个插件 + 2 个回测策略，无第三方插件。**

---

## 2. 现有清单（逐个登记）

### 2.1 线上信号插件（`Plugin`）

| # | `plugin_id` | 名称 | category | subCategory | 复杂度 | 参数（默认/范围） | 落信号 | 可回测 | 参数可配 | 测试 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `rsi_oversold` | RSI(14) 超买超卖 | `monitor` | `momentum` 动量 | simple | `period`=14(5-30)、`oversold`=30(1-50)、`overbought`=70(50-100)、`days`=120(30-365)、`symbol`(必填/运行时注入) | ✅ `user_strategy_signal`（origin=`live`/`replay`） | ❌ | ✅ `user_plugin_config` 已生效 | ✅ coverage + 集成 + 真实行情 5000 扫描 |
| 2 | `macd_cross` | MACD 金叉死叉 | `monitor` | `trend` 趋势 | simple | `fast`=12(2-30)、`slow`=26(10-60)、`signal`=9(2-20)、`days`=120（min 40）、`symbol` | ✅ 同上 | ❌ | ✅ | ✅ coverage + 集成 |
| 3 | `ma_bullish_alignment` | 均线多头排列 | `filter` | `trend` 趋势 | simple | `periodShort`=5、`periodMid`=10、`periodLong`=20（跨字段校验严格递增）、`days`=120、`limit`=50、`symbol`/`symbols` | ❌ 仅 `/api/stockscan` 返回候选，**不落库** | ❌ | ✅ | ✅ coverage |
| 4 | `volume_breakout` | 放量突破 | `filter` | `breakout` 突破 | simple | `lookback`=20(5-120)、`volumeRatio`=1.5(1-10)、`days`=120、`limit`=50、`symbol`/`symbols` | ❌ 仅选股返回，**不落库** | ❌ | ✅ | ✅ coverage |

代码位置（便于复核）：`pluginEngine.ts:285-320`（rsi）、`:382-420`（macd）、`:464-500`（ma）、`:561-600`（volume）。

实现完整度统一说明：
- **计算**：4 个都真实计算（不是占位空实现），`execute()` 内均为纯计算 + 已批量预取的 K 线。
- **落信号**：只有 `category='monitor'` 会进入 `executeAllPlugins`（`pluginEngine.ts:1458` 的 `.filter(p => p.category === 'monitor')`），再由 `admin.ts:85-90` 逐插件 `persistSignals` 落库；`filter` 类只在 `/api/stockscan` 内返回 JSON，**没有任何持久化**。
- **可配参**：`loadUserPluginConfigs()`（`pluginEngine.ts:1391-1425`）+ `:1454-1459`，`enabled=0` 会停用、`params_json` 会合并；**F 域修复后已真实生效**（此前是死开关）。
- **可解释**：4 个都填了 `label` 与 `detail`（`pluginEngine.ts:357/369` 等），信号列表可读。

### 2.2 回测策略（`Strategy`）

| # | `strategy.id` | 名称 | 业务类别（推定） | 关键参数 | 可回测 | 产出信号 | 对外入口 | 测试 |
|---|---|---|---|---|---|---|---|---|
| 5 | `ref-buy-and-hold` | 参考策略：买入持有 | 基准（**不属六类**） | `symbol`=sh510300、`weight`=1、`rebalance`=false | ✅ | ❌（基准对照，只产净值） | CLI `--strategy` | ✅ m2-engine / m2-metrics |
| 6 | `wufu-rotation` | 五福轮动 ETF v5.2（日线主干） | **动量/轮动**（代码无 `subCategory` 字段） | `divisor`、`topN`、`holdingsNum`、`lookbackDays`、`minScore` 等 | ✅（golden oracle） | ❌（回测内 trades/metrics，不写业务库） | **仅 CLI**，无 `/api/backtest/*` 路由 | ✅ m3-wufu + m3-attribution + m3-dynamic-panel |

代码位置：`backtest/strategies/buyAndHold.ts:28-60`、`backtest/strategies/wufuRotation/index.ts:380-399`（`defineStrategy` 元数据）、`:69-110`（参数）。

> ⚠️ 两个回测策略**不使用** `PluginSubCategory`，与线上插件不在同一分类体系内 —— 这是第 6 节「待确认 ④」。

---

## 3. 分类口径

### 3.1 采用口径：V3 §4.1 六分类（权威）

`InvestAssistantV3_NewRequirements.md:645-652`：

| 类别 | 说明 | 文档典型 |
|---|---|---|
| 趋势类 | 方向与强度 | 均线排列、MACD、ADX、均线斜率 |
| 动量类 | 超买超卖 | RSI、KDJ、CCI、威廉指标 |
| 波动率类 | 通道与带宽 | 布林带、ATR 通道 |
| 量价类 | 成交确认 | 放量突破、缩量回调、量价背离 |
| 形态类 | K 线形态 | 锤子线、吞没、缺口、双底 |
| 风险类 | 仓位与止损 | ATR 止损、最大回撤、组合暴露 |

配套不变量：`INV-S3-15`（归属且仅归属一类）、`INV-S3-16`（声明适用周期）、`INV-S3-17`（声明适用品种）、`INV-S3-18/19`（可组合、条件独立开关）。

### 3.2 为什么不直接用代码里的 `PluginSubCategory`

代码枚举（`pluginEngine.ts:54-61`，与 `SDD.md:1721-1728` 一致）是 7 值：
`momentum / trend / volume / breakout / mean_reversion / pattern / custom`

与 V3 六类的差异：

| V3 六类 | 代码 `PluginSubCategory` | 差异 |
|---|---|---|
| 趋势类 | `trend` | ✅ 对应 |
| 动量类 | `momentum` | ✅ 对应 |
| 波动率类 | **无** | ❌ 缺失 |
| 量价类 | `volume` + `breakout` | 拆成两值，粒度更细 |
| 形态类 | `pattern` | ✅ 对应 |
| 风险类 | **无** | ❌ 缺失 |
| —（V3 无） | `mean_reversion`、`custom` | 代码多出两值 |

**规划口径决定**：本规划的「每类一个代表」一律按 **V3 六类** 组织；代码 7 值作为**实现细节**保留，但需在 UI/文档中建立映射（见待确认 ④）。理由：V3 是不变量层（WHAT），代码枚举只是工程标签；且 PRD 的策略卡已按 V3 六类展示（`PRD_v3.md:335、356`）。

---

## 4. 「每类一个代表」的选择标准与打分

### 4.1 选择标准（6 项，权重合计 1.0）

| 维度 | 权重 | 判定依据 |
|---|---|---|
| A 类别归属明确 | 0.15 | 能唯一归入六类之一（`INV-S3-15`） |
| B 链路闭环 | 0.25 | 计算 → 落库 → 前端可查（信号页/统计），不是「只算不存」 |
| C 可回测 | 0.20 | 能进回测引擎（需 `TargetSet` 适配或本身是 `Strategy`） |
| D 参数具名可调且生效 | 0.15 | `paramSchema` 带默认/范围，且 `user_plugin_config` 真实生效（`INV-S3-20/21`） |
| E 可解释 | 0.10 | 有 `label/detail` 与可复算指标值，用户能理解「为什么出信号」 |
| F 有自动化测试 | 0.15 | 有单测/集成/golden 覆盖 |

5 分制打分（0/2/4/5 四档），加权求总分。

### 4.2 打分结果

| 候选 | A | B | C | D | E | F | 加权总分 |
|---|---|---|---|---|---|---|---|
| `rsi_oversold` | 5 | 5 | 0 | 5 | 5 | 5 | **4.00** |
| `macd_cross` | 5 | 5 | 0 | 5 | 5 | 5 | **4.00** |
| `ma_bullish_alignment` | 5 | 2 | 0 | 5 | 4 | 5 | 3.15 |
| `volume_breakout` | 5 | 2 | 0 | 5 | 4 | 5 | 3.15 |
| `wufu-rotation` | 3 | 2 | 5 | 4 | 4 | 5 | 3.70 |

**及格线 = 3.50**（B/C 两个「闭环/可回测」维度合计 0.45，任一为 0 就极难及格）。

### 4.3 代表结论（逐类）

| V3 类别 | 代表 | 判定 | 理由（不止名字） |
|---|---|---|---|
| **动量类** | `rsi_oversold` | ✅ 已就绪 | 唯一归入动量类；链路闭环（落库 + 信号页可查 + `label` 带「RSI 超卖买入（39.30 < 30）」可解释）；参数 4 个全部带范围且受配置页控制；有真实行情 5000 标的扫描测试。**唯一短板是不可回测**（插件接口无 `TargetSet`） |
| **趋势类** | `macd_cross` | ✅ 已就绪 | 比 `ma_bullish_alignment` 更适合当代表：后者是 `filter` 类，**不落信号**（B=2），用户站在策略页看不到它的结论；`macd_cross` 落库且 K 线副图叠加已配 `chartOverlay`，解释成本最低 |
| **量价类** | `volume_breakout` | ⚠️ 需完善 | 实现是真的（突破 + 放量倍数 + `limit` 截断），但**只进选股列表不落库**（B=2），且是 `filter` 语义（「筛选」而非「择时信号」）。够格当候选，不够格当「代表」 |
| **波动率类** | **无** | ❌ 需新增 | 全仓无任何 BOLL/ATR 实现（`grep volatility` 无命中） |
| **形态类** | **无** | ❌ 需新增 | 全仓无任何 K 线形态判定；`PluginSubCategory.pattern` 只是枚举占位，**没有任何插件使用它** |
| **风险类** | **无** | ❌ 需新增 | `portfolioRisk.ts` 是「风险指标计算」（评估侧），不是「策略」；且**线上插件接口无持仓/成本视图**，ATR 止损这类天然无法用 `Plugin` 表达 —— 需走 `Strategy` 层或新增 risk 类型（见 §5.3） |

---

## 5. 分层规划

### 5.1 已就绪（链路完整、可直接对外称「代表」）

| 类别 | 代表 | 现状证据 | 后续只需 |
|---|---|---|---|
| 动量类 | `rsi_oversold` | 落库 + 信号页 + 参数生效 + 单测 | （可选）补回测适配 |
| 趋势类 | `macd_cross` | 同上 + K 线叠加 | （可选）补回测适配 |

### 5.2 需完善（有本体，缺关键能力）

| 项 | 缺什么 | 最小补齐动作 | 优先级 |
|---|---|---|---|
| 量价类代表 `volume_breakout` | ①不落信号 ②无回测 ③与 `ma_bullish_alignment` 一样是「选股」而非「择时」 | 二选一：(a) 新增同名 `monitor` 版本（对自选∪持仓逐标的判突破），与 filter 版本并存；(b) 给 filter 结果加「用户手动固化为信号」入口 | **P0** |
| `wufu-rotation` | 无 API/无 UI，只有 CLI；且不属插件分类体系 | 加 `/api/backtest/run` + 前端「策略回测」页；在 `Strategy` 上加 `category` 字段（填 `momentum`） | **P1** |
| `ma_bullish_alignment` | filter 型、不落信号 | 与量价项同一套方案，可暂不升级（趋势类代表已由 `macd_cross` 占位） | P2 |

### 5.3 需新增（该类无任何可用实现）

| 类别 | 建议代表策略 | 为什么选它当第一个 | 实现要点 | 优先级 |
|---|---|---|---|---|
| **波动率类** | 布林带（BOLL 20,2）超卖回踩/突破 | ①OHLC 数据已够，无新数据依赖；②与 RSI 同构（单序列阈值判定），可完全复用 `monitor` 骨架；③解释性强（带宽/通道位置可画在 K 线主图，`chartOverlay` 现成） | `paramSchema`: `period`=20、`k`=2、`days`=120；`subCategory` 需新增 `volatility` 枚举值 | **P0** |
| **形态类** | 锤子线 / 吞没形态（先做 1 个） | ①日线已闭合 bar，符合 `INV-S7-6`（形态必须在已闭合 bar 判定）；②`DailyKline` 已含 open/high/low/close；③单根 + 前一根即可判定，成本最低 | 需明确「形态优先级」与「同类重复出信号」的口径；`subCategory='pattern'` 已存在，可直接用 | **P1** |
| **风险类** | ATR 止损 / 最大回撤约束 | 文档明确要求（`INV-S3-17` 的典型），但**结构上不能做成 `Plugin`**：`PluginContext` 只有行情，无持仓/成本/可用资金 | **必须二选一**：(a) 做成 `Strategy`（回测层有 `positions()/cash()/equity()`）→ 只能回测不能实盘；(b) 给 `PluginContext` 加只读 `positions()`（改动面大，涉及沙盒与 50ms 边界） | **P2** |

> 🔴 **结构性提醒**：`Plugin` 与 `Strategy` 是两套接口（详见 `docs/audit/proposal-strategy-backtest-framework.md` §4 解耦三硬边界）。P0/P1 的 3 个新策略都应建在 `Plugin`（因为要落信号、上信号页），只有「风险类」因为需要持仓视图而必须建在 `Strategy`。

---

## 6. 待确认（文档与代码不一致，**不自行择一**）

| # | 不一致点 | 文档说法 | 代码现状 | 影响 |
|---|---|---|---|---|
| ① | 动量插件 `plugin_id` | `Requirements_simplified.md:220` 与 `SDD.md:1874` 均写 **`rsi`** | 代码是 **`rsi_oversold`**（`pluginEngine.ts:285`） | 影响 API/配置/日志对账；自定义插件若用 `rsi` 会与文档冲突（代码不认为冲突） |
| ② | `rsi` 分类数量 | `SDD.md:1874` 写 `monitor + filter`（双分类） | `Requirements_simplified.md:223-226` 明确**单值**（并专门记录「初稿双分类已被 2026-10-17 修正」）；代码为 `monitor` | SDD 该行是过期表述，需 owner 裁决以哪份为准 |
| ③ | 内置插件存放层 | `SDD.md:1845` 写「打包在 `@invest/core` 包内」 | 实际在 `apps/backend/src/services/pluginEngine.ts`；`packages/core/src/plugin.ts` **只有 `DailyKline` 类型** | 层界（core 零业务依赖）与文档冲突；影响将来 V2 云函数复用 |
| ④ | 分类枚举 | V3 §4.1 六类（趋势/动量/波动率/量价/形态/风险） | `PluginSubCategory` 七值（含 `breakout`/`mean_reversion`/`custom`，**无** `volatility`/`risk`） | 新增波动率类必须先扩枚举；且「每类一个代表」在 UI 上无法按 V3 六类分组 |
| ⑤ | 适用周期/品种 | `INV-S3-16/17` 要求声明周期与品种 | `Period` 恒为 `'daily'`；**无 `appliesTo` 字段**；`INV-S3-17` 的「跨境 ETF 需区别对待」在代码中无落点 | 跨境 ETF 与 A 股 ETF 共用同一套参数评估（Requirements 明确说「无意义」） |
| ⑥ | 策略可组合 | `INV-S3-18/19` 要求可组合、条件独立开关 | 全仓无组合逻辑（`grep combine/combo/conditions` 无命中）；一个策略 = 一个插件 | 用户只能「多个插件各看各的」，无法表达「均线多头 **且** 放量」 |
| ⑦ | 信号状态机 | `Requirements_simplified.md:232` 要求「仅在不满足→满足瞬间生成一次，持续满足不刷屏」 | **无状态机**（跨日无记忆）；`rsi_oversold` 在 RSI 连续多日 < 30 时**每天都会发 BUY** | 与「不刷屏」直接冲突；当前只靠 `UNIQUE(user_id, asset_code, plugin_id, trade_date)` 防「同一天重复」，不防「连续多天重复」 |
| ⑧ | 两个 filter 插件未登记 | `Requirements_simplified.md:216-221` 内置清单只有 2 个（rsi + macd_cross）；`SDD.md:1870-1875` 同样只有 2 个 | 代码实有 4 个（多出 `ma_bullish_alignment`、`volume_breakout`） | 文档清单过期；「MVP 内置策略数」对外口径（2 还是 4）需 owner 定 |

---

## 7. 优先级汇总（可执行清单）

| 优先级 | 事项 | 类型 | 依赖 |
|---|---|---|---|
| **P0-1** | 新增 **波动率类** 代表：布林带 `boll_reversion`（monitor，落库） | 需新增 | 需扩 `PluginSubCategory` 加 `volatility`（待确认 ④ 裁决后） |
| **P0-2** | 量价类 `volume_breakout` 补「可落信号」能力 | 需完善 | 复用 `persistSignals`，无需新表 |
| **P0-3** | 裁决待确认 ①②④（`rsi` vs `rsi_oversold`、分类枚举口径） | 决策 | owner |
| **P1-1** | 新增 **形态类** 代表：锤子线或吞没（monitor，落库） | 需新增 | 明确形态优先级口径（待确认） |
| **P1-2** | `wufu-rotation` 补 `category` 字段 + `/api/backtest/run` + 前端入口 | 需完善 | 回测框架已有 M1-M3 |
| **P1-3** | 建立 `Plugin` → `Strategy` 适配器（`PluginSignal[]` → `TargetPosition[]`，等权） | 需完善 | 让 4 个插件获得「可回测」能力 |
| **P2-1** | **风险类** 代表（ATR 止损/回撤约束） | 需新增 | 需裁决「建在 Strategy（仅回测）」还是「扩 `PluginContext` 持仓视图」 |
| **P2-2** | 分类在 UI 上按 V3 六类分组（策略卡显示「类别/周期/适用品种」） | 需完善 | `PRD_v3.md:335` 已定义卡片形态 |
| **P2-3** | 补 `appliesTo`（适用品种）与组合能力（`INV-S3-17/18`） | 需新增 | 改动面较大，建议独立 ADR |

---

## 8. 如何复核本盘点的关键数字

```bash
# 1) 插件清单（4 个 id 与元数据）
rg -n "id: '(rsi_oversold|macd_cross|ma_bullish_alignment|volume_breakout)'" -A 8 \
  apps/backend/src/services/pluginEngine.ts

# 2) 只有 monitor 类会落信号
rg -n "filter\(\(p\) => p.category === 'monitor'\)" apps/backend/src/services/pluginEngine.ts

# 3) 磁盘插件为 0
rg -n "PLUGIN_ALLOWED_PATH|loadPluginsFromDir" apps/backend/src/services/pluginEngine.ts
#   运行日志：ENOENT: scandir 'D:\opt\invol\IA_Prod\plugins\strategies'

# 4) 回测策略仅 2 个、且无 HTTP 入口
ls apps/backend/src/services/backtest/strategies
rg -n "backtest" apps/backend/src/routes || echo "无 backtest 路由"

# 5) 波动率/形态/风险 三类无实现
rg -n "boll|atr|锤子|吞没|engulf|hammer" apps/backend/src/services | grep -v node_modules || echo "无命中"
```

> 最后一条若在后续提交中出现命中，说明本盘点的「需新增」结论需要复审。
