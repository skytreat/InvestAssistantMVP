# 交互与功能组织 UX 审计报告（2026-10-30）

## 1. 结论摘要

- 审计对象：测试环境（地址略），`admin` 账号。
- 审计重点：交互复杂性、功能组织、危险操作位置与防护；**不评价配色、排版美观度**。
- 结论：券商对账域存在 **2 个 P0 数据信任问题**；管理员域存在 **角色转移死锁、长页面无分区、恢复操作过于靠近日常备份** 等问题；多数危险操作已有二次确认，应保留。
- 工单总量：**P0 × 2、P1 × 6、P2 × 4、P3 × 3**，估算 **18 人天**（开发 + 自测，不含 review/联调）。

| 优先级 | 数量 | 核心问题 |
|---|---:|---|
| P0 | 2 | 切换券商后仍显示上一券商报告；手工标记后仍可补录，造成重复交易记录 |
| P1 | 6 | 券商选择器含已撤销/伪券商；导入页丢上下文；资金校验字段错位；339 条“多余”无下钻；校验值被过度脱敏；管理员角色无法转移 |
| P2 | 4 | 管理员单页堆叠；恢复操作缺少危险区；对账术语/反馈错误；主导航 14 项平铺 |
| P3 | 3 | 导入/管理员文案开发者化；日志检索效率；批次表缺筛选分页 |

## 2. 范围与方法

### 2.1 代码与环境

- 仓库：`D:\workspace\InvestAssistantMVP`。
- 仓库没有 `origin/master`；实际同步到 `origin/main`，最新 commit `c5493b3`。
- 远端未暴露构建 SHA，无法逐字确认部署版本；页面行为与本地 `origin/main` 源码一致，本报告同时给出源码定位。
- 浏览器：Playwright CLI + Microsoft Edge；会话名 `ux`。
- 视口：1440×900；另有一张管理员全页截图。
- 鉴权：测试账号 `admin`（密码由环境注入，报告不记录）；测试环境允许写操作。

### 2.2 审计范围

已覆盖：

- 全局主导航。
- 券商对账：`/broker/reconcile`。
- 券商文件导入：`/broker/import`。
- 管理员：`/admin` 的校验卡、手动触发、备份恢复、角色管理、系统日志。

未覆盖：

- 移动端/平板专项。
- 配色、字体、间距等纯视觉评价。
- 非管理员角色的页面可见性细节。
- 真实生产数据上的性能与并发。

### 2.3 证据与数据变更

证据目录：`docs/audit/assets/ux-interaction-2026-10-30/`。

本次真实写入：

- 导入批次 `#17`：`2026-10-20-国泰股票成交.xlsx`，12 行。
- 将事实行 `#8349` 标记为“已手工记录”。
- 对 `#8349` 执行“全部补录”，成功写入 1 条交易记录。
- 点击“立即备份”，生成 `business.db.2026-10-30`（8.4 MB）；DuckDB 因配置关闭而跳过。

本次仅打开并取消、未执行：

- 撤销批次。
- 恢复备份。
- 补跑行情、执行数据校验、执行信号生成。

> 若需复现干净状态，请使用独立测试库或在审计后回滚测试数据；批次 `#17` 与 `#8349` 相关记录已不是原始状态。

## 3. 工单与发现

### P0

#### UX-01 切换券商后仍显示上一券商的报告，且暴露原始 404

**现象**

在 `/broker/reconcile?brokerCode=国泰` 看到报告后，把券商切到“华宝”（该券商无有效事实层数据）：

- 下拉已显示“华宝”。
- 报告区仍显示国泰的 `事实行 12 / 已匹配 1 / 缺失 7 / 多余 339`。
- 页面出现红色原文 `Request failed with status code 404`。
- 覆盖区间、生成时间仍是上一份报告的值。

**证据**

- [19-broker-switch-stale-report.png](assets/ux-interaction-2026-10-30/19-broker-switch-stale-report.png)
- [broker-reconcile-flow.webm](assets/ux-interaction-2026-10-30/broker-reconcile-flow.webm)

**影响**

这是本次最严重的数据信任问题。管理员会把“国泰”的数字误认为“华宝”的数字，并可能据此补录、手工匹配或判断对账是否完成。错误报告比没有报告更危险。

**代码定位**

- `apps/frontend/src/pages/BrokerReconcile.tsx:126`：`loadReport()` 失败时只 `setError()`，**没有清空 `report`**。
- `apps/frontend/src/pages/BrokerReconcile.tsx:135`：直接使用 `String((e as Error).message)`，把 axios 的 `Request failed with status code 404` 暴露给用户。
- `apps/frontend/src/pages/BrokerReconcile.tsx:152`：`brokerCode` 变化时只触发加载，没有在切换瞬间清空旧状态。
- 后端 `apps/backend/src/routes/brokerReconcile.ts:65` 对无数据返回 404 `BROKER_NO_DATA`，这个语义应在前端被识别。

**建议**

- 券商变化时立即 `setReport(null)`、`setDiffRows([])`、`setSelected(new Map())`、`setConfirmResult(null)`，并进入明确的 loading 状态。
- 对 404 `BROKER_NO_DATA` 显示空态：`该券商暂无已导入流水` + `导入文件` 按钮；不要显示原始 HTTP 错误。
- 报告标题或摘要区显式显示当前 `brokerCode`，避免用户只看数字不看下拉。
- 加一条回归测试：券商 A 有报告、券商 B 无数据，切换后不得出现 A 的任何数字。

**验收标准**

1. 从有报告券商切到无数据券商，页面只显示空态和导入入口，不显示旧报告数字。
2. 页面不出现 `Request failed with status code` 等传输层原文。
3. 切换券商时旧差异明细、旧勾选、旧补录结果全部清空。
4. 自动化测试覆盖“有报告 → 无数据”切换。

