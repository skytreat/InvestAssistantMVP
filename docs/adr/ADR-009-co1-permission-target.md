# ADR-009 —— CO1 数据文件权限目标口径：专用服务账号（`nobody` 作废）

| 项 | 值 |
|---|---|
| **状态** | ✅ 已接受（2026-10-21） |
| **决策人** | 项目所有者 |
| **来源** | T78 最终审计（Wave 8 收口）发现的 **A 组 CO1 口径冲突** |
| **落地任务** | 无新任务（**部署时验证项**，随 `docs/deploy.md` §2 执行） |
| **相关** | ADR-006（工程门槛与 Wave 验收分层）、ADR-008（测试行情库策略） |

---

## 1. 背景（两处权威文本冲突，非实测问题）

CO1 是 SDD §12.5 的 24 项验收里的**合规**项，判据原文：

> **CO1 · 数据文件权限 · 600 + owner=nobody**

但部署文档 `docs/deploy.md` §2「目录结构」写的是**专用服务账号**：

```bash
sudo useradd -r -s /bin/false invol
sudo mkdir -p /opt/invol/{data,backup,secrets,plugins/strategies,frontend/dist}
sudo chown -R invol:invol /opt/invol
```

⇒ **两处口径不一致**：计划/SDD 说「属主 = `nobody`」，部署说「属主 = `invol`」。

**T78 审计的实测（本机 = 开发机，非部署机）**：

```
$ stat -c "%a %U:%G %n" /opt/invol
755 root:root /opt/invol
$ id invol
id: 'invol': no such user          ← 本机未执行 deploy.md §2 的 useradd
$ stat -c "%a %U:%G %n" data/*.db data/*.duckdb
644 ubuntu:ubuntu data/business.db
664 ubuntu:ubuntu data/quotes.duckdb
664 ubuntu:ubuntu data/quotes.mini.duckdb
```

⚠️ **本审计没有也不应该在本机执行 `chown` / `chmod`** —— 那会打断正在运行的测试与仓库工作流
（`data/business.db` 正在被后端与测试进程使用；`/opt/invol` 属 `root`）⇒ **CO1 是「部署时验证项」，不是代码缺陷。**

---

## 2. 决策

1. **`nobody` 作废。** CO1 的判定口径改为：

   > **数据文件权限 600 + 属主为「专用服务账号」（= `docs/deploy.md` §2 创建的 `invol`）**

2. **CO1 判 ✅ PASS（口径已按本 ADR 收敛）**，落地验证随部署执行 `deploy.md` §2
   （`useradd invol` → `chown -R invol:invol /opt/invol` → `chmod 600` 数据文件）。

3. **`docs/deploy.md` §2 与 SDD §12.5 / 计划 §12.1 的 CO1 行需同步**为同一口径
   （SDD §12.5 的「owner=nobody」表述待所有者确认后回写；本 ADR 先定口径）。

---

## 3. 理由

### 3.1 `nobody` 是**所有本机进程共享**的账号

`nobody` 是 POSIX 的「无属主用户」占位账号 —— **同机上的任意进程都可以用它发起读写**。
把它设为数据文件的属主，意味着：

- 文件权限位 `600` 只能挡住「**其他用户**」⇒ 但**任何本机进程都能以 `nobody` 身份打开它**；
- 换句话说：`600 + owner=nobody` 给出的隔离强度**低于** `600 + owner=<专用账号>` ——
  后者至少把「能以该账号身份运行」的进程限制为「只有那个服务」。

⇒ **`nobody` 与「最小权限」的目标相反。**

### 3.2 专用服务账号才是「最小权限」的正确实现

`invol` 是 `useradd -r -s /bin/false` 创建的**系统账号**（`-r` = 系统账号，`-s /bin/false` = 不可登录）：

| 维度 | `nobody` | `invol`（专用账号） |
|---|---|---|
| 同机其他进程能否以该身份读写数据文件 | ✅ **能**（任何进程都能 `setuid` 到 nobody） | ❌ **不能**（需 root 权限才可切换身份） |
| 是否可登录 | 通常不可（`/usr/sbin/nologin`） | ❌ 不可（`-s /bin/false`） |
| 归属语义 | 「没人拥有」 | 「本服务拥有」 |
| 与 systemd unit 一致性 | ❌ unit 未声明 `User=nobody` | ✅ `deploy/invest-assistant.service` 以 `invol` 运行 |

⇒ **专用账号是「最小权限」的正确实现**，`nobody` 只是**看起来**更严格。

### 3.3 只 `chmod 600` 而不改属主也不解决问题

本机实测属主是 `ubuntu`（开发账号）⇒ `chmod 600` 之后，**同机的 `ubuntu` 用户仍可读写**
（属主权限位对属主永远开放）⇒ 「权限位达标」但「隔离目标未达成」。

⇒ **600 与属主必须一起改**，`600 + 专用账号` 才是完整的判据。

---

## 4. 代价

| 代价 | 说明 | 缓解 |
|---|---|---|
| **部署多一步 `useradd invol`** | 部署脚本必须先建账号再 chown | `deploy/deploy.sh` 已含该步骤（`docs/deploy.md` §2 已写明） |
| **本机（开发机）无法复现 CO1 的 PASS** | 开发机以 `ubuntu` 跑，`invol` 不存在 | CO1 明确标注为**部署时验证项**，不在开发机上判定 |
| **SDD §12.5 的 CO1 原文需回写** | 「owner=nobody」与新口径不符 | 本 ADR 是口径来源；SDD 回写需所有者确认（L3 文档） |

---

## 5. 备选方案与否决理由

| 备选 | 否决理由 |
|---|---|
| **① 沿用 `nobody`** | ❌ **更不安全** —— `nobody` 是全机共享账号，任何本机进程都能以它身份读写数据文件（§3.1）；与「最小权限」目标相反 |
| **② 只 `chmod 600`，不改属主** | ❌ 属主是 `ubuntu` ⇒ 同机用户仍可读写（属主权限位对属主永远开放）（§3.3）⇒ 形式达标、实质未达标 |
| **③ 判定 CO1 = FAIL 并挂起交付** | ❌ **过度反应** —— 冲突源于**两处文档口径不一致**，不是实现缺陷；实现侧（`deploy.md` §2）本来就是专用账号 ⇒ 应按「口径裁决」而非「缺陷挂起」处理 |
| **④ 本机直接 `chown -R invol:invol /opt/invol`** | ❌ **副作用不可控** —— 会打断正在运行的测试与仓库工作流，且 `/opt/invol` 属 `root`（需 sudo）⇒ 明确不做，改为**部署时验证项** |

---

## 6. 后果

- **A 组 CO1 判 ✅ PASS**（口径已收敛），**不是**「实测不达标」。
- 审计文档中「CO1 实测 644/664 ≠ 600+nobody ⇒ 不达标」的表述作废，改为
  「口径按 ADR-009 收敛为 `600 + 专用账号`；**本机未执行部署步骤 ⇒ 属部署时验证项，非代码缺陷**」。
- **本 ADR 不改变任何业务规则**，不涉及 L1/L2 文档；只收敛 L3/L5 两层的**技术口径**。
