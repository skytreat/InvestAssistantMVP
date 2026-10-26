# V3 实施期 —— 待确认决策记录

> **用途**：owner 授权 agent「中途需要确认的点先自决、继续推进」后，所有**自决事项**在此登记。
> owner 最后统一过一遍；任一条推翻 ⇒ 按 ADR 流程新增/修正，不留静默改动。
> **格式**：`D-N | 事项 | 自决值 | 理由 | 推翻成本 | 状态`
>
> 状态：🟡 **待 owner 确认**（默认生效中） / ✅ 已确认 / 🔴 已推翻

| # | 事项 | 自决值 | 理由 | 推翻成本 | 状态 |
|---|---|---|---|---|---|
| D-1 | **V3 任务编号**（撞 v2 T100~T111） | 整体顺延 **T119~T137**（映射表见 ADR-017） | 全仓 T 号唯一；保「一个 T 一条 commit + 按区间 revert」铁律 | 低（改前只动了 6 份文档，未写一行代码） | 🟡 |
| D-2 | U15 情绪状态枚举（T131 落库） | **5 档默认值生效**：极度兴奋/兴奋/平静/焦虑/恐慌 | owner 2026-10-24 已确认（PRD_v3 §6.1 定稿） | — | ✅ |
| D-3 | V3.1 样本文件 | 来源 `/home/ubuntu/brokertrades/成交交割单`（owner 提供，6 文件）；**入库路径 `tests/fixtures/broker-samples/`**（repo 根 tests/fixtures，与 AGENTS.md「黄金测试数据集 tests/fixtures/golden」同层；backend 单测经 `../../../../tests/fixtures/broker-samples` 相对导入，与既有 golden 导入范式一致）；入库前**脱敏**：国泰 xlsx 前 4 行元数据（资金账号 / 用户名 / 营业部名）+ 股东代码列替换为占位值，数值列不动；**原始敏感值不入仓**（manifest/决策文档不枚举原值，避免反查表 ⇒ 脱敏白做，见 D-33），6 数据文件 grep = 0 | gate G8 敏感 0；数值型断言（利息 7501.46 / 145/148 / 125/125）不依赖敏感字段 | 低（脱敏脚本可重跑；路径若需改放 `packages/...` 只需同步测试 import） | 🟡 |
| D-4 | V3 第一个 PR 的范围 | **V3.0 + V3.0b + V3.1 合成一个 PR**（T119+T120+T121~T127 + fixtures 提交） | plan_v3 §2.1 明文建议（三者互为前提，拆开产生中间态） | 中（拆 PR 需重排依赖） | 🟡（按 plan 建议执行，若 owner 要求拆，在 T121 提交前仍可拆） |
| D-5 | 阶段审计文件命名 | `docs/audit/v3-1-audit.md` / `v3-2-audit.md` …（plan 4.5 G4 规定 `v3-N-audit.md`，N = 阶段序号） | 与 v2 的 `wave-N-audit.md` 同构且 plan 已定 | 低 | ✅（plan 已定稿，仅登记） |
| D-6 | 文档 PR（#25）的验收落档名 | `docs/audit/v3-spec-gate.md` 内「实测结果」节**原地复跑更新**（不加新文件），gate 8/8 PASS + 本轮重编号后重新扫描 | gate 定义与结果同档，纯文档 PR 不必再开第二份 | 低 | 🟡 |
| D-7 | V3.2（T128/T129）的 DDL 定稿 | 前置条件已满足：v2 Wave 1-12 全部合入，`user_trade_record` 自 T49/T87 重建后无未决改动 ⇒ **V3-B3/B4 在 V3-2 开工时由 agent 依 SDD_v3 §11.2 留白直接定稿**，定稿随 T128 commit 落档 | plan §1.3 的阻塞项是「Wave 1-8 对该表改动稳定」，现已稳定 | 中（DDL 定稿后返工 = 再一次幂等表重建） | 🟡 |
| D-8 | V3 各 PR 的 CI 判定口径 | `gh pr checks` 全绿 + 本 PR gate audit 全 PASS（🔒 门槛不可豁免）→ `gh pr merge --squash`；任一 FAIL 就地修复重跑，**不 merge** | AGENTS.md「CI 是必要条件，gate 是充分条件，两者都过才 merge」 | — | ✅（规则既定，仅登记） |
| D-9 | 后续未决 Q2/Q3/Q4/Q5/Q6 | 不预先定，**到对应阶段开工时实测后定**（Q2 逆回购品种段 → T127；Q3/Q4 快照同步与拼音库 → T136；Q5 基准标的 / Q6 净值曲线 → T135/T137） | 早定无实测依据，违反 AGENTS「实现前必须实测」铁律 | — | ✅（节奏既定，仅登记） |

