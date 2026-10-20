# 横向溢出探针（G3.5 / G3.5b / G4.6 / G6.6 / G7.7）— 探针用法 + 实测矩阵

> **落档日期**：2026-10-20
> **实测代码版本**：`2f4dd7f`（`feat(T67): 持仓卡片网格 + 仓位进度条 + 信号标记 + 排序过滤`）
> ＋ 工作树中并行 agent 的未提交文件（`TradeFormModal.tsx` / `PositionDetailModal.tsx` / `KlineMiniChart.tsx` / `klineCanvas.ts`）
> **探针脚本**：`scripts/probe-overflow.mjs`
> **上游证据**：`docs/audit/gap-list-2026-10-17.md` F-Q12（实测溢出基线）
> ＋ `docs/client/code_implementation_plan_v2.md` §12.7 的 5 道溢出门槛

---

## 0. 一句话结论

**5 道溢出门槛当前全部为 FAIL（除 G3.5b 因前移不单独判定）**：
`dashboard@375 = +169px`、`review@375 = +241px`、`stockscan@375 = +100px`、`admin@375 = +420px`、`admin@768 = +27px`。
768px / 1440px 除 admin 外全部为 0。

| 页面 | 375（手机） | 768（平板） | 1440（桌面） |
|---|---|---|---|
| login | 0 | 0 | 0 |
| **dashboard** | **+169 ❌** | 0 | 0 |
| trade | 0 | 0 | 0 |
| signals | 0 | 0 | 0 |
| kline | 0 | 0 | 0 |
| **stockscan** | **+100 ❌** | 0 | 0 |
| **review** | **+241 ❌** | 0 | 0 |
| settings | 0 | 0 | 0 |
| **admin** | **+420 ❌** | **+27 ❌** | 0 |
| notfound | 0 | 0 | 0 |

---

## 1. 探针是什么

**判据**（plan §12.7 G3.5 逐字，脚本与本文档均不改写）：

```
document.documentElement.scrollWidth - document.documentElement.clientWidth <= 2
```

> ⚠️ 允许的 **2px** 是浮点/亚像素容差，**不是**「可以溢出 2px」的额度设计。

**为什么必须真浏览器**：jsdom 没有 layout engine（`clientWidth` 恒 0、`getBoundingClientRect()` 全 0），
只能做结构断言；**真实溢出必须在 Chromium 真渲染下测**。

**页面清单不硬编码**：从 `apps/frontend/src/App.tsx` 的 `<Route path=...>` 解析
（`/` → dashboard、`*` → notfound、`/login` → login …），与 `scripts/a11y-check.mjs` **同一套解析逻辑** ——
两个门禁脚本对「有哪些页面」的认知必须一致，否则一个绿一个红没法互相印证。

**视口**：375×812（手机）/ 768×1024（平板）/ 1440×900（桌面）。

---

## 2. 门槛矩阵（哪道门槛管哪些页面 × 哪些视口）

| 门槛 | 归属波次 | 覆盖页面 × 视口 | 判据 | 归属说明 |
|---|---|---|---|---|
| **G3.5** | **Wave 3** | `dashboard` × 375 | `scrollWidth − clientWidth ≤ 2` | plan 原文写「覆盖全站 6 页」，但 2026-10-18 修订后 **Wave 3 只对 dashboard 判定** |
| **G3.5b** | ~~Wave 3~~ → **Wave 7** | `admin` × 768 | 同上 | ⚠️ **plan 自身重复登记**，见 §3 |
| **G4.6** | **Wave 4** | `review` × 375 | 同上 | 自 G3.5 前移（review 页属 T69 / Wave 4） |
| **G6.6** | **Wave 6** | `stockscan` × 375 | 同上 | 自 G3.5 前移（stockscan 页属 T73 / Wave 6） |
| **G7.7** | **Wave 7** | `admin` × 375 **+** 768 | 同上（两个视口各跑一次） | 自 G3.5/G3.5b 前移；**整体承接 G3.5b** |

**没有门槛归属的页面**（探针仍然全扫，但判定归属需明确）：

| 页面 | 说明 |
|---|---|
| `trade` / `kline` | plan G3.5 原文六页清单里，**未被前移**的两页 → 归 **Wave 8 T78 汇总复核** |
| `login` / `signals` / `settings` / `notfound` | 不在 plan 六页清单内 → 本脚本**顺带扫描**，作为回归护栏，**不参与任何门槛判定** |

