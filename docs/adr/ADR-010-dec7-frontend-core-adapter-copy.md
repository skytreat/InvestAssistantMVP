# ADR-010 —— DEC-6 / DEC-7 收口：前端复制一份适配层，AGENTS.md **不修订**

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（2026-10-21） |
| **决策人** | 项目所有者 |
| **来源** | T78 最终审计（Wave 8 收口）对 §9.2「待确认」台账项 **DEC-6 / DEC-7** 的实测复核 |
| **落地任务** | 无新任务（Wave 5 已按 (b) 落地；Wave 8 只做**口径收口**） |
| **相关** | ADR-001（前端与后端技术选型）、ADR-008（测试行情库策略） |

---

## 1. 背景：DEC-6 / DEC-7 一直挂在「待确认」

实施计划 §9.2 的决策台账里有三条「待确认」：

| # | 决策 | 背景 | 当时的建议 |
|---|---|---|---|
| **DEC-6** | **适配层放 core 还是前端各写一份** | §4.3.4：适配层只有「数组补齐 5 行 + 柱值 ×2 1 行」，**不实现算法**。放 core 则两处复用一份；各写一份则 6 行写两遍 | **放 core**（窄化放开 AGENTS.md §3 只允许 import 纯算法函数） |
| **DEC-7** | **AGENTS.md 同步修订**（§4.5） | ① core「零业务依赖」→ 需为纯数学指标库开口子；② 「口径一致性靠 golden」→ 主保障已是「同库同版本锁定」，golden 降级为回归网 | 一并修订（AGENTS.md 是最高约束文件，本计划不擅自改） |
| **DEC-8** | MACD warm-up 瞬态是否需要数据订正 | 见 [ADR-011](./ADR-011-dec8-macd-warmup-drift.md) | 接受漂移 + 归档 |

**DEC-7 的前提是 DEC-6 选了 (a)「放 core」** ——
因为**只有前端要 `import` core**，才需要给 core「开口子」（放宽「零业务依赖」）。

---

## 2. 实测：DEC-6 实际走的是 (b)，DEC-7 的前提不成立

### 2.1 前端**零** `@invest/core` import

```
$ grep -rn "@invest/core" apps/frontend/src apps/frontend/tests
apps/frontend/src/indicators/kdj.ts:22: * （前端禁止 import @invest/core，故只能各存一份）。
apps/frontend/src/indicators/chartBars.ts:33: * （前端禁止 import `@invest/core`，故只能各存一份；…）。
apps/frontend/src/indicators/bollinger.ts:12: * （前端禁止 import `@invest/core`），两份必须保持字节一致。
apps/frontend/tests/unit/frontend.test.tsx:428: *    （前端禁止 import `@invest/core`）—— 两端同库同版本 ⇒ 必然逐位相同。
```

⇒ **4 处命中全是注释，0 处真实 import。**

### 2.2 两份适配层是**字节一致的副本**

```
$ diff apps/frontend/src/indicators/technical.ts packages/core/src/indicators/adapters.ts && echo IDENTICAL
IDENTICAL
$ md5sum apps/frontend/src/indicators/technical.ts packages/core/src/indicators/adapters.ts
7d13c92525275f0c1385d84644316872  apps/frontend/src/indicators/technical.ts
7d13c92525275f0c1385d84644316872  packages/core/src/indicators/adapters.ts
```

⇒ **DEC-6 §9.2 表里写的「放 core」**（即前端 import core）**并未落地**；
实际形态是 **(b)「前端复制一份适配层」** —— 且复制的**不是「6 行变换」**，
而是**整个适配层文件**（含 `calculateRSI` / `calculateMACD` / `calculateSMA` / `calculateKDJ` / `calculateBoll`）。

### 2.3 防漂移的护栏**已经落地且在 CI 里跑**

| 护栏 | 位置 | 作用 |
|---|---|---|
| **字节一致断言**（适配层） | `apps/frontend/tests/unit/kline-page.test.tsx:355` —— 读 `core/.../adapters.ts` 与 `frontend/.../technical.ts` 逐字比较 | 改一份必须同步另一份，**漂移当场红** |
| **字节一致断言**（KDJ / 布林） | `packages/core/tests/kdj.parity.test.ts:85` | 同上 |
| **golden 逐位相等**（零容差） | `packages/core/tests/fixtures/golden/{movingWeightedCost,rsi,macd,kdj}.json` + `packages/core/tests/adapters.golden.test.ts`（18 例）+ `apps/frontend/tests/unit/frontend.test.tsx` `kline_render` | 双端口径漂移当场红 |

⇒ **两份副本的漂移风险已被 CI 断言覆盖**（不是靠人工同步纪律）。

