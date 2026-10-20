# a11y 基线（Wave 3 · G3.4「axe 核心规则 0 critical」）

> 生成日期：2026-10-20
> 工具：`axe-core@4.14.0`（`apps/frontend/package.json` devDependencies）
> 判定人：主 agent（Wave 3 实施者）
> 上游：[`wave-2-audit.md`](./wave-2-audit.md)（G2 判定 PASS 6/6）
> 关联：[`wave-3-task-cards.md`](./wave-3-task-cards.md) 卡 8（G3.4 + G3.5 出口门槛探针）

---

## 0. 一句话结论

**G3.4 当前是 PASS 的**：现有 9 个可测页面 + 1 个真浏览器页面（`/kline`），
在 jsdom 与 Chromium 两条路径下 **critical 级违规均为 0 条**。

但**存在 6 类非 critical 违规**（`color-contrast` serious / `page-has-heading-one` moderate），
它们**只在真浏览器下可见**（jsdom 无 layout engine）—— 详见 §4。

---

## 1. 两条门禁路径

G3.4 有**两条互补**的执行路径，缺一不可：

| 路径 | 载体 | 运行环境 | 覆盖 | 能否进 CI |
|---|---|---|---|---|
| **A · jsdom 断言** | `apps/frontend/tests/unit/a11y.test.tsx` | vitest + jsdom | 9 个页面（除 `/kline`） | ✅ 能（`npm test -w @invest/frontend`） |
| **B · 真浏览器门禁** | `scripts/a11y-check.mjs` | Chromium（真渲染） | **全部 10 个页面**，**一条规则都不关** | ⚠️ 需浏览器环境 |

**为什么必须有 B**：jsdom 没有 layout engine，5 条 axe 规则不可评估（§3），
其中最关键的 `color-contrast`（文字对比度）**恰恰是本项目真实存在问题的规则**。

**为什么 A 不能省**：B 需要真起后端 + 前端 + 浏览器，不适合放进 CI 的常规门禁；
A 是「每次 `npm test` 都自动跑」的回归防线。

---

## 2. 各页面 critical 违规清单

### 2.1 jsdom 路径（`apps/frontend/tests/unit/a11y.test.tsx`）

**实测：全部为空（0 条 critical）。**

| 页面 | 路由 | critical 违规 | 全量违规（任何等级） |
|---|---|---|---|
| 登录 | `/login` | **0** | **0** |
| 仪表盘 | `/` | **0** | **0** |
| 交易录入 | `/trade` | **0** | **0** |
| 策略信号 | `/signals` | **0** | **0** |
| 条件选股 | `/stockscan` | **0** | **0** |
| 交易复盘 | `/review` | **0** | **0** |
| 设置 | `/settings` | **0** | **0** |
| 管理员 | `/admin` | **0** | **0** |
| 404 | 任意未知路径 | **0** | **0** |
| K 线 | `/kline` | — | **jsdom 无法评估**（见下） |

> ⚠️ **`/kline` 的例外**：该页用 `<canvas>` 手绘 K 线 + MACD/RSI 副图，
> jsdom 未实现 `HTMLCanvasElement.getContext('2d')`（返回 `null`）→ 组件必崩。
> 已在测试里登记为 `it.todo`，**由路径 B（真浏览器）覆盖**。

### 2.2 真浏览器路径（`scripts/a11y-check.mjs`）

**实测：10 个页面全部 0 条 critical。**

```
[a11y-check] 待检页面（10）：login, dashboard, trade, signals, kline, stockscan, review, settings, admin, notfound
[a11y-check] ✅ login（/login）：0 critical
[a11y-check] ✅ dashboard（/）：0 critical
[a11y-check] ✅ trade（/trade）：0 critical
[a11y-check] ✅ signals（/signals）：0 critical
[a11y-check] ✅ kline（/kline）：0 critical
[a11y-check] ✅ stockscan（/stockscan）：0 critical
[a11y-check] ✅ review（/review）：0 critical
[a11y-check] ✅ settings（/settings）：0 critical
[a11y-check] ✅ admin（/admin）：0 critical
[a11y-check] ✅ notfound（/__a11y_unknown_route__）：0 critical
[a11y-check] ✅ 全部 10 个页面 0 条 critical 违规 —— G3.4 通过
```

### 2.3 门禁本身的反证（negative control）

> 只断言「0 critical」无法区分「真干净」与「axe 根本没跑到东西」。
> `a11y.test.tsx` 里有一条**反证用例**：往 DOM 注入一个缺 `alt` 的 `<img>`
> （axe `image-alt`，impact=critical），断言门禁**必须报错**，
> 移除后再断言恢复绿色。

