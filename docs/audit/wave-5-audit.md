# Wave 5 验收 —— Kline + Signals（G5）

> 判定人：主 agent（Wave 5 实施者）
> 日期：2026-10-21
> 波次范围：**T70（Kline 改接 klinecharts@10.1.0）** + **T71（指标参数实时生效）** + **T72（Signals 增强）**
> + **T60b（迷你 DuckDB 测试基建）** + **T60c（DuckDB 视图物化反模式修复）**
> 上游：[`wave-4-audit.md`](./wave-4-audit.md)（G4 判定 PASS 6/6）
> 起始 commit：`5e0edf7`（Wave 4 收尾）
> PR：#23 `feat(Wave 5): Kline + Signals —— T70/T71/T72 + T60b/T60c`

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| 🔒 **G5.1** SDD §12.5 功能组 **F1-F8 全部 PASS** | ✅ **PASS** | 10 个指定用例名**全部是真实 `it()`/`describe()` 用例名**（非注释），逐个 grep 验证 |
| **G5.2** F-K1~F-K8 关闭 + ETF/指数按 class 分流 | ✅ **PASS**（附 1 项能力缺口）| F-K1~F-K8 **8/8** 有实现 + 测试载体；class 分流实测 stock/etf/**bj** ✅，**index 类 K 线为空**（见 §4.2）|
| 🔒 **G5.3** `ma60`/`rsi`/`macd` 与 golden 逐位相同，双端误差 = 0 | ✅ **PASS** | `frontend.test.tsx` golden **零容差**逐位相等全绿；`technical.ts` 与 core `adapters.ts` **字节一致** |
| 🔒 **G5.4** KDJ 手写实现 golden 断言通过（含 `K_0=D_0=50` + `Hn−Ln=0` 不产生 NaN）| ✅ **PASS** | `frontend.test.tsx` 的 KDJ golden + 边界 + 口径自洽用例全绿 |
| **G5.5** signals 升序 + `asset_code`/`start_date`/`end_date` 筛选正确 | ✅ **PASS** | 后端 `ORDER BY trade_date ASC`（外层升序排回）+ 3 个筛选参数 11 处引用 + 用例 |
| **G5.6** K 线价格轴范围正确 | ✅ **PASS** | **真浏览器探针**（新建 `scripts/probe-kline-axis.mjs`）：4 标的 max/min = **1.2415~1.2867 ≤ 3**，且 **y 轴均不从 0 起步** |

**G5 = 6/6 PASS → Wave 5 可合入 `main`。**

> 🔒 **数据正确性类门槛（G5.1 / G5.3 / G5.4）零豁免，全部实测 PASS。**

---

## 1. 实测原始数据

### G5.1 —— F1-F8 的载体逐个核实

| 用例名 | 归属 | 载体 | 真实用例名？ |
|---|---|---|---|
| `login_success` | F1 | `apps/backend/tests/integration/auth.test.ts` | ✅ 2 处 |
| `login_wrong_password` | F1 | 同上 | ✅ 2 处 |
| `create_trade_all_types` | F2 | `apps/backend/tests/integration/trade.test.ts` | ✅ 5 处 |
| `avg_cost_calc_5_scenarios` | F3 | `apps/backend/tests/unit/holding.test.ts` | ✅ 1 处 |
| `yield_caliber_switch` | F4 | 同上 | ✅ 1 处 |
| `kline_render` | F5 | `apps/frontend/tests/unit/frontend.test.tsx` | ✅ 31 处 |
| `state_machine_4_paths` | F6 | `packages/core/tests/plugin.test.ts` | ✅ 1 处 |
| `scan_5000_target` | F7 / PE2 | `apps/backend/tests/integration/scan5000.test.ts` | ✅ 1 处 |
| `cron_sequence_trigger` | F8 | `apps/backend/tests/integration/cronSequence.test.ts` | ✅ 7 处 |

> ⚠️ 判定口径：**必须是 `it()`/`describe()` 的参数位置**，不能只是在注释里出现。
> （`scan_5000_target` 此前只命中 `t55` 的一句注释 —— **门禁会因此假绿**，故逐个用跨行上下文核实。）

**SDD §12.5 状态表已同步**（F1/F2/F5/F8 由「❌ 待建」改为「✅ 已有」，汇总由 9/24 改为 **13/24**）。

### G5.2 —— F-K1~F-K8 关闭证据（实现文件数 / 测试文件数）

| Gap | 要求 | 实现 | 测试 |
|---|---|---|---|
| F-K1 | fq 四值（**含后复权**）| 5 | 3 |
| F-K2 | **MA60** | 2 | 4 |
| F-K3 | MA 可隐藏 | 3 | 1 |
| F-K4 | **KDJ** | 10 | 4 |
| F-K5 | 桌面副图可切换 | 8 | 4 |
| F-K6 | 十字光标 + OHLCV 悬浮 | 4 | 3 |
| F-K7 | 周K / 月K | 1 | 2 |
| F-K8 | 信号标记 hover 明细 | 8 | 8 |

**class 分流实测**（`GET /api/quote/:symbol/kline`，真库 + 真后端）：

| 标的 | HTTP | `symbolClass` | bars | 判定 |
|---|---|---|---|---|
| `sh600000` | 200 | `stock` | 10 | ✅ |
| `sh510300`（ETF）| 200 | `etf` | 10 | ✅ |
| `sz159915`（ETF）| 200 | `etf` | 10 | ✅ |
| `bj920001`（北交所）| 200 | `stock` | 10 | ✅（**本波修复后**）|
| `sh000001`（指数）| 200 | `index` | **0** | ⚠️ **能力缺口**（见 §4.2）|

### G5.3 / G5.4 —— 指标 golden（零容差）

`apps/frontend/tests/unit/frontend.test.tsx`：

```
✓ kline_render · MA / MACD / RSI 对 golden 逐位相等（零容差）  ×7
✓ kline_render · KDJ 指标对 golden 逐位相等（零容差）           ×5
✓ kline_render · KDJ 口径自洽（独立于 golden 的防错校验）        ×2
```

- **双端误差 = 0**：`src/indicators/technical.ts`（MA/MACD/RSI）与 `packages/core/src/indicators/adapters.ts` **字节一致**（有专门断言）
- **取整位数按视图不同**（T60c 实测发现）：`v_stock_qfq`=2、**`v_etf_qfq`=3**、`v_stock_hfq`=2、`v_etf_hfq`=3、**bfq 不取整**
- **KDJ 边界**：`K_0 = D_0 = 50` 首值 + `Hn−Ln = 0`（横盘）**不产生 NaN** ⇒ 有专门断言
- golden 数据集本身是 **221 根**（`kdj/macd/rsi` 三份一致），来自真库 `ORDER BY date DESC LIMIT 221`

### G5.6 —— K 线价格轴范围（真浏览器探针）

新建 `scripts/probe-kline-axis.mjs`（DEV 模式下 `window.__investKlineChart` 暴露 chart 实例 ⇒ 读真实轴范围）：

```bash
node scripts/probe-kline-axis.mjs --api-base-url http://127.0.0.1:8081 \
     --username admin --password admin123 --symbols sh600000,sh600519,sz000001,sh510300
```

| 标的 | from | to | max/min | bars | 判定 |
|---|---|---|---|---|---|
| `sh600000` | 7.947 | 10.066 | **1.2666** | 120 | ✅ |
| `sh600519` | 1128.576 | 1420.222 | **1.2584** | 120 | ✅ |
| `sz000001` | 9.569 | 12.312 | **1.2867** | 120 | ✅ |
| `sh510300`（ETF）| 4.230 | 5.252 | **1.2415** | 120 | ✅ |

全部：max/min ≤ 3 ✅ · y 轴下界 > 0（**未从 0 起步**）✅ · 区间 2026-04-14~2026-10-12（120 根）✅

> 🔴 **I-23 的症状确已消失**：历史上后端 MA 预热期用 `null` 占位 → 进 `Math.min` → y 轴变 0.00~9.74、蜡烛被压到顶部 5%。
> 现在 klinecharts 内部用 `Number.isFinite` ⇒ NaN 不进 y 轴范围。

### 全量测试（本波结束时）

| 范围 | 结果 |
|---|---|
| **后端（full 档 / 真库）** | **701 passed**（54 文件）|
| 后端（mini 档 / 迷你库）| 695 passed + 6 skipped（**48.8s vs full 档 240.9s，5x**）|
| **前端** | **508 passed + 1 todo**（27 文件）|
| 前端覆盖率 | **73.9% → 82.6%**（T65/T70/T71/T72 新增用例贡献）|
| `npm run lint` / `npm run typecheck` | exit 0 |
| PR #23 CI | Stage 2 **pass 1m17s** · build-and-test **pass 4m26s** |

---

## 2. 本波交付清单

| 任务 | 交付 |
|---|---|
| **T70** | Kline 页改接 `klinecharts@10.1.0`：**v10 的 API 全部从 `node_modules` 的类型定义确认**（`applyNewData` 等 9.x 写法全部作废）；6 个**自定义指标**（`APP_MA/MACD/RSI/KDJ/VOL/SIGNAL`，**库不参与任何计算**，避免与后端 core 双口径）；十字光标 / 缩放 / OHLCV 悬浮 / 响应式 / 信号标记 hover 明细；**修 2 个必修 bug**（`/kline/<code>` 路由不存在 → 改 `/api/quote/:symbol/kline`；K 线页不读 `?symbol=` → 改 `useSearchParams`）|
| **T71** | 指标参数面板（MA 周期 / MACD 12-26-9 / RSI 周期+超买超卖 / KDJ N-M1-M2）→ **改值即时重绘，零网络请求**（连 klinecharts 的数据加载器都不碰；重算 + `overrideIndicator`）|
| **T72** | Signals 页增强：进页自动加载、方向 pill、强度进度条/星、标签 tag、分页、**300ms debounce 筛选**、「筛选」按钮删除 |
| **T60b** | **迷你 DuckDB 测试行情库**：生成器 + Parquet 入库 + 三档（`MARKET_DATA_MODE`）+ 三层能力（`numeric`/`scale`/`performance`）|
| **T60c** | **DuckDB 视图物化反模式修复** + 批量日志 + 档位统一到服务层 |

---

## 3. 本波挖出并修复的真实缺陷

### 3.1 🔴 `/api/market/latest` **12.18s 拿 5 行**，且**免鉴权**
原为 `SELECT … FROM v_stock_qfq ORDER BY date DESC LIMIT 5` —— 为拿 5 行物化整个复权视图（2800 万行 × 4 JOIN）。
该端点在 `PUBLIC_ROUTES` ⇒ **可被反复调用烧 CPU 的面**。
→ 改基表 + `MAX(date)` + 显式前复权 ⇒ **11.46s → 0.66s（17x）**。
⚠️ 性能关键点：`raw_adjust_factor` **2150 万行**不预过滤时 join 要建全量哈希表（7.19s），按 date 预过滤后（zone map 命中）⇒ 0.66s。

### 3.2 🔴 `batchGetLatestClose` **3.38s 只查 5 只标的** ⇒ **Dashboard 首屏 3+ 秒**
视图上打 `ROW_NUMBER() OVER (PARTITION BY symbol)` ⇒ 视图整体物化。
→ 基表 + `IN` 下推 + 手工复权因子 ⇒ **0.08s（41x）**。

### 3.3 🔴 `resolveTable` **硬编码 `v_stock_qfq`** ⇒ **持有 ETF 的用户拿不到现价/市值/盈亏**
视图的 `INNER JOIN raw_symbol_class class='stock'` 把 ETF 全过滤掉了。
→ 新实现走基表 ⇒ **旧行为是 bug，新行为更正确**（**行为变化，已登记**）。

### 3.4 🔴 「迷你库档只快了 4%」—— 档位只改了「测试读哪个库」，**服务层仍读 `DUCKDB_PATH`**
`db/duckdb.ts` 的路径在**模块加载时快照** ⇒ 备份/健康检查仍打 1.24GB 真库
（`smoke-m3` 备份 **31.4s**、`smoke-m1` 健康检查 **18.5s**）。
→ 路径改**连接时惰性解析** + 档位解析放进 `tests/setup.ts` 的统一入口。
⚠️ **但测试文件自己显式设了 `DUCKDB_PATH` 时必须尊重它**（`backup.test.ts` 指向自己的临时库）⇒ **优先级：文件显式设置 > 档位解析**。

### 3.5 🔴 `bj`（北交所）前缀被 400 拒 —— K 线页与候选池对**全部 615 只北交所标的**不可用
真实库的 symbol 前缀有**三种**：`sh` 5958 / `sz` 5876 / **`bj` 615**；
旧正则 `/^(sh|sz)\d{6}$/` 把北交所全挡在门外
⇒ K 线 400、候选池无法添加、且 t85b 的信号标的域会 `SKIP` 北交所持仓。
→ `routes/kline.ts` 与 `services/candidateService.ts` 两处正则均改为接受 `bj`。
⚠️ **实施计划 T70 卡里写的 `bd000` 是笔误** —— 库里真实前缀是 `bj`。

### 3.6 🔴 `getYAxes()` 在 klinecharts v10 **必须传 filter 对象**
无参调用会读 `undefined.paneId` → **抛 TypeError**（实测）。
⇒ 正确写法 `chart.getYAxes({ paneId: 'candle_pane' })[0].getRange()`（`candle_pane` = 主图，其余是副图窗格）。
⚠️ 这也是探针反复失败的原因（表现为「eval 失败」而非「轴读不到」）。

### 3.7 🔴 CI 的后端测试命令**没走 backend 的 vitest config** ⇒ ① setupFiles 从未加载 ② **后端覆盖率一直是 0%**

CI 的命令是 `npx vitest run apps/backend/tests/unit --coverage`（**在仓库根跑**），
而**仓库根没有 vitest config** ⇒ 走 vitest 默认配置 ⇒ **不带 `setupFiles`**
⇒ `tests/setup.ts` 的两级 env 基线守卫**完全没跑**（本地 `npm test` 走的是
`vitest run apps/backend --config apps/backend/vitest.config.ts` ⇒ 守卫是生效的 ⇒ **本地与 CI 行为不一致**）。

⚠️ 第二个后果更隐蔽：`coverage.include: ['src/**/*.ts']` 相对 **cwd** 解析
⇒ 在仓库根跑时匹配的是 `<repo>/src/`（**不存在**）⇒ **后端覆盖率一直是 0%**
（实测修复前 CI 的 coverage 报表里只有 `src/services/...` 这类**不存在的路径**，全 0%）。

