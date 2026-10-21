# Wave 7 验收 —— Admin + 全局导航 / a11y / 响应式（G7）

> 判定人：主 agent（Wave 7 实施者）
> 日期：2026-10-21
> 波次范围：**T75（Admin 补全）** + **T76（全局导航 / a11y / 响应式基础）**
> 上游：[`wave-6-audit.md`](./wave-6-audit.md)（G6 判定 PASS 6/6）
> 起始 commit：`038411b`（Wave 6 收尾）
> commit 区间：`038411b..290e2b3` —— **7 个 commit**

---

## 0. 判定结论

| 门槛 | 判定 | 实测依据 |
|---|---|---|
| **G7.1** SDD §12.5 **F10 PASS**（备份恢复）| ✅ **PASS** | `backup_restore_sqlite` 用例真跑（造库→备份→破坏→恢复→逐行 `toEqual`），**12 passed**；白名单拒 5 类非法文件名 |
| **G7.2** §12.3 **PRD §5.7 对应行零 gap** | ✅ **PASS** | §5.7 的 **5 行逐条勾对**（见 §2）|
| **G7.3** **F-A1~F-A3 关闭** | ✅ **PASS** | 3 项逐条勾对（见 §3）|
| **G7.4** **管理员二次鉴权：普通用户访问全部 admin 端点均 403** | ✅ **PASS** | **实测枚举 11 个端点，11/11 403 `FORBIDDEN`** + **零副作用快照** + **清单漂移守卫** |
| 🔒 **G7.5** **DuckDB 备份恢复真实跑通**（`COPY TO PARQUET GZIP` → 恢复 → `COUNT(*)` 相等），**不得只 mock** | ✅ **PASS** | 4 条用例全过 + 独立取证脚本：源库 `COUNT(*)=6` → 恢复后 `=6`，**相等 = true**；产物 1518 字节、文件头 `PAR1` |
| 🔒 **G7.6** **12 项校验卡片真实渲染 12 条**，名称与 **SDD §5.7 主表一致** | ✅ **PASS** | API `data.length=12`、`checkId` 集合 = `{C1..C12}`；**12 条 `name` 与 SDD §5.7 小节标题逐字一致（不一致 0 条）**；真浏览器 DOM `cardCount=12` |
| **G7.7** **375px + 768px admin 页均无横向溢出** | ✅ **PASS** | 探针 **375/768/1440 全 0px**（修前 @375 +603px、@768 +210px）|

**G7 = 7/7 PASS → Wave 7 可合入 `main`。**

> 🔒 **数据正确性类门槛（G7.5 / G7.6）零豁免，实测 PASS。**
> **G3.4 回归**：全站 11 页 **0 critical / 0 serious / 0 moderate / 0 minor**。

---

## 1. 实测原始数据

### G7.1 / G7.5 —— 备份恢复（真跑，零 mock）

```
✓ backup_restore_sqlite：造库 → 备份 → 删改数据 → 恢复 → 逐行一致（COUNT(*) + 关键行内容）
✓ backup_restore_sqlite：白名单：非 business.db.YYYY-MM-DD 形态的文件名一律拒绝恢复（且不碰库文件）
✓ backup_restore_duckdb：COPY TO parquet → COPY FROM 恢复 → COUNT(*) 与源库一致
✓ backup_restore_duckdb：SDD 指定的 COPY TO PARQUET GZIP → 恢复 → COUNT(*) 一致
✓ backup_restore_duckdb：恢复出来的数据内容与源库一致（symbol / date / close 抽样比对）
✓ backup_restore_duckdb：备份产物落在临时 BACKUP_DIR，且不触碰真实行情库 data/quotes.duckdb
```