```
✓ a11y 基线 · G3.4 > 反证（negative control）：注入已知 critical 违规后，门禁断言必须失败
```

---

## 3. jsdom 下不可评估的 axe 规则（5 条）

**唯一事实源**：`apps/frontend/tests/helpers/a11y.ts` 的 `AXE_RULES_UNSUPPORTED_IN_JSDOM`。
**实测方法**：逐条规则单独跑 `axe.run(body, { runOnly: { type: 'rule', values: [id] } })`，
看返回的是 violation / incomplete / pass / inapplicable。

| # | 规则 id | jsdom 实测现象 | 为什么不可评估 | 谁兜底 |
|---|---|---|---|---|
| 1 | `color-contrast` | **incomplete**（需人工复核） | axe 判断「图标连字」要调 `canvas.getContext('2d')` 量文本宽度（axe.js `_isIconLigature`）。jsdom 未实现 canvas → 返回 `null` → axe 抛错降级为 incomplete。**顺带**会往 stderr 打 `Not implemented: HTMLCanvasElement.prototype.getContext` 噪声 | 路径 B |
| 2 | `link-in-text-block` | **inapplicable** | 与 `color-contrast` **共用同一条 canvas 颜色检测路径**。一旦页面出现「文本块内的异色链接」，jsdom 下会退化成 incomplete（静默漏检）而非给出结论 | 路径 B |
| 3 | `target-size` | **pass**（恒真） | WCAG 2.2「目标尺寸」要读 `getBoundingClientRect()` 的真实几何尺寸；jsdom 的矩形**恒为 0×0** → 恒判通过 = **假阴性** | 路径 B |
| 4 | `avoid-inline-spacing` | **pass**（恒真） | 要读行内元素的 `getClientRects()` 包围盒间距；jsdom **恒返回空数组** → 恒判通过 = **假阴性** | 路径 B |
| 5 | `scrollable-region-focusable` | **inapplicable** | 要比较 `scrollWidth/scrollHeight` 与 `clientWidth/clientHeight`；jsdom 这些值**恒为 0** → 永远判定「没有可滚动区域」 | 路径 B |

> 🔒 **扩清单的门槛**：每多关一条，G3.4 的检出能力就少一分。
> 扩清单前**必须**先跑一遍 `node scripts/a11y-check.mjs`（真浏览器）确认该规则在真实渲染下确实可用，
> 并把原因写进 `AXE_RULES_UNSUPPORTED_IN_JSDOM`。
> **不允许**为了让门禁变绿而扩大白名单。

### 3.1 为什么这 5 条**必须**关掉（而不是「留着看看」）

第 3/4/5 条（`target-size` / `avoid-inline-spacing` / `scrollable-region-focusable`）在 jsdom 下
**恒判通过** —— 留着它们会制造「已经覆盖了 WCAG 2.2 目标尺寸」的**假象**，
而实际上一个都没检。显式关掉 + 写明原因，等于把「这里有盲区」变成**显式契约**，
由真浏览器路径兜住。

---

## 4. 非 critical 违规清单（**真浏览器实测**，jsdom 看不到）

> ⚠️ 这些**不影响 G3.4 的 PASS 判定**（门槛只卡 critical），
> 但它们是**真实存在的无障碍缺陷**，Wave 3 ~ Wave 7 应择机修掉。

### 4.1 `color-contrast`（serious，WCAG 1.4.3 对比度）