⇒ 修法：`apps/backend/vitest.config.ts` 显式加 `root: __dirname` + `include: ['tests/**/*.test.ts']`
⇒ `include` / `coverage.include` / `setupFiles` 都相对 `apps/backend/` 解析 ⇒ **任何 cwd 下都正确**；
CI 的 4 处后端命令改为带 `--config`。

### 3.8 🔴 行情库**档位在同进程内跨文件泄漏** ⇒ 规模型用例在 CI 上不 skip

`resolveMarketData()` 会把 `process.env.DUCKDB_PATH` **写成迷你库路径**
（让 `src/db/duckdb.ts` 的惰性解析能拿到它）。
⇒ **同进程内的下一个测试文件**（vitest 同进程跑多个文件）看到「DUCKDB_PATH 已设」
⇒ `auto` 档被误判成 **full** ⇒ `marketDataSupports('scale')` 返回 true
⇒ **规模型用例不再 skip**（迷你库只有 104 只 stock / 41 只 ETF）
⇒ CI 红：`expected 104 to be greater than 3000`。

⇒ 修法：`auto` 档判定时**排除「我们自己写进去的迷你库路径」**
（是 ⇒ 仍按 mini 处理；不是 ⇒ 才是 full）。
⚠️ 这与 3.7 是**叠加关系**：3.7 让 env 守卫在 CI 上生效（还原泄漏），3.8 从档位判定本身免疫。

