> **⚠️ 已归档（2026-10-17）**：本文为需求 **V1.1（2026-10-13，OCI ARM VM 架构）** 原始版，
> 已被 [docs/client/Requirements_simplified.md](../client/Requirements_simplified.md)（V1.0，2026-10-14，桌面本地架构）取代。
> **架构前提已完全不同**（本文 15 处 OCI / 9 处桌面；现行版 0 处 OCI / 6 处桌面）。
> 业务规则以 Requirements_simplified.md 为准，本文仅作历史留档，**不得作为执行依据**。
# 个人投资助手 OCI ARM VM + DuckDB需求规格文档（Requirements）

**版本：V1.1**
**日期：2026-10-13**
**架构基线：OCI ARM VM (12GB memory) + tdx2db + DuckDB + SQLite + Fastify + 响应式 H5 SPA**
**产品形态：单中心 Web 应用（桌面浏览器 + 手机浏览器共用一套 H5 SPA）**

> **架构决策记录**：本文档基于 2026-10-13 的架构优化讨论，**完全抛弃原 V2.5 的微信云开发 + 桌面 Node 双端架构**。新架构将全部组件塌缩到一台 OCI VM 上，数据源从 Tushare-Pro + GitHub Runner + akshare 替换为 tdx2db + DuckDB。
>
> **V1.1 更新**：加入 6 大补充设计——①分红/送转/转增交易类型（自动导入 + 收益双口径）、②指标计算位置（Node cron + 浏览器端同一份 technicalindicators）、③停牌日推断、④12 项数据校验（C1-C12）、⑤管理员角色、⑥5 段收盘时序（新增 17:01 校验 + 17:03 除权导入）。

---

## 1. 项目概述

### 1.1 系统定位

面向 A 股/ETF 个人投资者的**纯 Web 单中心投资管理工具**。全部后端组件部署在一台 OCI ARM 东京虚机上，用户通过桌面浏览器或手机浏览器直接访问 HTTPS URL。

系统仅做数据记录、行情计算、条件判断与结果展示，**不自动交易、不对接实盘券商、不构成任何投资建议**。

### 1.2 核心设计目标

| 目标 | 指标 | 说明 |
|------|------|------|
| 记账绝对精准 | 移动加权平均成本核算零计算误差，手续费口径全局唯一 | 业务规则不变，数据源变了 |
| 行情可信 | tdx2db 通达信公开数据（免费、无限流、覆盖全市场）| 替代 Tushare-Pro |
| 策略稳定 | 仅日线周期，收盘后生成终态策略信号，无盘中临时信号 | 不变 |
| 插件可扩展 | 插件化策略引擎，MVP 内置 RSI/MACD，**预留 50+ 策略扩展** | 新增 50+ 预留约束 |
| 双端一致 | 核心 TS 算法 100% 复用；桌面/手机浏览器展示结果一致 | 不变（但现在是同一套前端） |
| 极简运维 | **单 VM 运维，零 daemon，零分布式组件** | 架构核心变化 |
| 备份可靠 | 行情数据（可重建）+ 业务数据（不可重建）分级备份 | DuckDB 实际 **1.2GB**（压缩备份 ~350MB）+ SQLite 50MB；DuckDB 行情 7 天 + SQLite 业务 30 天 + OSS 90 天；**压缩后总用量 ~7.3GB，在 OSS 免费档 10GB 内** |
| 数据可信 | 三层校验保障：内部一致性（C1-C10）+ Tushare 跨源原始数据（C11）+ 东财跨源复权数据（C12） | 新增 12 项校验机制 |
| 收益透明 | **双口径收益统计**：价格收益率（前复权）+ 实际收益率（含分红送转现金流入） | 新增 |

### 1.3 架构核心约束

1. **单中心 Web 应用**：所有后端组件部署在一台 OCI ARM 东京虚机上，浏览器直接 HTTPS 访问；**无微信云开发、无桌面本地 Node 后端、无离线模式**；
2. **无 Python 运行时**：所有组件用 TypeScript/Node.js 实现；tdx2db 为预编译 Go 二进制，独立运行；东财跨源校验用 Node.js axios 直接调 HTTP 接口（不引入 Python/akshare）；
3. **仅日线周期**：移除全部分钟 K 线、多周期指标、盘中实时信号；
4. **双数据库分离**：DuckDB（行情，只读，可重建）+ SQLite（业务，可写，不可重建）；
5. **行情数据不写入云端**：行情数据全部在 OCI VM 本地 DuckDB，不经过任何外部服务；
6. **tdx2db 数据源**：每日 17:00 cron 增量更新 DuckDB；通达信公开数据，免费无限流；
7. **HTTPS 访问**：Caddy + Let's Encrypt 免费证书；**不需要 ICP 备案域名**（VM 在东京区域）。

---

## 2. 功能模块清单

| # | 模块 | MVP 范围 | 优先级 | 数据源 |
|---|------|---------|--------|--------|
| F1 | 交易记账 | **7 种交易类型**（买入/加仓/减仓/清仓 + 分红/送股/转增）；手动交易操作理由必填；分红/送转由 cron 自动导入 + 用户可手动补充（手动补充时操作理由固化为"人工补充"）；`is_auto_import` 字段区分来源；永久留痕不可物理删除 | P0 | SQLite |
| F2 | 持仓管理 | 移动加权成本聚合；成本/盈亏/收益率/仓位占比实时计算 | P0 | SQLite + DuckDB（现价） |
| F3 | 日线行情跟踪 | **前复权**日线 K 线（v_stock_qfq 直接提供）；**自动有除权除息**（通达信数据源自带） | P0 | DuckDB |
| F4 | 日线策略监控（插件化） | 覆盖**自选 + 持仓**标的；**MVP 内置 RSI/MACD 2 个插件**（默认全部启用）；**引擎预留 50+ 策略扩展**；收盘后 VM 本地生成终态信号 | P0 | SQLite + DuckDB |
| F5 | 候选跟踪池 | **MVP 先支持手动加标的**（输入代码+理由，基准价=加入日收盘价） | P1 | SQLite + DuckDB |
| F6 | 复盘统计 | **双口径收益**（价格收益率 + 实际收益率）；胜率、盈亏比、月度/季度/年度收益曲线；交易归因 | P1 | SQLite + DuckDB |
| F7 | 全市场条件选股 | **桌面 + 手机浏览器统一可用**；DuckDB OLAP 查询，秒级返回；**无灌入步骤** | P1 | DuckDB |
| F8 | 前端指标展示 | KLineChart K 线图 + technicalindicators **客户端算指标**（Node cron + 浏览器同一份库）+ 响应式布局 | P0 | DuckDB（原始 OHLCV） |
| F9 | 用户鉴权 | 简单用户名/密码 + JWT token；**user/admin 双角色** | P0 | SQLite |
| F10 | 数据质量校验 | **12 项校验**（C1-C12）：DuckDB 内部一致性 8 项 + Tushare 跨源原始数据 + 东财跨源复权数据 | P0 | DuckDB + Tushare + 东财 HTTP |
| F11 | 管理员功能 | **按需触发 tdx2db** + **查看每日校验日志**（PASS/WARN/ERROR）+ **查看 system_log fallback 日志**（SQLite 损坏时降级到文件）+ 手动备份/恢复 | P1 | SQLite（system_log）+ 纯文件 fallback（/opt/invest/logs/）|