| 页面 | 节点数 | 影响节点（html 片段） | 用到的 token | 当前对比度（白底） | 达标要求 |
|---|---|---|---|---|---|
| 仪表盘 | 2 | `<div style="color: rgb(156, 163, 175); …">暂无资产快照…</div>`<br>`<div style="color: rgb(156, 163, 175); font-size: 14px;">暂无持仓资产</div>` | `COLORS.textMuted` = `#9ca3af` | **2.54 : 1** ❌ | 4.5 : 1 |
| 交易复盘 | 4 | `<div style="color: rgb(156, 163, 175); font-size: 13px;">暂无历史快照…</div>`<br>`<span style="color: rgb(22, 163, 74); font-weight: 600;">买入</span>`<br>`<span style="color: rgb(156, 163, 175);">未标记</span>` ×2 | `textMuted` `#9ca3af` / `success` `#16a34a` | **2.54 : 1** ❌ / **3.30 : 1** ❌ | 4.5 : 1 |
| 设置 | 4 | `<code>rsi_oversold</code>` / `<code>macd_cross</code>` / `<code>ma_bullish_alignment</code>` / `<code>volume_breakout</code>` | `<code>` 继承 `textMuted` | **2.54 : 1** ❌ | 4.5 : 1 |
| 管理员 | **20** | `<td style="… color: rgb(59, 130, 246); font-weight: 600;">INFO</td>` ×17<br>`<td style="… color: rgb(156, 163, 175); font-weight: 600;">SKIP</td>` ×3 | `info` `#3b82f6` / `textMuted` `#9ca3af` | **3.68 : 1** ❌ / **2.54 : 1** ❌ | 4.5 : 1 |
| K 线 | 1 | `<div style="color: rgb(136, 136, 136); padding: 40px; text-align: center;">输入股票代码后点击「加载」获取K线数据</div>` | `textFaint` `#888888` | **3.54 : 1** ❌ | 4.5 : 1 |
| 404 | 1 | `<p style="… font-size: 13px; color: rgb(136, 136, 136);">该地址不存在，或对应功能尚未上线…</p>` | `textFaint` `#888888` | **3.54 : 1** ❌ | 4.5 : 1 |
| 登录 | 2 | 同「仪表盘」 | `textMuted` | **2.54 : 1** ❌ | 4.5 : 1 |
| 交易录入 / 策略信号 / 条件选股 | 0 | — | — | — | — |

**根因是 token 本身**（`apps/frontend/src/theme/tokens.ts`）：

| token | 当前值 | 白底对比度 | 判定 |
|---|---|---|---|
| `COLORS.textMuted` | `#9ca3af` | 2.54 : 1 | ❌ 远低于 4.5 |
| `COLORS.textFaint` | `#888888` | 3.54 : 1 | ❌ 低于 4.5 |
| `COLORS.info` | `#3b82f6` | 3.68 : 1 | ❌ 低于 4.5（≥18.66px 粗体 / ≥24px 才可降到 3:1）|
| `COLORS.success` | `#16a34a` | 3.30 : 1 | ❌ 低于 4.5 |
| `COLORS.textTertiary` | `#666666` | 5.74 : 1 | ✅ |
| `COLORS.neutral` | `#6b7280` | 4.83 : 1 | ✅ |
| `COLORS.danger` | `#dc2626` | 4.83 : 1 | ✅ |
| `COLORS.brandLink` | `#1d4ed8` | 6.70 : 1 | ✅ |

**建议修法（改 token 一次，全站受益）**：
把 `textMuted` / `textFaint` 调到 **≥ 4.5:1**（例如 `#6b7280` 一档的深灰），
`info` / `success` 若要继续当**正文**颜色用，也要 ≥ 4.5:1（当前两色更适合当**边框 / 徽章底色**，
徽章文字另配深色）。

> ⚠️ 这属于**视觉 Token 变更**，会牵动 `ui-spec.md` 的色板 ——
> 按 AGENTS.md「文档分层」应先在 `docs/client/ui-spec.md` 落定新值，再改 `tokens.ts`。

### 4.2 `page-has-heading-one`（moderate，WCAG 2.4.6 / best-practice）

| 页面 | 影响节点 | 原因 | 建议修法 |
|---|---|---|---|
| `/kline` | `<html lang="zh-CN">`（= 整页无 `<h1>`） | 该页标题是 **`<h2>`**（`Kline.tsx:425`）| 改成 `<h1 style={titleStyle}>K 线图（日线）</h1>`（T76 ⑦）|
| `/stockscan` | `<html lang="zh-CN">`（= 整页无 `<h1>`） | 该页标题是 **`<h2>`**（`StockScan.tsx:201`）| 改成 `<h1 style={titleStyle}>条件选股</h1>`（T76 ⑦）|

> ✅ 其余 8 个页面都有 `<h1>`（`titleStyle` 统一）。
> 📌 `/kline` 与 `/stockscan` 的归属：
> `/kline` 属 **Wave 5**（K 线页重写），`/stockscan` 属 **Wave 6**（条件选股）——
> 建议在各自重写时一并补 `<h1>`。

---

## 5. `scripts/a11y-check.mjs` 用法

### 5.1 前置条件

```bash
# 1) playwright-cli（全局，仓库的 .claude/skills/playwright-cli 技能用的就是它）
npm i -g @playwright/cli
# 2) 浏览器内核
npx playwright install chromium
# ⚠️ 本机默认浏览器是 chrome（未安装）→ 脚本默认用 --browser=chromium
```