---

## 3. 决策

1. **DEC-6 实际落地形态 = (b)「前端复制一份适配层」** —— **予以追认**（事实已在 Wave 5 交付并落 CI 护栏）。
2. **DEC-7 前提不成立 ⇒ 不修订 AGENTS.md。**
   - DEC-7 的两条理由（① core 需为纯数学指标库开口子 / ② golden 降级为回归网）
     都建立在「前端 import core」之上：
     - 理由 ① **不成立** —— 前端**没有** import core ⇒ core 的依赖集合不会因前端而变化；
     - 理由 ② **部分成立但无需改文** —— 「口径一致性靠 golden 在 CI 验证」**恰恰就是当前实现**，
       且 §9.2 §4.5 描述的主保障（同库同版本锁定）在**两份副本**的场景下同样成立
       （两份副本都 import `fast-technical-indicators@1.1.6` 精确锁版本）。
3. **AGENTS.md 现有表述与实现完全一致，不改**：
   - 「apps/frontend 禁止直接 import packages/core」✅ 与 0 import 的实测一致；
   - 「算法口径一致性靠 golden 数据集在 CI 里验证」✅ 与已落地的 golden + 字节一致断言一致。
4. **§9.2 的 DEC-6 / DEC-7 状态改为「已决」**，指向本 ADR。

---

## 4. 理由

- **DEC-7 是 DEC-6 的下游决策。** 上游（DEC-6）没有按建议落地 ⇒ 下游的修订动议**失去事实基础**。
  为一份**从未发生**的依赖开口子，是**为假想问题改最高约束文件** —— 违反 AGENTS.md
  「🔒 注释不是规格。改动既有代码前，先证明『现状是错的』」的同源原则。
- **AGENTS.md 现在的文字恰好描述了现状。** 「禁止前端 import core」+「golden 保障一致性」——
  两句都是**真的**，且都被 CI 断言强制 ⇒ **不需要修订**。
- **保留禁令本身有价值**：前端 import core 会把 core 的**构建产物**（`packages/core/dist`）
  拖进前端依赖链 ⇒ 违反 AGENTS.md 记的「后端 tsconfig 无 paths ⇒ tsc 走 gitignored 的 dist」
  那类**契约漂移盲区**（T86 的教训）。禁令是**便宜的护栏**。

---

## 5. 代价

| 代价 | 说明 | 缓解 |
|---|---|---|
| **两份副本需靠 CI 防漂移** | 改 `core/.../adapters.ts` 必须同步 `frontend/.../technical.ts` | ✅ **已落地**：字节一致断言（2 处）+ golden 逐位断言（4 个 golden 文件 / 18 例）⇒ 漂移在 CI 直接红 |
| **「同一份代码」变「两份代码」** | 改算法约定要改两处 | 字节一致断言把「要改两处」变成「忘了改第二处就红」 |
| **core 的依赖升级不会自动传导前端** | 若 core 升级 `fast-technical-indicators` 版本而前端不动 ⇒ 双端口径可能分叉 | golden 逐位断言 + 字节一致断言**同时**拦住；且两份都精确锁 `1.1.6`（无 `^`） |

---

## 6. 备选方案与否决理由

| 备选 | 否决理由 |
|---|---|
| **① 现在改成「前端 import core」** | ❌ 收益仅「省 6 行变换代码」（§4.3.4 的原估），成本是**窄化 AGENTS.md §3 的最高约束** + 破坏 §9.2 DEC-7 的一致性 + 把前端构建绑到 core 的 dist 产物（gitignored 盲区）。**为省 6 行改最高约束文件，收益成本严重倒挂** |
| **② 保持现状不动（本决策）** | ✅ **采纳** —— 现状**已被实测证实**（0 import + 字节一致副本 + CI 护栏），且与 AGENTS.md 文字一致 |
| **③ 只改 AGENTS.md 的措辞（不加依赖白名单）** | ❌ 半吊子 —— 会让 AGENTS.md 与 §4.5 的原文（DEC-7 的两条理由）失去对应关系，反而制造第二处口径漂移 |
| **④ 把两份副本合并回 core（前端改用 HTTP 取指标）** | ❌ 违反 PRD §5.2「零网络请求」+ §6.3「≤300ms」⇒ 直接否 |

---

## 7. 后果

- **E 组 B5「DEC-6~DEC-8 已决策」中的 DEC-6 / DEC-7 已清**（DEC-8 见 ADR-011）。
- **AGENTS.md 不改** —— 本 ADR 是「为什么不改」的归档依据。
- 实施计划 §9.2 的 DEC-6 / DEC-7 行状态改为「✅ 已决」，指向本 ADR。