**独立取证脚本**（临时 DuckDB，与真库无关）：
```
[源库] v_stock_qfq COUNT(*) = 6
[备份] COPY TO PARQUET GZIP → 1518 字节，文件头 = PAR1
[恢复] COPY FROM → COUNT(*) = 6
[恢复] 抽样内容 = [{sh600001,2026-10-09,10.1}, …共 6 行]
=== 源库 COUNT(*)=6；恢复后 COUNT(*)=6；相等 = true   exit code = 0 ===
```

**变异验证**（证明载体有鉴别力）：注释掉恢复里的 `fs.copyFileSync` → 用例红（`expected 2 to be 3`）⇒ **非假绿**。

### G7.4 —— 11 个 admin 端点逐端点 403

| # | 端点 | 来源 | 结果 |
|---|---|---|---|
| 1 | `GET /api/admin/system-log` | admin.ts | 403 `FORBIDDEN` + 零副作用 |
| 2 | `GET /api/admin/system-log/fallback` | admin.ts | 403 + 零副作用 |
| 3 | `GET /api/admin/backups` | admin.ts | 403 + 零副作用 |
| 4 | `GET /api/admin/users` | admin.ts | 403 + 零副作用 |
| 5 | `PATCH /api/admin/role/:userId` | admin.ts | 403 + 零副作用（目标=自己）|
| 6 | `POST /api/admin/rerun-quotes` | admin.ts | 403 + 零副作用 |
| 7 | `POST /api/admin/backup` | admin.ts | 403 + 零副作用 |
| 8 | `POST /api/admin/backup/:file/restore` | admin.ts | 403 + 零副作用（带 `confirm:true`）|
| 9 | `POST /api/admin/run-signal` | admin.ts | 403 + 零副作用 |
| 10 | `POST /api/admin/datacheck/trigger` | admin.ts | 403 + 零副作用 |
| 11 | `GET /api/admin/datacheck/result` | **dataCheck.ts** | 403 + 零副作用 |

每条还断言 `code=error=FORBIDDEN` / `success=false` / `data=null` / message 非空
+ **请求前后副作用快照**（`trigger_manual`/`backup` 日志数、普通用户角色、备份目录文件列表）**完全相同**。

**清单漂移守卫**：从源码字面量正则抽取端点做**精确集合比对**（双向）⇒
变异新增 `GET /api/admin/mutation-endpoint` → 守卫红（`未被 G7.4 清单覆盖`）。

**鉴权顺序变异**：把 `POST /api/admin/datacheck/trigger` 的 `writeSystemLog` 挪到 role 校验**之前**
（响应仍 403）→ 载体仍红（`产生了副作用（鉴权顺序危险）`）
⇒ **当前 11/11 的 role 校验都在 handler 第一条语句**（副作用之前）—— **未发现「鉴权在副作用之后」的危险端点**。

### G7.6 —— 12 项校验卡片 + 名称逐字比对

`checkId` 集合 = `{C1,…,C12}`（**12 条，不多不少，无 C13+ 扩展校验混入**）。

| # | SDD §5.7 小节标题（权威）| API `name` | DOM 卡片名 | 逐字一致 |
|---|---|---|---|---|
| C1 | 当日日线行数是否正常 | 同左 | 同左 | ✅ |
| C2 | 交易日历匹配 | 同左 | 同左 | ✅ |
| C3 | 复权因子数据新鲜度 | 同左 | 同左 | ✅ |
| C4 | 除权除息数据新鲜度 | 同左 | 同左 | ✅ |
| C5 | 板块 / 概念数据完整性（含「 / 」空格）| 同左 | 同左 | ✅ |
| C6 | 市值数据存在性 | 同左 | 同左 | ✅ |
| C7 | 日线价格合理性 | 同左 | 同左 | ✅ |
| C8 | 行情更新执行时长 | 同左 | 同左 | ✅ |
| C9 | 复权因子抽样数学一致性 | 同左 | 同左 | ✅ |
| C10 | 除权除息事件覆盖完整性 | 同左 | 同左 | ✅ |
| C11 | Tushare 免费 API 跨源校验（每日 1 次）（全角括号）| 同左 | 同左 | ✅ |
| C12 | 东财跨源校验（20 只抽样，节流）| 同左 | 同左 | ✅ |