### 2.1 In-Scope（MVP 交付）

1. **OCI VM 单中心部署**：Fastify 后端 + DuckDB + SQLite + tdx2db cron + Caddy HTTPS
2. **tdx2db 数据源**：通达信公开数据，每日 17:00 增量更新，自动前复权，自动除权除息处理
3. **响应式 H5 SPA 前端**：KLineChart K 线图 + technicalindicators 指标计算（浏览器本地），桌面多副图布局，手机 tab 切换单副图布局
4. **交易记账、持仓、移动加权成本、复盘统计**
5. **7 种交易类型**：买入/加仓/减仓/清仓 + **分红/送股/转增**；后三种由 17:03 cron 自动导入 + 用户也可手动补充（手动补充时操作理由固化为"人工补充"）
6. **除权自动导入 cron**：DuckDB raw_gbbq → SQLite 自动生成分红/送转交易记录（17:03 cron）；导入前先查是否已存在同 UUID（自动/手动），已存在则跳过，保证幂等
7. **收益双口径统计**：价格收益率（前复权，不含分红现金）+ 实际收益率（含分红现金流入，含送转市值）
8. **插件化策略引擎**：**MVP 内置 RSI/MACD 2 个默认插件**（默认全部启用）；**引擎一次性按 50+ 容量设计**（热加载、故障隔离、50ms 超时、插件分类管理）；支持安装自定义 .js 插件放入 plugins/strategies/ 目录
9. **全市场条件选股**：DuckDB OLAP 查询秒级返回；按行业/概念板块/市值/换手率/ST 状态过滤；**不需要灌入**
10. **候选跟踪池**：手动加标的 + 选股结果一键加入；基准价固化
11. **12 项数据质量校验**：C1-C10 内部一致性 + C11 Tushare 跨源原始 OHLCV（含 pre_close）+ C12 东财跨源前/后复权价；每日 17:01 cron 自动执行；结果写入 SQLite system_log 表
12. **三层完整性防线**：DuckDB 内部一致性校验（必过）+ Tushare 跨源原始数据（每日 1 次免费机会）+ 东财跨源复权数据（免费无限制）
13. **管理员角色**：首个注册用户自动 admin；admin 可手动触发 tdx2db 增量更新、查看每日校验日志（12 项）、**查看 system_log fallback 日志**、手动备份/恢复
14. **收盘后 5 段自动化**：17:00 tdx2db 更新 → **17:01 数据校验** → 17:02 信号生成 + 资产快照 → **17:03 除权自动导入** → 17:05 双库备份到 OCI Object Storage
15. **备份策略**：DuckDB 行情 7 天（可重建）+ SQLite 业务 30 天 + OSS 90 天（不可重建）；**DuckDB 实际 1.2GB，采用 COPY TO PARQUET GZIP 压缩备份至 ~350MB，压缩后总用量 ~7.3GB，在 OSS 免费档 10GB 内**
16. **用户鉴权**：简单用户名/密码 + JWT；**user/admin 双角色**；首个注册用户自动 admin（bootstrap）

### 2.2 Out-of-Scope（MVP 不交付，架构上完全排除）

以下组件**已从新架构中彻底移除**，不在任何 Phase 交付：

| # | 原架构组件 | 为什么移除 |
|---|----------|----------|
| 1 | **微信云开发**（云函数 + 云数据库） | 不需要微信小程序，OCI VM 单中心完全覆盖 |
| 2 | **微信小程序原生开发**（WXML/JS） | 用户不需要 |
| 3 | **设备绑定流程**（device_uuid ↔ openid） | 没有小程序，不需要绑定 |
| 4 | **双向增量同步链**（pull-upload） | 只有一个后端数据源，不需要同步 |
| 5 | **Tushare-Pro HTTP 采集链** | DuckDB 已有全市场日线，不依赖 Tushare |
| 6 | **GitHub Actions Runner + akshare** | DuckDB 自带除权除息 + 后复权因子，不需要独立管道 |
| 7 | **核心层 adj_factor 递推模块** | v_stock_qfq 直接提供前复权价，零转换开销 |
| 8 | **Phase4 全市场日线灌入** | DuckDB init 时通达信完整包一次到位，不需要 250 次 Tushare 循环 |
| 9 | **桌面本地 Node 后端** | 浏览器直接连 VM，不需要本地后端 |
| 10 | **桌面本地 SQLite** | 业务数据全部在 VM 的 SQLite 里 |
| 11 | **trade_cal 替代方案**（daily 返回行数 > 0） | raw_holidays 精准交易日历 |
| 12 | **行情来源切换**（模式 A/B） | 固定 tdx2db 数据源 |
| 13 | **订阅消息推送**（Phase5） | 没有小程序，不需要 |

---

## 3. 核心业务规则

### 3.1 交易与持仓记账

#### 3.1.1 交易类型（7 种，MVP 全部交付）

支持：买入、加仓、减仓、清仓 + **分红、送股、转增**。所有交易永久留痕，**不可物理删除**，仅可软删除（is_deleted=true）。

| 类型 | 操作 | 触发方式 | 操作理由默认值 | 影响持仓 |
|------|------|---------|---------------|---------|
| `buy` | 新开买入 | 用户手动 | 用户填写 | 增加数量 + 移动加权成本 |
| `add` | 加仓 | 用户手动 | 用户填写 | 增加数量 + 移动加权成本 |
| `reduce` | 减仓 | 用户手动 | 用户填写 | 减少数量（不超持仓），成本不变 |
| `clear` | 清仓 | 用户手动 | 用户填写 | 减少数量到 0，成本重置 |
| **`dividend`** | **现金分红** | **17:03 cron 自动导入 + 用户手动补充** | 自动：**"系统导入 - {ex_date} 除权除息"**<br>手动：**"人工补充 - {ex_date} 除权除息"**（固化不可改） | **不改变数量；现金流入计入实际收益** |
| **`bonus`** | **送股** | **17:03 cron 自动导入 + 用户手动补充** | 自动：**"系统导入 - {ex_date} 送股"**<br>手动：**"人工补充 - {ex_date} 送股"**（固化不可改） | **增加数量（同比例），均价不变** |
| **`transfer`** | **转增** | **17:03 cron 自动导入 + 用户手动补充** | 自动：**"系统导入 - {ex_date} 转增"**<br>手动：**"人工补充 - {ex_date} 转增"**（固化不可改） | **增加数量（同比例），均价不变** |

**`is_auto_import` 字段**：user_trade_record 表新增布尔字段，`true`=cron 自动导入，`false`=用户手动（含手动补充的 dividend/bonus/transfer）。用于前端 UI 标签显示 + 风险排查。

**自动导入兜底**：绝大多数除权事件由 cron 自动导入（DuckDB raw_gbbq → SQLite），用户不需要手动添加。如果自动导入遗漏或失败（raw_gbbq 缺失 / 网络问题），用户可手动补充；管理员也可在设置页手动触发除权导入补跑。