**估算**：0.5 人天。  
**依赖**：无。

---

#### UX-02 “已手工记录”后仍可补录，存在重复写交易记录风险

**现象**

在对账差异表点击某行“已手工记录”：

- 没有任何确认弹窗。
- 该行立即从差异表消失。
- 但下方“补录：1 笔”面板仍保留该行，并显示 `#8349`。
- 再点击“全部补录（1 笔）”，系统返回 `成功 1 · 已存在 0 · 不可补 0`，为已经标记为手工记录的事实行新建了一条交易记录。

**证据**

- [07-broker-stale-selection.png](assets/ux-interaction-2026-10-30/07-broker-stale-selection.png)
- [06-broker-report.png](assets/ux-interaction-2026-10-30/06-broker-report.png)：操作前状态。
- [broker-reconcile-flow.webm](assets/ux-interaction-2026-10-30/broker-reconcile-flow.webm)

**影响**

管理员以为“已手工记录”只是把事实行标记为已核对，实际仍可把它补录成业务交易。由于该按钮和“补录”面板在同一个长页面，且选中项不会清除，很容易造成重复交易记录。交易记录是业务层核心数据，重复写入会影响持仓、成本和收益。

**代码定位**

- `apps/frontend/src/pages/BrokerReconcile.tsx:246`：`markManuallyRecorded()` 只调用 `/match`，没有确认、没有清空 `selected`。
- `apps/frontend/src/pages/BrokerReconcile.tsx:529`：补录面板只判断 `selected.size > 0`，不校验该事实行是否已 `MATCHED`。
- `apps/backend/src/services/broker/brokerConfirm.ts:160-167`：`loadFactRows()` 只排除 `EXCLUDED`，`MATCHED` 仍进入候选集合。
- `apps/backend/src/services/broker/brokerConfirm.ts:203-210`：只把“已有活交易锚点”的行归入 `alreadyIds`。
- `apps/backend/src/services/broker/brokerConfirm.ts:253`：补录循环只跳过“已有活交易锚点”的行，**不跳过 `match_status='MATCHED'` 但无锚点的行**。
- `apps/backend/src/services/broker/brokerConfirm.ts:347`：`markAsManuallyRecorded()` 允许 `tradeRecordId=null`，只改事实层状态，不建立业务层锚点。

**建议**

- “已手工记录”改为确认弹窗，二选一：
  - 关联一条已有交易记录（传 `tradeRecordId`，校验标的）；
  - 仅标记事实层，并明确提示“以后不可再补录，需先撤销标记”。
- 标记成功后从 `selected` 中删除该行；若面板为空则收起。
- 补录接口对 `match_status='MATCHED'` 且无 `source_broker_record_id` 锚点的行返回 409 或 `already`，禁止新建。
- 补录前增加最终确认，列出“将写入 N 条交易记录”的标的、日期、类型。
- 加回归测试：标记 → 尝试补录 → 不产生新记录。

**验收标准**

1. “已手工记录”有明确确认，不能一键静默改状态。
2. 标记后该行从补录面板移除，不能再次补录。
3. 已标记但未关联交易记录的事实行，补录接口拒绝写入。
4. 测试数据中不会出现同一事实行对应两条活交易记录。

**估算**：1.5 人天。  
**依赖**：需要后端 `brokerConfirm.ts` / `brokerReconcile.ts` 配合。

---

### P1

#### UX-03 券商选择器包含已撤销、伪券商和疑似重复编码

**现象**

对账页券商下拉包含：

`国泰`、`华宝`、`未识别`、`hb`

其中：

- `未识别` 是导入分组键，不是真实券商。
- `华宝` 和 `hb` 疑似同一券商的两种写法。
- `华宝`、`未识别`、`hb` 对应批次均已撤销或无有效数据，但仍在可选列表。
- 选中“华宝”后得到 404，直接触发 UX-01 的旧报告残留。

**证据**

- [19-broker-switch-stale-report.png](assets/ux-interaction-2026-10-30/19-broker-switch-stale-report.png)
- [03-broker-import-initial.png](assets/ux-interaction-2026-10-30/03-broker-import-initial.png)：批次表中可见 `华宝`、`未识别`、`hb` 均为已撤销。

**代码定位**

- `apps/frontend/src/pages/BrokerReconcile.tsx:108`：券商下拉直接取 `/broker-import/batches` 的所有 `broker_code`，没有按 `status` 过滤，也没有规范化别名。
- `apps/frontend/src/pages/BrokerImport.tsx:191-198`：分组键在无推断时回退为字面量 `未识别`，用于展示与确认按钮标签。
- `apps/frontend/src/pages/BrokerImport.tsx:310-321`：券商标识仅校验“非空”，任意字符串（包括 `未识别`）都可落库；批次表中已有该伪编码。

**建议**

- 对账下拉只列“有有效事实层数据”的券商；至少过滤 `status='revoked'` 和空编码。
- 不把 `未识别` 作为可选券商；导入时必须要求用户填写真实券商标识。
- 建立券商别名/规范名映射（如 `hb` → `华宝`），或在 UI 同时显示“编码 + 名称”。
- 空状态提供“去导入”入口，而不是让用户选一个必然 404 的项。

**验收标准**

1. 下拉中不出现 `未识别`。
2. 已撤销批次不再出现在对账券商下拉。
3. 同一券商不会以两个编码重复出现（或明确显示为别名）。
4. 选择无数据券商时显示空态，不触发旧报告残留。

**估算**：1.0 人天。  
**依赖**：UX-01；如需别名表，需产品确认券商主数据来源。

---

#### UX-04 导入页丢失 `brokerCode` 上下文，确认按钮标签与完成态错误

**现象**