**不一致 = 0 条**（API 12/12、浏览器 DOM 12/12）。比对基准是**直接解析 SDD.md 的 `#### Cn：标题`**，非引用代码常量。

### G7.7 —— 横向溢出（真浏览器探针）

| 视口 | scrollWidth / clientWidth | 溢出 | 修前 |
|---|---|---|---|
| 375×812 | 375 / 375 | **0px** | **+603px** |
| 768×1024 | 768 / 768 | **0px** | **+210px** |
| 1440×900 | 1440 / 1440 | **0px** | 0px |

375px 下走**卡片分支**：`admin-log-cards` 存在、20 张日志卡、日志面板内 `<table>` 为 null。

### a11y（11 页）

| | critical | serious | moderate | minor |
|---|---|---|---|---|
| 全站 11 页 | **0** | **0** | **0** | **0** |

**Wave 7 前**为 critical 0 / **serious 57** / moderate 1 ⇒ **serious 57 → 0**。

### 全量验证

| 检查 | 结果 |
|---|---|
| `npm run lint` / `npm run typecheck` | exit 0 |
| **前端全量** | **621 passed + 1 todo / 41 文件** |
| **后端全量** | **734 passed / 55 文件**，0 failed（基线 719 → +15）|
| CI 模拟（unit + `--coverage`）| 572 passed / 0 failed |
| `vite build` | ✓ |

---

## 2. G7.2 —— PRD §5.7 逐行勾对

| PRD §5.7 行 | 实现 | 状态 |
|---|---|---|
| **校验仪表盘**：12 项校验卡片，四色（PASS=绿/WARN=黄/ERROR=红/SKIP=灰）；点击卡片展开详情 JSON | `DatacheckCards.tsx` | ✅ |
| **手动触发行情更新**：按钮 + 二次确认弹窗 + 进度轮询显示 | `AdminTriggerPanel.tsx` | ✅（**进度为「轨迹」非真轮询**，见 §4.1）|
| **日志查看**：分页 + 日期过滤 + 类型过滤；显示系统日志降级记录 | `AdminLogPanel.tsx` | ✅ |
| **备份恢复**：手动备份按钮 + 备份列表（日期 + 体积）+ 恢复按钮 + 恢复前二次确认 | `AdminBackupPanel.tsx` | ✅ |
| **角色管理**：用户列表 + 升级/降级按钮（admin 仅 1 人，可转移）| `AdminRolePanel.tsx` | ⚠️（**「可转移」不可实现**，见 §4.2）|

---

## 3. G7.3 —— F-A1~F-A3 勾对

| Gap | 原描述 | 实现 | 状态 |
|---|---|---|---|
| **F-A1** | system_log 无日期过滤、无类型过滤（后端已支持，从未传）| `AdminLogPanel`（日期范围 + 类型下拉 + level 下拉）| ✅ |
| **F-A2** | 备份列表 + 恢复 UI 完全缺失 | `AdminBackupPanel` | ✅ |
| **F-A3** | 角色管理 UI 完全缺失 | `AdminRolePanel` | ✅ |

---

## 4. 口径裁决（owner 需过目）

> 本波 **19 条**裁决（D-1~D-19）。以下为需过目的部分。