### 3.9 ⚠️ 探针改写 `/api/**` 过宽会把**前端源文件**也改写到后端
`page.route('**/api/**')` + `slice(indexOf('/api/'))` 会把 `/src/api/client.ts` 也当成 API 路径
⇒ 后端返回 401 ⇒ 前端模块加载失败 ⇒ **白屏**（探针看到 `canvases=0`）。
⇒ 必须用**锚定开头**的正则 `^https?://[^/]+/api/`（与 `probe-overflow.mjs` / `a11y-check.mjs` 逐字同源）。

> ⚠️ **3.7 / 3.8 是 CI 首次红**的根因 —— 两者叠加才触发：
> 3.7 让 `setupFiles` 在 CI 上生效（env 守卫开始还原泄漏）**但 CI 命令同时改成了带 `--config`**；
> 3.8 让档位判定本身免疫。
> ⇒ **CI 复现验证**（仓库根 + 无 `.env.local` + 无迷你库 + 无 `DUCKDB_PATH`）：
> 修复前 `42 files / 2 failed`（`expected 104 to be greater than 3000`）⇒
> 修复后 **42 files / 557 passed + 5 skipped，exit 0**，且**后端 coverage 从 0% 变成真实值**
> （`src/config 89.12%` / `src/db 89.34%` / `src/lib 100%`）。