1. 从对账页点击“导入文件”跳到 `/broker/import?brokerCode=国泰`，但导入页的“券商标识”输入框仍为空。
2. 用户手动填入 `国泰` 后，确认按钮仍显示 `确认导入【未识别】（1 个文件）`，旁边却写着 `券商：国泰`。
3. 导入成功后，下方出现“导入完成”面板并带“查看对账报告 →”，但原确认按钮仍可点击，两个入口并存，容易误点重复导入。
4. 页面说明出现字面量 `**事实层**`，Markdown 星号未被渲染。

**证据**

- [03-broker-import-initial.png](assets/ux-interaction-2026-10-30/03-broker-import-initial.png)：URL 带 `brokerCode`，输入框为空；说明区显示 `**事实层**`。
- [05-broker-import-success.png](assets/ux-interaction-2026-10-30/05-broker-import-success.png)：按钮仍为 `确认导入【未识别】`，下方已有“导入完成 / 批次【国泰】”。

**代码定位**

- `apps/frontend/src/pages/BrokerImport.tsx:107`：组件只使用 `useNavigate`，没有读取 `useSearchParams`。
- `apps/frontend/src/pages/BrokerImport.tsx:302`：说明文案包含字面量 `**事实层**`。
- `apps/frontend/src/pages/BrokerImport.tsx:490-503`：确认按钮标签使用分组键 `key`（无推断时为 `未识别`），实际落库用 `code`；两者可同时显示。
- `apps/frontend/src/pages/BrokerImport.tsx:520-529`：成功面板渲染后，`groups` / `detects` 未清空，原确认按钮仍在，仍可重复点击。

**建议**

- 挂载时读取 `brokerCode` 并填入输入框，标记为“来自对账页”；用户可修改。
- 确认按钮文案使用实际生效的 `code`，或改成中性文案 `确认导入（N 个文件）`，避免“未识别”与“券商：国泰”同时出现。
- 保留成功面板的“查看对账报告”入口，同时禁用/替换原确认按钮，避免重复导入。
- 修复说明文案，直接写“事实层”，不要暴露 Markdown 语法。

**验收标准**

1. 从对账页带 `?brokerCode=国泰` 进入，输入框预填 `国泰`。
2. 确认按钮不再出现与实际券商不一致的 `【未识别】`。
3. 导入成功后不能再次点击同一确认按钮，并保留/强化“查看对账报告”入口。
4. 页面不再出现 `**事实层**` 字面量。

**估算**：1.0 人天。  
**依赖**：UX-01 的券商上下文规范。

---

#### UX-05 资金校验字段与后端契约错位，页面显示空白

**现象**

报告中的“资金校验（行内自洽）”显示：

`适用 · 通过 · 不适用 0`

“适用”和“通过”两个数字为空；同时没有展示校验范围、失配数量、失配分类和 `scopeNote`。

**证据**

- [06-broker-report.png](assets/ux-interaction-2026-10-30/06-broker-report.png)

**代码定位**

- 前端 `apps/frontend/src/pages/BrokerReconcile.tsx:31` 声明 `fundCheck: { applicable; passed; notApplicable; byReason }`。
- 后端 `apps/backend/src/services/broker/brokerFundCheck.ts:29` 实际返回 `{ checked; hit; notApplicable; skippedEvents; mismatch; scopeNote }`。
- 前端 `apps/frontend/src/pages/BrokerReconcile.tsx:361` 渲染 `applicable` / `passed`，这两个字段在响应里不存在，因此显示空白。

**影响**

资金校验是管理员判断“流水是否自洽”的主要入口。字段错位后，页面看起来像“0 条适用、0 条通过”，实际是“字段没取到”，会误导审计结论。

**建议**

- 前端改用 `checked` / `hit` / `notApplicable` / `skippedEvents` / `mismatch.length`。
- 显示 `scopeNote`，明确“仅交割侧、有成交金额的买卖/申赎系事件参与校验”。
- 显示失配分类计数（`fee_conflict` / `dividend` / `unknown`），并提供查看失配行的入口。
- 在类型层建立共享契约或至少加响应形状测试，防止再次错位。

**验收标准**

1. 页面显示“适用/通过/不适用/范围外/失配”五项实际数字。
2. 页面显示校验范围声明。
3. 失配行可按分类查看。
4. 前端类型与后端返回字段一致，有单元测试或契约测试。

**估算**：0.5 人天。  
**依赖**：无。

---

#### UX-06 339 条“多余”无下钻入口，缺失计数口径未解释

**现象**

报告摘要显示 `多余 339`，但：

- “多余”卡片不可点击。
- 差异明细的分类下拉只有 `unmatched / repo / cashLikeEtf / dividend / offExchange / unknown`，没有“多余”。
- 差额归因表也没有“多余”行。
- 用户无法查看这 339 条到底是什么。

同时，摘要“缺失（可补录）”与差异明细总数不一致：

- 初始：摘要缺失 `8`，差异明细 `12`。
- 标记 1 条后：摘要缺失 `7`，差异明细 `11`。

**证据**

- [06-broker-report.png](assets/ux-interaction-2026-10-30/06-broker-report.png)
- [07-broker-stale-selection.png](assets/ux-interaction-2026-10-30/07-broker-stale-selection.png)

**代码定位**

- `apps/backend/src/services/broker/brokerReconcileReport.ts:81-84`：`missing` / `extra` 统计的是 **去重后的 `asset_code + trade_date` 键**。
- `apps/backend/src/services/broker/brokerReconcileReport.ts:222-238`：差异明细按 `MISSING/FUZZY` 的 **事实行** 逐条查询，所以同一标的同一天多笔会产生多行，和去重键计数不同。
- `apps/backend/src/services/broker/brokerReconcileReport.ts:226`：`attributionDrilldown()` 的类别中没有 `extra`。
- `apps/frontend/src/pages/BrokerReconcile.tsx:328`：`多余` 只是摘要卡，没有 onClick 或链接。