| # | 事项 | 裁决 | 依据 |
|---|---|---|---|
| 4.1 | **「进度轮询」** | 实现为**进度轨迹**（「已提交 → 补跑中 → 完成（通道：…）」），**非真轮询** | 后端 `/admin/rerun-quotes` 是**同步**接口，**无任务状态端点**。后端若改异步，只需把「补跑中」换成轮询，**UI 契约不变** |
| 4.2 | **PRD §5.7「admin 仅 1 人，可转移」** | **当前后端约束下不可实现** | operator 自己是 admin ⇒ 给他人升 admin 必被「已有管理员」挡（`routes/admin.ts:155-162`）；自降级被「禁止降级当前登录账号」挡（`:150-152`）⇒ **升级路径事实上是死路** ⇒ **建议登记为 §13 偏差待办** |
| 4.3 | **「正文色 / 徽章底色」两档** | 新增 `textSuccess`/`textInfo`/`textWarning`；`textMuted`/`textFaint` 就地加深；**饱和的 `success`/`info`/`warning` 保留原值** | 饱和值加深会毁掉**深色画布**上的信号绿（画布 5.18:1 → 3.40:1）⇒ 只用于描边/色点/深色画布，**不得承载白字** |
| 4.4 | **断点方案** | 容器 padding → **CSS media query**；导航显隐 → **JS hook** | inline style 表达不了 `@media`；CSS 隐藏会让**两份导航 DOM 同时存在**（读屏读两遍）；jsdom 不解析 media query ⇒ 「侧栏不存在」无法单测；1024/768 是**形态切换**，CSS 只能显隐不能换形态 |
| 4.5 | **导航顺序** | 桌面按 **ux_v2 §1-2**（仪表盘→交易录入→条件选股→K线图→策略信号→交易复盘→候选池→设置→管理员）| PRD **未规定顺序**；移动 Tab 顺序未动 |
| 4.6 | **「主导航」可访问名** | 侧栏 / 顶栏平铺 / hamburger **互斥渲染** | 任一时刻只有一个同名 landmark（否则 axe `landmark-unique` 违规）|
| 4.7 | **ConfirmDialog 焦点落点** | 落**容器**，不落破坏性「确认」按钮 | 否则 **Enter 直接触发删除**；且会打破既有用例「按其它键 → 不触发 onConfirm」|
| 4.8 | **焦点锁定实现** | **原生** `addEventListener('keydown')` + `activeElement` + `focus()`，**不引第三方库** | 裁决；可聚焦判定**不看可见性**（jsdom `offsetParent` 恒 null，用它过滤会假绿）|
| 4.9 | **`result` 出库四态** | 落库 `SUCCESS` → 出库 `PASS` | PRD 四色 + `CheckResult` 类型 + 既有 fixture 三方一致 |
| 4.10 | **「最近一次校验」去重** | 同 checkId **保留最新**一条（原保留最旧）| 「最近一次」语义 |
| 4.11 | **校验名称唯一来源** | **后端** `validator.ts` 的 `CHECK_NAMES`；前端**只硬编码编号集合** | D-4；前端硬编码名称 = 两处真理 |
| 4.12 | **缺失项不伪造 detail** | `detail: null` + message「未运行」| 假 detail 比缺 detail 更危险 |
| 4.13 | **扩展校验不进 C 编号集合** | 后端 + 前端双白名单 | 扩展校验「不占 C 编号、不计入 12 项主表」|
| 4.14 | **降级日志端点** | 只回读尾部 200 行；**响应体不含路径**；500 不回传 fs 原始错误 | 防路径泄露 |
| 4.15 | **降级区默认折叠 + 首次展开才请求** | — | 避免每次进 Admin 页多打一个请求 |
| 4.16 | **后端日志区间** | 保留历史 `trade_date`（折算成起止同一天，**语义与旧 `log_date = ?` 完全等价**，不破坏既有调用方）；新增 `start_date`/`end_date`；只给一端 → 开区间 | — |
| 4.17 | **`log_type` 映射以「后端 CHECK 白名单」为准**（10 种）| 补齐旧表漏的 `candidate_migrate` | 单一真相源 |
| 4.18 | **`MAX_WIDTH` 保留为桌面上限** | 「fluid」= 宽度随视口变，**不是**去掉上限 | D-6 |
| 4.19 | **组件与页面的外框归属** | 带外框的（`AdminLogPanel`/`DatacheckCards`）直接用；不带的（其余 3 个）由页面提供 | 依实际，避免双层边框 |