> ⚠️ **探针扫描范围 > 门槛判定范围** 是刻意的：脚本跑全矩阵，但门槛判定只对
> 「该门槛负责的页面 × 视口」出 PASS/FAIL，避免同一件事被两道门槛各判一次。

---

## 3. 🔴 G3.5b 的登记冲突（plan 自身的重复登记）

### 3.1 冲突事实

plan §12.7 的 G3 表里**同时**登记了两条几乎相同的事：

| 位置 | 原文 | 所属波次 |
|---|---|---|
| G3 表 · **G3.5b** | 「**768px 平板视口 admin 页无溢出**（F-Q12 实测 +23px）」 | G3 = Wave 3 |
| G7 表 · **G7.7** | 「**375px + 768px admin 页均无横向溢出**（F-Q12 实测 375px +460px、768px +23px，**G3.5/G3.5b 前移项**）」 | G7 = Wave 7 |

### 3.2 为什么它是冲突而不是「两条都要做」

1. **admin 页在 Wave 3 时点不存在** —— admin 属 **Wave 7 / T75**（T75 = Admin 页）。
   Wave 3 跑 G3.5b 时 `/admin` 路由尚未实现 → 探针只会量到 404 页 → **门槛无法判定**。
2. **G7.7 已整体承接** —— G7.7 的原文自己就写了「G3.5/G3.5b 前移项」，
   且 375px + 768px 两个视口**都**包含在 G7.7 里 → G3.5b 是 G7.7 的**真子集**。
3. **同因同判会被记两次** —— 若两道门槛都判 admin@768，一次修复会同时让两道变绿，
   门槛数量虚增一位、审计落档出现「两条同内容的 FAIL 行」。

### 3.3 建议裁决（**建议，未改 plan 文档**）

> **建议：G3.5b 前移至 G7.7，由 G7.7 单独承接，Wave 3 不再判定 G3.5b。**

- 落档位置：plan §12.7 的 G3 表 —— 把 **G3.5b** 一行**移出** G3 表（不再属于 Wave 3 出口），
  在 G7 表的 G7.7 行注明「**并入本条的 768px 视口**」。
- 本次**未改动 plan 文档**（本任务的文件边界只允许改 `scripts/probe-overflow.mjs` 与本文档）。
- 探针脚本的对应实现：`GATES` 里 G3.5b 带 `supersededBy: 'G7.7'` →
  判定输出为 **「➖ 前移（不单独判定）」**，但**仍给出实测值**（本次 `admin@768 = +27px`），
  供 G7.7 判定时直接引用。
- ⚠️ 若所有者在 plan 里保留 G3.5b，则**两处措辞必须二选一**（要么删 G3.5b，要么从 G7.7 里删掉 768px），
  不能两条都留 —— 这正是本次登记的根因。

---

## 4. 探针用法

### 4.1 前置条件

```bash
# 1) 后端（提供真实数据）
#    ⚠️ 宿主 8080 常被 llama-server 占用 → 用 8081
#    ⚠️ .env.local 的 SQLITE_DB_PATH 必须指向当前用户可写的目录
PORT=8081 npm run dev -w @invest/backend

# 2) 前端 dev server（vite，固定 5173）
npm run dev -w @invest/frontend
```

### 4.2 跑法

```bash
# 全矩阵（10 页 × 3 视口）
node scripts/probe-overflow.mjs --api-base-url http://127.0.0.1:8081 --username admin --password admin123

# 只跑某些视口
node scripts/probe-overflow.mjs --viewports 375,768,1440

# 只跑某些页面（页面名，不是路径）
node scripts/probe-overflow.mjs --pages dashboard,trade,review,kline,stockscan,admin

# 落 JSON 报告（CI 消费）
node scripts/probe-overflow.mjs --report /tmp/overflow.json

# 只跑某一道门槛涉及的「页面 × 视口」
node scripts/probe-overflow.mjs --gate G3.5

# 只打印门槛 → 页面 × 视口 映射（不跑浏览器）
node scripts/probe-overflow.mjs --list-gates
```

