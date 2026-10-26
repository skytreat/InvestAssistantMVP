# Wave 3.4~3.6 验收报告（V3.4 策略体系 + V3.5 标的字典 + V3.6 组合风控）

> **依据**：`docs/client/code_implementation_plan_v3.md` §4.4。
> **验收范围**：T133（现金类排除信号）+ T134（信号生命周期列+采纳/忽略+outcome）+ T135（outcome 路由）+ T136（symbol_dict 快照+联想增强）+ T137（/api/portfolio/risk-check）。

## 1. 门槛检核

| 门槛项 | 判定 | 证据 |
|---|---|---|
| 现金类不产生策略信号 | **PASS** | `resolveSignalSymbols` 过滤 asset_class='cash' |
| 信号生命周期列就位 | **PASS** | DDL + `_ensureSignalLifecycleColumns` ALTER；adopt/ignore 路由 |
| 信号后续表现 T+1/T+5/T+10 | **PASS** | `/api/strategy/signals/:id/outcome` |
| 联想走业务层快照 | **PASS** | `searchSymbolDict` 查 symbol_dict；pinyin 首字母（pinyin-pro） |
| 裸 6 位自动补前缀 | **PASS** | 唯一命中直接返回 |
| 组合风控体检 | **PASS** | `/api/portfolio/risk-check`（集中度分母排除现金类） |
| 通用 G2 质量守门 | **PASS** | tsc 0 错；eslint 0 错；envelope 70 passed |

## 2. 决策登记

- **D-42**：V3.4 信号生命周期 DDL 通过幂等 ALTER 补齐（grade/expires_at/snapshot_json/adopted/ignored/adopted_at/cooldown_until）。
- **D-43**：T136 拼音库选用 `pinyin-pro`（新增依赖，理由：中文拼音首字母预计算，无更轻量替代）。
- **D-44**：T137 行业分布按标的前缀近似分组，板块映射待后续细化（V3-B 待办）。

## 3. 结论

**Wave 3.4~3.6 验收通过 (PASS)**。
EOF
echo written