---

## 5. 本波挖出并修复的真实缺陷

### 5.1 🔴 三个 🔒 门槛缺测试载体（**F10 / G7.4 / G7.5**）

- **G7.1/F10**：`backup_restore_sqlite` 用例**从不存在**（`backup.test.ts` 只覆盖 `backupSQLite` 的成功路径 / `_deleteOldBackups` / `db.backup` 失败 / `db.backup` 返回 undefined，**没有「备份→恢复→数据一致」的端到端**）
  ⇒ 新增 2 条（真跑，独立临时库，**不碰 `data/business.db`**）
- **G7.4**：**11 个 admin 端点逐端点 403** 的载体**从不存在**
  ⇒ 新增 13 条（含清单漂移守卫 + 越权副作用守卫）
- **G7.5**：`backup_restore_duckdb` 的 `COPY TO PARQUET GZIP → 恢复 → COUNT(*)` 载体已存在且真跑 ✅

### 5.2 🔴 `Admin.tsx` 旧内联块导致的两个硬失败

- **旧 `RESULT_COLOR` 无 `PASS` 键** ⇒ PASS 卡退化为**浅灰底白字** ⇒ **26 条 serious `color-contrast`**
- **旧内联 6 列日志表无滚动容器** ⇒ **admin@375 溢出 +603px**
  ⇒ 接线 5 个新组件 + **删 407 行**（462 → 106 行），连带删掉 **2 处 `alert()`**、旧 `RESULT_COLOR`、
  旧 `LOG_TYPE_LABEL` 副本（漏 `candidate_migrate`）、5 个 handler、5 个 interface、4 个无用 import
  ⇒ **11 条 eslint unused-var 归零**、**serious 57 → 0**

### 5.3 🔴 `klinecharts` v10 注入的 2 条 serious（**不引第三方库、不改 `node_modules`**）

- `aria-prohibited-attr`：`<div aria-label="K 线图">` **无 role** ⇒ 外层包装层加 `role="figure"`
  （**不用 `role="img"`** —— 它会把子树整体 presentational）
- `tabindex`：库注入 `tabindex="1"`（**正数 tabindex 打断自然 Tab 顺序**）⇒ 归一为 `"0"` + 补 `role="img"` + `aria-label`
  ⇒ 修后该页 `violations = []`

### 5.4 🔴 5 个 token 对比度不足（Wave 3 的 a11y 基线发现）

`textMuted` 2.54:1 · `textFaint` 3.54:1 · `info` 3.68:1 · `success` 3.30:1 · `warning` 3.19:1
⇒ 拆「正文色档 / 徽章图形档」两档，**5 个正文色取值双底均 ≥4.5:1**（4.53~7.09）

### 5.5 🔴 缺 3 个端点的 SDD §4.4 登记

`system-log/fallback` / `backups` / `backup/:file/restore` / `users` / `rerun-quotes` / `run-signal`
+ `system-log` 的 `start_date`/`end_date` + `datacheck/result` 的 `name` 与 role 校验
⇒ **前端能调的端点必须在册**（SDD 是技术契约唯一权威）⇒ 已补 11 条。

---

## 6. 本波未解决 / 移交