> 本脚本**不往 package.json 里加 playwright 依赖**
> （AGENTS.md「新增 npm 依赖必须说明理由，禁止随意引入第三方库」）。

### 5.2 起服务

```bash
# 后端（提供真实数据；SQLITE_DB_PATH 必须指向当前用户可写的目录）
npm run dev -w @invest/backend

# 前端 dev server（vite，固定 127.0.0.1:5173）
npm run dev -w @invest/frontend
```

### 5.3 跑门禁

```bash
# 全部页面
node scripts/a11y-check.mjs

# 指定页面（页面名 = 路由去掉斜杠；/ → dashboard，* → notfound）
node scripts/a11y-check.mjs --pages dashboard,review,signals

# 后端不在 vite.config.ts 写死的 8080 时（例如 8080 被宿主其它服务占用）
node scripts/a11y-check.mjs --api-base-url http://127.0.0.1:8081 --username admin --password admin123

# 出 JSON 报告
node scripts/a11y-check.mjs --report /tmp/a11y-report.json
```

**完整参数**：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--base-url <url>` | `http://127.0.0.1:5173` | 前端 dev server 地址 |
| `--api-base-url <url>` | 无（直连前端代理） | 把页面里的 `/api/*` 改写到该后端地址（绕开 vite 写死的 8080） |
| `--pages <a,b,c>` | 全部 | 只查指定页面 |
| `--browser <name>` | `chromium` | playwright 浏览器 |
| `--username` / `--password` | — | 登录凭据（登录后用后端返回的**真实角色**） |
| `--token <jwt>` | — | 直接注入已签发的 token（跳过登录） |
| `--role <role>` | `user` | 注入 `--token` 时的角色 |
| `--report <file>` | — | 输出 JSON 报告 |
| `--timeout <ms>` | `60000` | 单页 axe 超时 |

**退出码**：`0` = 无 critical；`1` = 有 critical（打印规则 id / 影响节点 html / 官方修复链接）；`2` = 用法或环境错误。

### 5.4 页面清单**不硬编码**

脚本从 `apps/frontend/src/App.tsx` 的 `<Route path="…">` 解析页面清单
（`<Route path="/" element={<Dashboard />} />` → `dashboard`）。
**新增路由后自动覆盖**，避免「加了新页面却忘了加 a11y 门禁」的盲区。
与 `apps/frontend/tests/unit/a11y.test.tsx` 的 `PAGES` 常量互为对照 ——
**两处都要更新**，否则会出现「jsdom 侧没查、真浏览器侧查了」的覆盖差异。

### 5.5 实测记录（2026-10-20）

```
# 环境：后端 PORT=8081（8080 被 llama-server 占用）+ vite 5173 + Chromium
$ node scripts/a11y-check.mjs --api-base-url http://127.0.0.1:8081 \
      --username admin --password admin123 --report /tmp/opencode/a11y-report.json
[a11y-check] 目标：http://127.0.0.1:5173
[a11y-check] 待检页面（10）：login, dashboard, trade, signals, kline, stockscan, review, settings, admin, notfound
[a11y-check] /api/* 已改写到 http://127.0.0.1:8081
[a11y-check] 已注入会话（user=admin, role=admin）
... （10 个页面全部 ✅ 0 critical）
[a11y-check] ✅ 全部 10 个页面 0 条 critical 违规 —— G3.4 通过
exit=0
```

**失败路径的反证**（验证「有 critical → exit 1」这条分支真的生效）：

> 用一份**临时副本**（放 `/tmp`，**不入库**）在每次 `goto` 之后往页面注入一个缺 `alt` 的 `<img>`
> （axe `image-alt`，impact = critical），跑同一份脚本：

```
[a11y-check] ❌ login（/login）：1 条 critical
   ✗ [critical] image-alt —— Images must have alternative text
     Ensure <img> elements have alternative text or a role of none or presentation
     修复参考：https://dequeuniversity.com/rules/axe/4.14/image-alt?application=axeAPI
     - <img src="x.png">
[a11y-check] ❌ dashboard（/）：1 条 critical
   ...
[a11y-check] ❌ 共发现 2 条 critical 违规 —— G3.4 不通过
exit=1
```

⇒ **绿 / 红两条分支都实测过**，脚本不是「永远返回 0」的假门禁。

---

## 6. 给后续 Wave 的建议（**发现但本次未修**）