> `--api-base-url` 的作用：`apps/frontend/vite.config.ts` 的代理 target **写死 8080**，
> 而 8080 常被宿主其它服务占用 → 后端只能跑 8081。
> 探针用 Playwright 的**请求路由在浏览器侧**改写 `/api/*` 目标，**不需要改仓库里的 vite 配置**。
> （与 `scripts/a11y-check.mjs` 的 `rewriteApiBase` 逐字同源。）

### 4.3 退出码（门禁语义）

| 码 | 含义 |
|---|---|
| `0` | 全部「页面 × 视口」组合溢出 ≤ 2px，**且**没有「落地路径被重定向」的组合 |
| `1` | 存在溢出；**或**存在**无法验证**的组合（页面被重定向 → 结果不可信 → **fail closed**） |
| `2` | 用法错误 / 依赖缺失 / 目标站点不可达 |

**fail closed 的理由**：没有登录凭据时，受保护页面会跳到 `/login`，
若把「跳到登录页的 0 溢出」当成 PASS，门禁会出现**假绿**（全站都「通过」）。
实测验证：

```
node scripts/probe-overflow.mjs --pages dashboard --viewports 375    # 无凭据
  → exit 1，输出「落地路径是 /login（预期 /）—— 被重定向，该页根本没被量到，判 FAIL」
```

---

## 5. 实测环境（隔离说明）

| 项 | 值 | 说明 |
|---|---|---|
| 后端 | `http://127.0.0.1:51230` | ⚠️ **不是 8081** —— 8081 已被并行 agent 的 dev server 占用，故改用 AGENTS.md 预留段 51200-51999 |
| 前端 | `http://127.0.0.1:51231` | ⚠️ **不是 5173** —— 5173 已被并行 agent 占用；本探针另起 vite 且**独立 cacheDir**（`/tmp/opencode/.vite-probe-cache`），避免两个 dev server 互相作废依赖预构建、打断对方 |
| DuckDB | `/tmp/opencode/overflow-quotes.duckdb` | **真实库副本**（`cp /opt/invol/quotes.duckdb`，1.24 GB）—— 避免锁住真实库，干扰并行 agent 跑 vitest |
| SQLite | `/tmp/opencode/overflow-business.db` | 真实业务库副本（`better-sqlite3` 的 `db.backup()` 热备份，含 WAL 内容） |
| 浏览器 | `playwright-cli` 0.1.22 + chromium | 全局 CLI，**未新增任何 npm 依赖** |
| 登录 | `admin` / `admin123`（role=admin） | admin 页需管理员身份，否则 `AdminGuard` 会把 `/admin` 重定向到 `/` → 判 FAIL |

---

## 6. 实测原始数据

### 6.1 溢出矩阵（页面 × 视口 → `scrollWidth / clientWidth` → 差值）

| 页面 | 375 | 768 | 1440 |
|---|---|---|---|
| login | 375 / 375 → **0** | 768 / 768 → **0** | 1440 / 1440 → **0** |
| dashboard | **544 / 375 → +169 ❌** | 768 / 768 → 0 | 1440 / 1440 → 0 |
| trade | 375 / 375 → 0 | 768 / 768 → 0 | 1440 / 1440 → 0 |
| signals | 375 / 375 → 0 | 768 / 768 → 0 | 1440 / 1440 → 0 |
| kline | 375 / 375 → 0 | 768 / 768 → 0 | 1440 / 1440 → 0 |
| stockscan | **475 / 375 → +100 ❌** | 768 / 768 → 0 | 1440 / 1440 → 0 |
| review | **616 / 375 → +241 ❌** | 768 / 768 → 0 | 1440 / 1440 → 0 |
| settings | 375 / 375 → 0 | 768 / 768 → 0 | 1440 / 1440 → 0 |
| admin | **795 / 375 → +420 ❌** | **795 / 768 → +27 ❌** | 1440 / 1440 → 0 |
| notfound | 375 / 375 → 0 | 768 / 768 → 0 | 1440 / 1440 → 0 |

**5 / 30 个组合溢出。**

### 6.2 门槛判定

| 门槛 | 判定 | 实测 |
|---|---|---|
| G3.5（Wave 3） | ❌ **FAIL** | `dashboard@375` 溢出 **+169px** |
| G3.5b（→ Wave 7） | ➖ 前移（不单独判定） | `admin@768` 实测 **+27px**（由 G7.7 判定） |
| G4.6（Wave 4） | ❌ **FAIL** | `review@375` 溢出 **+241px** |
| G6.6（Wave 6） | ❌ **FAIL** | `stockscan@375` 溢出 **+100px** |
| G7.7（Wave 7） | ❌ **FAIL** | `admin@375` **+420px**、`admin@768` **+27px** |