**建议**

- “多余”卡片可点击，打开“系统有、事实层没有”的交易列表；后端增加对应分页查询。
- 明确标注计数口径：
  - 摘要“缺失”= 去重后的标的×日期数；
  - 差异明细“N”= 事实行数；
  - 或统一成同一种口径。
- 在摘要卡上加 tooltip/帮助文案，避免用户把 `8` 和 `12` 当成 bug。
- 归因表标单位：`repo/cashLikeEtf/dividend/offExchange/residual` 是 `ABS(cash_flow)` 金额（元），`caliberDiff` 是失配条数；两者不能共用一列单位。

**验收标准**

1. `多余 339` 可点击并看到分页明细。
2. 摘要缺失数与差异明细总数的关系有明确说明。
3. 归因表明确区分金额（元）与条数，`caliberDiff` 不再与金额混排。
4. 后端下钻接口有分页与权限测试。

**估算**：2.0 人天。  
**依赖**：需要后端新增“多余交易”查询；UX-05 可并行。

---

#### UX-07 日志脱敏规则过宽，C1/C3/C4/C6 等校验值不可读

**现象**

- C1 详情显示 `当日标的数=****（阈值 >=****）`。
- C6 显示 `当日标的数=****，其中有市值数据=****（阈值 >=****）`。
- C3/C4 日期被脱敏成 `****-10-29`、`****-11-06`。
- 系统日志中的 `size`、日期、标的数也出现 `****`。
- 管理员只能看到 PASS/SKIP 结论，无法核对实际数字与阈值。

**证据**

- [18-admin-c1-detail.png](assets/ux-interaction-2026-10-30/18-admin-c1-detail.png)
- [17-admin-logs.png](assets/ux-interaction-2026-10-30/17-admin-logs.png)

**代码定位**

- `apps/backend/src/services/logger.ts:34-39`：`maskAmount()` 用 `\b(\d{4,})(\.\d+)?\b` 匹配**任何 4 位以上数字的末 4 位**（4 位数整体变成 `****`）。
- `apps/backend/src/services/logger.ts:86`：该规则同时作用于 `message` 和 `detail`，所以日期、数量、阈值都被当成金额脱敏。

**影响**

数据校验页的核心价值是“可核对”。把校验数字和阈值都遮掉后，PASS 只剩一个无证据的标签；管理员无法判断是校验真的通过，还是校验逻辑/数据有问题。

**建议**

- 脱敏只作用于明确的敏感字段（金额、账号、token、路径中的用户名），不要对整段文本做“4 位以上数字”替换。
- 校验日志使用结构化字段（`actual` / `threshold` / `date` / `count`），展示层按字段渲染；只对敏感字段脱敏。
- 至少保留：校验计数、阈值、数据日期、阈值日期。
- 增加脱敏单元测试：`当日标的数=5561（阈值 >=5000）` 不应被改变；真实金额/用户名仍应被遮。

**验收标准**

1. C1 详情能看到实际标的数和阈值。
2. C3/C4 能看到实际日期与阈值日期。
3. C6 能看到有市值数据的数量。
4. 金额和用户标识仍按安全要求脱敏。
5. 有测试覆盖“保留校验数字”和“遮蔽敏感信息”两类输入。

**估算**：1.0 人天。  
**依赖**：需与安全要求确认哪些字段必须脱敏。

---

#### UX-08 管理员角色转移死锁：无法降自己，也无法升级别人

**现象**

角色管理只有一名管理员 `admin`（当前登录账号）：

- `admin` 的“降级为普通用户”按钮禁用，提示“不能降级当前登录账号”。
- 其他所有用户的“升级为管理员”按钮禁用，提示“已有管理员，请先降级现任管理员”。

两条提示互相指向对方，形成一个没有出口的死锁。PRD/源码注释声称“admin 仅 1 人，可转移”，但 UI 没有转移入口。

**证据**

- [16-admin-roles.png](assets/ux-interaction-2026-10-30/16-admin-roles.png)
- [admin-flow.webm](assets/ux-interaction-2026-10-30/admin-flow.webm)

**代码定位**

- `apps/frontend/src/components/AdminRolePanel.tsx:245`：`demoteDisabled = isAdmin && isSelf`。
- `apps/frontend/src/components/AdminRolePanel.tsx:249`：`promoteDisabled = !isAdmin && hasAdmin`。
- `apps/backend/src/routes/admin.ts:187`：禁止降级自己。
- `apps/backend/src/routes/admin.ts:192`：升级时若已有其他 admin，拒绝。
- 当前没有“transfer”接口或原子操作。

**建议**

- 增加“转移管理员”流程：选择一个普通用户，确认后**同一事务内**把目标升为 admin、当前 admin 降为 user；保证始终恰好 1 个 admin。
- 或允许当前 admin 在二次确认后降级自己，并明确系统进入“无管理员”状态及恢复方式。
- 更新提示文案：不要给出无法执行的“请先降级现任管理员”。
- 增加审计日志与失败回滚测试。

**验收标准**

1. 当前唯一 admin 可以在 UI 中把管理员角色转移给另一个用户。
2. 转移后当前账号变为普通用户，目标账号成为唯一管理员。
3. 任一步失败时事务回滚，不出现 0 个或 2 个 admin。
4. 有审计日志和权限测试。

**估算**：1.5 人天。  
**依赖**：需要后端新增/调整角色接口；需产品确认“是否允许短暂无管理员”。

---

### P2

#### UX-09 管理员页是超长单页，缺少分区与定位

**现象**

`/admin` 从上到下依次堆叠：