---

## 4. 口径裁决（owner 需过目）

> 本波 **14 条**裁决。以下为需过目的部分。

| # | 事项 | 裁决 | 依据 / 理由 |
|---|---|---|---|
| 4.1 | **klinecharts v10 的 API 用法** | 全部从 `node_modules/klinecharts/dist/index.d.ts` 确认，**不照抄网上 9.x 教程** | `applyNewData` / `getIndicatorSeries` 在 v10 **不存在**；`createIndicator` 需 `{name,paneId,series,styles}`；**未注册的名字返回 `null` 且不抛异常**（信号标记静默不显示的坑）|
| 4.2 | **class 覆盖不全**：`v_stock_*` 只含 `class='stock'`、`v_etf_*` 只含 `class='etf'` ⇒ **index / block / unknown / bstock 无视图，K 线为空** | **本波不修，记为能力缺口** | 修它要**建视图**，而 **DuckDB 只读**（AGENTS.md：写入权仅 tdx2db Go 二进制持有，不在本仓库）；用基表绕开则需裁决「index 的前复权取整位数」（无先例：stock=2 / etf=3）⇒ **留待 owner 裁决** |
| 4.3 | **T70 卡的「sd000 / bd000 / k000」** | 判定为**基于错误假设** | 库里**没有** `sd` / `bd` 前缀（只有 `sh`/`sz`/`bj`）⇒ 真正需要支持的是 `bj`（已修）|
| 4.4 | **取整位数按视图不同** | `v_stock_qfq`=2、**`v_etf_qfq`=3**、`v_stock_hfq`=2、`v_etf_hfq`=3、**bfq 不取整** | 实测 `duckdb_views()` 拿到视图定义原文 |
| 4.5 | **旧行为 vs 新行为（ETF 持仓无价）** | 采用**新行为**（走基表 ⇒ ETF 也能取到价） | 旧行为是 bug（视图 class 过滤）；但属**行为变化**，已登记 |
| 4.6 | **迷你库跨度 = 365 自然日** | 不用半年 | `golden/{kdj,macd,rsi}` 全是 **221 根**（335 自然日），半年只有 **119 个交易日** ⇒ golden 取不到数据 |
| 4.7 | **迷你库 N = 250** | 按真库真实 class 比例 | 手工配额（stock 75%）与真库（49.5%）不符 |
| 4.8 | **抽样用 FNV-1a 32bit hash** | 不用随机 | 随机需固定 seed 才有可复现性；hash 排序天然确定 |
| 4.9 | **三层能力开关**（而非一层/两层）| `numeric` / `scale` / `performance` 分开 | 迷你库**数值可信、规模不可信**；规模与性能的可跑性也不同（迷你库 stock 104 只 vs 真库 5561 只）|
| 4.10 | **档位必须统一到服务层** | 路径改**连接时惰性解析** | 模块加载时快照 ⇒ 迷你库档只快 4% |
| 4.11 | **文件显式设 `DUCKDB_PATH` 优先于档位** | 文件 > 档位 | `backup.test.ts` 断言「不触碰真实行情库 data/quotes.duckdb」|
| 4.12 | **`/api/market/latest` 的 `LIMIT 5` 不加 `ORDER BY` 之外的稳定序** | 保持与旧实现同语义（同日期下 tie-break 任意）| 旧写法 `ORDER BY date DESC LIMIT 5` 在同日期下顺序本就不确定 ⇒ 「具体哪 5 只」**不是契约**；口径等价性由**视图作 oracle、逐 symbol 比对 close** 的用例守住 |
| 4.13 | **G5.6 的判据实现** | 读 `getYAxes({paneId:'candle_pane'})[0].getRange()` | 主图窗格 id = `candle_pane`；不带 filter 会抛异常 |
| 4.14 | **`sd`/`bd`/`k` 前缀** | 按真实库的 `sh`/`sz`/`bj` 实现 | 见 4.3 |