| # | 问题 | 影响等级 | 建议归属 | 说明 |
|---|---|---|---|---|
| 1 | `COLORS.textMuted` / `textFaint` 对比度不足（2.54 / 3.54 : 1） | serious（非 critical，不卡 G3.4）| **T76 · Wave 8**（「桌面侧边导航 + **全站 a11y 收尾** + 响应式基础」）| 改 token 会牵动 `ui-spec.md` 色板 → 先改 spec 再改代码（AGENTS.md 文档分层）|
| 2 | `COLORS.info` / `success` 当正文色时对比度不足（3.68 / 3.30 : 1） | serious | 同上（T76）| 或改用法：这两色只当**徽章底色 / 边框**，徽章文字另配深色 |
| 3 | `/kline` 用 `<h2>` 无 `<h1>`（`page-has-heading-one`） | moderate | **T76 ⑦ · Wave 8** | 计划已登记：「实测 `Kline.tsx:362`、`StockScan.tsx:197` 仍是 `<h2>`，全站统一 `titleStyle` + `h1`」（行号已漂移到 425 / 201）。**Wave 5 的 T70 会整页重写 Kline，届时顺带确认标题层级** |
| 4 | `/stockscan` 用 `<h2>` 无 `<h1>`（`page-has-heading-one`） | moderate | **T76 ⑦ · Wave 8** | 同上；Wave 6 的 T73 重写 StockScan 时顺带确认 |
| 5 | `/kline` 在 jsdom 下无法评估 | — | — | 已登记 `it.todo`，由真浏览器脚本覆盖 |
| 6 | G3.5（375px 横向溢出）探针**尚未存在** | — | **Wave 3 卡 8** | `scripts/a11y-check.mjs` **只跑 axe**，不含 `scrollWidth` 探测、也不切视口 → 需另建 `scripts/probe-overflow.mjs` |
| 7 | 仓库根 `vitest.config.ts` 无 `environment: 'jsdom'` → 在根目录跑 `npx vitest run` 会用 **node 环境**执行前端用例 | — | 可选（与本次任务无关，**先于本次任务存在**）| 实测：`npx vitest run --config vitest.config.ts apps/frontend/tests/unit/smoke.test.tsx` → `ReferenceError: document is not defined`（**存量用例同样如此**，非 a11y 引入）。CI 走 `npm run test -w @invest/frontend`（用 `apps/frontend/vitest.config.ts`）**不受影响**。a11y 用例须用 `npm run test -w @invest/frontend` 或 `cd apps/frontend && npx vitest run --config vitest.config.ts` 跑 |

> ⚠️ 第 6 条与 [`wave-3-task-cards.md`](./wave-3-task-cards.md) 卡 8 的「改哪些文件」一致 ——
> 本次任务**只做 G3.4**，不越界实现 G3.5 探针。

> 📌 **第 1~4 条的归属依据**：实施计划 T76（Wave 8）的验收标准里明确写着
> 「② axe 核心规则 0 critical」「⑦ h1/h2 层级统一（ux_v2 §3.4-1）」——
> 即**全站 a11y 收尾本就归 T76**。本次基线把「当前 0 critical」与「4 类非 critical 缺陷」
> 量化出来，供 T76 开工时直接取用。
> ⚠️ 但要注意：**T76 是 Wave 8**，在它之前这些 serious 缺陷会一直存在 ——
> 若 Wave 3~7 期间有页面改版（Dashboard / Review / Admin 的卡片化），
> **顺手把新节点的对比度做到 ≥4.5:1**，比留到 Wave 8 一次性返工便宜。

---

## 7. 复现命令

```bash
cd /opt/invol/InvestAssistantMVP

# A · jsdom 路径（CI 可跑）
npm run test -w @invest/frontend
npx vitest run --config apps/frontend/vitest.config.ts tests/unit/a11y.test.tsx

# B · 真浏览器路径（需先起后端 + 前端）
node scripts/a11y-check.mjs --api-base-url http://127.0.0.1:8081 \
      --username admin --password admin123
```

**实测数据（2026-10-20）**：

| 项 | 结果 |
|---|---|
| 前端用例总数 | **189 passed + 1 todo = 190**（Wave 2 基线 169 → 新增 21）|
| 前端 coverage | **73.9%**（Wave 2 基线 63.75% → +10.15pp，a11y 用例顺带覆盖了 Settings/StockScan/TradeInput/Admin 等此前未覆盖的页面）|
| `npx eslint .` | exit **0** |
| `npx prettier --check` | exit **0** |
| `npx tsc --noEmit -p tsconfig.test.json` | exit **0** |
| 真浏览器 a11y 门禁 | exit **0**（10 页 0 critical）|