1. C1-C12 校验卡（12 张）。
2. 手动触发（补跑行情 / 数据校验 / 信号生成）。
3. 备份与恢复（审计时备份列表 8 行，手动备份后 9 行）。
4. 角色管理（15 个用户）。
5. 系统日志（审计末次读取 12,608 条 / 631 页；审计写操作会使条数继续增长）。

页面没有 tabs、侧边子导航、锚点或折叠分区。要查看日志最底部，必须滚过前面所有模块；手动触发和备份恢复也混在同一条长滚动流里。

**证据**

- [09-admin-full.png](assets/ux-interaction-2026-10-30/09-admin-full.png)
- [09-admin-top.png](assets/ux-interaction-2026-10-30/09-admin-top.png)
- [17-admin-logs.png](assets/ux-interaction-2026-10-30/17-admin-logs.png)

**代码定位**

- `apps/frontend/src/pages/Admin.tsx:65`：单页顺序渲染 `DatacheckCards`、`AdminTriggerPanel`、`AdminBackupPanel`、`AdminRolePanel`、`AdminLogPanel`，没有分区路由或 tab 状态。

**建议**

- 改为 5 个分区：`校验` / `触发` / `备份` / `角色` / `日志`。
- 用 tabs 或左侧子导航；URL 可深链（如 `/admin?tab=logs`）。
- 每个分区保留独立 loading/error 状态；切换不丢失校验刷新。
- 日志分区默认只显示最近 1 天或 `WARN/ERROR`，避免 631 页成为默认视图。

**验收标准**

1. 管理员页有明确分区导航，任一分区可直接深链。
2. 首次进入不再渲染全部 631 页日志表。
3. 切换分区不触发无关请求。
4. 移动端/窄屏分区可折叠。

**估算**：2.0 人天。  
**依赖**：无；建议在 UX-10 之前完成，便于危险区独立。

---

#### UX-10 恢复备份按钮混在日常备份表中，缺少影响说明

**现象**

- 备份表每行一个红色“恢复”按钮，与“立即备份”同处一个普通卡片。
- 审计时备份表 8 个文件、6 个可恢复，包括 `business.db.2026-10-23`（92.0 KB）这类很早期/很小的库；手动备份后新增 1 个。
- 二次确认存在，文案是“恢复「business.db.2026-10-30」会覆盖当前业务库，操作不可撤销。确认继续？”
- 但确认框没有说明：
  - 备份覆盖到哪一天；
  - 当前库与备份的数据量差异；
  - 恢复后哪些交易/配置会丢失；
  - 是否需要重启或重新登录。

**证据**

- [10-admin-backup.png](assets/ux-interaction-2026-10-30/10-admin-backup.png)
- [21-admin-restore-confirm.png](assets/ux-interaction-2026-10-30/21-admin-restore-confirm.png)

**代码定位**

- `apps/frontend/src/components/AdminBackupPanel.tsx:324-353`：备份表内联渲染“恢复”按钮。
- `apps/frontend/src/components/AdminBackupPanel.tsx:390`：确认框只带文件名和“不可撤销”。
- `apps/frontend/src/components/AdminBackupPanel.tsx:183-209`：备份与恢复在同一组件内，未拆分危险区。

**建议**

- 把“恢复”从日常备份列表移到独立的“危险恢复区”，与“立即备份”视觉/结构分离。
- 恢复前展示：备份日期、当前库最新交易日期、备份体积、当前体积、预计丢失区间。
- 对明显异常的小备份（如 92 KB）标记“可能是测试/早期备份”，默认不提供恢复或需要额外确认。
- 高风险场景使用输入文件名确认，而不是仅点“确认恢复”。
- 保留现有二次确认与红色主按钮，不要回退。

**验收标准**

1. 恢复入口不在普通备份表行内，或至少处于独立危险区。
2. 确认框显示备份日期与影响范围。
3. 小体积/早期备份有额外警示。
4. 恢复失败可重试，成功有明确反馈。

**估算**：1.5 人天。  
**依赖**：UX-09 的分区更合适；后端可提供备份元数据。

---

#### UX-11 对账术语、反馈样式和单位不一致

**现象**

- 分类下拉显示 raw `unmatched`、`unknown`。
- 补录类型下拉显示 raw `buy/add/reduce/clear`。
- “重新对账”成功后，`对账已刷新` 用红色错误样式显示（实测 `rgb(220, 38, 38)`）。
- 差额归因表没有列头/单位，且金额行（`repo` 等）与计数行（`caliberDiff`）混排，用户无法判断单位。
- 逆回购卡片排版粘连：`年化 0%在途 0 · 数据不全 0`。

**证据**

- [06-broker-report.png](assets/ux-interaction-2026-10-30/06-broker-report.png)
- [07-broker-stale-selection.png](assets/ux-interaction-2026-10-30/07-broker-stale-selection.png)
- [20-broker-refresh-success-error-style.png](assets/ux-interaction-2026-10-30/20-broker-refresh-success-error-style.png)

**代码定位**

- `apps/frontend/src/pages/BrokerReconcile.tsx:69`：`CATEGORIES` 含 raw `unmatched` / `unknown`，`ATTR_LABELS` 没有对应中文。
- `apps/frontend/src/pages/BrokerReconcile.tsx:70`：`CONFIRM_TYPES` 为 raw `buy/add/reduce/clear`。
- `apps/frontend/src/pages/BrokerReconcile.tsx:167`：成功提示写入 `setError('对账已刷新')`，因此使用 `errorStyle`。
- `apps/frontend/src/pages/BrokerReconcile.tsx:358`：资金校验字段错位，见 UX-05。
- `apps/frontend/src/pages/BrokerReconcile.tsx:376-378`：逆回购文案用 `<br/>` 与空格拼接，窄宽度下会粘连。