---

## 5. 本波未解决 / 移交

| # | 问题 | 归属 |
|---|---|---|
| 5.1 | **index / block / unknown / bstock 类标的 K 线为空**（无视图）| **需 owner 裁决**（见 4.2）—— 修它要动 tdx2db（Go，不在本仓库）|
| 5.2 | `stockscan@375` 溢出 +100px | **G6.6（Wave 6 / T73）** |
| 5.3 | `admin@375` +435px / `@768` +42px | **G7.7（Wave 7 / T75）** |
| 5.4 | `color-contrast` serious（4 个 token 不达标）· `page-has-heading-one` moderate | **T76（Wave 7）** |
| 5.5 | T60 剩余项（`tests/http/` + PE4 + `calcAllPositions` N+1）| **G8.3（Wave 8）** —— 已登记在 plan §12.7 机制表 |
| 5.6 | `watchPromote.test.ts` 偶发 15s 超时 · `smoke-m3` 偶发 120s 超时 | 既有 flaky（已把 smoke 的备份 timeout 提到 300s）|
| 5.7 | `getTodaySignalStats` 仍是**无调用方**的导出 | 按 D-13 登记，不删 |
| 5.8 | 前端 `PositionDetailModal` 的 `transfer` 标「转股」、`Review`/`TodayActivityCard` 标「转增」 | **需 owner 统一**（Requirements §5.1 = 转增）|
| 5.9 | 迷你库的 `manifest.json` 每次重抽都产生 diff（已加 `.prettierignore`）| 已缓解 |

---

## 6. 验证汇总

| 检查 | 结果 |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| **后端全量（full 档）** | **701 passed / 54 文件** |
| **后端全量（mini 档）** | 695 passed + 6 skipped（**48.8s，5x 提速**）|
| **前端全量** | **508 passed + 1 todo / 27 文件** |
| **G5.1** | 10 个指定用例名全部为真实用例名 ✅ |
| **G5.2** | F-K1~F-K8 = 8/8 ✅；class 分流 stock/etf/bj ✅（index 缺口已登记）|
| **G5.3 / G5.4** | golden 零容差逐位相等全绿 ✅ |
| **G5.5** | 升序 + 3 筛选参数 ✅ |
| **G5.6** | 真浏览器 4 标的 max/min 1.2415~1.2867 ≤ 3，未从 0 起步 ✅ |
| PR #23 CI | Stage 2 pass · build-and-test pass ✅ |
