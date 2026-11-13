# ADR-019 —— 策略配置并入设置页（/strategy/config 删除，三 Tab）

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（2026-11-12，所有者裁决） |
| **落地** | PR「行业数据源启用 + 两页合并」（`apps/frontend`） |
| **关联** | PRD_v3 §4.1（T148 原定义独立策略配置页）、SDD_v3 §13.1 路由表、plan_v3 T148 |
| **取代** | 原 `/strategy/config` 独立路由（删除，**不保留重定向**） |

---

## 1. 背景

1. **重复实现**：`Settings.tsx` 与 `StrategyConfig.tsx` 各自实现了「插件列表 + 启停 + 参数编辑」
   （同一组 API：`GET /strategy/plugins`、`PUT .../toggle`、`PUT .../config`，同一渲染器
   `PluginParamForm`），且已经漂移——Settings 保存后 `await load()` 重新拉取，
   StrategyConfig 只改本地 state。
2. **移动端不可达**：移动端底部 Tab 只有「设置」（PRD §5.8 #6），`/strategy/config` 在移动端进不去。
3. **单机应用无深链价值**：本地 SPA（127.0.0.1），没有对外分享/SEO/邮件链接，
   旧路由的唯一消费者是本人书签 ⇒ 删除 `/strategy/config` 时**不加重定向**（重定向只是心理保险，
   还要多维护一行路由 + a11y 矩阵 + 文档路由表）。

## 2. 决策

- 唯一路由 `/settings`，页内三 Tab：**插件管理 / 组合策略 / 合规声明**；
  `?tab=plugins|combos|compliance` 可直达（深链仍可用；侧栏入口见 §6 增补）。
- 插件管理唯一实现抽到 `components/PluginManager.tsx`；组合区块抽到
  `components/ComboSection.tsx`（含跨境 ETF 提示与删除确认）。
- **PRD §5.9 位置约束保留**：插件安全承诺在「插件管理」区内（`plugin-security-notice`），
  隐私声明在「合规声明」区（`privacy-notice`，仍属设置页）。
- 删除 `StrategyConfig.tsx` 与 `/strategy/config` 路由（不重定向）。

## 3. 代价

- 偏离 PRD_v3 §4.1 / T148 的「策略配置独立页面」IA（已在本 ADR + PRD_v3 §4.1 注记 +
  SDD_v3 §13.1 + plan_v3 T148 四处登记）；
- `strategy-config` 的 a11y 路由条目替换为 `settings-combos`；`/strategy/config` 的旧书签会 404。

## 4. 备选与否决

| 方案 | 否决理由 |
|---|---|
| 保留两页，只抽共享组件 | 移动端不可达、双份状态管理的问题仍在 |
| 合并 + `/strategy/config` 重定向 | 单机应用无深链消费者；多一行要维护的 legacy 路由 + 文档条目，不值 |

## 5. 验证

- 前端全量单测：**869 passed**（含 `combo-ui` / `strategy-pages` / `settings-*` / `a11y` 适配）；
- `tsc`（含 `tsconfig.test.json`）通过；eslint / prettier 通过。

---

## 6. 增补（2026-11-13，所有者裁决）：侧栏不再单列「策略配置」入口

**背景**：合并后 `/settings` 页同时承担「插件管理 / 组合策略 / 合规声明」，
但侧栏与顶栏仍保留**两个**指向 `/settings` 的入口（`/settings` 与 `/settings?tab=combos`）。

**问题**：React Router 的 `NavLink` `isActive` **只比较 pathname、不比较 search**
⇒ 停在 `/settings`（含 `?tab=combos`）时两个入口**同时命中 `isActive` ⇒ 侧栏两处同时高亮**。
要么给「策略配置」单独写 `isActive`（比 search）并把「设置」改成「非 combos 时高亮」，
要么删掉别名入口。

**决策**：**删除「策略配置」入口，只保留「设置」**。

| 理由 | 说明 |
|---|---|
| PRD 硬性入口 | PRD §5.8 #6 移动端底部 Tab 必须有「设置」；§5.9 要求隐私声明常驻设置页 ⇒ 「设置」不能删 |
| 别名已无意义 | 「策略配置」只是为找回入口而保留的别名，合并后已无独立路由 |
| Tab 承担分区职责 | 页内 Tab 栏（插件管理 / 组合策略 / 合规声明）已让「组合策略」一键可达 |
| 副作用更干净 | 删掉一个 ⇒ 双高亮问题消失，无需维护两套 `isActive` 判定 |

**保留的能力**：深链 `/settings?tab=combos` **仍然可用**（书签 / 外部跳转不受影响），
移动端底部 Tab 仍指向 `/settings`。

**代价**：侧栏少了一个直达「组合策略」的入口（需先点「设置」再切 Tab，1 次点击之差）。

**落地**：`apps/frontend/src/pages/_shared.tsx` 的 `NAV_ITEMS` 删除该条目；
`apps/frontend/tests/unit/side-nav.test.tsx` 的入口清单同步。
