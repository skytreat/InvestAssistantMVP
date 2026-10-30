# InvestAssistant V3 —— 系统设计（SDD v3）

**版本**：V3.0（第 1 部分）
**日期**：2026-10-20
**范围**：V3 新增能力的**技术契约**
**上游**：`InvestAssistantV3_NewRequirements.md`（业务规则与不变量，186 条，唯一权威）
**下游**：`PRD_v3.md`（交互）、`code_implementation_plan_v3.md`（实施计划）

> **本文档只定义 HOW。** 业务规则（「要什么」）一律在 `InvestAssistantV3_NewRequirements.md`，
> 本文档**只引用不复述**；交互（「长什么样」）在 PRD，本文档只定义接口形状。

---

## 0. 与 `SDD.md`（V1）的关系

本文档是 **V3 的增量契约**，不是 V1 的替代。三段式声明：

| 段 | 内容 | 处置 |
|---|---|---|
| **① V1 契约继续有效** | `SDD.md` 全文（除 §12.3 被 V3 覆盖的条目外） | **继续有效，不改写、不复述**。V3 实现时以 `SDD.md` 为准 |
| **② V3 修改的 V1 契约** | 见 §0.1 清单 | 在本文档定义**改后**形态；`SDD.md` 对应条目在 V3 落地时同步更新 |
| **③ V3 新增的契约** | 本文档 §2 ~ §10 | 全新 |

### 0.1 V3 修改的 V1 契约（§②）

| V1 位置 | V1 契约 | V3 改为 | 理由 |
|---|---|---|---|
| `SDD.md` §4 API | 无导入 / 对账 / 补录路由 | 新增 §9 的 11 个端点 | Requirements §2 |
| `SDD.md` §4 | `GET /api/symbols/search` 支持裸 6 位匹配（Wave 6 已建 `symbolSearch.ts`） | 增强：返回名称 + 拼音首字母 + 分类（§9.4） | Requirements §1 |
| `SDD.md` §5 插件引擎 | 4 个内置插件、单一 `category` | V3 不改插件引擎；**新增**现金类资产分类维度（§2） | Requirements §3.5 |
| `SDD.md` §4 | `GET /api/review/*`（Wave 4 已建 `review.ts`） | 扩展：交易对视图 + 新字段（§9.7） | Requirements §6 |
| `SDD.md` §4.4 | `GET /api/quote/:symbol/kline` 返回 K 线/指标/信号 | 增加 `trades[]`（K 线交易标记，§9.9） | Requirements §6.3 |
| `SDD.md` §6 数据模型 | `user_trade_record` 单一来源 | 新增事实层三表（§11.1），业务层加券商维度（§11.2，DDL 待定稿） | Requirements §2.4.3 |
| `SDD.md` §9/§10/§11 测试映射 | 无 V3 用例 | 新增 §12 映射 | Requirements §9 |
| `packages/core` 公开类型 | `CoreTrade.direction: 'buy' \| 'sell'` | 扩展支持送股 / 分红（§8） | Requirements §3.6 |

### 0.2 前置依赖

| 依赖 | 状态 | 阻塞什么 |
|---|---|---|
| Wave 1-8 对 `user_trade_record` 的改动稳定 | **未完成**（Wave 2 在跑） | §11.2 的 DDL 定稿 |
| `packages/core` 类型扩展 | 本文档 §8 定义，Wave 2 之后实施 | V3.0 |
| 标的分类表 | 本文档 §2 定义 | V3.0b |
| `fast-technical-indicators@1.1.6` | ✅ 已装（精确锁版本） | 指标类需求 |
| 行情层 `raw_symbol_name` / `raw_symbol_class` | ✅ 可用 | §2 分类初判、§9.4 联想 |

---

## 目录