**建议**

- 为 `unmatched` / `unknown` 补中文：`未匹配` / `未知`。
- 为 `buy/add/reduce/clear` 补中文：`买入/加仓/减仓/清仓`。
- 成功/失败分开状态：`setSuccess()` 或 `notice` 用成功色；`error` 只放错误。
- 归因表拆成“金额（元）”和“条数”两组/两列，或至少逐行标注单位。
- 逆回购拆成两行或使用列表，避免 `%在途` 粘连。

**验收标准**

1. 对账页不再出现 raw 英文分类/交易类型。
2. 成功提示为绿色/成功样式，错误提示才用红色。
3. 金额有单位，计数与金额不混排。
4. 逆回购卡片在 1440 与 375 宽度下都不粘连。

**估算**：1.0 人天。  
**依赖**：无。

---

#### UX-12 主导航 14 项平铺，缺少业务域分组

**现象**

桌面左侧栏依次平铺 14 项：

仪表盘、交易录入、条件选股、K线图、策略信号、交易复盘、收益、候选池、券商对账、设置、策略配置、策略有效性、组合体检、管理员。

管理员入口与“设置”同级；券商对账与交易/策略/组合页面混在一条列表里。没有分组标题、折叠或“更多”菜单。

**证据**

- [01-dashboard-1440.png](assets/ux-interaction-2026-10-30/01-dashboard-1440.png)
- [18-admin-c1-detail.png](assets/ux-interaction-2026-10-30/18-admin-c1-detail.png)

**代码定位**

- `apps/frontend/src/pages/_shared.tsx:61`：`NAV_ITEMS` 是单一扁平数组。
- `apps/frontend/src/pages/_shared.tsx:213`：平铺导航直接 `items.map`，没有分组。

**建议**

- 按业务域分组，例如：
  - 交易：仪表盘、交易录入、交易复盘、收益、组合体检；
  - 研究：条件选股、K线图、策略信号、策略配置、策略有效性、候选池；
  - 数据：券商对账；
  - 系统：设置、管理员。
- 管理员入口可移到用户菜单，减少日常导航噪音。
- 移动端折叠菜单保持同样分组；保留当前活跃态。

**验收标准**

1. 桌面导航有清晰分组标题，14 项不再一条平铺。
2. 管理员入口不再与普通业务页同级（或明确归入“系统”）。
3. 移动端菜单同步分组，键盘/读屏可访问。
4. 现有路由与权限过滤不变。

**估算**：1.5 人天。  
**依赖**：需产品确认分组命名。

---

### P3

#### UX-13 导入/管理员反馈文案开发者化

**现象**

- 导入说明出现 `**事实层**` 字面量（见 UX-04）。
- 管理员“执行数据校验”成功提示预计为 `校验完成：summaries 数量 = 12`。
- 信号生成成功提示使用 `total=... success=... timeout=... error=... inserted=...` 等英文键。
- 备份成功提示 `SQLite：成功 / DuckDB：已跳过（配置关闭）` 对普通管理员不够直观。

**代码定位**

- `apps/frontend/src/components/AdminTriggerPanel.tsx:185`：`summaries 数量`。
- `apps/frontend/src/components/AdminTriggerPanel.tsx:208`：`total=... success=...` 拼接。
- `apps/frontend/src/components/AdminBackupPanel.tsx:197`：备份结果文案。

**建议**

- 改成用户语言：`已完成 12 项校验`、`信号生成完成：共 30 个标的，成功 28，超时 1，失败 1，写入 5 条`。
- 备份：`SQLite 备份成功；行情库备份已关闭`。
- 把技术细节放到“详情”折叠区，不放在主提示。

**验收标准**

1. 主提示不出现 `summaries`、`total=` 等开发者字段名。
2. 技术细节可在详情区查看。
3. 导入说明不再出现 Markdown 星号。

**估算**：0.5 人天。  
**依赖**：UX-04。

---

#### UX-14 日志检索效率与行详情不足

**现象**

- 审计末次读取 12,608 条日志、631 页，只有“上一页/下一页”，没有页码跳转、页大小、导出。
- 1440 宽度下“类型”“校验项”列很窄，中文逐字换行，扫描困难。
- 桌面端 `detail` 只截断并用 `title` 显示全文，不能像窄屏卡片那样展开。
- 没有“仅 WARN/ERROR”快捷筛选、没有保存筛选条件。
- “降级日志”入口在 631 页分页之后，位置很深。

**证据**

- [17-admin-logs.png](assets/ux-interaction-2026-10-30/17-admin-logs.png)
- [15-admin-degraded-log.png](assets/ux-interaction-2026-10-30/15-admin-degraded-log.png)

**代码定位**

- `apps/frontend/src/components/AdminLogPanel.tsx:532`：只有上一页/下一页。
- `apps/frontend/src/components/AdminLogPanel.tsx:508`：桌面 `message`/`detail` 使用 `truncatedTextStyle`，仅 `title`。
- `apps/frontend/src/components/AdminLogPanel.tsx:563`：降级日志在分页之后。
- `apps/frontend/src/components/AdminLogPanel.tsx:101`：列定义没有列宽/优先级。

**建议**

- 增加页码跳转、每页 50/100 条、按时间倒序/正序。
- 增加 `仅 WARN/ERROR` 快捷 chip；保留现有日期/类型/级别筛选。
- 桌面行支持“展开详情”，与窄屏卡片一致；长路径可复制。
- 把“降级日志”入口移到筛选区附近或独立状态卡。
- 可选：导出当前筛选结果为 CSV（管理员数据排障）。

**验收标准**

1. 可跳转到指定页，可改页大小。
2. 桌面端可展开查看完整详情。
3. `WARN/ERROR` 一键筛选。
4. 降级日志入口不需要滚过 631 页。
5. 1440 宽度下类型/校验项不再逐字竖排。