**幂等规则**：cron 自动导入时，UUID = `auto_{user_id}_{symbol}_{ex_date}_{type}`（固定格式）。如果 SQLite 已存在同 UUID 记录（不管是之前 cron 导入的还是用户手动补的），则跳过不重复写入。

#### 3.1.2 强制业务约束

每笔**手动交易**分两类处理：

- **buy / add / reduce / clear**：用户**必须填写操作理由 trade_reason**（UI 强制校验 + 服务端二次校验），不允许留空
- **dividend / bonus / transfer（用户手动补充）**：操作理由**由系统固化写入**，格式 `"人工补充 - {ex_date} {type}"`，前端表单中操作理由字段**置灰不可编辑**，用户只填除权日、分红金额/送转比例等数值字段

cron 自动导入的 dividend/bonus/transfer：操作理由由系统标注 `"系统导入 - {ex_date} {type}"`，`is_auto_import=true`。

**减仓/清仓持仓充足性校验（服务端强制）**：减仓/清仓数量不得超过当前实际持仓（SQLite 实时聚合）：
- 前端预校验：减仓数量 > 当前持仓 → 禁用提交按钮
- 服务端校验：Fastify API 在写入前聚合校验；校验失败返回 `HOLDING_INSUFFICIENT` 错误
- 校验目的：交易永久留痕不可物理删除，负持仓脏数据一旦写入将永久污染聚合结果

**复盘补充字段（交易后填写，非必填）**：每笔交易记录预留 4 个复盘字段，交易录入时留空，**复盘时由用户手动填写**：
- `review_summary`：复盘总结（做对/做错的地方）
- `system_followed`：是否符合交易系统（三态：true/false/null）
- `is_stop_loss`：是否止损（三态：true/false/null）
- `remark`：备注

#### 3.1.3 持仓成本与手续费口径

1. **成本算法**：移动加权平均法，全系统统一
2. **买入手续费**：计入总成本、摊薄平均成本
3. **卖出手续费**：仅抵扣本次卖出盈亏，**不影响剩余持仓成本**
4. **送转股处理**：bonus/transfer 类型交易**只增加持仓数量**，avg_cost 不变（同比例稀释）
5. **分红处理**：dividend 类型交易**不改变持仓数量和成本**，现金流入单独计入实际收益统计
6. **持仓数据由交易记录实时聚合计算**，不冗余存储快照

**移动加权平均成本公式**：
```
新均价 = (原持仓数 × 原均价 + 买入数 × 买入价 + 买入手续费) / (原持仓数 + 买入数)
```

**边界 case 处理**：
- 减仓/清仓：只减少持仓数量，avg_cost 不变
- 减仓/清仓数量 > 当前持仓 → **服务端拒绝保存**（HOLDING_INSUFFICIENT）
- 清仓后再买：均价重置为首次买入价
- 持仓数为 0 时买入：等同于首次建仓
- 送转后再买入：送转数量计入"原持仓数"，加权正常计算
- 分红后再买入：分红不影响成本

#### 3.1.4 收益统计口径（双口径，复盘页可切换）

**口径 1：价格收益率（默认，技术分析参考）**
```
价格收益率 = (现价市值 - 原始投入成本) / 原始投入成本
```
- 数据源：DuckDB v_stock_qfq 前复权价
- **不含分红现金流入**
- 通达信数据源自动处理除权除息，前复权价天然连续
- 适合看价格波动、技术信号触发时的盈亏

**口径 2：实际收益率（新增，用户关心的真实收益）**
```
实际收益率 = (现价市值 + 累计分红现金流入 + 送转后新增市值 - 原始投入成本) / 原始投入成本
```
- 数据源：价格收益率 + SQLite dividend/bonus/transfer 交易记录
- **包含所有分红现金流入 + 送转后的市值变化**
- 最接近证券账户 App 显示的实际盈亏

### 3.2 日线时序数据架构

#### 3.2.1 行情数据源

**唯一行情源**：tdx2db + 通达信公开数据，写入 DuckDB。

| 维度 | 说明 |
|------|------|
| 数据来源 | 通达信公开日线（opentdx 协议 + 日线数据完整包） |
| 采集频率 | 每日 17:00 cron 增量更新 |
| 不复权日线 | `raw_kline_daily` 表 |
| 直接前复权 | `v_stock_qfq` / `v_etf_qfq` 视图（QUANTAXIS 算法，与通达信/雪球一致） |
| 后复权因子 | `raw_adjust_factor` 表（自动计算） |
| 除权除息 | `raw_gbbq` 表（通达信股本变迁数据） |
| 交易日历 | `raw_holidays` 表（精准，免费可用） |
| 行业/概念/板块 | `raw_tdx_blocks_info` + `raw_tdx_blocks_member` |
| 市值/换手率 | `raw_basic_daily` 表 |
| 品种分类 | `raw_symbol_class`（stock/index/etf） |
| 免费/限流 | **完全免费，无限流** |

#### 3.2.2 不复权 vs 前复权

**核心简化**：DuckDB 的 `v_stock_qfq` / `v_etf_qfq` 视图直接提供前复权日线，策略插件消费前**零转换开销**。核心层不再需要 adj_factor 递推模块。

#### 3.2.3 停牌日信息

tdx2db 没有专门的停牌表，通过推断获得：

```sql
-- 停牌日 = raw_holidays 标记为交易日（is_trading_day=1）
--          但 raw_kline_daily 没有对应日线
--          （或者 close=0 + volume=0 的占位行）

SELECT h.trade_date
FROM raw_holidays h
WHERE h.is_trading_day = 1
  AND h.trade_date NOT IN (
    SELECT trade_date FROM raw_kline_daily 
    WHERE symbol = ? AND close > 0 AND volume > 0
  );
```

**策略引擎对停牌的处理**：停牌日没有新的日线数据 → 插件 execute() 拿到的 DailyBar[] 最后一根是停牌前 → **状态机自然维持，不生成新信号**。不需要硬编码停牌日跳过逻辑。

### 3.3 策略引擎规则（插件化，50+ 预留）

#### 3.3.1 插件接口契约

```typescript
interface StrategyPlugin {
  /** 插件唯一标识，全系统唯一，不可变 */
  readonly id: string;
  /** 插件展示名称 */
  readonly name: string;
  /** 版本号（语义化） */
  readonly version: string;
  /** 插件作者/来源 */
  readonly author: string;
  /** 周期：MVP 固定 "daily" */
  readonly period: "daily";
  /** 插件分类：monitor（监控类）/ filter（筛选类） */
  readonly category: "monitor" | "filter";
  /** 插件归属（UI 分组用，50+ 插件后必须有） */
  readonly sub_category: "momentum" | "trend" | "volume" | "breakout" | "mean_reversion" | "pattern" | "custom";
  /** 执行复杂度（日志统计用，不是硬约束） */
  readonly complexity: "simple" | "medium" | "complex";
  /** 参数 Schema（Web 页面动态渲染配置表单） */
  readonly paramSchema: ParamField[];
  /** 默认参数值 */
  readonly defaultParams: Record<string, any>;
  /** 图表渲染元数据（新增，前端 KLineChart 渲染用） */
  readonly chartOverlay?: ChartOverlayConfig;
  /**
   * 核心计算方法
   * @param dailyData 日线序列（**前复权价**，直接来自 DuckDB v_stock_qfq）
   * @param params 用户配置的参数
   * @returns 信号对象；返回 null 表示"无信号"
   */
  execute(dailyData: DailyBar[], params: Record<string, any>): StrategySignal | null;
}

interface DailyBar {
  trade_date: string;   // yyyy-MM-DD
  open: number;         // 前复权价（直接来自 DuckDB）
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

interface StrategySignal {
  direction: "buy" | "sell" | "hold";
  label: string;
  strength?: number;
  metrics?: Record<string, number>;
}
```