### 6.3 超宽元素定位（可直接定位到元素，不只是「溢出了多少」）

| 组合 | 元凶元素 | 尺寸 / 位置 | 所在容器 |
|---|---|---|---|
| `dashboard@375` | `<th>`「消息」+ `<td>` ×5 | 宽 217px，右边缘 **544px**，超出 169px | 「最近日志」`<table>`：**4 列**，总宽 **483px** |
| `stockscan@375` | `<span>` 插件说明 | 宽 103px，右边缘 **475px**，超出 100px | 插件参数行（`label + select + span` 的 flex 行） |
| `review@375` | `<th>`「操作理由」「复盘」「符合策略」「止损」「来源」「操作」 | 67 / 35 / 35 / 35 / 35 / 53px，右边缘 **615px** | 「交易复盘列表」`<table>`：**11 列**，总宽 **555px** |
| `admin@375` / `admin@768` | `<th>`「message」「detail」+ `<td>` ×13 | 217 / 225px，右边缘 **794px**，超出 419 / 26px | 「系统日志」`<table>`：**6 列**，总宽 **734px** |

触发撑宽的具体文本（前三项均为**不可断的长字符串**）：

```
插件目录不可读，跳过磁盘加载: /opt/invol/plugins/strategies
ENOENT: no such file or directory, scandir '/opt/invol/plugins/strategies'
4 段 cron 已注册: 17:01 校验 / 17:02 信号 / 17:03 除权 / 17:05 备份
RSI 跌破超卖线发出买入信号；RSI 升破超买线发出卖出信号（Requirements §5.5）
```

### 6.4 与历史基线的差异（**以探针实测为准**）

| 页面 | gap-list F-Q12（2026-10-17） | plan §12.7（2026-10-18 修订） | **本次实测（2026-10-20）** |
|---|---|---|---|
| dashboard@375 | +163 | +177 | **+169** |
| review@375 | +250 | +249 | **+241** |
| stockscan@375 | +39 | +43 | **+100** |
| admin@375 | +416 | +460 | **+420** |
| admin@768 | +23 | +23 | **+27** |

⚠️ **两点必须记下**：

1. **三个来源三个数** —— 数值本就有 ±20px 的漂移（F-Q12 与 plan 自身就对不上），
   故 §6.1 的实测值才是本次判定依据（与 wave-3-task-cards「卡 8」的「实测口径」一致）。
2. **溢出像素数依赖实际数据** —— admin 页最宽的一格是日志表里的 `detail` 列，
   其宽度由**日志正文内容**决定（本次副本里的日志与实时库不同 → 420 vs 早前实测 435）。
   ⇒ **门槛判定必须固定同一份数据副本**，否则同一份代码会给出不同像素数、无法复现。

---

## 7. 发现但**未修**的问题（本任务不改业务代码）

> 🔒 本任务的文件边界只允许改 `scripts/probe-overflow.mjs` 与本文档；
> `apps/frontend/src/**` 有并行 agent 在改，**不得顺手改 UI**（wave-3-task-cards「卡 8」负向边界）。