| # | 问题 | 归属 |
|---|---|---|
| 6.1 | ⚠️ **PRD §5.7「admin 仅 1 人，可转移」在当前后端约束下不可实现**（见 4.2）| **需 owner 裁决 + 登记 §13 偏差** |
| 6.2 | ⚠️ **「进度轮询」是进度轨迹**（后端同步接口无状态端点）| 待后端改异步后替换 |
| 6.3 | 🟠 **SDD §12.5 F10 的「`integrity_check` 全绿」子句无载体** —— 实现用 better-sqlite3 `db.backup()` 热备份（AGENTS.md 推荐，二选一），恢复后只校验 `SELECT 1` + 关键表存在 + 行数 | 需补一条 `integrity_check` 断言 |
| 6.4 | 🔴 **安全备份可能丢 WAL 数据**（`backup.ts:242`）：`fs.copyFileSync(dbPath, safetyPath)` 在 `ConfigStore.resetInstance()`（= checkpoint）**之前** ⇒ WAL 未落盘的行不在 `.pre-restore-` 备份里。修法：改用 `db.backup()`（async ⇒ 需把 `restoreSQLiteBackup` 改 async + admin 路由 await）| 独立任务（改的是生产语义）|
| 6.5 | 🟠 **plan T76 ①「`<1024px` 折叠为移动 Tab 栏」与 PRD §5.8 #6 冲突**（PRD 列 5 项）⇒ 按 D-7 执行（顶栏承担），**不自行裁决** | **需 owner 裁决 + 登记 §13 偏差** |
| 6.6 | 🟠 **移动 Tab 现 6 项**（PRD §5.8 #6 列 5 项，多「候选池」+ admin 的「管理」）| 同 6.5 |
| 6.7 | 🟠 **PRD §5.9 的隐私声明已落在 `/login`**（前端无独立注册页路由，注册表单将来补时需两处都留）| — |
| 6.8 | 🟡 **开发库里落库的校验结果是「历史脏批次」**：9 条 ERROR + 3 条 SKIP，detail 是 `Catalog Error: Table with name v_stock_qfq does not exist!`（跑在 12KB 空壳库上）与 `ARRAY_AGG(... LIMIT)` 语法错 —— **T85 重写前的老实现**留下的旧记录，**不是当前代码缺陷**（当前实现对真库重跑 12 条全 SKIP、无 SQL 报错）| ⚠️ **Wave 8 汇总时会被误读成引擎故障** ⇒ 需在 §13 注明来源 |
| 6.9 | 🟡 `data/business.db` 的 `system_log` 仍有 **14 条假日期 `2026-99-99`** 的 datacheck 行（代码已用「真实日历日 + ≤今天」过滤规避）| 是否清数据待定 |
| 6.10 | 🟡 **AGENTS.md 的 CI 模拟配方有缺陷**：`DUCKDB_PATH=/tmp/nonexistent-q.duckdb` 会让 `setup.ts` 的 `resolveMarketData()` 被跳过（「文件显式设 DUCKDB_PATH」优先）⇒ t55/t67 从 skip 变 fail（**基线同样 fail**，pre-existing）| 需修配方 |
| 6.11 | 🟡 **vite proxy target 写死 8080** ⇒ 手测 admin 页会 404（须走探针的 `page.route` 改写）| 开发体验 |
| 6.12 | 🟡 `apps/backend/dist/` 是过期构建产物（16:51 vs src 17:57）⇒ **只改 src 不重建就起 dist，运行时门槛会测到旧代码** | 流程 |
| 6.13 | 🟡 `.playwright-cli/`（1666 个历史文件）堆积在仓库内（已 gitignore）| 清理 |

---

## 7. 验证汇总

| 检查 | 结果 |
|---|---|
| `npm run lint` / `npm run typecheck` | exit 0 |
| **前端全量** | **621 passed + 1 todo / 41 文件** |
| **后端全量** | **734 passed / 55 文件**，0 failed |
| CI 模拟（unit + `--coverage`）| 572 passed / 0 failed |
| **G7.1 / F10** | `backup_restore_sqlite` 真跑，12 passed |
| **G7.4** | 11/11 端点 403 + 零副作用 + 漂移守卫 |
| 🔒 **G7.5** | `COPY TO PARQUET GZIP` → 恢复 → `COUNT(*)` 相等（6 → 6）|
| 🔒 **G7.6** | 12 条 checkId + 12 条 name 与 SDD §5.7 **逐字一致（0 不一致）** |
| **G7.7** | 375/768/1440 **全 0px** |
| **a11y（G3.4 回归）** | 11 页 **0 critical / 0 serious / 0 moderate / 0 minor** |