#### 3.3.2 指标计算位置（服务端 + 浏览器同一份库）

**同一个 technicalindicators npm 包，两处计算，数值一致**：

| 位置 | 场景 | 时机 | 数据库 |
|------|------|------|--------|
| **Fastify cron 17:02** | 每日收盘后自动生成终态信号 | 17:02 批量执行 | SQLite（写入 user_strategy_signal） |
| **浏览器 KLineChart** | 用户交互式探索指标参数 | 页面加载 / 用户改参数时 | 浏览器本地（不写数据库） |

**保证数值一致**：两者调用 technicalindicators 包里**同一个 RSI/MACD.calculate 函数**。

#### 3.3.3 插件目录与加载机制

| 规则 | 说明 |
|------|------|
| **内置插件库** | 打包在 `@invest/core` 包内，开箱即用；**MVP 仅 rsi + macd_cross（默认全部启用）**；**引擎按 50+ 容量设计**（sub_category 分类、complexity 标记、chartOverlay 元数据） |
| **用户自定义插件** | 放置在 VM 上 `/opt/invest/plugins/strategies/`，**仅支持 .js**；直接 require() 加载 |
| **加载时机** | Fastify 启动时扫描加载；Web 页面【设置 → 策略插件管理】可手动触发热重载 |
| **唯一键** | 以 `plugin.id` 为唯一键；内置插件与自定义插件 id 不可冲突 |
| **故障隔离** | 单个插件 execute() 抛异常 → catch 后标记该插件本轮跳过、记录 ERROR 日志、**不影响其他插件和主流程** |
| **超时保护** | 单插件 execute() **硬限制 50ms**（Promise.race + reject）；超时标记为 PLUGIN_TIMEOUT，跳过本轮 |
| **批量调度** | 收盘信号生成时，同一标的的日线数据**一次查询、多插件共享**（避免 N 次 DuckDB 查询） |

#### 3.3.4 内置默认插件清单

**MVP 内置（2 个，默认启用，引擎按 50+ 容量设计）**

| 插件 ID | 分类 | sub_category | 名称 | 默认参数 | 信号触发逻辑 | chartOverlay |
|---------|------|-------------|------|---------|------------|--------------|
| `rsi` | monitor + filter | momentum | RSI(14) 超买超卖 | period=14, oversold=30, overbought=70 | RSI < oversold → buy；RSI > overbought → sell | sub + 超买超卖阈值线 |
| `macd_cross` | monitor | trend | MACD 金叉死叉 | fast=12, slow=26, signal=9 | DIF 上穿 DEA → buy；下穿 → sell | sub + DIF/DEA/柱状图 |

#### 3.3.5 信号状态机与收盘固化

1. 监控覆盖范围：**自选 + 持仓**标的全集并集（去重，排除软删除关联）
2. 以「标的 + 插件 id + 周期」为独立状态单元
3. 仅状态由不满足→满足瞬间生成一次信号，持续满足不刷屏
4. 日线行情数据异常时**不改变状态、不发假信号**
5. 信号**收盘后直接生成终态 is_final=1**（无盘中临时态，MVP 不做分钟级防抖）
6. **写入前置条件**：17:02 cron 必须等 17:00 tdx2db 完成后才触发；从 DuckDB `v_stock_qfq` 批量查前复权日线（已由 tdx2db cron 写入完毕）
7. **单日唯一索引防重**：单日同一标的 + 同一插件仅留存一条有效信号，靠 SQLite `UNIQUE(user_id, asset_code, plugin_id, trade_date)` 联合唯一索引天然防重；**不需要进程内存防抖 Map**
8. **收盘固化**：每日收盘后固化当日所有终态策略信号，用于复盘统计、胜率计算；杜绝单日多条重复信号干扰复盘归因

> **为什么砍掉 10min 防抖？** 防抖是给盘中实时数据（秒级 tick、分钟级 K 线）用的，防止临时数据抖动导致信号频繁切换。日线收盘数据每天只有 1 次，不存在抖动可能。防单日重复信号靠数据库唯一索引就够了。

### 3.4 筛选与跟踪池

1. 独立于自选列表，用于评估选股策略胜率与稳定性
2. **MVP 支持手动加标的**：输入标的代码 + 加入理由即生成跟踪记录；基准价 = 加入日前复权收盘价
3. 每次筛选/加入固化「基准价」，同一标的多次跟踪生成多条独立记录
4. 迁移自选：复用基准价 / 使用当前现价二选一；MVP 迁移自选时**只打标记**，不自动创建自选关联

### 3.5 行情数据质量

| 规则 | MVP 处理 |
|------|---------|
| 主键天然去重 | DuckDB 主键 = (asset_code, trade_date)，天然幂等 |
| 停牌日推断 | `raw_holidays.is_trading_day=1` 但 `raw_kline_daily` 无数据 → 停牌；策略引擎自然维持状态 |
| 交易日判定 | **raw_holidays 精准判定** |
| 退市/ST 过滤 | raw_symbol_class.is_listing + is_st 字段 |
| 除权除息 | tdx2db 原生处理，v_stock_qfq 自动前复权；raw_gbbq 供除权自动导入 cron 使用 |
| 行业/板块过滤 | raw_tdx_blocks_info + raw_tdx_blocks_member |
| 免费/限流 | **完全免费，无限流** |

### 3.6 数据质量校验（12 项，每日 17:01 cron 自动执行）

#### C1-C10：DuckDB 内部一致性校验（必过，SQLite system_log 写结果）

| # | 校验项 | 检查方式 | 失败级别 | 自动处理 |
|---|--------|---------|---------|---------|
| C1 | 日线行数正常 | 当日标的数 ≥ 3000（正常 5000+）| ERROR | 自动触发 tdx2db update 补跑 |
| C2 | 交易日历匹配 | is_trading_day=1 的日期有日线 | ERROR | 自动触发 tdx2db update + raw_holidays 重下 |
| C3 | 复权因子更新时间 | raw_adjust_factor 最新日期 = 当日 | WARN | 自动触发 tdx2db update 补跑 |
| C4 | 除权除息更新时间 | raw_gbbq 最新 ex_date ≥ 当日 - 7 天 | WARN | 自动触发 tdx2db update 补跑 |
| C5 | 板块数据完整 | raw_tdx_blocks_member 总量稳定（降幅 < 10%）| WARN | 记录，人工确认 |
| C6 | 市值数据存在 | raw_basic_daily 当日标的数 ≥ 3000 | WARN | 自动触发 tdx2db update 补跑 |
| C7 | 日线价格合理性 | close ≠ 0 AND open ≤ close × 2 | WARN | 记录异常标的 |
| C8 | tdx2db 执行时长 | systemd timer 日志 ≤ 120s | WARN | 记录 |
| C9 | **复权因子数学一致性** | v_stock_qfq.close ≈ raw_kline_daily.close × raw_adjust_factor.factor（抽样 100 只，容差 < 0.01 元）| ERROR (>0.1) / WARN (0.01-0.1) | ERROR 触发 tdx2db update 补跑 |
| C10 | **除权日事件交叉验证** | 除权日价格跳变率 ≈ raw_gbbq 事件参数（现金分红 + 送转比例）| WARN | 记录，人工确认 |