| # | 问题 | 定位 | 归属建议 |
|---|---|---|---|
| 1 | **表格 `width:100%` 撑破容器** —— `width:100%` 对 table 只是**最小宽度**；未设 `table-layout: fixed`、单元格未设 `word-break`/`overflow-wrap`，长不可断字符串（日志消息、路径、操作理由）把表格撑到容器外 | `apps/frontend/src/theme/styles.ts:71`（`tableStyle`）→ 影响 dashboard / admin / review 三页 | T69（Wave 4，review 卡片化）/ T75（Wave 7，admin 日志卡片化）/ dashboard 日志表；**T79①「表格手机端改卡片列表」正是唯一修复手段**（plan 行 344 已把它升级为 G4.6/G6.6/G7.7 的硬门槛） |
| 2 | **表单行不换行** —— `formRowStyle` 是 `display:flex` 且**无 `flexWrap:'wrap'`**；`label + select + span` 三件套在 375px 放不下 → 整行溢出 100px | `apps/frontend/src/theme/styles.ts:126`（`formRowStyle`）→ 影响 stockscan | T73（Wave 6，stockscan） |
| 3 | **插件说明文案无宽度约束** —— 后端 `pluginEngine.ts` 返回的 `description` 是长句，前端直接渲染成 `<span>` 且未设 `maxWidth`/可换行 | `apps/frontend/src/pages/StockScan.tsx:230`、`apps/backend/src/services/pluginEngine.ts:291` | T73（Wave 6） |
| 4 | **768px admin 仍溢出 27px** —— 平板视口下 6 列日志表总宽 734px 已经很接近 768px，任何一格变宽即溢出 | `apps/frontend/src/pages/Admin.tsx:346` | T75（Wave 7）/ G7.7 |
| 5 | **dashboard 的「最近日志」表把后端内部日志直接渲染给用户** —— `插件目录不可读…`、`ENOENT…`、`4 段 cron 已注册…` 这类运维噪声既撑宽表格又是面向用户的错误文案（AGENTS.md「面向用户的文案」原则） | `apps/frontend/src/pages/Dashboard.tsx:697`（最近日志表） | Wave 3 批次 5 owner / T67 卡 5（今日动态卡）—— 建议只留业务事件 |
| 6 | **`PLUGIN_ALLOWED_PATH` 未设** —— 本机 `/opt/invol/plugins/strategies` 不可写 → 后端每次启动都往 `system_log` 写 ERROR → 正是撑宽 dashboard/admin 两张表的元凶 | `.env.local`（该行被注释掉）+ `apps/backend/src/services/pluginEngine.ts` | 环境配置项；**不是代码缺陷**，但会让溢出数值随环境漂移 |

---

## 8. 复现步骤（本次实测的完整命令）

```bash
# 0) 隔离副本（避免锁住真实 DuckDB，干扰并行 agent 的 vitest）
cp /opt/invol/quotes.duckdb /tmp/opencode/overflow-quotes.duckdb
node -e "const D=require('better-sqlite3');const db=new D('data/business.db',{readonly:true});\
  db.backup('/tmp/opencode/overflow-business.db').then(()=>{db.close()})"

# 1) 后端（独立端口 + 副本库）
cd apps/backend && PORT=51230 \
  DUCKDB_PATH=/tmp/opencode/overflow-quotes.duckdb \
  SQLITE_DB_PATH=/tmp/opencode/overflow-business.db \
  npx tsx --env-file=../../.env.local src/server.ts

# 2) 前端（独立端口 + 独立 cacheDir）
cd apps/frontend && npx vite --config /tmp/opencode/vite.probe.config.ts   # → 51231

# 3) 跑探针
cd /opt/invol/InvestAssistantMVP
node scripts/probe-overflow.mjs \
  --base-url http://127.0.0.1:51231 \
  --api-base-url http://127.0.0.1:51230 \
  --username admin --password admin123 \
  --viewports 375,768,1440 \
  --report /tmp/opencode/overflow-full.json
# → exit 1（5/30 组合溢出），矩阵与原始数值见 §6
```

---

## 9. 收尾（后台进程四步）

按 AGENTS.md「后台进程收尾流程」四步执行，验收标准 = **端口 LISTEN 归零 且 Step 3 查询无输出**：

| 步骤 | 动作 | 本次对象 |
|---|---|---|
| 1 | 杀整棵进程树（从监听 PID 向上遍历 ppid） | 本次起的 vite（51231）与其父 `npm`/`sh` |
| 2 | 按端口段强杀 | 51230 / 51231 |
| 3 | 查不占端口的残留（tsx watch / vite） | 本次**未用** `tsx watch`（用的是 `npx tsx`，无看门狗），仍逐项确认 |
| 4 | 端口段 LISTEN 归零 + Step 3 无输出 | `ss -lntp` 检查 51230/51231 |
| 附 | `playwright-cli list` → `(no browsers)` | 探针 `finally` 里已 `close`，仍复核 |
| 附 | 删除 DuckDB 副本（1.24 GB） | `rm /tmp/opencode/overflow-quotes.duckdb` |

> ⚠️ **未动 5173 / 8081** —— 那是并行 agent 的进程，不属本任务的收尾范围。
