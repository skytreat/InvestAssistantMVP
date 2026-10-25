# InvestAssistant V3 —— 系统设计（SDD v3）

**版本**：V3.0（第 1 部分）
**日期**：2026-10-20
**范围**：V3 新增能力的**技术契约**
**上游**：`InvestAssistantV3_NewRequirements.md`（业务规则与不变量，178 条，唯一权威）
**下游**：`InvestAssistantV3_PRD.md`（交互）、`plan_v3.md`（实施计划）

> **本文档只定义 HOW。** 业务规则（「要什么」）一律在 `InvestAssistantV3_NewRequirements.md`，
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
| `/api/broker-import/confirm` | POST | 确认导入 → 落事实层（**不写系统记录**） |
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
  matchSummary: { exact: number; fuzzy: number; priceMismatch: number;
                  qtyMismatch: number; directionMismatch: number;
                  missing: number; extra: number };
  attribution: {                        // §9.2 的差额归因
    repo: number; cashLikeEtf: number; dividend: number;
    offExchange: number; uncoveredPeriod: number; caliberDiff: number;
    residual: number                    // ← 真实差异，必须醒目
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
    class: 'stock' | 'etf' | 'index' | 'bond' | 'unknown';
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
    class         TEXT,
    asset_class   TEXT NOT NULL CHECK (asset_class IN ('risk','cash')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_symbol_dict_code6 ON symbol_dict(code6);
CREATE INDEX IF NOT EXISTS idx_symbol_dict_pinyin ON symbol_dict(pinyin);
```

> 由行情层**只读**同步而来；`asset_class` 来自 §2 的分类表。
> **快照而非实时查行情层** —— 联想是高频操作，且行情层按需开关连接（`AGENTS.md`）。

#### 11.1.5 资产分类

见 §2.2。

### 11.2 `user_trade_record` 的改造（**DDL 待定稿**）

> ⏳ **依赖**：Wave 1-8 对 `user_trade_record` 的改动稳定。
> 现状：该表已在 T49（7 种 CHECK）、T87（加 `trade_time`、改 UNIQUE）中被改过两次。

**待定稿的改造点**（Requirements 已定契约，此处仅列物理形态待决的部分）：

| 改造点 | 需求侧已定 | 待定稿内容 |
|---|---|---|
| 券商维度 | `user_trade_record` 带券商维度，可空（手工录入） | 列形态：`broker_code TEXT`（简单）或 `broker_account_id INTEGER` 外键 |
| 唯一性约束 | 手工记录保留「同日同标的同类型同时刻唯一」；导入记录允许同秒多笔 | 物理实现：**两个部分唯一索引**（`WHERE broker_code IS NULL` / 含 `broker_seq`） |
| 成交时间可空 | 导入记录无成交时间时留空 | 是否放宽 `NOT NULL`、索引如何调整 |
| 交易类型扩展 | **不需要扩展**（7 种够用，Requirements §3.1） | — |
| 补录来源回溯 | 必须可回溯到事实层 | 列形态：`source_broker_record_id INTEGER` |
| 现金类资产 | 逆回购 / 货币 ETF 作为现金类资产 | 是否需要 `asset_class` 列，还是靠 `asset_code` 关联 `asset_class` 表 |

**定稿时机**：Wave 2 验收后、Wave 3 开工前。若届时 `user_trade_record` 仍在变动，则推迟到稳定后。

**约束提醒**：`CREATE TABLE IF NOT EXISTS` 对已存在的表**无效** → 改 UNIQUE / CHECK 必须走**幂等表重建**
（`建新表 → INSERT SELECT → DROP 旧表 → ALTER RENAME`），且**与 T87/T49 的重建历史合并考虑**，
不得叠加多次重建。

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
| `INV-S1-1` ~ `INV-S1-7`（标的联想） | `symbolSearch.test.ts` |

**验收基线**（实测，可直接作为断言期望值）：

```
行内自洽命中        145/148（3 行为现金分红，公式不适用）
跨文件回填命中率    125/125（国泰 ETF）、12/12（国泰股票）
逆回购配对          180/180，未配对 0
逆回购利息          7,501.46 元（155 个交易日）
排除后保留行数      811 / 1627
```

---

## 修订记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-20 | V3.0-1 | 初稿（第 1 部分）。基于 6 份真实券商文件（1627 行）的实测分析。DDL 覆盖新增 5 表；`user_trade_record` 改造留白（依赖 Wave 1-8 稳定） |