#### C11-C12：跨源校验（外部数据源，免费/低频）

| # | 校验项 | 数据源 | 抽样 | 容差 | 失败级别 |
|---|--------|--------|------|------|---------|
| C11 | **Tushare 跨源原始数据** | Tushare free `daily(trade_date)`（每日 1 次免费机会，含 pre_close） | 30 只 | OHLC 完全一致或 <0.01 元；volume <1%；pre_close 合理 | >3 只不匹配 → WARN；>5 只 → ERROR |
| C12 | **东财跨源复权数据** | 东方财富 HTTP（Node.js axios 直接调，不引入 Python/akshare） | 20 只 | 前复权 close <0.02 元；后复权相对差异 <0.5% | >5 只有差异 → WARN；>1 只差异 >0.1 元 → ERROR |

**东财 HTTP 接口协议**：直接调东财公开接口 `https://push2his.eastmoney.com/api/qt/stock/kline/get`，参数 `fqt=1`（前复权）/ `fqt=2`（后复权）。Node.js axios 直接 fetch，不需要 Python/akshare。

**C12 鲁棒性策略**：
- 请求节流：每只标的之间 sleep 500ms
- 有限重试：每只最多 2 次（退避 1s + 3s）
- 失败类型拆分：ConnectionError → 跳过；HTTP 403/418（被限流）→ 跳过
- 上限保护：20 只 × 2 复权口径 = 40 次 HTTP；总耗时 ≤ 30s
- 超时保护：单标的请求 10s
- 降级：东财整体不可用（连续 5 只失败）→ C12 标记 SKIP，写 INFO 日志

#### 三层完整性防线

```
第一层：DuckDB 内部一致性（C1-C10，必过）
第二层：Tushare 跨源原始数据（C11，每日 1 次免费机会，校验不复权 OHLCV + pre_close）
第三层：东财跨源复权数据（C12，免费无限制，校验前复权 + 后复权价）
三层全过 → tdx2db 数据可信
任何一层 ERROR → 自动触发 tdx2db update 补跑 + 人工确认
```

### 3.7 鉴权规则（双角色）

| 角色 | 权限 |
|------|------|
| **user**（普通用户，默认）| 交易、持仓、行情、信号、选股、复盘、候选池、插件管理、**查看校验结果（只读）**|
| **admin**（管理员）| user 全部权限 + **按需触发 tdx2db 增量更新** + **查看每日校验日志详情** + **查看 system_log fallback 日志** + **手动备份** + **恢复备份** + **升级/降级其他用户角色** |

**bootstrap 逻辑**：首个注册的用户自动成为 admin。后续注册默认 role='user'。admin 可在设置页升级/降级角色。