## 执行期追加区（V3-1 ~ V3-6 实施中新增的自决事项继续往下加）

| # | 事项 | 自决值 | 理由 | 推翻成本 | 状态 |
|---|---|---|---|---|---|
| D-10 | **「同日先送股后分红」的实现层**（T119） | 规则落在 **core**：`calculateMovingWeightedCost` 入口按 date 分组做稳定重排，组内优先级 bonus(0) < dividend(1) < 其它(2)，同级保持输入原序（含对乱序输入的鲁棒性） | Requirements INV-S4 明文「核心层必须支持，上层不得单独预处理」；除权模块同日 bonus/dividend 同为 00:00:00、靠行 id 定先后，插入顺序不可控 ⇒ 只有 core 能兜死 | 低（算法 O(n log n)，纯函数可整体回退） | 🟡 |
| D-10b | `PositionResult.cashReceived` 为**必填**（非 SDD §8.4 的「可选字段」） | 必填 number，纯函数恒返回 | 可选字段会让每个消费方写 `?? 0` 兜底，且丢失「分红已参与计算」的类型证据；core 输出侧无破坏性 | 低 | 🟡 |
| D-11 | **SDD_v3 §8.5 原文「删除 getHoldingBeforeDate 中 bonus → +quantity 分支」不执行** | T119 后该 SQL 与 core 口径**已一致**（bonus +n 净股数 ≡ core 回放），删除该 CASE 项反而造成除权基数少算 60 股的**真实回归**；保留 SQL，加注释锚点 + 回归测试（`t119-cost-semantic.test.ts`「除权前持仓含历史送股」）；SDD_v3 §8.5 的表述将在 V3-1 PR 内以 docs 提交修正（指向 D-11） | AGENTS「注释不是规格：改动既有代码前先证明现状是错的」—— 实测证明现状是对的，SDD 该句按 T119 前假设状态撰写 | 中（若 owner 认为应改为「调用 core 计算」，属纯重构、语义不变，可后续单独立任务） | 🟡 |
| D-12 | T120 资产分类**不新增管理 API 端点**（SDD §9 无独立端点） | 人工修正走 service 函数 `setManualClass`（API 暴露归 T129 补录/管理端点批次） | SDD §9 只定义 9 组端点、无资产分类端点；YAGNI，分类数据 T126 报告可列出 | 低 | 🟡 |
| D-13 | **逆回购品种段实测确认**（V3-B5/Q2 关闭） | 真库 raw_kline_daily 实测：sh204001/002/003/004/007 + sz131810/131811 有 K 线；204005/006/009、131812~131818 **未收录**（停刊/未跟踪），不入规则；样本再遇走人工修正 | AGENTS 铁律「品种段清单须实测，不得凭记忆硬编码」；`raw_symbol_class` 0 行覆盖 2040xx/1318xx（只读实测） | 低（清单是常量 Set，增删一行） | 🟡 |
| D-14 | **货币 ETF near_par 阈值重定义**（推翻 SDD 原文「最新价贴近 100」） | 近 250 交易日窗口相对振幅 ≤5% **且** 最新收盘 ∈ [90,130]（净值带） | 实测推翻 SDD 假设：货币 ETF 全史价格带 90~123（非贴 100）；近 250 日振幅 货币 ≤4.05% vs 股票/现金流/黄金 ETF ≥20.89%（4.5 倍裕量）；「现金流指数 ETF」含「现金」二字但振幅 26% ⇒ 名称关键词必须与价格带**同**成立（INV-S4-15） | 中（阈值常量在 assetClass.ts NEAR_PAR，可调） | 🟡 |
| D-15 | xlsx 读取**零新依赖** | 手写最小 zip（local header + central directory + node:zlib inflateRawSync）+ sharedStrings/sheet1 XML 正则提取 | AGENTS「新增 npm 依赖必须说明理由」：为解析券商导出文件引 sheetjs 级依赖过重；解析目标面受限（券商导出，结构固定） | 中（若遇复杂 xlsx（多 sheet/加密）需升级，已抛结构化错误兜住） | 🟡 |
| D-16 | fileKind 判定**打分制**（SDD §3.2 特征表扩展） | settle 分 = 资金余额/费用合计/发生金额/≥2 费用列加权；trade 分 = 成交时间/委托编号/剩余金额加权；取高分 | SDD 原表「资金余额或剩余金额+费用合计」不覆盖华宝交割单（有发生金额+分项费、无费用合计/资金余额）；实测 6 样本两种布局下打分全对 | 低（打分权重是常量表） | 🟡 |
| D-17 | T123 先于 T122 落 commit（任务号序与依赖序解耦） | T123（归一化纯函数）先行，T122 的 confirm 端点消费它 | confirm 落库需要 event_type（DDL NOT NULL）；按依赖序提交不违反「一个 T 一条 commit」 | 0（commit 可追溯） | ✅ |
| D-18 | 「场内 LOF 申购确认」映射 TRADE_BUY（owner 2026-10-20 决策的落地） | `LOF基金申购确认` → TRADE_BUY（成交价即净值，数量×价格=成交金额恒等）；短词「基金申购」（华宝场外）仍 → EXCLUDED_OFFEXCHANGE | af2377e 决策「场内 LOF/ETF 申购确认 → buy，7 种枚举够用」 | 低 | ✅ |
| D-19 | 上传通道 = **base64 JSON**（不引入 @fastify/multipart） | `POST /upload {filename, fileBase64, brokerCode}`，10MB 上限 | 零新依赖（AGENTS 铁律）；10MB 上限 ⇒ base64 约 13.3MB JSON，MVP 可接受 | 中（换 multipart 需前端同步改） | 🟡 |
| D-20 | 回填 L1「稳定标识（成交编号=合同序号）」通道**暂缓** | 当前 L1 = 精确内容键（同标的同日同方向同价量）；标识通道需映射模板把 tradeId 下标固化进 raw_row_json（T129 前属 V3-B8 待办） | 精确内容键命中即 100% 可靠，不弱于标识匹配；G5 基线 100% 命中已由 L1（内容键）达成 | 低（加一条 L1 通道不改 L2/L3） | 🟡 |
| D-21 | 去重/回填的「方向」按**事件语义**判定，不得用 cash_flow 符号 | REPO：出资腿=+1 / 购回腿=−1（按 raw_event_type）；CASH_LIKE：退款=流入腿 | **实测两文件符号约定不一致**：华宝逆回购出资腿在交割单 = −177000.35、在同文件成交流水 = +177000；按符号判方向会漏去重（G4 双计 3 组实测复现） | 低（directionOf 单函数） | 🟡 |
| D-22 | 货币 ETF 申赎子事件腿别：退款=流入（卖出侧）/ 扣款=流出（买入侧） | brokerFundCheck 方向正则 卖出\|赎回\|退款 | 实测 4 行（申购现金替代退款 3 + 现金差额扣款 1）按此修正后国泰交割 139/139 全命中 | 低 | 🟡 |
| D-23 | 逆回购隐含年化口径 = 本金×天数加权（1.44%），非规格 2.04%（日均口径） | 报告输出 1.44%，口径差异登记 | G9 判据只含「利息 7501.46±0.5 + 配对 180/180」（年均非判据）；两口径数学等价但分母不同（加权 vs 日均在途） | 0（展示层） | 🟡 |
| D-24 | 逆回购配对 = **金额带 [0.995,1.02] + 最小差值贪心 + 同开仓日 2~3 笔合并收回拆分**（v2） | 见 brokerCashModel.ts 注释 | 实测迭代：纯时间 FIFO 跨配 10 对负利息（最小 −39.9 万）；同日多笔（14:46/14:55 两笔）+ 合并结算（0820 一笔 1,485,060.42 = 0819 两笔 744000+741000 收回）⇒ 单腿贪心不够，需合并拆分；终态 180/180、0 负利息、利息精确 7501.46 | 中（算法整段可换，但 3 轮实测驱动，重写成本高） | 🟡 |
| D-25 | `/api/broker-reconcile/latest` **按需重算**，不建报告表 | 事实层为唯一真相源，重算幂等；MVP 规模（6 文件 1627 行）性能达标 | SDD §11 的 5 张表无报告表；YAGNI。T132 后若性能/审计需要再落表 | 低 | 🟡 |
| D-26 | T126 returnSummary = 两口径占位（现金类=逆回购利息；货币 ETF 市值收益需行情上下文未计），严格三口径归 T132 | 报告 note 字段明示占位口径 | 三口径可加性断言是 T132 的 gate；T126 结构先行（§9.2 报告结构含 returnSummary 字段） | 低 | 🟡 |
| D-27 | T126 `buildReconcileReport` = **纯读取**（不改库，供 /latest 幂等）；`attributionDrilldown` 6 类 = repo/cashLikeEtf/dividend/offExchange/unknown/unmatched；matchSummary = 系统层粗匹配（asset_code+trade_date 家族，精确匹配归 T129） | residual = UNKNOWN 的 cash_flow，**恒置顶**（order[0]） | SDD_v3 §9.2 归因逐项可下钻 + 不得「其他/未知」兜底 + 覆盖区间声明；纯读取保证 /latest 与 /run 结果一致（D-25） | 低 | ✅ |
| D-28 | **T119（V3.0）bonus 摊薄使 4 个既有测试文件期望失效**，本会话按 T119 口径更新期望（仅改测试期望，不改 src） | holding 场景5 数量 100→110 / 均价 10→1000/110；t67 weight/totalMarketValue（sh600002 bonus300 ⇒ 总市值 6780→13530）；trade G5 bonus expectQty 100→110（transfer 仍被过滤 → 100）；smoke-m5 clear 清仓量 1100→1200 + 除权事件日期移到清仓前 + realizedPnL 7592→9192 | T119 有意改 bonus 口径（SDD_v3 §8.5 / A5 偏差已消除）；旧测试钉死「bonus 被过滤」行为；按 AGENTS「改既有代码前先证明现状是错的」，逐处实测确认为**期望过期**（非 src 缺陷） | 低（纯测试期望） | ✅ |
| D-29 | T122/T126 的 10 条 broker 路由（7 导入 + 3 对账）**未入 T89b 路由遍历表**，本会话补入 | 10 条 RouteCase（POST 路由体至少给 `{}`，防 `toInput(undefined)` 触发 500 非 envelope 体） | T89b 契约要求遍历表覆盖**全部**已注册路由；T122/T126 新增路由未同步遍历表 ⇒ 该 gate 必红 | 低 | ✅ |
| D-30 | smoke-m1「7 张业务表」→「11 张」 | 期望表清单 +`asset_class`（T120）+`broker_trade_record`/`broker_import_batch`/`broker_import_template`（T122） | T120/T122 DDL 引入新表；smoke-m1 钉死表集合，未随 V3.1 同步 | 低 | ✅ |
| D-31 | broker_reconcile.test「国泰 4 份」回填计数用例改用**专属 user 7104**（不再与「回填只写成交时间」共享 7101） | 断言 `matched=109` 的用例独享 7104 | `backfillTradeTime` 一次性（trade_time 已填 ⇒ totalNeeded=0），两用例共享 7101 时 `sequence.shuffle=true` 下顺序翻转即红（实测 standalone 3 跑 2 红，证实既有隐患，非 T126 引入） | 低 | ✅ |
| D-32 | t55「真实 DuckDB 数据」板块表前置断言过期（断言 0 行，实测真库板块表现在 89928 行） | **本会话不改其断言**：该 describe 由 `MARKET_DATA_NUMERIC_AVAILABLE` 守卫，CI（无真行情库）**自动跳过**，非 gate 阻断项；在此登记真实数据现状 | 板块表新数据属 tdx2db 数据层变更；「行业过滤在真数据上的行为」应单独立任务并实测后再写断言（AGENTS：不得对未实测数据硬编码期望） | 0（仅登记，不动码） | 🟡（待 owner：是否立任务更新 t55 行业过滤基线） |

| D-33 | **脱敏映射表 / 决策文档曾复述原始敏感值**（反查表 ⇒ 脱敏失效） | 2026-10-26 复核发现：`broker-samples/README.md` 映射表「原值」列、`v3-pending-decisions.md` D-3、`v3-spec-gate.md` 复跑记录共 3 处把 8 个原始敏感值（资金账号/股东代码/营业部/用户名）写进了仓库。本次全部脱敏：README 映射表改为「列 + 格式 + 占位值」（不列原值）；D-3 / v3-spec-gate.md 删除原值枚举。G8 判定口径收紧为「全仓（含 md）grep 原值 = 0」 | AGENTS「敏感配置/token 禁止明文」同理 —— 脱敏的意义是仓库可共享；manifest 列原值等于反查表。owner 提问「README 脱敏映射是否也属敏感信息」触发 | 低（纯文档脱敏，不影响任何测试/数值基线） | ✅ |

<!-- D-34+ -->