**估算**：1.5 人天。  
**依赖**：UX-09 分区可一并处理。

---

#### UX-15 导入批次表缺少筛选、分页和当前批次高亮

**现象**

- 导入批次表有 17 行，全部平铺；没有状态筛选、券商筛选、文件名搜索、分页。
- 已撤销批次与有效批次混排。
- 最近导入的批次未必显式高亮；用户需要自己找。
- 撤销按钮在最后一列，表格横向较宽。

**证据**

- [03-broker-import-initial.png](assets/ux-interaction-2026-10-30/03-broker-import-initial.png)
- [05-broker-import-success.png](assets/ux-interaction-2026-10-30/05-broker-import-success.png)

**代码定位**

- `apps/frontend/src/pages/BrokerImport.tsx:584`：直接 `batches.map`，无筛选/分页。
- `apps/frontend/src/pages/BrokerImport.tsx:612`：撤销按钮在操作列，仅按 `status` 隐藏。

**建议**

- 增加状态筛选（全部/已导入/已撤销）、券商筛选、文件名搜索。
- 默认按 `created_at` 倒序；新导入批次高亮 3 秒或置顶。
- 超过 20 行分页；保留撤销二次确认。
- 对已撤销批次提供“重新导入”入口（复用文件？需产品确认）。

**验收标准**

1. 可按状态/券商筛选批次。
2. 新导入批次在列表中明确高亮/置顶。
3. 批次超过 20 行可分页。
4. 撤销确认与软删语义不变。

**估算**：1.0 人天。  
**依赖**：无。

## 4. 正向发现（不要回退）

- 撤销导入批次有二次确认，文案说明“软删除事实层、原始行保留、可重新导入”。见 [08-broker-revoke-confirm.png](assets/ux-interaction-2026-10-30/08-broker-revoke-confirm.png)。
- 恢复备份有二次确认，明确“覆盖当前业务库、不可撤销”，并使用危险色主按钮。见 [21-admin-restore-confirm.png](assets/ux-interaction-2026-10-30/21-admin-restore-confirm.png)。
- 手动触发三类重操作都有二次确认，且文案说明后果：
  - 补跑行情：会覆盖当日行情；
  - 数据校验：占用后端计算资源；
  - 信号生成：写入信号表。
  见 [11-admin-trigger-confirm.png](assets/ux-interaction-2026-10-30/11-admin-trigger-confirm.png)、[12-admin-datacheck-confirm.png](assets/ux-interaction-2026-10-30/12-admin-datacheck-confirm.png)、[13-admin-signal-confirm.png](assets/ux-interaction-2026-10-30/13-admin-signal-confirm.png)。
- 角色变更也有二次确认（虽然当前流程死锁，确认组件本身可保留）。见 `AdminRolePanel.tsx:325`。
- 备份、触发、恢复都有内联成功/失败反馈和重试入口，不使用阻塞式 `alert`。
- 日志面板已有日期/类型/级别筛选、分页、窄屏卡片化和降级日志查看；修复 UX-14 时不要重写这些能力。
- 对账报告的差异表支持当前页全选/部分选中（indeterminate），批量补录结果区分 `成功/已存在/不可补`，方向正确。

## 5. 建议排期

| 波次 | 工单 | 估算 | 目标 |
|---|---|---:|---|
| Wave A（立即） | UX-01、UX-02 | 2.0 人天 | 先消除数据信任与重复写入风险 |
| Wave B | UX-03、UX-04、UX-05、UX-06、UX-07、UX-08 | 7.0 人天 | 修复券商上下文、校验可读性、角色死锁 |
| Wave C | UX-09、UX-10、UX-11、UX-12 | 6.0 人天 | 管理页分区、危险区、术语、导航 |
| Wave D | UX-13、UX-14、UX-15 | 3.0 人天 | 文案、日志效率、批次管理 |
| 合计 | 15 张工单 | 18.0 人天 | 不含 review/联调 |

建议顺序：

1. **UX-01 + UX-02 先做**，两者都涉及数据正确性，且改动集中在 `BrokerReconcile.tsx` 与 `brokerConfirm.ts`，可一起回归。
2. UX-05、UX-11 可在同一 PR 做，都是报告展示契约/文案。
3. UX-09 分区完成后再做 UX-10、UX-14，避免在长页面上继续堆补丁。
4. UX-06、UX-08 需要后端接口，提前排后端资源。

## 6. 复现步骤（关键项）

### UX-01 旧报告残留

1. 登录 admin。
2. 打开 `/broker/reconcile?brokerCode=国泰`，等待报告加载。
3. 券商下拉切换到“华宝”。
4. 观察：下拉为“华宝”，报告仍是国泰的 12/1/7/339，并出现 `Request failed with status code 404`。

### UX-02 标记后仍可补录

1. 打开国泰对账报告，差异明细选一行 `MISSING`。
2. 点击“已手工记录”，观察行消失、补录面板仍显示该行。
3. 点击“全部补录”，观察 `成功 1`。
4. 检查交易记录，确认同一事实行已生成业务记录。

### UX-05 资金校验空白

1. 打开任意有报告的对账页。
2. 查看“资金校验（行内自洽）”。
3. 观察：`适用 · 通过 · 不适用 0`，前两个数字为空。

### UX-07 校验值被遮

1. 打开 `/admin`。
2. 点击 C1 卡片。
3. 观察：`当日标的数=****（阈值 >=****）`。
4. 在系统日志中查看 C3/C4/C6，日期/数量/阈值同样出现 `****`。

### UX-08 角色死锁