**MVP 鉴权实现**：
- 用户名 + 密码（bcrypt hash）
- JWT token（有效期 7 天，刷新 token 30 天）
- 登录后所有 API 请求 header 带 `Authorization: Bearer <token>`
- 管理员 API（/api/admin/*）需要额外检查 role='admin'
- VM 防火墙只开放 HTTPS 443 和 SSH 22

---

## 4. 核心业务流程

### 4.1 每日收盘自动化时序（5 段，完整）

```
时间线（东京时区，UTC+9）：

  17:00  tdx2db cron（VM 本地）
         ├── 增量更新日线（raw_kline_daily）
         ├── 更新后复权因子（raw_adjust_factor）
         ├── 更新股本变迁（raw_gbbq）
         ├── 更新假期日历（raw_holidays）
         └── 更新板块/概念/行业（raw_tdx_blocks_*）
         → DuckDB 文件更新完毕
         → 耗时 ≈ 30-60s

  17:01  Fastify 内部 cron（数据校验，**新增**）
         ├── C1-C10 内部一致性校验（DuckDB SQL，秒级）
         ├── C11 Tushare 跨源原始数据（30 只抽样）
         ├── C12 东财跨源复权数据（20 只抽样，含节流）
         ├── 结果写入 SQLite system_log 表（12 条记录，每条含 PASS/WARN/ERROR）
         ├── WARN 级别自动处理：C3/C4/C6 → 自动触发 tdx2db update 补跑
         └── ERROR 级别：记录 + 管理员设置页告警
         → 耗时 ≈ 10-60s（含 C11/C12 网络请求，取决于节流速度）

  17:02  Fastify 内部 cron（信号生成 + 资产快照）
         ├── Step 1: SQLite 查所有用户自选+持仓标的并集
         ├── Step 2: DuckDB v_stock_qfq 批量查前复权日线
         ├── Step 3: 加载所有启用的 monitor 插件
         ├── Step 4: 批量 execute() × 状态机 → 终态信号
         └── Step 5: SQLite 批量写入信号表 + 资产快照
         → 耗时 ≈ 5-15s

  17:03  Fastify 内部 cron（除权自动导入，**新增**）
         ├── Step 1: DuckDB raw_gbbq 查最近除权事件
         ├── Step 2: 对每条事件，判断用户是否在除权日持股
         ├── Step 3: 生成 dividend/bonus/transfer 交易记录
         ├── Step 4: SQLite 写入（操作理由自动标注"系统导入"）
         └── Step 5: 用 UUID 幂等（'auto_{symbol}_{ex_date}_{type}'）
         → 耗时 ≈ 2-5s（绝大多数日子没有除权事件，秒级跳过）

  17:05  Fastify 内部 cron（备份）
         ├── DuckDB: **COPY TO PARQUET GZIP 压缩导出**（实际 1.2GB → ~350MB，列式压缩率 3-5x）
         ├── SQLite: WAL checkpoint + VACUUM INTO + integrity_check（~50MB，直接 cp 已够小）
         └── 上传到 OCI Object Storage（business 30 天 + market 7 天；Lifecycle Policy 自动清理）
         → 耗时 ≈ 20-30s（DuckDB 压缩 ~15-20s + 上传 ~5s；比之前直接 cp 慢但可接受）
```

### 4.2 交易记账流程

**buy / add / reduce / clear（手动）**：
1. 用户在浏览器输入交易信息，**操作理由必填**（UI 不允许空值）
2. 前端参数校验（减仓/清仓不超持仓、操作理由非空）
3. 请求 Fastify API：`POST /api/trade/add`
4. Fastify 服务端二次校验：持仓充足性（减仓/清仓）、操作理由非空
5. SQLite 事务：写入交易记录 + 更新 user_asset_rel avg_cost（移动加权）
6. 校验失败 → 返回 HOLDING_INSUFFICIENT 或 TRADE_REASON_REQUIRED → 前端 Toast

**dividend / bonus / transfer（用户手动补充）**：
1. 用户在浏览器选"除权补充"入口，输入标的代码 + 除权日 + 金额/比例
2. 前端校验（标的必须在自选/持仓里、除权日格式）
3. 请求 Fastify API：`POST /api/trade/add`（同一路由，trade_type=dividend/bonus/transfer）
4. Fastify 服务端自动填充：操作理由 `"人工补充 - {ex_date} {type}"`（固化不可改）+ `is_auto_import=false` + UUID（避免和 cron 冲突用 `manual_{user}_{symbol}_{ex_date}_{type}`）
5. SQLite 写入（独立事务，不与主业务混用）
6. 前端 UI 标签显示"人工补充"（灰色标签）

**dividend / bonus / transfer（cron 自动导入，17:03）**：
见 4.3 节。自动导入的记录 `is_auto_import=true`，操作理由 `"系统导入 - {ex_date} {type}"`，前端 UI 标签显示"系统导入"（绿色标签）。

### 4.3 除权自动导入流程（17:03 cron）

1. Fastify cron 17:03 触发
2. DuckDB raw_gbbq 查最近除权事件（`ex_date > 用户最后一次除权导入日期`）
3. 对每条事件，查所有持有该标的的用户
4. 计算用户除权日前一日的持仓数量（SQLite 交易历史聚合）
5. 生成交易记录：
   - `dividend`：数量=0，price=0，**现金流入=持仓数 × cash_per_share**（单独计入实际收益）
   - `bonus`：数量=持仓数 × bonus_ratio，price=0，**同比例稀释**（avg_cost 不变）
   - `transfer`：数量=持仓数 × transfer_ratio，price=0，**同比例稀释**
6. **幂等检查（关键）**：写入前先查 SQLite 是否已存在 `symbol + ex_date + trade_type` 相同的记录（不管是之前 cron 导入的 `auto_*` UUID 还是用户手动补的 `manual_*` UUID），已存在则跳过，避免重复写入
7. SQLite 写入：UUID=`'auto_{user_id}_{symbol}_{ex_date}_{type}'`，操作理由 `"系统导入 - {ex_date} {type}"`，`is_auto_import=true`
8. 写入完成后更新用户的"最后除权导入日期"游标（避免下次重复扫描历史 raw_gbbq）

### 4.4 日线策略信号生成流程

1. **17:02 Fastify cron 触发**
2. SQLite 查所有用户的自选 + 持仓标的并集
3. DuckDB v_stock_qfq 批量查前复权日线
4. 内存构建 DailyBar[] + 插件 params
5. 遍历 monitor 插件：execute() → 状态机 → 决定是否写信号
6. SQLite 批量写入（1 个大事务），唯一索引防重

### 4.5 全市场选股流程

1. 用户选择筛选插件 + 参数
2. Fastify `POST /api/stockscan`
3. DuckDB OLAP 查询：v_stock_qfq + raw_tdx_blocks_member + raw_symbol_class + raw_basic_daily
4. 返回 ≤ 100 条结果，支持分页
5. 用户可 [加入候选池] 或 [加入自选]

### 4.6 管理员手动触发 tdx2db

1. admin 在设置页点击 [🔄 立即触发增量更新]
2. Fastify 执行 `/opt/tdx2db/tdx2db update`（最多等待 180s）
3. 更新成功 → **立即触发** 17:01 校验 + 17:02 信号生成 + 17:03 除权导入
4. 结果写入 system_log，前端轮询/推送显示进度
5. 今日已执行过且成功 → 返回"今天已更新"，需要管理员确认重新执行

---

## 5. 数据模型（双数据库）

### 5.1 DuckDB（行情层，只读，可重建）

tdx2db 原生表，不做任何 schema 变更。核心表：

| 表/视图 | 说明 |
|---------|------|
| v_stock_qfq / v_etf_qfq | 直接前复权日线视图 |
| v_stock_hfq / v_etf_hfq | 直接后复权日线视图 |
| raw_kline_daily | 不复权日线原始表 |
| raw_adjust_factor | 后复权因子 |
| raw_holidays | 假期日历（精准交易日判定）|
| raw_basic_daily | 前收盘价/换手率/市值/成交额 |
| raw_gbbq | 股本变迁（除权除息事件，含 cash_per_share / bonus_ratio）|
| raw_symbol_class | 品种分类（stock/index/etf/is_st/is_listing）|
| raw_tdx_blocks_info | 行业/概念/板块定义 |
| raw_tdx_blocks_member | 板块成分关系 |

### 5.2 SQLite（业务层，可写，不可重建）

| 表 | 说明 | 关键约束 |
|----|------|---------|
| user_account | 用户账号 | **role TEXT DEFAULT 'user' CHECK (role IN ('user','admin'))** |
| user_trade_record | 交易记录 | trade_type 扩展为 7 种（buy/add/reduce/clear/dividend/bonus/transfer）+ **is_auto_import INTEGER NOT NULL DEFAULT 0**（0=用户手动含手动补充除权，1=cron 自动导入）|
| user_asset_rel | 用户-标的关联（watch/hold/candidate）| UNIQUE(user_id, asset_code, rel_type) |
| user_strategy_signal | 策略信号 | UNIQUE(user_id, asset_code, plugin_id, trade_date) + 4 个查询索引 |
| user_plugin_config | 插件配置 | UNIQUE(user_id, plugin_id) |
| user_candidate_pool | 候选跟踪池 | idx_candidate_user_date |
| user_asset_stat | 资产快照（双口径可选） | UNIQUE(user_id, trade_date) |
| **system_log** ⭐ 新增 | **系统日志（校验/更新/备份）** | **idx_system_log_date(type, level)** |

#### 交易类型 CHECK 约束更新

```sql
-- 原来 4 种 → 现在 7 种
trade_type TEXT NOT NULL CHECK (
  trade_type IN ('buy', 'add', 'reduce', 'clear', 'dividend', 'bonus', 'transfer')
)

-- 新增：区分自动导入 vs 用户手动（含手动补充除权）
is_auto_import INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_import IN (0, 1))
-- 0 = 用户手动（buy/add/reduce/clear/dividend/bonus/transfer 手动补充）
-- 1 = cron 自动导入（仅 dividend/bonus/transfer，17:03 cron 执行）
```

#### system_log 表（新增）

```sql
CREATE TABLE IF NOT EXISTS system_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_date TEXT NOT NULL,       -- 执行日期 yyyy-MM-DD
  log_type TEXT NOT NULL CHECK (
    log_type IN ('tdx2db_update', 'datacheck', 'signal_generate', 
                 'dividend_import', 'backup')
  ),
  level TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'ERROR', 'SKIP')),
  check_item TEXT,              -- 校验项 C1/C2/.../C12（仅 datacheck 有）
  message TEXT NOT NULL,
  detail TEXT,                  -- JSON 详细数据
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_system_log_date 
  ON system_log(log_date, log_type, level);
```

#### 信号表索引（针对 50+ 插件优化）

```sql
CREATE TABLE user_strategy_signal (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  asset_code TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_category TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  direction TEXT NOT NULL,
  is_final INTEGER DEFAULT 1,
  metrics_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(user_id, asset_code, plugin_id, trade_date)
);
-- 4 个高频查询索引
CREATE INDEX idx_signal_user_date ON user_strategy_signal(user_id, trade_date DESC);
CREATE INDEX idx_signal_user_plugin ON user_strategy_signal(user_id, plugin_id, trade_date DESC);
CREATE INDEX idx_signal_user_asset ON user_strategy_signal(user_id, asset_code, trade_date DESC);
CREATE INDEX idx_signal_user_dir_date ON user_strategy_signal(user_id, direction, trade_date DESC);
```

---

## 6. 非功能性需求

### 6.1 性能需求

| 指标 | 目标 | 说明 |
|------|------|------|
| 首屏加载 | ≤1.5s | Fastify <100ms + 浏览器渲染 + KLineChart |
| Fastify API 常规 | ≤200ms | SQLite WAL + DuckDB 缓存 |
| 全市场选股 | ≤3s | DuckDB OLAP |
| 信号生成（50 插件 × 30 标的）| ≤20s | 17:02 cron |
| 数据校验（C1-C12）| ≤60s | C11/C12 含网络请求 |
| 除权自动导入 | ≤5s | 绝大多数日子秒级跳过 |
| 备份 | ≤30s | DuckDB 1.2GB **压缩备份 ~350MB** + SQLite ~50MB + OSS 上传 |

### 6.2 可用性需求

1. **VM 不可用**：页面显示"服务暂不可用"
2. **单插件故障隔离**：单插件异常不中断其他插件
3. **数据自愈**：DuckDB 缺失 → 次日 tdx2db 覆盖；SQLite 损坏 → OSS 备份恢复
4. **校验失败自愈**：C3/C4/C6 WARN → 自动触发 tdx2db update 补跑
5. **东财校验降级**：东财整体不可用 → C12 标记 SKIP，不阻塞

### 6.3 安全需求

| # | 要求 |
|---|------|
| 1 | HTTPS 强制（Caddy + Let's Encrypt）|
| 2 | VM 防火墙只开放 443 + 22 |
| 3 | 密码 bcrypt hash |
| 4 | JWT HS256，7 天有效期 |
| 5 | SQLite 600 权限；DuckDB 644 只读 |
| 6 | 日志脱敏（金额、用户 ID 末 4 位）|
| 7 | 管理员 API 需要 role='admin' 双重检查 |
| 8 | 插件沙盒：MVP 靠约定 + 50ms 超时；V2 VM2 硬隔离 |

### 6.4 合规需求

1. 全局 UI 标注"本工具不构成投资建议，数据仅供参考"
2. 不收集手机号、位置等多余隐私
3. 不做预测、荐股类文案
4. 插件禁止包含荐股、资金托管、实盘对接功能（MVP 靠约定 + 人工审计）

---

## 7. MVP 迭代规划（4 Phase，每 Phase 交付可运行闭环）

### Phase 1：基础底座 + 引擎骨架（只交付空壳，不含业务逻辑）

| 内容 | 交付物 |
|------|--------|
| 项目脚手架 | npm workspaces monorepo（packages/core + apps/backend + apps/web） |
| DuckDB 初始化 | OCI VM 上 tdx2db init（20 分钟拉通达信日线完整包） |
| SQLite 建表 DDL（幂等） | user_account（role 字段）+ user_trade_record（7 种 trade_type CHECK）+ user_asset_rel（UNIQUE 三列）+ user_strategy_signal（4 个查询索引）+ user_plugin_config + user_candidate_pool + user_asset_stat + **system_log** |
| Fastify 后端骨架 | 鉴权中间件（bcrypt + JWT）+ 角色检查（user/admin）+ 注册/登录 API + **管理员 API 路由骨架** |
| user_account role bootstrap | 首个注册自动 admin；后续默认 role='user' |
| **插件引擎完整骨架**（50+ 容量设计）| StrategyPlugin 接口（含 sub_category/complexity/chartOverlay）+ 热加载 + 50ms 超时（Promise.race）+ try-catch 故障隔离 + **插件安全约束**（禁止 global/process/require + 参数双重校验） |
| 内置 RSI + MACD 插件 | technicalindicators 库 + chartOverlay 元数据 |
| **数据校验骨架**（C1-C12 框架）| C1-C8 内部一致性 SQL 模板 + C9/C10 校验逻辑 + C11/C12 外部调用框架 |
| Caddy HTTPS 部署脚本 | Let's Encrypt 免费证书 + 443 反代 Fastify |
| OCI VM systemd 基础 | Fastify service + tdx2db timer（17:00）+ VM 防火墙（仅开 443 + 22）|
| OCI Object Storage bucket | business + market 两个 bucket + Lifecycle Policy（business 90 天 / market 7 天）|

### Phase 2：后端业务闭环（交易 + 持仓 + 算法 + system_log 三层保护）

| 内容 | 交付物 |
|------|--------|
| **@invest/core 算法层** | DailyBar（直接消费 DuckDB v_stock_qfq 前复权价）+ 移动加权成本（含送转稀释）+ 7 种交易类型处理 + 双口径收益计算 + 策略引擎状态机核心（唯一索引防重 + 状态切换瞬间写信号）|
| user_asset_rel CRUD API | 自选（watch）+ 持仓（hold）+ 候选池（candidate）关联的增删查 |
| 交易记账 API（7 种类型全部暴露）| POST /api/trade/add（buy/add/reduce/clear，操作理由必填 + 服务端 HOLDING_INSUFFICIENT 校验）+ POST /api/trade/add（dividend/bonus/transfer，用户手动补充，操作理由固化 `"人工补充 - {ex_date} {type}"`，`is_auto_import=false`）+ 自动导入 dividend/bonus/transfer 写入路径（17:03 cron 执行，UUID=`auto_{user}_{symbol}_{ex_date}_{type}` 幂等，已存在则跳过，`is_auto_import=true`）|
| 持仓实时聚合 | user_asset_rel 从 trade_record 实时聚合 avg_cost + 数量，不冗余快照 |
| **system_log 三层保护** | writeSystemLog() 统一入口：独立事务写 SQLite system_log → 失败降级到 /opt/invest/logs/system_log_YYYY-MM-DD.log（JSON Lines，appendFileSync）→ console.error 最后兜底；SQLite 正常写时只写 SQLite，不写文件（不会两边都写）|
| 除权自动导入 cron 逻辑 | 查 DuckDB raw_gbbq → 判断用户持股 → 生成 dividend/bonus/transfer 交易记录（UUID='auto_{user}_{symbol}_{ex_date}_{type}' 幂等）|
| 信号生成逻辑 | Fastify cron 框架内：DuckDB v_stock_qfq 批量查前复权日线 → 插件 execute() × 状态机 → SQLite 批量写入 |

### Phase 3：H5 SPA + 5 段 cron + 校验完整实现

| 内容 | 交付物 |
|------|--------|
| 响应式 H5 SPA 骨架 | React + Vite + 路由（登录/持仓/K线/选股/复盘/设置）+ 登录页 |
| 持仓页 | 总资产/盈亏/收益率 + 资产组成饼图 + 持仓卡片列表 + [新增交易] 按钮 |
| K 线详情页 | **KLineChart**（klinecharts MIT，~150KB）默认前复权 + MA(5/10/20/60) + MACD/RSI/KDJ 副图 tab 切换 + **策略信号标记**（买入绿色▲/卖出红色▼）+ **浏览器端 technicalindicators**（改 RSI 参数即时重绘，零网络请求）|
| 交易录入弹窗 | 7 种类型完整表单 + 预设标签快捷填充（买入类/卖出类动态按钮）+ 预估新均价实时计算 + 减仓超持仓变红色禁用提交 |
| **交易复盘 4 字段编辑** | 复盘页点击交易记录 → 弹窗填写 review_summary/system_followed（三态 true/false/null）/is_stop_loss（三态）/remark + 列表标签颜色（未复盘=灰色/系统信号=绿色/主观决策=橙色/止损=红色叠加）|
| 管理员校验仪表盘 | 设置页 12 项校验结果（PASS/WARN/ERROR/SKIP 四色）+ 点详情展开 JSON |
| **完整 5 段 cron 打通** | 17:00 tdx2db（systemd timer）→ 17:01 数据校验（C1-C10 DuckDB SQL + C11 Tushare 30 只跨源 pre_close + C12 东财 20 只跨源 500ms 节流 axios）→ 17:02 信号生成 + 资产快照 → 17:03 除权自动导入 → 17:05 双库备份 |

### Phase 4：选股 + 候选池 + 备份 + 管理员功能 + MVP 验收

| 内容 | 交付物 |
|------|--------|
| 全市场条件选股 | DuckDB OLAP 查询（≤3s）+ 标的类型过滤（股票/ETF）+ 筛选插件下拉（动态 paramSchema 渲染）+ 公共过滤（排除 ST/成交额下限/行业）+ [全部加入候选池] |
| 候选池 | 手动加标的（代码 + 理由 + 基准价固化）+ 选股结果一键加入 + **候选池→自选迁移**（复用基准价 / 使用现价二选一，原跟踪记录保留不覆盖）|
| 双库备份 + OSS | **DuckDB COPY TO PARQUET GZIP 压缩备份**（1.2GB → ~350MB）+ SQLite WAL checkpoint + VACUUM INTO + integrity_check（不压缩 ~50MB）+ oci os object put 上传 + Lifecycle Policy 自动清理 |
| 管理员手动触发 tdx2db | POST /api/admin/tdx2db/trigger → 顺序跑 tdx2db → 校验 → 信号 → 除权导入 + 进度轮询 |
| 管理员日志查看 | GET /api/admin/system_log（分页 + 日期过滤）+ **GET /api/admin/logs/fallback**（SQLite 写失败降级时查看文件列表 + 最新 200 行）|
| MVP 验收 | Requirements §9 验收标准逐条走查（功能 11 项 + 性能 6 项 + 安全 6 项 + 合规 1 项）+ 12 项校验全部 PASS |

---

**Phase 边界原则**：每 Phase 交付一个**可运行的独立闭环**，Phase 之间是线性依赖（Phase N+1 的交付物依赖 Phase N 的基础），不允许 Phase N 抢跑 Phase N+1 的功能。

---

## 8. 风险与应对

| # | 风险 | 概率 | 应对 |
|---|------|------|------|
| R1 | OCI 免费档 VM 被回收 | 中 | DuckDB + SQLite 每日备份到 OSS；**DuckDB 用 COPY PARQUET GZIP 压缩至 ~350MB**，压缩后总用量 ~7.3GB 在免费档内；换 VM + 恢复备份 |
| R2 | DuckDB 文件损坏 | 低 | 每日压缩备份；C9 内部校验早发现；tdx2db init 可重建（20min）|
| R3 | SQLite 文件损坏 | 低 | VACUUM INTO 热备份 + OSS 30 天 + 本地 30 天双备份 |
| R4 | tdx2db cron 失败 | 低 | systemd timer + C1-C8 校验 + 自动补跑 |
| R5 | 自定义插件超时/异常 | 低 | 50ms 超时 + try-catch 隔离 |
| R6 | 通达信数据源不可用 | 低 | tdx2db 社区维护；备选 opentdx 客户端；最坏付费 Tushare-Pro |
| R7 | OCI 东京国内延迟 | 极低 | 实测 50-80ms；Cloudflare CDN 可选 |
| R8 | 东财接口限流 C12 跳过 | 低 | C12 标记 SKIP 不阻塞；东财正常情况下 500ms 节流足够 |
| R9 | Tushare 免费积分耗尽 C11 跳过 | 极低 | 每日 1 次机会，120 积分/天绰绰有余；失败降级 SKIP |
| R10 | 除权自动导入遗漏 | 低 | UUID 幂等可重跑；管理员手动触发补跑；C10 交叉验证发现后告警 |

---

## 9. 验收标准

### 9.1 功能验收

| 验收项 | 标准 |
|--------|------|
| 7 种交易类型 | buy/add/reduce/clear + dividend/bonus/transfer 全部可写；后三种由 cron 自动导入 |
| 移动加权成本（含送转） | bonus/transfer 数量增加、avg_cost 不变；dividend 不影响成本 |
| 收益双口径 | 复盘页价格收益率 vs 实际收益率切换；实际收益率含分红现金流入 |
| 日线行情 | v_stock_qfq 抽样 10 只与通达信/雪球价格差 < 0.01 元 |
| 除权除息 | 除权后前复权价连续；自动导入 dividend/bonus/transfer 交易记录 |
| **数据校验 12 项** | C1-C10 内部一致性全 PASS；C11 30 只跨源 ≤3 只差异；C12 20 只跨源 ≤5 只差异 |
| **管理员功能** | 手动触发 tdx2db 成功；查看 12 项校验日志；WARN 自动补跑生效 |
| 策略引擎 | RSI/MACD 正常；热重载；50ms 超时；故障隔离 |
| 全市场选股 | ≤3s 返回；过滤生效 |
| 复盘 | 胜率/盈亏比/收益曲线/双口径/归因/4 字段编辑 |
| 备份 | SQLite VACUUM INTO + integrity_check + OSS 上传；**DuckDB COPY PARQUET GZIP 压缩 + OSS 上传**；恢复可验证 |

### 9.2 性能验收

| 验收项 | 标准 |
|--------|------|
| 首屏加载 | ≤1.5s |
| API 常规 | ≤200ms |
| 选股 | ≤3s |
| 信号生成 | ≤20s（50 插件 × 30 标的）|
| 数据校验 | ≤60s（含 C11/C12）|
| K 线首渲染 | ≤500ms |

### 9.3 安全验收

| 验收项 | 标准 |
|--------|------|
| HTTPS 强制 | HTTP 301 重定向 |
| 防火墙 | 仅 443 + 22 |
| 密码 bcrypt | 不明文 |
| DB 权限 | SQLite 600；DuckDB 644 |
| 管理员鉴权 | /api/admin/* 需要 role='admin' |
| 日志脱敏 | 金额、用户 ID 末 4 位 |

### 9.4 合规验收

| 验收项 | 标准 |
|--------|------|
| 全局标注 | "本工具不构成投资建议，数据仅供参考" |

---

> **架构决策记录**：本文档是架构优化讨论后的完整重写 + V1.1 补充。原 Requirements_MVP_doubao.md V2.5 保留为历史参考。新架构以本系列文档为准。

> （注：部分内容由 AI 生成）