1. [范围与前置](#1-范围与前置)
2. [标的资产分类（风险 / 现金）](#2-标的资产分类风险--现金)
3. [券商文件解析器](#3-券商文件解析器)
4. [事件归一化](#4-事件归一化)
5. [跨文件处理（去重 + 时间回填）](#5-跨文件处理去重--时间回填)
6. [资金校验（行内自洽）](#6-资金校验行内自洽)
7. [现金类资产建模](#7-现金类资产建模)
8. [core 类型扩展](#8-core-类型扩展)
9. [API 契约](#9-api-契约)
10. [性能与安全门槛](#10-性能与安全门槛)
11. [数据模型（DDL）](#11-数据模型ddl)
12. [验收用例映射](#12-验收用例映射)

---

## 1. 范围与前置

### 1.1 覆盖的 V3 能力

| 能力 | 契约位置 |
|---|---|
| S1 标的联想与免前缀 | §9.4 |
| S2 券商流水导入 / 对账 / 补录 | §3 §4 §5 §6 §9.1-9.3 |
| S3 策略体系（分类 / 组合 / 信号生命周期） | §10.3 |
| S4 交易成本与三口径收益 | §7.3 §9.5 |
| S5 策略有效性评估 | §9.6 |
| S6 复盘字段对齐 + 交易对视图 | §9.7 |
| S8 组合风控 | §9.8 |

**不覆盖**：S7 分钟线监控（Requirements §7 已判定不纳入 V3）。

### 1.2 强制执行的项目铁律

以下来自 `AGENTS.md`，在 V3 实现中同样生效：

| 铁律 | V3 落地要求 |
|---|---|
| **注释不是规格** | 解析器对表头的识别**必须以实测为准**，不得照抄文档列名（实测：券商写「资金发生**数**」而非「额」） |
| **DuckDB 只读** | V3 的所有行情读取（标的名称、现价、分类初判）**只读**；Node 侧不得写行情层 |
| **批量查询用 `IN (...)`** | §9.4 联想、§7.3 收益率计算**禁止逐标的循环**查行情层 |
| **改既有表约束必须幂等表重建** | §11.2 的 `user_trade_record` 改造必须走幂等重建（`CREATE TABLE IF NOT EXISTS` 对已存在的表无效） |
| **core 类型变更后必须重建 dist** | §8 落地后必须 `npm run build -w @invest/core`，否则后端 typecheck 走旧 dist（`apps/backend/tsconfig.json` 无 `paths`） |
| **SQL 全预编译参数化** | §11 全部 INSERT/SELECT 禁止字符串拼接 |

---

## 2. 标的资产分类（风险 / 现金）

### 2.1 为什么需要

现有行情层 `raw_symbol_class.class` 的实测取值分布：

```
stock 6158 | etf 2839 | unknown 1357 | block 1128 | index 801 | bstock 166
```

**无法区分「货币 ETF」与「股票 ETF」** —— 实测 `sz162719 石油LOF`（场外 LOF）也被标为 `class='etf'`，
且**有 2314 根日线**（行情层同时收录了场内价格与场外标的名）。

→ 分类不能从行情层直接取，**必须有一层显式、可维护的分类**。

### 2.2 分类表设计

```sql
-- 资产分类：风险 vs 现金
CREATE TABLE IF NOT EXISTS asset_class (
    symbol        TEXT PRIMARY KEY,
    asset_class   TEXT NOT NULL CHECK (asset_class IN ('risk', 'cash')),
    rule_hit      TEXT,                    -- 命中的初判规则标识（manual 修正后保留原值，便于回溯）
    source        TEXT NOT NULL CHECK (source IN ('rule', 'manual')),
    updated_by    INTEGER REFERENCES user_account(id),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_asset_class_kind ON asset_class(asset_class);
```

**语义**：

| 字段 | 语义 |
|---|---|
| `asset_class` | `risk` = 风险资产（参与涨跌幅、信号、集中度）；`cash` = 现金类（不参与上述，只参与资产总额与收益） |
| `rule_hit` | 初判规则标识，如 `repo_code` / `cash_etf_name` / `price_near_par`。**人工修正后仍保留** → 可回溯「当初是谁按什么规则判的」 |
| `source` | `rule` = 规则初判；`manual` = 人工修正。**人工优先级高于规则** |

> 分类**不落行情层**（行情层只读），也不复用 `raw_symbol_class`（那是行情层事实，不能被业务侧改写）。

### 2.3 规则初判

初判在**导入时**或**分类表为空时**按需触发，规则集如下（每条必须有可验证依据，不得仅凭名称关键词）：

| 规则标识 | 判定 | 依据 |
|---|---|---|
| `repo_code` | 证券代码属于国债逆回购品种段 | 实测 `204001`（沪 1 天）、`131810`（深 3 天）。**品种段清单须在实现时实测确认，不得凭记忆硬编码** |
| `cash_etf_near_par` | 该标的在行情层的**最新价贴近面值 100 元**且历史波动极小 | 实测货币 ETF 价格区间 99.997~100.047（振幅 0.05%），而股票 ETF 振幅是数个百分点 |
| `cash_etf_name` | 名称含「货币」「添益」「日利」「现金」等**且**被 `cash_etf_near_par` 佐证 | 名称只作**辅助**，不得单独定案（Requirements `INV-S4-15`） |
| `default` | 其余全部 → `risk` | 默认风险资产是安全侧（错了会让现金类混进风险指标） |

**初判必须记录 `rule_hit`**，以便审计「为什么这个标的是现金类」。

### 2.4 人工修正

| 规则 | 实现 |
|---|---|
| 人工修正**优先于**规则 | 导入时若 `asset_class.source='manual'`，**不再用规则覆盖** |
| 修正必须可追溯 | 记录 `updated_by` / `updated_at` / `rule_hit`（保留原规则标识） |
| 修正后历史可重算 | 分类影响收益率口径（§7.3），修正后**历史收益必须可重算**（Requirements `INV-S4-17`） |
| 未分类标的 | `asset_class` 表中无记录的标的按 `default` = `risk`，但**报告须列出「本次对账期间未分类的标的」**，不得静默按 risk 处理 |

---

## 3. 券商文件解析器

### 3.1 解析器接口契约

```
parseBrokerFile(input: BrokerFileInput) -> Promise<BrokerFileParseResult>
```

```ts
interface BrokerFileInput {
  buffer: Buffer;                 // 原始字节
  filename: string;               // 仅用于报错提示，**不得用于推断文件类型**
  declaredBroker?: string;        // 用户可选声明，**仅作提示**，不得作为识别依据
}

interface BrokerFileParseResult {
  ok: boolean;
  fileKind: 'settlement' | 'trade' | 'unknown';   // 交割单 / 成交流水
  encoding: 'utf-8' | 'utf-8-bom' | 'gb18030' | 'unknown';
  headerRowIndex: number;         // 表头所在行（0 基）
  columns: DetectedColumn[];      // 表头特征探测结果
  rows: ParsedRow[];              // 逐行规范化前的原始值
  mappingSuggestion: ColumnMappingSuggestion;
  warnings: ParseWarning[];
  errors: ParseError[];
}
```

### 3.2 文件类型探测（表头特征，不认券商名）

**必须以列名组合判定**，不得以文件名或用户选择判定。实测两个券商的四种文件：

| 特征列组合 | 判定 |
|---|---|
| 含「资金余额」或「剩余金额」+ 含「费用合计」 | `settlement`（交割单） |
| 含「成交时间」+ 无「费用合计」 | `trade`（成交流水） |
| 含「委托类别」（短词） | 券商甲系（但**仅作映射模板提示**，不作为正确性依据） |
| 含「交易类别」（长描述） | 券商乙系（同上） |

> ⚠️ 实测教训：同一券商的「成交」与「交割单」是**子集+增量**关系，不是两个独立源
> （Requirements §2.2）。探测结果必须能表达这种关系。

### 3.3 编码嗅探

按顺序尝试，**第一个能无乱码解析的即采用**：

```
1. BOM 存在（EF BB BF）        -> utf-8-bom
2. 严格 UTF-8 解码成功          -> utf-8
3. GB18030 解码                 -> gb18030
4. 都不合格                     -> 报错，要求用户另存为 UTF-8 或 GBK
```

> 实测：华宝两个文件为 **GBK/GB18030 的制表符分隔文本**，扩展名却是 `.xls`。

### 3.4 单元格包裹风格（三种）

实测同一券商的不同导出入口分别使用：

| 风格 | 样例 | 处理 |
|---|---|---|
| `="值"` | `="20260601"` | 去前缀 `="` 与后缀 `"` |
| `"值"` | `"20260128"` | 去前后 `"` |
| 原生值 | `20260601`（xlsx 单元格） | 原样 |

**实现要求**：去包裹必须是**幂等**的（对已去包裹的值再处理不产生变化）；
**数字字段同样可能被引号包裹**（实测 `"0.0000"`、`"1"`），转数值前必须先去包裹。

### 3.5 列映射模板

```ts
interface ColumnMappingTemplate {
  id: number;
  brokerCode: string;         // 逻辑券商标识（用户自维护，非文件名推断）
  fileKind: 'settlement' | 'trade';
  mapping: Record<SemanticField, ColumnIndex>;   // 语义字段 -> 列下标
  createdAt: string;
}

type SemanticField =
  | 'tradeDate' | 'tradeTime' | 'settleDate' | 'symbol' | 'name' | 'direction'
  | 'price' | 'quantity' | 'amount' | 'cashFlow' | 'cashBalance' | 'balance'
  | 'feeTotal' | 'fee' | 'stampTax' | 'transferFee' | 'otherFee' | 'tradeId' | 'contractNo';
```

**要求**：

| 规则 | 说明 |
|---|---|
| 语义列名**不得硬编码** | 实测同一文件内「资金发生**数**」与「资金余**额**」用字不一致 → 匹配必须容忍同义 / 错字 |
| 匹配**必须容忍错字与同义** | 匹配失败时给候选（按编辑距离），由用户确认 |
| 匹配结果**必须经用户确认** | 首次导入走向导；同一券商后续导入可套用模板并**提示复核** |
| 模板按（券商 × 文件类型）维度 | 券商甲的交割单模板不能用于其成交流水 |
| 数值列的**语义校验** | 例：`cashFlow` 候选列若不满足「金额 ± 费用」的行内自洽（§6），则标记为低可信 |
| 费用分项列**单独存** | 实测国泰交割单有 10 个费用分项列（佣金/规费/印花税/过户费/经手费/清算费/前台费用/交易规费/证管费/其他费用） |

### 3.6 敏感字段处理

以下字段**在解析阶段丢弃**，不落库、不入日志、不回显：

```
资金账号 | 股东代码 | 营业部名称 | 用户名 | 结算汇率
```

- 股东代码**仅在解析期用于辅助推断市场**（沪 A / 深 A 前缀），推断结果记入 `market` 后即丢弃
- 错误信息中若需引用某行，**只报行号与列名，不报原始值**

> 实测：国泰文件头部含营业部名称、用户名、资金账号、查询日期四行元数据；表头在**第 6 行**（非首行）。

### 3.7 表头定位

解析器**必须向下扫描定位表头行**（§3.2 的特征列组合首次出现的行），不得假设首行。

---

## 4. 事件归一化

### 4.1 规范化事件枚举

见 `InvestAssistantV3_NewRequirements.md` §2.4.1（13 种 + `UNKNOWN`）。本节只定义**实现契约**。

```ts
type BrokerEventType =
  | 'TRADE_BUY' | 'TRADE_SELL'
  | 'FUND_SUBSCRIBE' | 'FUND_REDEEM'
  | 'DIVIDEND_CASH' | 'DIVIDEND_BONUS'
  | 'TRANSFER_IN'
  | 'MARGIN_SHORT' | 'MARGIN_REPAY'
  | 'REPO' | 'CASH_LIKE_ETF'
  | 'EXCLUDED_OFFEXCHANGE' | 'PLACEHOLDER' | 'IGNORE' | 'UNKNOWN';
```

### 4.2 归一化规则

#### 4.2.1 短词型（券商甲）

```
买入 -> TRADE_BUY          卖出 -> TRADE_SELL
盘后定价买入 -> TRADE_BUY   调帐转入 -> TRANSFER_IN
基金申购 -> EXCLUDED_OFFEXCHANGE（场外）
红利 / 股息红利 -> DIVIDEND_CASH
送股 -> DIVIDEND_BONUS
融券 / 融券购回 -> REPO     （普通账户已确认，见下）
指定 -> PLACEHOLDER
```

> **账户类型**（Requirements §2.4.2）：用户全部账户为**普通账户**，
> 故「融券 / 融券购回」**确定映射为 `REPO`**。
> 证据：实测 360 行**全部**指向国债逆回购品种（`204001` / `131810`），且资金流闭合
> （出资 `-14000.14` → 收回 `+14000.56`，利息 0.56 元 → 年化 1.46%）。
> **将来接入信用账户时必须重新引入「账户类型」维度**，并把该词汇映射到 `MARGIN_SHORT` / `MARGIN_REPAY`。

#### 4.2.2 长描述型（券商乙）

形如 `市场 + 品种 + 方向 + 方式`，**按四段解析**：

```
市场   : 上海 | 深圳
品种   : A股普通股票 | 跨市场股票ETF | 跨境ETF | 货币ETF | 单市场股票ETF
         | 单市场债券ETF | 黄金ETF | LOF基金
方向   : 竞价买入 | 竞价卖出 | 盘后买入 | 盘后卖出 | 现金申购 | 现金赎回 | 买入 | 卖出
方式   : 普通 | 盘后 | 现金 | 特殊调账
```

**品种维度直接决定现金类判定**（§2.3）：`货币ETF` → `CASH_LIKE_ETF`；
`跨境ETF` / `黄金ETF` → **风险资产**（但需标记「跨境」维度，§10.3 策略适用性用）。

**未知组合** → `UNKNOWN` 并保留原文，**不得丢弃**（Requirements `INV-S2-7`）。

#### 4.2.3 归一化必须保留原文

事实层必须同时存 `raw_event_type`（原始表述）与 `event_type`（归一化结果）。

### 4.3 排除项与事实层保留

| 事件 | 进系统记录 | 进事实层 | 参与收益 |
|---|---|---|---|
| `REPO` / `CASH_LIKE_ETF` | ✅ 作为现金类资产 | ✅ | ✅ |
| `EXCLUDED_OFFEXCHANGE` / `PLACEHOLDER` / `IGNORE` | ❌ | ✅（标 `exclude_reason`） | ❌ |

**排除项仍必须留在事实层** —— 否则对账差额无法归因（§9.2）。

---

## 5. 跨文件处理（去重 + 时间回填）

### 5.1 结构性事实（实测）

```
交割单  =  成交流水  ∪  非成交事件（分红 / 份额折算 / 申赎杂项 / 特殊调账）
           ↑ 有成交时间      ↑ 无成交时间
```

实测：券商甲 ETF 成交 125 行**全部**匹配到交割单（**匹配率 100%**），成交独有 0 行；
交割独有 9 行**全为非成交事件**（货币 ETF 申赎杂项 4 + 基金现金分红 5）。
股票品种：成交 12/12 全匹配，交割独有 2 行 = 红利入账。

### 5.2 跨文件去重

**去重键**：`标的 + 日期 + 方向 + 价格 + 数量`

| 键相同 | 价与量 | 判读 | 动作 |
|---|---|---|---|
| 同 | **同** | 同一笔交易的**两份冗余导出** | 只保留一条；记录另一来源文件 |
| 同 | **不同** | **真实的分笔成交** | **全部保留**，按出现顺序编号 |

> 不做跨文件去重的后果：同一笔被导入两次 → **持仓与盈亏翻倍**。

**「标的名称」不得用作键** —— 实测同一标的存在多个名称变体
（`159530 机器人ETF易方达` 与 `159530 机器人E`）。

### 5.3 成交时间回填

交割单缺成交时间时，用同券商的成交流水回填。

**匹配优先级（降级）**：

| 级别 | 键 | 说明 |
|---|---|---|
| L1 | 稳定标识（合同序号 / 成交编号） | 国泰交割单有「合同序号」（字母数字混合），最可靠 |
| L2 | 内容键（标的+方向+价格+数量）+ 日期窗口（默认 ±2 天，可配置） | 实测 100% 命中 |
| L3 | 内容键 + 出现顺序配对 | 最后手段 |

**日期权威源 = 成交流水的日期**（按定义即成交日）；交割单的日期**只作辅助键**。

> 实测：某券商的交割单「交收日期」**等于**成交日（含跨境 ETF），但这是该券商该文件的实际口径，
> **不是通用规律** —— 换券商必须重新实测（Requirements `INV-S2-60`）。

**低置信度匹配（L2/L3）必须单列统计**（Requirements `INV-S2-61d`）。

**回填只写成交时间**，其余字段以交割单为准（交割单信息更全：资金发生数、资金余额、费用明细、证券余额）。

### 5.4 同券商多文件的账户合并

同一账户的多个文件（ETF 交割单 + 股票 交割单 + …）**合并为一条记录流**。
实测两文件在重叠日期上余额仅差 120.90 → **同一账户**。

**合并后仍不可做账户级资金闭合**（见 §6）。

---

## 6. 资金校验（行内自洽）

### 6.1 为什么不做账户级闭合

实测否证：

| 检验 | 结果 |
|---|---|
| 「资金余额」列出现**百万级跳变**，而当日成交额仅几万 | 该列是**全账户总资产**，不是现金余额 |
| 同一账户两文件重叠日期余额差 120.90 | 两文件是**品种筛选子集** |
| 逐笔闭合 `上笔余额 − 资金发生数 = 本笔余额` | **1/134 成立** → 不可行 |
| 账户级 `Σflow + 期末 − 期初` | 更不平 → 不可行 |

> **教训来源**：曾以 4 行样本得出「132/133 成立」的结论，全量复测为 1/134。
> 小样本 generalize 是本项目已确认的失败模式。

### 6.2 行内自洽公式（唯一可靠的资金校验）

```
买入：资金发生额 = −(成交金额 + 费用合计)
卖出：资金发生额 = +(成交金额 − 费用合计)
```

实测命中 **145/148**（国泰 ETF 交割单 131/134 + 股票交割单 14/14）。

**3 处不命中**均为**现金分红**（无成交金额，`资金发生额` 即分红额，公式不适用）。

| 规则 | 说明 |
|---|---|
| 不适用行**单独归类** | 现金分红 / 场外申赎 / 占位事件 → 归入「公式不适用」类，**不计入不平行统计** |
| 失配行**必须分类报告** | 「费用口径不符」/「分红」/「口径未知」三类，**不得笼统报「不平」** |
| 「资金余额」列**不得当现金余额用** | 语义为全账户总资产，且随未导出的品种操作跳变 |
| 校验适用范围**须声明** | 无费用明细列的成交流水**不参与**该校验 |

---

## 7. 现金类资产建模

### 7.1 国债逆回购

#### 7.1.1 字段语义（与股票 / ETF 完全不同）

| 字段 | 股票 / ETF | **国债逆回购** |
|---|---|---|
| 成交价格 | 每股价格（元） | **年化收益率（%）** —— 实测 `1.465` 表示 1.465% |
| 成交数量 | 股数 | **手数** —— 实测 14 手 ↔ 14000 元（1 手 = 1000 元） |
| 成交金额 | 价格 × 数量 | **实际资金额** |
| 利息 | 无 | **= 收回金额 − 出资金额**（持有期产生的现金） |

> ⚠️ **把「成交价格」当单价处理是错的。**
> 验证：`14000 × 1.465% / 365 = 0.562` 元，与实测利息 0.56 元吻合。

#### 7.1.2 建模

逆回购建模为**有期限的债权**，不是普通持仓：

```
出资日：建立一笔现金类资产，面额 = 出资金额，到期日 = 出资日 + 期限
到期日：收回本金 + 利息，该资产消失，现金增加
```

- 期限由品种决定（实测沪 1 天期、深 3 天期），**须在实现时按品种实测确认**
- 利息**必须配对算出**（§7.1.3），**不得用费率估算**

#### 7.1.3 配对算法

```
按标的分组 → 各自按 (日期, 时间) 排序 → FIFO 队列
  出资: 入队
  收回: 出队最早的一笔，利息 = 收回金额 − 出资金额
```

> ⚠️ **实测坑**：按数组顺序配对会**严重错配**（实测错误配对导致利息被算成 -100 万量级）。
> 必须按**时间顺序 FIFO**。

#### 7.1.4 未配对处理

未配对的（出资无收回 / 收回无出资）**必须单独报告**：
- 出资无收回 = **在途头寸**（未到期）
- 收回无出资 = 数据不全

实测：180 对全部配对成功，未配对 0 笔。

#### 7.1.5 实测基线（验收参照）

```
180 对（1 天期，覆盖 155 个交易日）
利息合计      7,501.46 元
在途本金      日均约 86.8 万，峰值 155.8 万
隐含年化      0.00558%/日 → 约 2.04%
```

### 7.2 货币 ETF

#### 7.2.1 两种价格语义

| 操作 | 实测样例 | 金额/数量 | 价格语义 |
|---|---|---|---|
| 现金申购 | 511990 价 0.000 量 2100 额 210000 | **100.00** | **面值**（100 元/份） |
| 场内竞价卖出 | 511990 价 99.997 量 10900 额 1089967.3 | **99.997** | **市价** |

**两者混用是正确的**（成本价 = 实际支付额 ÷ 份额，移动加权成本天然处理），
但**价格字段不得当作可比较的涨跌幅基准**。

#### 7.2.2 收益计算

实测价格区间 `99.997 ~ 100.047`，**振幅约 0.05%**。

| 规则 | 说明 |
|---|---|
| 收益**必须按「市值变动」或「日结收益」口径** | 常规百分比涨跌幅在此量级下**因四舍五入而失真** |
| 成本价 = 实际支付额 ÷ 份额 | 天然正确 |
| **不产生交易信号** | 不进 RSI / 择时 / 集中度分母（§2） |
| 申赎杂项**归入现金类收益** | 「现金替代退款」「现金差额扣款」等不得作为独立交易，也不得丢弃 |
| 场内 / 场外操作**须保留来源** | 交易类型同为 `buy`/`reduce`，但须能区分「按面值」与「按市价」 |

### 7.3 收益率三口径

| 口径 | 定义 |
|---|---|
| **风险资产收益率** | (风险资产浮盈 + 已实现盈亏 + 现金分红) ÷ 风险资产成本 |
| **现金类收益率** | (逆回购利息 + 货币 ETF 市值变动) ÷ 现金类投入 |
| **总收益率** | (总资产 − 总投入 − 累计费用) ÷ 总投入 |

**实现要求**：

| 规则 | 说明 |
|---|---|
| **可加性必须成立** | 总 = 风险资产 + 现金类 − 费用（可断言） |
| **费用必须扣除** | 含最低佣金影响（实测小额成交成本率可达 3.13%） |
| **分母定义须明确** | 成本口径 vs 投入口径，并标注与券商口径的差异 |
| **分项必须可见** | 用户要能看到「钱从哪来」，不能只有一个总数 |

---

## 8. core 类型扩展

### 8.1 现状

`packages/core/src/movingWeightedCost.ts` 只接受 `direction: 'buy' | 'sell'`；
上层 `positionCalculator.ts` 的 `mapToCoreTrade` 把 `dividend`/`bonus`/`transfer` 统一映射为 `null`（忽略），
而 `exDividendSync.getHoldingBeforeDate` 又把 `bonus` 计为 `+quantity` → **两处口径相反**。

**实测后果**：某标的当日送股 60 股 + 现金分红 34 元 → 系统持仓**少 60 股**、分红收入为 0。

### 8.2 扩展定义

```ts
export type CoreTradeDirection = 'buy' | 'sell' | 'bonus' | 'dividend';

export interface CoreTrade {
  date: string;
  direction: CoreTradeDirection;
  quantity: number;
  price: number;        // buy/sell = 成交价；bonus = 0；dividend = 每股分红额
  fee?: number;
}

export interface CostPosition {
  quantity: number;        // 当前股数
  totalCost: number;       // 总成本
  avgCost: number;         // 成本价 = totalCost / quantity
  realizedPnl: number;     // 已实现价差盈亏
  cashReceived: number;    // 累计现金分红（新增）
}
```

### 8.3 计算规则

| 事件 | quantity | totalCost | avgCost | cashReceived | realizedPnl |
|---|---|---|---|---|---|
| `buy` | +q | +q×p+fee | 派生 | — | — |
| `sell` | −q | −q×avgCost | 派生 | — | +(p−avgCost)×q − fee |
| `bonus`（送股） | **+n** | **不变** | 派生（摊薄） | — | **不产生** |
| `dividend`（现金分红） | 不变 | 不变 | 不变 | **+= q×p** | **不产生** |

**同日顺序**：先 `bonus` 后 `dividend`（分红基数以送股后股数为准）。

**摊薄后成本价**：`新均价 = 原均价 × Q / (Q+n)`（等价于 `totalCost` 不变、`quantity` 增大后重算）。

### 8.4 向后兼容策略

| 方案 | 说明 |
|---|---|
| **扩展联合类型**（非 breaking） | `CoreTradeDirection` 扩为 4 值；`CostPosition` 增 `cashReceived`（**新增可选字段**）。既有调用方（只传 `buy`/`sell`）**无需改动** |
| 既有 `calculateMovingWeightedCost` 的**返回值结构变化** | 属 breaking → 须在 V3 一次性升级，**不做双轨** |
| `packages/core` 是**零业务依赖**的纯算法层 | 送股/分红语义属于**通用资产记账**，不属于业务耦合 → 放在 core 是合适的 |
| **必须重建 dist** | `npm run build -w @invest/core` 后再验证后端 typecheck（`apps/backend/tsconfig.json` 无 `paths`，走 `packages/core/dist`） |

### 8.5 上层映射

`positionCalculator.ts` 的 `mapToCoreTrade` 须改为：

```
buy / add        -> direction 'buy'
reduce / clear   -> direction 'sell'
dividend         -> direction 'dividend'（quantity = 股数，price = 每股分红额）
bonus            -> direction 'bonus'（quantity = 送股数，price = 0）
transfer         -> 忽略（转托管不改变总持仓）
```

并**删除** `exDividendSync.getHoldingBeforeDate` 中把 `bonus` 计为 `+quantity` 的分支（口径统一到 core）。

---

## 9. API 契约

> 沿用 `SDD.md` §4.2 的响应信封：`{code, data, timestamp, success}`（`INV-S2` 的 Wave 1 形态）。
> 本节只列 **V3 新增/修改**的端点。

### 9.1 导入

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/broker-import/upload` | POST | 上传文件 → 探测 + 预览 + 映射建议（**不落库**） |
| `/api/broker-import/preview` | POST | 按给定映射重新预览 |
 | `/api/broker-import/confirm` | POST | 确认导入 → 落事实层（**不写系统记录**）；导入前做**存在性预检**（查行情层 `raw_symbol_class`）：检测到未知标的 → 200 + `pending_unknown_assets`（不整批拒绝），前端弹窗让用户选择跳过；导入后自动调用 `backfillTradeTime` 回填交割单缺失的 `trade_time`（L1/L2/L3），响应体含 `backfill` 统计 |
 | `/api/broker-import/confirm-batch` | POST | 同券商多文件一次提交（≤5 个，如成交流水+交割单）；整批预检，未知标的一致走 `pending_unknown_assets` 弹窗；全部导入后统一回填一次；**不支持跨券商**（body 仅一个 `brokerCode`） |
 | `/api/broker-import/confirm-final` | POST | 携带 `skipUnknownAssetCodes` 的最终确认端点（二次确认，非幂等）：跳过代码对应行被过滤后落盘 |
 | `/api/broker-import/batches` | GET | 导入批次列表（含统计与撤销入口） |
| `/api/broker-import/batches/:id/revoke` | POST | 撤销批次（软删该批次全部事实层记录） |
| `/api/broker-import/templates` | GET / POST | 列映射模板的读取 / 保存 |

**`upload` 响应要点**：

```ts
{
  fileKind: 'settlement' | 'trade',
  encoding: string,
  headerRowIndex: number,
  detectedColumns: { semantic: string; index: number; label: string; confidence: number }[],
  mappingSuggestion: Record<SemanticField, number | null>,
  previewRows: (ParsedRow & { normalized: NormalizedRow })[],   // 前 N 行
  stats: { total: number; excluded: number; byEventType: Record<string, number> },
  warnings: { code: string; message: string; rowNo?: number }[],
  batchId?: number      // 复用已有文件时返回（文件指纹命中）
}
```

**`confirm` 请求要点**：

```ts
{ fileId: string; mapping: Record<SemanticField, number | null>; accountId?: number }
```

- **幂等**：服务端按**文件内容指纹**（SHA-256）+ 批次号去重；重复上传返回既有批次 ID，**不重复落库**
- **只落事实层**；`user_trade_record` **不在此端点写入**（§9.3）
- **存在性判定**：标的代码归一化后查行情层 `raw_symbol_class`（`class <> 'block'`，见 §11.1.4）；命中未知标的 → 200 + `pending_unknown_assets`（前端弹窗选跳过），**不再整批 422 拒绝**；行情库不可读时跳过校验放行（不误拒）
  - 裸 6 位码歧义（同 code6 多 symbol）：用该行的 `raw_name` 在 `symbol_dict` 精确消解（`code6 + name`），消解结果须同时存在于 `raw_symbol_class` 才生效

### 9.2 对账

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/broker-reconcile/run` | POST | 触发一次对账（参数：券商、覆盖区间、券商维度） |
| `/api/broker-reconcile/latest` | GET | 最近一次对账报告 |
| `/api/broker-reconcile/diff` | GET | 差异明细（分页 + 按类型过滤） |

**报告结构（要点）**：

```ts
{
  brokerCode: string;
  coveredRange: { from: string; to: string };
  matchSummary: {
    exact: number; fuzzy: number; priceMismatch: number;
    qtyMismatch: number; directionMismatch: number;
    missing: number; extra: number;      // 交易记录笔数
    missingGroups?: number; extraGroups?: number; // 标的×日期组数，仅辅助
  };
  attribution: {                        // §9.2 的差额归因（金额单位均为元）
    repo: number; cashLikeEtf: number; dividend: number;
    offExchange: number; uncoveredPeriod: number;
    caliberDiff: number;                // 口径差异金额（元）
    caliberDiffCount: number;           // 口径差异条数（辅助）
    residual: number                    // ← 真实差异金额（元），必须醒目
  };
  fundCheck: {                          // §6 行内自洽
    applicable: number; passed: number;
    notApplicable: number; byReason: Record<string, number>; failedSamples: ...
  };
  timeBackfill: { matched: number; lowConfidence: number; unmatched: number };
  returnSummary: { risk: number; cash: number; total: number };   // §7.3 三口径
}
```

**强制**：`residual`（无法解释的残差）**必须单独返回且不为 0 时置顶**；
**不得用「其他 / 未知」兜底**（Requirements `INV-S2-62/63`）。

**计量口径（强制）**：
- `attribution` 中除 `caliberDiffCount` 外均为**元**；`caliberDiff` 是金额，`caliberDiffCount` 是条数，二者不得互相替代。
- `matchSummary.missing/extra` 是**交易记录笔数**；`missingGroups/extraGroups` 是去重后的**标的×日期组数**，仅 tooltip/辅助。
- `GET /diff` 在现有 `unmatched/repo/cashLikeEtf/dividend/offExchange/unknown` 类别基础上增加 **`extra`**（系统有、事实层无），并与摘要卡同口径分页。

### 9.3 补录

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/broker-reconcile/confirm` | POST | 确认补录（批量 + 逐条可修正） |
| `/api/broker-reconcile/diff/:id/match` | POST | 把「缺失」标记为「已手工记录」（关联到已有 `user_trade_record`） |

**补录契约**：

| 规则 | 实现 |
|---|---|
| **必须显式确认** | 导入端点**不自动补录**（Requirements `INV-S2-33`） |
| 交易类型**由系统推导 + 用户可修正** | 推导规则见 `Requirements` §3.2（有「证券余额」列 → 单行判定；无 → 按券商分别回放） |
| 成交时间缺失时**留空** | **不得填假时间**（Requirements `INV-S2-36`） |
| 必须可回溯 | 新增 `user_trade_record.source_broker_record_id` |
| 撤销只影响业务层 | 撤销补录 = 软删 `user_trade_record`；**事实层永不删除** |
| 事务边界 | 一次确认的补录**整体一个事务**，部分失败整体回滚 |
| **存在性判定** | 补录前校验 `asset_code` 存在于行情层 `raw_symbol_class`（见 §11.1.4），不存在 → 行级 `invalid`（reason `标的不存在于行情层`），**不阻断整批**；行情库不可读时降级放行 |

**T129 实现补充（2026-10-26，V3.2）**：

| 事项 | 落地口径 |
|---|---|
| **match_status 语义** | 补录确认后事实行置 `MATCHED`（五态无 IMPORTED）；「标记已手工记录」同样置 `MATCHED` + `matched_trade_record_id`（可选关联） |
| **可修正白名单** | `buy / add / reduce / clear` 四态（分红/送股**不可**经补录端点进入，仍走除权链路 §8） |
| **推导顺序** | ① 用户修正 > ② 有 `balance_after` 单行判定（卖&余0=clear / 卖&余>0=reduce / 买&余=量=buy / 买&余>量=add；余<量=异常保守 buy）> ③ 无余额按 (user, broker, asset) 分桶、`date→time→fact id` 时序回放。前端默认不传 `tradeType`，仅用户修正时覆盖 |
| **回放起点** | 事实层该标的在该券商的首行（期前持仓不并入回放；覆盖区间之外的口径由用户修正兜底，见 D-37） |
| **明细落库** | `is_auto_import=1`、`trade_reason='券商补录'`、`fee=fee_total`、`broker_seq=content_seq`；时间无法解析 → `NULL`（不变假时间） |
| **权限** | 两端点仅 admin（§10.3）；含 T122 写路由（import confirm / revoke / template save）admin 门补位（D-35） |
| **幂等** | 已映射事实 → `already` 不重复插入；软删业务行后同 source 可再补录（部分唯一索引 B 释放锚点） |
| **冲突** | UNIQUE 撞 B/C 锚 → `409 BROKER_CONFIRM_CONFLICT`，事务整体回滚（部分失败全回滚） |

### 9.4 标的联想（修改既有端点）

`GET /api/symbols/search` 增强：

**请求**：`q`（≥2 字符触发）、`limit`（默认 20）

**响应**：

```ts
{
  code: 0, data: [{
    symbol: string;        // 完整代码（含前缀）
    code6: string;         // 6 位裸码
    name: string;          // 中文名（缺失时为空串，不报错）
    market: 'sh' | 'sz' | 'bj';
    assetClass: 'risk' | 'cash';      // 现金类标识（§2）
    pinyin: string;        // 拼音首字母（用于「gzzq」→「贵州茅台」）
    matchType: 'code' | 'name' | 'pinyin';
  }], timestamp, success
}
```

**实现约束**：

| 约束 | 说明 |
|---|---|
| **不得全表扫描** | 联想是高频操作 → 必须在**业务层的标的字典快照**上查（§11.3），不得直接 `LIKE '%q%'` 扫行情层 |
| 拼音首字母**须预计算并存储** | 不得在查询时实时计算 |
| 名称变体**不得影响匹配** | 实测同一标的有多个名称（`159530 机器人ETF易方达` / `159530 机器人E`）→ 匹配键是**代码** |
| 裸 6 位**自动补前缀** | 唯一命中 → 直接返回完整 `symbol`；多命中 → 返回列表由用户选（Requirements `INV-S1-2`） |
| 前端提交时**自动带前缀** | 不依赖用户从下拉里选（Requirements §1.1 核心缺口） |

### 9.5 收益率

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/portfolio/return` | GET | 三口径收益率（§7.3） |

**响应**：

```ts
{
  risk: { pnl: number; cost: number; rate: number; realized: number; dividend: number },
  cash: { pnl: number; invested: number; rate: number; repoInterest: number; cashEtfChange: number },
  total: { assets: number; invested: number; rate: number; fees: number },
  caliberNote: string        // 与券商口径的差异说明（必须存在）
}
```

### 9.6 策略有效性评估

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/strategy/signals/:id/outcome` | GET | 单条信号的后续表现（T+1/T+5/T+10） |
| `/api/strategy/effectiveness` | GET | 按策略 / 参数 / 品种 / 周期分组的评估结果 |

**实现约束**：必须扣**真实交易成本**（含最低佣金）；必须与基准对比；
信号若在生效前已失效（如止损触发）按**实际可成交价**评估。

### 9.7 复盘与交易对视图

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/review/pairs` | GET | 交易对视图（开仓→平仓配对） |
| `/api/review/pairs/:id` | PATCH | 更新复盘字段（买入逻辑 / 卖出逻辑 / 情绪状态 / 复盘总结 …） |

### 9.8 组合风控

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/portfolio/risk-check` | GET | 组合体检（行业分布 / 单票占比 / 可用现金 / 组合回撤） |

**约束**：集中度分母**必须排除现金类资产**（§2）；组合回撤基于**净值曲线**（含费用）。

### 9.9 K 线交易标记（T152）

**路由**：扩展既有 `GET /api/quote/:symbol/kline`，在响应中新增 `trades[]`；**不新增独立端点**，也不复用 `GET /api/trade` 分页端点（后者上限 200 条/页且无全历史回放）。

**返回项**：仅当前用户、`is_deleted = 0`、`trade_type ∈ {buy, add, reduce, clear}`、且 `quantity > 0` / `price > 0` 的记录。

```jsonc
{
  "id": 123,
  "trade_date": "2026-10-12",
  "trade_time": "09:35:00",   // 可空（V3 券商导入后）；空时前端省略时间
  "trade_type": "buy",        // 原始录入/导入类型，保留供审计
  "marker_type": "open",      // 展示推导类型：open / add / reduce / close
  "quantity": 100,
  "price": 10.50,             // 实际成交价（不复权）
  "adj_price": 10.72          // 当前 fq 口径下的复权价；前端唯一显示价
}
```

**窗口口径**：

- `trades[]` 只包含 `trade_date` 落在本次返回的 `klines[]` 首尾日期（闭区间）内的记录；`days` 上限沿用 500。
- **推导回放必须从该标的全历史活记录开始**（不能只回放窗口内）—— 否则窗口首日的买入会被误判为建仓。
- **持仓口径 = 该用户该标的的跨券商合并持仓**（与 `calcPosition` 一致），**不按券商分组**。⚠️ 与 §3.2 的导入推导不同：那里的「按券商分组」只用于确定单条 `trade_type`；K 线展示必须用合并持仓，否则同一标的在多券商持有时会把加仓误判为建仓。
- 回放顺序与 `calcPosition` 一致：同日 `bonus` 优先于 `dividend`，`dividend` 优先于买卖，买卖之间按 `trade_time / id`；**不能只用 SQL 的 `trade_time` 排序**。
- 回放口径与 `calcPosition` 一致（`buy/add` 增加数量、`reduce/clear` 减少数量、`bonus` 增加数量、`dividend` 不影响数量；其余类型按持仓计算口径）。超卖按 `calcPosition` 的容错口径结算（按实际可卖数量，绝不允许负持仓）。分红/送股/转增**不进入 `trades[]`**。
- 推导规则：
  - 买入前持仓 ≤ 0 → `open`；买入前持仓 > 0 → `add`。
  - 卖出后持仓 ≤ 0 → `close`；卖出后持仓 > 0 → `reduce`。
  - 卖出前持仓 ≤ 0 的异常记录，按原始 `trade_type` 兜底映射（`reduce`→`reduce`，`clear`→`close`），**不丢点**；原始 `trade_type` 保留供审计。
- 同一标的同一天多笔：后端逐笔返回，前端按日/周/月桶聚合展示；API **不得**把同日多笔合并成一条。
- `klines` 为空时同样返回 `trades: []`，保证 `trades` 键恒存在。

**复权换算**：

- `fq=qfq`：`adj_price = price × qfq_factor(交易日)`；`fq=hfq`：`adj_price = price × hfq_factor(交易日)`；`fq=bfq/raw`：`adj_price = price`。
- 因子取该交易日行情行的 `qfq_factor` / `hfq_factor`；无当日 K 线（停牌/非交易日）时取**之前最近一个交易日**的因子；仍无则 `adj_price = price` 并写 `system_log`（WARN）。禁止用窗口最后一天的因子统一换算。
- 换算在后端完成；前端不重新计算复权，避免双端口径漂移。

**安全与过滤**：

- `user_id` 只从 JWT 取，绝不接受请求参数；`is_deleted = 0`；`asset_code` 归一化后再查；ETF/北交所同一套。
- 只返回 4 类交易；`dividend / bonus / transfer` 即使落在窗口内也不返回。
- 不得因为 `trades[]` 查询失败而让整个 K 线端点 500：交易查询异常时降级为 `trades: []` 并写 `system_log`（WARN），K 线主数据仍返回。

**前端映射**：

- 日 K：`trade_date` 有对应 bar 时直接映射；无对应 bar（周末/停牌）时归入其后最近一根，**不插值、不改写交易日期**；超出窗口不画。
- 周/月 K：按 `trade_date` 归入所属周/月桶；同一桶多笔聚合为一个标记，明细保留全部记录。周/月聚合必须保留桶起止日期，**不得只按 `bar.date` 精确匹配**。
- `ChartBar` 需从单值 `signal` 扩展为可承载多笔 `trades`（同日多笔不能只留一笔）。

**性能**：

- 全历史回放只取必要列（`id, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted`），一次查询后内存回放，禁止逐笔 `calcPosition`。
- `trades[]` 只返回窗口内记录，响应体积与窗口内交易笔数线性，不随全历史增长。

**测试要点**：

- 单测：空仓买入→`open`；有仓买入→`add`；卖光→`close`；部分卖→`reduce`；`clear` 部分卖→`reduce`；`clear` 卖光→`close`；`bonus` 参与数量但不输出；`dividend` 不输出；软删除不参与；窗口首日买入仍判 `open`（全历史回放）；同日 `bonus` 先于卖出；跨券商合并持仓下加仓不被误判为建仓。
- 集成：K 线响应含 `trades[]`；`fq=qfq/hfq/bfq/raw` 的 `adj_price` 正确；同日多笔不合并；无交易时 `trades: []`；交易查询异常降级不 500。

---

## 10. 性能与安全门槛

### 10.1 性能门槛

| 场景 | 门槛 | 依据 |
|---|---|---|
| 标的联想响应 | p95 < 100ms | 高频操作，须走业务层快照（Wave 4 的 `SymbolAutocomplete` 已在用） |
| 单文件解析（≤700 行） | < 3s | 实测样本最大 671 行 |
| 全量导入（6 文件 1627 行） | < 30s | 含去重、回填、校验 |
| 跨文件去重 + 回填 | < 5s / 千行 | |
| 收益率三口径计算 | < 1s | 单次全量持仓 |
| 对账报告生成 | < 10s | 覆盖 3 年区间 |
| K 线交易标记回放 | < 300ms | 单标的全历史一次查询 + 内存回放；禁止逐笔 `calcPosition` |

**禁止**：逐标的循环查行情层（一律 `IN (...)` 批量）。

### 10.2 内存与数据量

| 项 | 量级 | 说明 |
|---|---|---|
| 单次导入行数 | ≤ 5000 | 超出须分批 |
| 事实层保留期 | 永久（软删） | 事实层是**不可变证据**，不得物理删除 |
| 解析峰值内存 | ≤ 200MB | 逐文件流式解析，不整目录载入 |

### 10.3 安全门槛

| 项 | 要求 |
|---|---|
| 文件上传 | 大小上限 **10MB**；扩展名白名单（`.xlsx` / `.xls` / `.csv` / `.txt`）；**扩展名不可信** → 以**内容嗅探**为准（§3.3） |
| 解析器隔离 | 解析在**受限上下文**执行；**不得 `eval` 用户内容**（与插件沙盒同款原则：§3 的沙箱约束） |
| 敏感字段 | §3.6 的字段**丢弃**，不入库、不入日志 |
| 日志 | 错误信息**只报行号与列名**，不报原始值 |
| SQL | 全部预编译参数化 |
| 文件存储 | 上传文件**不落盘**（或落临时目录并及时清理）；只保留解析结果与原始行的 JSON |
| 导入权限 | 仅 admin 可导入与补录（补录会改业务数据） |

### 10.4 插件与策略

V3 **不改插件引擎**（50ms 预算、参数校验、沙箱约束全部沿用 `SDD.md` §5.3）。
新增的现金类分类维度**只影响**策略的**适用品种**过滤（`Requirements` `INV-S3-15`）：

| 策略维度 | 取值 |
|---|---|
| 适用品种 | 全部 / 仅股票 / 仅场内 ETF / 仅跨境 ETF / **排除跨境** / **排除现金类** |
| 适用周期 | 日线 / 60 分钟 / 15 分钟（V3 只用日线，§7 判定分钟线不纳入） |

---

## 11. 数据模型（DDL）

### 11.1 V3 新增表（**现在定稿**）

#### 11.1.1 事实层：券商原始记录

```sql
CREATE TABLE IF NOT EXISTS broker_trade_record (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL,
    import_batch_id     INTEGER NOT NULL,
    broker_code         TEXT NOT NULL,
    source_kind         TEXT NOT NULL CHECK (source_kind IN ('broker', 'manual_sheet')),

    -- 规范化
    event_type          TEXT NOT NULL,
    asset_code          TEXT,
    trade_date          TEXT,
    trade_time          TEXT,
    price               REAL,
    quantity            REAL,
    amount              REAL,
    cash_flow           REAL,
    fee_total           REAL,
    fee_breakdown_json  TEXT,
    balance_after       REAL,
    cash_balance_after  REAL,
    market              TEXT,

    -- 原始（可追溯，见 Requirements INV-S2-6）
    raw_symbol          TEXT,
    raw_name            TEXT,
    raw_event_type      TEXT,
    raw_row_json        TEXT NOT NULL,
    source_file         TEXT,
    source_row_no       INTEGER,

    -- 匹配与归因
    match_status        TEXT NOT NULL CHECK (match_status IN
                            ('MATCHED','FUZZY','MISSING','EXCLUDED','CONFLICT')),
    matched_trade_record_id INTEGER,
    exclude_reason      TEXT,
    match_confidence    TEXT,
    row_hash            TEXT NOT NULL,
    content_seq         INTEGER NOT NULL DEFAULT 0,

    is_deleted          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);
CREATE INDEX IF NOT EXISTS idx_btr_hash    ON broker_trade_record(user_id, row_hash);
CREATE INDEX IF NOT EXISTS idx_btr_batch   ON broker_trade_record(user_id, import_batch_id);
CREATE INDEX IF NOT EXISTS idx_btr_match   ON broker_trade_record(user_id, broker_code, match_status);
CREATE INDEX IF NOT EXISTS idx_btr_key     ON broker_trade_record(user_id, broker_code, asset_code, trade_date);
```

**关键点**：

| 点 | 说明 |
|---|---|
| `row_hash` + `content_seq` | **幂等键**（Requirements `INV-S2-39`）。`row_hash` = 归一化内容的 SHA-256；`content_seq` = **同哈希内容在批次内的出现序号** → 「同内容多笔」不被误判为重复，「同一文件重复上传」被识别为重复 |
| `raw_row_json` | **必存**（`INV-S2-6`）。解析 bug 修复后可重放，无需用户重新上传 |
| `match_status` 五态 | `MATCHED` / `FUZZY`（低置信度）/ `MISSING`（券商有系统无）/ `EXCLUDED`（排除项）/ `CONFLICT` |
| `source_kind` | `broker` / `manual_sheet`（三方对账的第三方参照，§9.2） |
| `raw_*` 列 | **不入库敏感字段**（§3.6） |

#### 11.1.2 导入批次

```sql
CREATE TABLE IF NOT EXISTS broker_import_batch (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    broker_code      TEXT NOT NULL,
    file_kind        TEXT NOT NULL CHECK (file_kind IN ('settlement','trade')),
    encoding         TEXT,
    file_name        TEXT,
    file_hash        TEXT NOT NULL,
    file_size        INTEGER,
    template_id      INTEGER,
    parser_version   TEXT NOT NULL,
    row_total        INTEGER NOT NULL DEFAULT 0,
    row_inserted     INTEGER NOT NULL DEFAULT 0,
    row_deduped      INTEGER NOT NULL DEFAULT 0,
    row_excluded     INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL CHECK (status IN ('pending','parsed','imported','revoked')),
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);
CREATE INDEX IF NOT EXISTS idx_batch_hash ON broker_import_batch(user_id, file_hash);
```

#### 11.1.3 列映射模板

```sql
CREATE TABLE IF NOT EXISTS broker_import_template (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    broker_code   TEXT NOT NULL,
    file_kind     TEXT NOT NULL CHECK (file_kind IN ('settlement','trade')),
    mapping_json  TEXT NOT NULL,
    is_deleted    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, broker_code, file_kind)
);
```

#### 11.1.4 标的字典快照（联想用，§9.4）

```sql
CREATE TABLE IF NOT EXISTS symbol_dict (
    symbol        TEXT PRIMARY KEY,
    code6         TEXT NOT NULL,
    name          TEXT,
    pinyin        TEXT,
    market        TEXT,
    asset_class   TEXT NOT NULL CHECK (asset_class IN ('risk','cash')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_symbol_dict_code6 ON symbol_dict(code6);
CREATE INDEX IF NOT EXISTS idx_symbol_dict_pinyin ON symbol_dict(pinyin);
```

> **定位（2026-10-29 收窄）**：字典只做**名称联想搜索 + code6 歧义消解**，**不做存在性判定**。
> - 由行情层 `raw_symbol_name` **只读**同步（有名称的标的）；`asset_class` 来自 §2 的分类表。
> - **快照而非实时查行情层** —— 联想是高频操作，且行情层按需开关连接（`AGENTS.md`）。
>
> **存在性判定源 = 行情层 `raw_symbol_class`**（覆盖 `raw_kline_daily` 全部标的，含 `unknown` 类）：
> - `raw_symbol_name` 只收录有名称的标的（实测 8,791 / 14,711 ≈ 59%），**不能**作为存在性判定源；
> - `raw_symbol_class` 与 `raw_kline_daily` 标的数完全一致（14,711 = 14,711，0 缺失），排除 `block`（板块分组非可交易证券）后即为「已知标的」全集；
> - 券商导入（`preflightBrokerFile`）、补录（`confirmTrades`）、手工录入（`POST /api/trade`）的存在性校验均查 `raw_symbol_class`（`class <> 'block'`）；
> - 孤儿判定（`listOrphanUserTradeRecords` / `softDeleteOrphanUserTradeRecords`）同样以 `raw_symbol_class` 为判定源，行情库不可读时保持「无法判定 → 禁止批量清理」语义。

#### 11.1.5 资产分类

见 §2.2。

#### 11.1.6 费用模型配置（V3.7 T140）

> 权威源 = `apps/backend/src/config/configStore.ts`（`DDL_SQL` 注释 `-- T140（V3.7）费用模型配置（INV-S4-3~5）`），DDL 原样如下。

```sql
-- T140（V3.7）费用模型配置（INV-S4-3~5）
CREATE TABLE IF NOT EXISTS user_fee_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    broker_code TEXT,
    asset_class TEXT CHECK (asset_class IS NULL OR asset_class IN ('risk','cash')),
    commission_rate REAL NOT NULL DEFAULT 0.0003,
    min_commission REAL NOT NULL DEFAULT 5,
    stamp_tax_rate REAL NOT NULL DEFAULT 0.001,
    transfer_fee_rate REAL NOT NULL DEFAULT 0.00002,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);
CREATE INDEX IF NOT EXISTS idx_fee_config_user ON user_fee_config(user_id, broker_code);
```

**语义说明**：

- `broker_code` / `asset_class` 均可空 ⇒ 费率（`commission_rate`）/ 最低佣金（`min_commission`）/ 印花税（`stamp_tax_rate`）/ 过户费（`transfer_fee_rate`）可按 **券商 / 资产类** 两个维度配置（NULL = 回落到账户级默认值）。
- **取数规则**（D-46）：源文件 `fee_total` **优先**；缺失才按本配置反算，并标 `user_trade_record.fee_estimated=1`（反算是兜底不是替代，源数据绝不覆盖）。见 `docs/audit/v3-pending-decisions.md` D-46。

### 11.2 `user_trade_record` 的改造（**已定稿**，T128）

> ✅ **定稿**（2026-10-26，`v3-pending-decisions.md` D-7/D-34）：Wave 1-12 已全部合入，该表自 T49/T87b 后无未决改动。
> 现状：该表已在 T49（7 种 CHECK）、T87（加 `trade_time`、改 UNIQUE）、T87b（ 部分 unique 索引）中被改过。
> 本次改造与 T87b/T49 的重建历史**合并为一次幂等表重建**（AGENTS.md「DDL 变更判据」）。

**定稿后的物理形态**（单一真相源 = `apps/backend/src/config/configStore.ts` 的 `TRADE_RECORD_COLUMNS_SQL`）：

| 改造点 | 需求侧已定 | **定稿值** |
|---|---|---|
| 券商维度 | `user_trade_record` 带券商维度，可空（手工录入） | **`broker_code TEXT`**（可空，NULL = 手工录入）。不引入 `broker_account_id` 外键 —— MVP 无券商账户表，券商编码与 `broker_import_batch.broker_code` 同一套 |
| 唯一性约束 | 手工记录「同日同标的同类型同时刻唯一」；导入允许同秒多笔 | **三条部分唯一索引**（语义见下） |
| 成交时间可空 | 导入记录无成交时间时留空 | **`trade_time TEXT`（NOT NULL 移除）**；手工必填由服务层校验（`validateTradeTime`）承担 |
| 交易类型扩展 | **不需要扩展**（7 种够用，Requirements §3.1） | CHECK 原样保留 |
| 补录来源回溯 | 必须可回溯到事实层 | **`source_broker_record_id INTEGER REFERENCES broker_trade_record(id)`** |
| 现金类资产 | 逆回购 / 货币 ETF 作为现金类资产 | **不加 `asset_class` 列**，靠 `asset_code` 关联 `asset_class` 表（D-34）——分类规则/人工修正可热改，不冗余 |
| 同内容序号 | 导入记录的身份键需能区分「同内容多笔」 | **`broker_seq INTEGER`** = 事实层 `content_seq`（同批次内同哈希出现序号） |

**三条部分唯一索引**（全部 `CREATE UNIQUE INDEX`，谓词见 SQL 常量）：

| # | 索引名 | 约束对象 | 谓词 | 需求依据 |
|---|---|---|---|---|
| A | `idx_user_trade_record_unique_live` | 手工记录：`(user_id, asset_code, trade_type, trade_date, trade_time)` | `WHERE is_deleted = 0 AND broker_code IS NULL` | INV-S3-12 / T87b 幽灵占用修复 |
| B | `idx_user_trade_record_broker_source` | 源锚：`(user_id, source_broker_record_id)` | `WHERE is_deleted = 0 AND source_broker_record_id IS NOT NULL` | INV-S2-34/35：同一事实行最多一条活记录；软删释放 ⇒ 撤销后可重新补录 |
| C | `idx_user_trade_record_broker_identity` | 导入身份键：`(user_id, broker_code, asset_code, trade_type, trade_date, broker_seq, trade_time)` | `WHERE is_deleted = 0 AND broker_code IS NOT NULL` | INV-S3-13：同秒多笔可表达；同内容重复补录被拦 |

> 🔴 **为什么 B 与 C 同时存在**（SDD 留白期只写了两个索引）：SQLite 唯一索引把 NULL 视为互异 ——
> 导入记录的 `trade_time` 可为 NULL（INV-S2-36），此时 C 的 (…, broker_seq, trade_time) 对
> 「同一事实行被补录两次」**拦不住**（两次都 NULL 不冲突）⇒ 必须由 B（源锚）兜底。
> C 的价值在「防止同内容事实行跨批次重复补录」（不同批次 seq 同为 0 时 C 拦截）。
> 物理偏差已登记 `v3-pending-decisions.md` D-34。

**迁移机制**：`_ensureTradeRecordUniqueConstraint()` 四态判定
（`ready` / `missing-index` / `stale-index` ／ `legacy`）——
表已最终形态只调索引；缺列 / 仍有表级 UNIQUE / trade_time 仍 NOT NULL ⇒ 一次幂等表重建（新表 → 灌数据 → 删旧表 → 改名，事务 + 零丢失校验）。

**约束提醒**：`CREATE TABLE IF NOT EXISTS` 对已存在的表**无效** → 改 UNIQUE / CHECK 必须走**幂等表重建**，
且**与 T87/T49 的重建历史合并考虑**，不得叠加多次重建。

#### V3.7（T140）新增列

```sql
fee_estimated INTEGER NOT NULL DEFAULT 0 CHECK (fee_estimated IN (0, 1))
```

- 源文件费用（`fee_total`）**缺失时**按 `user_fee_config`（§11.1.6）反算并置 `1`；源数据有费用则直接用（置 `0`）。取数规则见 `docs/audit/v3-pending-decisions.md` D-46。
- 迁移：存量表补列走 `_ensureTradeRecordReviewColumns()` 的 `ALTER TABLE ADD COLUMN`（configStore.ts，幂等，不重建表）。

#### V3.3（T131）复盘列（同补入本表）

```sql
buy_reason TEXT,
sell_reason TEXT,
emotion_status TEXT CHECK (emotion_status IS NULL OR emotion_status IN ('极度兴奋','兴奋','平静','焦虑','恐慌'))
```

- `buy_reason` / `sell_reason`（INV-S6-2）：买入 / 卖出逻辑**两列分离**，允许只填其一（历史 `trade_reason` 列保留在表内）。
- `emotion_status`（INV-S6-3）：**5 档固定枚举**（极度兴奋 / 兴奋 / 平静 / 焦虑 / 恐慌，Q7 2026-10-24 定稿：落库后不可改语义，新增档位可以）。

#### `user_strategy_signal` V3.4~V3.7 生命周期列（T134/T141）

> 该表基础结构在 `SDD.md` §3.2，SDD_v3 不复述；此处仅列 V3 新增列（configStore.ts `DDL_SQL` / `_ensureSignalLifecycleColumns()` 原文）。

| 列 | 约束 | 任务 | 语义 |
|---|---|---|---|
| `grade` | `TEXT CHECK (grade IS NULL OR grade IN ('strong','medium','weak'))` | T134 | 信号分级（强 / 中 / 弱，每日 Top N 摘要） |
| `expires_at` | `TEXT` | T134 | 过期时间（过期标灰不删） |
| `snapshot_json` | `TEXT` | T134 | 触发快照（当时 K 线与指标值） |
| `adopted` | `INTEGER NOT NULL DEFAULT 0 CHECK (adopted IN (0, 1))` | T134 | 采纳标注 |
| `ignored` | `INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1))` | T134 | 忽略标注 |
| `adopted_at` | `TEXT` | T134 | 采纳时间 |
| `cooldown_until` | `TEXT` | T134 | 冷却期（同策略 / 同标的 / 同方向至此不重复出信号；MVP 先按日线） |
| `linked_trade_id` | `INTEGER REFERENCES user_trade_record(id)` | T141 | 手动关联交易记录（跳转复盘，INV-S3-15/16） |

> 迁移：存量表逐列 `ALTER TABLE ADD COLUMN` 由 `_ensureSignalLifecycleColumns()` 补齐（幂等，不重建表）。

---

## 12. 验收用例映射

| Requirements 不变量 | 验收用例（SDD §12.5 载体） |
|---|---|
| `INV-S2-1` ~ `INV-S2-4`（探测/表头定位/编码/伪 xls） | `broker_parser.test.ts` |
| `INV-S2-5` ~ `INV-S2-6`（废单/原始行） | `broker_parser.test.ts` |
| `INV-S2-7`、`INV-S2-8`（未知类型/敏感字段） | `broker_parser.test.ts` |
| `INV-S2-9`（文件级幂等） | `broker_import.test.ts` |
| `INV-S2-39`（行级幂等 + 同内容多笔） | `broker_import.test.ts` |
| `INV-S2-48` ~ `INV-S2-51`（跨文件去重） | `broker_reconcile.test.ts` |
| `INV-S2-54` ~ `INV-S2-61d`（时间回填） | `broker_reconcile.test.ts` |
| `INV-S2-40` ~ `INV-S2-44`（行内自洽校验） | `broker_fundcheck.test.ts` |
| `INV-S2-62` ~ `INV-S2-65`（差额归因） | `broker_reconcile.test.ts` |
| `INV-S4-8` ~ `INV-S4-13`（现金类分类） | `asset_class.test.ts` |
| `INV-S4-14` ~ `INV-S4-17`（分类表与人工修正） | `asset_class.test.ts` |
| `INV-S4-18` ~ `INV-S4-22`（逆回购建模） | `repo_model.test.ts` |
| `INV-S4-23` ~ `INV-S4-26`（货币 ETF 建模） | `cash_etf.test.ts` |
| `INV-S4-27` ~ `INV-S4-29`（三口径收益） | `portfolio_return.test.ts` |
| `INV-S3-*`（交易类型与成本语义） | `movingWeightedCost`（core）+ `positionCalculator.test.ts` |
| `INV-S1-1` ~ `INV-S1-7`（标的联想） | `symbolSearch.test.ts` + `symbolDict.test.ts`（T136 快照 / 拼音 / 免前缀） |
| `INV-S6-10` ~ `INV-S6-17`（K 线交易标记） | `klineTrades.test.ts` + `Kline.test.tsx`（T152） |

**V3.7 补录映射（2026-10-26 交叉审计，测试载体待 T138~T141 后续 commit 补齐）**：

| Requirements 不变量 | 测试载体（计划） |
|---|---|
| `INV-S2-14/15`（代码补零 / 前导空白裁剪） | `broker_parser.test.ts` + `broker_import.test.ts`（T138） |
| `INV-S2-17~20`（数值化 / 金额保留 / 余额保留 / 费用分项保留） | `broker_parser.test.ts`（T138） |
| `INV-S2-21/22/23`（按券商分组匹配 / 全流水覆盖 / 缺失可标记已手工） | `broker_reconcile.test.ts` + `brokerConfirm.test.ts`（T129 已含 ④/⑥） |
| `INV-S2-26/27/29~31`（对账不改记录 / 多余保留 / 三层呈现 / 手工独立成组） | `broker_reconcile_report.test.ts` |
| `INV-S2-52`（列名同义/错字容忍） | `broker_parser.test.ts`（T138） |
| `INV-S3-1/2/10`（类型表达 / 一次性扩展 / 时间仅区分同日多笔） | `positionCalculator.test.ts` + `t87-trade-time.test.ts`（已有） |
| `INV-S3-15/16`、`INV-S6-4`（信号↔交易关联 / 跳转复盘） | `signalLink.test.ts`（T141，载体新建） |
| `INV-S3-21`（默认参数可解释依据） | 插件文档 + `pluginEngine.test.ts` |
| `INV-S4-1~6`（毛/净盈亏 / 成本项 / 账户费率 / 品种费率 / 源文件优先+反算标注） | `feeModel.test.ts`（T140，载体新建） |
| `INV-S4-3~5`（费用模型配置） | `feeModel.test.ts` + `user_fee_config` DDL 断言 |
| `INV-S2-45~47`（manual_sheet 三方对账） | **V4 候选**（V3-B8 / D-45，不映射 V3 测试） |

**验收基线**（实测，可直接作为断言期望值）：

```
行内自洽命中        145/148（3 行为现金分红，公式不适用）
跨文件回填命中率    125/125（国泰 ETF）、12/12（国泰股票）
逆回购配对          180/180，未配对 0
逆回购利息          7,501.46 元（155 个交易日）
排除后保留行数      811 / 1627
```

---

## 13. 前端 V3 架构（页面 / 路由 / 组件）

> V3.1~V3.7 交付的是**后端 API + 算法**；PRD_v3 §2~§5 的界面在 **V3.8**（T142~T150）落地。
> 本节点定「长什么样、挂在哪、连哪个端点」，**不复述交互细节**（交互权威源 = `PRD_v3.md` 对应章节）。

### 13.1 新增路由（挂在 `apps/frontend/src/router` 既有路由体系）

| 路由 | 页面 | 主要端点 | PRD 章节 | 任务 |
|---|---|---|---|---|
| `/broker/import` | 导入向导（拖拽→探测/映射→预览→确认） | `POST /api/broker-import/upload /preview /confirm` | §3.1 | T143 |
| `/broker/reconcile` | 对账报告（摘要/归因/资金校验/回填/差异/三口径） | `POST /run`、`GET /latest /diff`、`/api/portfolio/return` | §3.2 | T144/T147 |
| （弹窗） | 补录对话框 | `POST /confirm`、`POST /diff/:id/match` | §3.3 | T145 |
| `/strategy/config` | 策略配置（分类/组合/适用品种/冷却期） | `GET /api/strategy/plugins`、`PUT /:id/config` | §4.1 | T148 |
| （现有 Signals 页增强） | 分级/过期/Top5/采纳/快照/关联 | `PATCH /api/signal/:id/adopt /ignore /link-trade`、`GET /outcome` | §4.2 | T149 |
| `/strategy/effectiveness` | 策略有效性（多周期/基准/导出 CSV） | `GET /api/strategy/signals/:id/outcome`（T135） | §4.3 | T150 |
| `/portfolio/risk-check` | 组合体检（四指标卡片/行业分布） | `GET /api/portfolio/risk-check` | §5.3 | T150 |
| （Review 页 tab） | 流水 / **交易对**双 tab + 复盘编辑 | `GET /api/review/pairs`、`PATCH /api/review/pairs/:id` | §5.1/5.2 | T150 |
| （持仓页增强） | 券商列 / 现金类分区 / 手工成组 | `GET /api/holding` + `asset_class` 快照 | §3.4.1 | T146 |
| （现有 Kline 页增强） | 4 类交易标记 + 图例/开关 + 同日明细面板 | `GET /api/quote/:symbol/kline`（新增 `trades[]`） | §5.4 | T152 |
| （全端联想增强） | 防抖/键盘/现金标签/唯一命中自动确认 | `GET /api/symbols/search`（T136 symbol_dict 快照） | §2.1/2.2 | T142 |

### 13.2 组件分层（沿用 `SDD.md` §2.12 的 Pages / Business / Common / Feature 四层）

| 层 | 新增 | 依赖 |
|---|---|---|
| Pages | `BrokerImport` / `BrokerReconcile` / `PortfolioReturn` / `RiskCheck` / `StrategyEffectiveness` 路由容器 | Business + Common |
| Business | `BrokerImportWizard`、`ReconcileReport`、`ComplementDialog`、`PortfolioReturnCard`、`RiskCheckCard`、`StrategyConfigForm`、`SignalLifecyclePanel`（采纳/忽略/快照/关联）、`ReviewPairsTable`、`ReviewEditForm`、`KlineTradeMarkerOverlay` | Common + Feature + `@/api/client` |
| Feature（store） | 扩展 `holdingStore`（含 broker/asset_class 维度）；新增 `brokerStore`（批次/报告缓存，React Query） | API client |

**硬约束**：前端**只走 HTTP API**（`apps/frontend` 禁止 import `packages/core`，AGENTS 硬约束）；
所有写操作（导入/补录）仅 admin 可见入口（SDD §10.3 路由层 403 已拦，前端按角色隐藏菜单）。

### 13.3 与既有页面的关系

- 不新增全局导航项：券商对账挂在「数据」分组下（PRD §3 导航 `数据 → 券商对账`）；
  收益/体检挂 Dashboard 二级入口；策略三页挂「策略」分组。

---

## 修订记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-20 | V3.0-1 | 初稿（第 1 部分）。基于 6 份真实券商文件（1627 行）的实测分析。DDL 覆盖新增 5 表；`user_trade_record` 改造留白（依赖 Wave 1-8 稳定） |
| 2026-10-26 | V3.2-1 | 交叉审计补全：§11.2 T128/T129 定稿回填；§12 补 V3.7 不变量映射（T138~T141）；**新增 §13 前端 V3 架构**（V3.8 T142~T150 页面规格）；§11 新增 `user_fee_config`（T140，见 §13/plan V3.7） |
| 2026-10-26 | V3.3-1 | §11 DDL 同步：user_trade_record 复盘/费用列、user_strategy_signal 生命周期列、user_fee_config 表（与 configStore.ts 权威源对齐） |
| 2026-10-30 | V3.9-1 | 新增 §9.9 K 线交易标记契约（T152）：`trades[]`、跨券商合并持仓回放、复权价、窗口/同日多笔/降级；§10.1 性能门槛、§12 验收映射、§13 前端组件同步 |