1. 打开 `/admin` 的角色管理。
2. 观察：当前 admin 的降级按钮禁用；其他用户升级按钮禁用，提示“已有管理员，请先降级现任管理员”。
3. 确认没有“转移管理员”入口。

### UX-10 恢复备份

1. 打开 `/admin`，滚动到“备份与恢复”。
2. 点击任一 `business.db.YYYY-MM-DD` 行的“恢复”。
3. 观察确认框只说明文件名与不可撤销，没有影响范围。
4. 取消，避免真实恢复。

## 7. 证据索引

### 截图

| 文件 | 内容 |
|---|---|
| [01-dashboard-1440.png](assets/ux-interaction-2026-10-30/01-dashboard-1440.png) | 主导航 14 项平铺 |
| [02-broker-empty-404.png](assets/ux-interaction-2026-10-30/02-broker-empty-404.png) | 无数据时的原始 404 |
| [03-broker-import-initial.png](assets/ux-interaction-2026-10-30/03-broker-import-initial.png) | 导入页 `**事实层**`、query 参数丢失、批次表 |
| [04-broker-import-detected.png](assets/ux-interaction-2026-10-30/04-broker-import-detected.png) | 探测结果与未识别分组 |
| [05-broker-import-success.png](assets/ux-interaction-2026-10-30/05-broker-import-success.png) | 成功后面板仍显示 `【未识别】` 且按钮可点 |
| [06-broker-report.png](assets/ux-interaction-2026-10-30/06-broker-report.png) | 资金校验空白、339 多余、归因无单位 |
| [07-broker-stale-selection.png](assets/ux-interaction-2026-10-30/07-broker-stale-selection.png) | 标记后 stale selection、补录面板仍在 |
| [08-broker-revoke-confirm.png](assets/ux-interaction-2026-10-30/08-broker-revoke-confirm.png) | 撤销批次确认（正向） |
| [09-admin-top.png](assets/ux-interaction-2026-10-30/09-admin-top.png) | 管理员页顶部 |
| [09-admin-full.png](assets/ux-interaction-2026-10-30/09-admin-full.png) | 管理员页全页 |
| [10-admin-backup.png](assets/ux-interaction-2026-10-30/10-admin-backup.png) | 备份列表与行内恢复按钮 |
| [11-admin-trigger-confirm.png](assets/ux-interaction-2026-10-30/11-admin-trigger-confirm.png) | 补跑行情确认（正向） |
| [12-admin-datacheck-confirm.png](assets/ux-interaction-2026-10-30/12-admin-datacheck-confirm.png) | 数据校验确认（正向） |
| [13-admin-signal-confirm.png](assets/ux-interaction-2026-10-30/13-admin-signal-confirm.png) | 信号生成确认（正向） |
| [14-admin-backup-success.png](assets/ux-interaction-2026-10-30/14-admin-backup-success.png) | 手动备份成功反馈 |
| [15-admin-degraded-log.png](assets/ux-interaction-2026-10-30/15-admin-degraded-log.png) | 降级日志展开、位置较深 |
| [16-admin-roles.png](assets/ux-interaction-2026-10-30/16-admin-roles.png) | 角色转移死锁 |
| [17-admin-logs.png](assets/ux-interaction-2026-10-30/17-admin-logs.png) | 日志表窄列、631 页、脱敏 |
| [18-admin-c1-detail.png](assets/ux-interaction-2026-10-30/18-admin-c1-detail.png) | C1 详情 `****` |
| [19-broker-switch-stale-report.png](assets/ux-interaction-2026-10-30/19-broker-switch-stale-report.png) | 切华宝后旧报告仍在 + 404 |
| [20-broker-refresh-success-error-style.png](assets/ux-interaction-2026-10-30/20-broker-refresh-success-error-style.png) | “对账已刷新”红色错误样式 |
| [21-admin-restore-confirm.png](assets/ux-interaction-2026-10-30/21-admin-restore-confirm.png) | 恢复备份确认，缺少影响范围 |

### 录屏

| 文件 | 内容 |
|---|---|
| [broker-reconcile-flow.webm](assets/ux-interaction-2026-10-30/broker-reconcile-flow.webm) | 导入、对账、差异、手工标记、补录、撤销确认 |
| [admin-flow.webm](assets/ux-interaction-2026-10-30/admin-flow.webm) | 管理员校验卡、手动触发、备份、角色、日志走查 |

### 关键源码

- `apps/frontend/src/pages/BrokerReconcile.tsx`
- `apps/frontend/src/pages/BrokerImport.tsx`
- `apps/frontend/src/pages/Admin.tsx`
- `apps/frontend/src/pages/_shared.tsx`
- `apps/frontend/src/components/AdminTriggerPanel.tsx`
- `apps/frontend/src/components/AdminBackupPanel.tsx`
- `apps/frontend/src/components/AdminRolePanel.tsx`
- `apps/frontend/src/components/AdminLogPanel.tsx`
- `apps/frontend/src/components/DatacheckCards.tsx`
- `apps/backend/src/routes/brokerReconcile.ts`
- `apps/backend/src/routes/admin.ts`
- `apps/backend/src/services/broker/brokerReconcileReport.ts`
- `apps/backend/src/services/broker/brokerFundCheck.ts`
- `apps/backend/src/services/broker/brokerConfirm.ts`
- `apps/backend/src/services/logger.ts`

## 8. 审计边界与遗留

- 本次未验证远端部署 commit 与 `origin/main@c5493b3` 完全一致；无构建 SHA 可读。
- 本次未做移动端/平板专项；管理员日志的窄屏卡片分支仅通过源码确认，未在 375px 实机走查。
- 本次未验证并发、性能与权限绕过；相关结论以后端现有测试和 SDD 为准。
- 本次未修改任何源码；仅新增本报告与 `assets/ux-interaction-2026-10-30/` 证据文件。
