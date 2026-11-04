#!/usr/bin/env node
/**
 * docs-lint —— ADR-018 D4/D5/D6 的最小落地实现（零依赖，Node ≥22）
 *
 * 用法：
 *   node scripts/docs-lint.mjs --gen      # 生成 docs/status.md、docs/backlog.md、docs/tasks/INDEX.md
 *   node scripts/docs-lint.mjs --check    # 校验（生成物是否同步 + 卡 front-matter/引用/开放项上浮）
 *
 * 事实源（手维护）：docs/tasks/**.md 的 front-matter；plan_v2 §13 的开放偏差；v3-pending-decisions.md 的 D 项
 * 生成物（本脚本写）：docs/status.md、docs/backlog.md、docs/tasks/INDEX.md
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TASK_DIRS = ['docs/tasks/v3', 'docs/tasks/v2'];
const PLAN_V2 = 'docs/client/code_implementation_plan_v2.md';
const PLAN_V3 = 'docs/client/code_implementation_plan_v3.md';
const V3_PENDING = 'docs/audit/v3-pending-decisions.md';

const ACTIVE = new Set(['open', 'in_progress', 'blocked']);
const REQUIRED = ['id', 'status', 'related_tasks', 'sources'];
const CARD_SOFT_LIMIT = 4096;

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`ERROR [${where}] ${msg}`);
const warn = (where, msg) => warnings.push(`WARNING [${where}] ${msg}`);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
/** 生成物内的相对链接（生成物与卡可能不同目录，不能写仓库根相对路径） */
const relLink = (outRel, targetRel) => {
  const r = path.posix.relative(path.posix.dirname(outRel), targetRel);
  return r.startsWith('.') ? r : `./${r}`;
};

const ARCHIVE_PREFIX = 'docs/archive';
const DOC_SOURCE = /\.(md|sql)$/i;
/** 浅克隆 / 无 git 时，依赖历史的检查（D6 的 last_reviewed_commit 项）整体跳过 */
const gitAvailable = (() => {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim() !== 'true'
    );
  } catch {
    return false;
  }
})();

/** 卡声明的权威来源（sources / audit_refs / source_decision） */
function sourceEntries(c) {
  return [
    ...(c.data.sources ?? []),
    ...(c.data.audit_refs ?? []),
    ...(c.data.source_decision ? [c.data.source_decision] : []),
  ];
}

/** 锚点可定位性：`§x.y` 按 `### x.y` 标题匹配；其余按小写包含（ADR-018 D6） */
function anchorOk(content, frag) {
  const f = decodeURIComponent(frag);
  if (f.startsWith('§')) {
    const sec = f
      .slice(1)
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^#+\\s*${sec}\\b`, 'm').test(content);
  }
  return content.toLowerCase().includes(f.toLowerCase());
}

/** 来源文件是否在 last_reviewed_commit 之后被改过（D6 的过期复核 WARNING） */
function changedSince(commit, rel) {
  try {
    return (
      execFileSync('git', ['log', '--format=%H', `${commit}..HEAD`, '--', rel], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim() !== ''
    );
  } catch {
    return false;
  }
}

/** 递归收集某目录下的 .md（用于历史文档失效链接扫描） */
function walkMd(dirRel, out = []) {
  const abs = path.join(ROOT, dirRel);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) walkMd(rel, out);
    else if (entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

/** 解析极简 YAML front-matter（只支持 `key: value` 与 `key: [a, b]`） */
function parseFrontMatter(src) {
  if (!src.startsWith('---')) return { data: {}, body: src, hasFm: false };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: src, hasFm: false };
  const raw = src.slice(3, end);
  const data = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const [, k, vRaw] = m;
    const v = vRaw.trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      data[k] = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else {
      data[k] = v.replace(/^['"]|['"]$/g, '');
    }
  }
  // CRLF 文件在 `---` 后仍带一个 \r\n，先剥掉再交给链接/锚点扫描
  return { data, body: src.slice(end + 4).replace(/^\r?\n/, ''), hasFm: true };
}

/** 收集任务卡 */
function collectCards() {
  const cards = [];
  for (const dir of TASK_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!f.endsWith('.md') || f === 'INDEX.md') continue;
      const rel = `${dir}/${f}`;
      const src = read(rel);
      const { data, body, hasFm } = parseFrontMatter(src);
      cards.push({ dir, rel, file: f, data, body, hasFm, size: Buffer.byteLength(src, 'utf8') });
    }
  }
  return cards;
}

/** 解析 plan_v2 §13 的偏差表（取「未关闭」行） */
function parsePlanV2OpenDeviations() {
  const src = read(PLAN_V2);
  const start = src.indexOf('## 13. 与 PRD / SDD 的已知偏差登记');
  // 明细只取 §13.1–§13.3；收口区 = §13.4「已裁决项」+ §13.5「裁决收口」+ 附录 A「本计划关闭的 Gap → 任务映射」
  const sec134 = src.indexOf('### 13.4', start);
  const appendix = src.indexOf('## 附录 A', start);
  const detail = src.slice(start, sec134 !== -1 ? sec134 : appendix);
  const closureEnd = src.indexOf('## 附录 B', start);
  const tail = sec134 !== -1 ? src.slice(sec134, closureEnd === -1 ? undefined : closureEnd) : '';
  const idRe = /^\|\s*(?:\*\*)?((?:I|B|S|D)-\d+(?:[ab])?)(?:\*\*)?\s*\|/;
  // 收口区只认「表格行首单元格里的 ID」（允许单元格内 ID 后仍有说明文字）；
  // 正文叙述里顺带引用的编号（如「参见 S-7」）不计入，避免把未裁决项误判为已关闭。
  const cellIdRe = /^\|\s*(?:\*\*)?((?:I|B|S|D)-\d+(?:[ab])?)(?:\*\*)?(?=[\s|])/;

  const closedIds = new Set();
  for (const line of tail.split(/\r?\n/)) {
    const m = line.match(cellIdRe);
    if (m) closedIds.add(m[1]);
  }

  const items = [];
  for (const line of detail.split(/\r?\n/)) {
    const m = line.match(idRe);
    if (!m) continue;
    const id = m[1];
    // ✅ 是显式关闭标记（🟡 / 空白 = 未关闭）；§13.4 汇总 + 关键字兜底防历史写法
    const closed =
      line.includes('✅') || closedIds.has(id) || /已关闭|已修|已裁决|已复核|误报|已兑现|已落地/.test(line);
    if (!closed && !items.some((it) => it.id === id)) items.push({ id, source: PLAN_V2, line: line.trim() });
  }
  return items;
}

/** 解析 v3-pending-decisions.md（状态列非 ✅ 视为开放） */
function parseV3PendingOpen() {
  const src = read(V3_PENDING);
  const items = [];
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\|\s*((?:D)-\d+(?:[ab])?)\s*\|\s*([^|]*)\|/);
    if (!m) continue;
    const id = m[1];
    const cells = line.split('|').map((c) => c.trim());
    const status = cells[cells.length - 2] ?? '';
    if (status.includes('✅')) continue;
    items.push({ id, source: V3_PENDING, title: m[2].replace(/\*\*/g, '').trim(), status });
  }
  return items;
}

/** 全仓已知 T-ID 集合（用于 related_tasks 存在性校验） */
function knownTaskIds() {
  const ids = new Set();
  for (const rel of [PLAN_V2, PLAN_V3]) {
    if (!exists(rel)) continue;
    for (const m of read(rel).matchAll(/T(\d{2,3})([ab]?)/g)) ids.add(`T${m[1]}${m[2]}`);
  }
  return ids;
}

function genStatus(cards, openDevs, openDecs) {
  const active = cards.filter((c) => ACTIVE.has(c.data.status));
  const rows = active
    .map(
      (c) =>
        `| [${c.data.id}](${relLink('docs/status.md', c.rel)}) | ${c.data.priority ?? '—'} | ${c.data.title ?? '—'} | ${c.data.status} | ${c.data.gate ?? '—'} | ${(c.data.related_tasks ?? []).join(' ') || '—'} |`,
    )
    .join('\n');
  const anchors = cards
    .filter((c) => c.data.verified_date || c.data.verified_commit)
    .map(
      (c) =>
        `| [${c.data.id}](${relLink('docs/status.md', c.rel)}) | ${c.data.verified_date ?? '—'} | ${c.data.verified_commit ?? '—'} |`,
    )
    .join('\n');
  return `# 项目状态（生成物）

> ⚠️ **本文件由 \`npm run docs:gen\` 生成，禁止手改**。事实源：\`docs/tasks/**\` front-matter（ADR-018 D4）。
> 口径：活跃卡 = \`status ∈ {open, in_progress, blocked}\`；开放偏差/决策来自 plan_v2 §13 与 v3-pending（只统计未关闭项）。
> 图例：卡状态 \`open\` 待开工 / \`in_progress\` 进行中 / \`blocked\` 阻塞（\`closed\` 不进本表）；
> 「开放偏差」= plan_v2 §13.1–§13.3 明细行中**行内无 ✅**、且**未以行首列登记在 §13.4–§13.5 / 附录 A 收口表**的行；
> 「开放决策」= v3-pending 状态列非 ✅ 的行（🟡 = 待裁决；「已登记 → Txx」表示有承接任务，但仍未收口）。

## 概览

| 项 | 数量 |
|---|---|
| 任务卡（全部） | ${cards.length} |
| 活跃卡 | ${active.length} |
| 开放偏差（plan_v2 §13） | ${openDevs.length} |
| 开放决策（v3-pending） | ${openDecs.length} |

## 活跃卡

| ID | 优先级 | 标题 | 状态 | gate | 关联 T |
|---|---|---|---|---|---|
${rows || '| — | — | — | — | — | — |'}

## 核验锚（已核验关闭的卡）

| ID | 核验日期 | 核验提交 |
|---|---|---|
${anchors || '| — | — | — |'}

## 阅读入口

- 文档路由与 5 触发规则：[INDEX.md](INDEX.md)
- 开放项清单（只链接不复述）：[backlog.md](backlog.md)
- T 状态索引：[tasks/INDEX.md](tasks/INDEX.md)
`;
}

function genBacklog(cards, openDevs, openDecs) {
  const active = cards.filter((c) => ACTIVE.has(c.data.status));
  const cardsRows = active
    .map((c) => {
      const srcRel = c.data.source_decision || c.data.sources?.[0] || c.rel;
      return `| [${c.data.id}](${relLink('docs/backlog.md', c.rel)}) | ${c.data.title ?? '—'} | ${c.data.priority ?? '—'} | [来源](${relLink('docs/backlog.md', srcRel)}) |`;
    })
    .join('\n');
  const devRows = openDevs
    .map((d) => `| ${d.id} | 见来源原文 | [${d.source}](${relLink('docs/backlog.md', d.source)}) |`)
    .join('\n');
  const decRows = openDecs
    .map(
      (d) =>
        `| ${d.id} | ${d.title || '见来源原文'} | [${d.source}](${relLink('docs/backlog.md', d.source)}) |`,
    )
    .join('\n');
  return `# 开放项清单（生成物）

> ⚠️ **本文件由 \`npm run docs:gen\` 生成，禁止手改**。每条**只链接**到卡或来源章节，**零复述**（ADR-018 D4）。
> 「开放决策未上浮」由 \`docs-lint --check\` 兜底（ADR-018 D6）。
> 图例：只收**未关闭**项 —— 偏差 = plan_v2 §13.1–§13.3 行内无 ✅ 且未在 §13.4–§13.5 / 附录 A 收口表行首列登记；决策 = v3-pending 状态列非 ✅。
> 🟡 表示「已登记 / 待裁决、尚未收口」；「已派任务 → Txx」只说明有承接任务，**不等于**已关闭。

## 1. 活跃任务卡

| ID | 标题 | 优先级 | 决策依据 |
|---|---|---|---|
${cardsRows || '| — | — | — | — |'}

## 2. 开放偏差（plan_v2 §13）

| ID | 摘要 | 备注 |
|---|---|---|
${devRows || '| — | — | — |'}

## 3. 开放决策（v3-pending-decisions）

| ID | 事项 | 备注 |
|---|---|---|
${decRows || '| — | — | — |'}
`;
}

function genIndex(cards) {
  const rows = cards
    .map(
      (c) =>
        `| [${c.data.id}](${relLink('docs/tasks/INDEX.md', c.rel)}) | ${c.data.version ?? '—'} | ${c.data.title ?? '—'} | ${c.data.status ?? '—'} | ${c.data.priority ?? '—'} | ${(c.data.related_tasks ?? []).join(' ') || '—'} |`,
    )
    .join('\n');
  return `# 任务卡索引（生成物）

> ⚠️ **本文件由 \`npm run docs:gen\` 生成，禁止手改**。
> T-ID 只是历史计划号索引；活跃实体是 D 卡（ADR-018 D3）。

| D-ID | 版本 | 标题 | 状态 | 优先级 | 关联 T |
|---|---|---|---|---|---|
${rows || '| — | — | — | — | — | — |'}
`;
}

/** 静态检查 */
function lint(cards) {
  const cardIds = new Map();
  for (const c of cards) {
    if (!c.hasFm) {
      err('task-card', `${c.rel} 缺少 front-matter`);
      continue;
    }
    const { data } = c;
    if (ACTIVE.has(data.status)) {
      for (const k of REQUIRED) {
        if (!data[k] || (Array.isArray(data[k]) && data[k].length === 0 && k !== 'sources')) {
          err('task-card', `${c.rel} 活跃卡缺少必填字段 ${k}`);
        }
      }
    }
    if (!data.id) err('task-card', `${c.rel} 缺少 id`);
    const key = `${c.dir}#${data.id}`;
    if (cardIds.has(key)) err('task-card', `同目录 D-ID 重复：${data.id}（${c.rel} 与 ${cardIds.get(key)}）`);
    else cardIds.set(key, c.rel);

    for (const dep of data.depends_on ?? []) {
      if (dep.endsWith('.md')) {
        if (!exists(dep)) err('task-card', `${c.rel} depends_on 指向不存在的文件 ${dep}`);
      }
    }
    if (c.size > CARD_SOFT_LIMIT)
      warn('task-card', `${c.rel} 正文超软上限（${c.size}B > ${CARD_SOFT_LIMIT}B）`);

    // 卡内相对链接存在性 + 锚点可定位性
    for (const m of c.body.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^(http|https|mailto):/.test(target)) continue;
      const absRel = path.posix.normalize(path.posix.join(path.posix.dirname(c.rel), target));
      if (!exists(absRel)) err('link', `${c.rel} 链接不存在：${target}`);
      else if (m[2] && !anchorOk(read(absRel), m[2].slice(1)))
        err('anchor', `${c.rel} 链接锚点不存在：${target}${m[2]}`);
    }

    // D6① 任务卡引用已废弃规格：证据层 docs/archive 不得作为执行依据
    const refs = [...sourceEntries(c), ...(c.data.depends_on ?? []), ...(c.data.related_tasks ?? [])];
    if (refs.some((r) => r.includes(ARCHIVE_PREFIX)))
      err('deprecated', `${c.rel} 引用 docs/archive 下的已废弃规格`);
    for (const m of c.body.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (m[1].includes(ARCHIVE_PREFIX)) err('deprecated', `${c.rel} 正文链接指向 docs/archive：${m[1]}`);
    }

    // D6② 权威文档来源存在性 + 锚点
    for (const s of sourceEntries(c)) {
      const [p, frag] = s.split('#');
      if (!DOC_SOURCE.test(p)) continue;
      if (!exists(p)) err('source', `${c.rel} sources 指向不存在的文件 ${p}`);
      else if (frag && !anchorOk(read(p), frag)) err('anchor', `${c.rel} sources 锚点不存在：${s}`);
    }

    // D6④ 来源章节晚于 last_reviewed_commit 变更（浅克隆/无 git 时跳过）
    if (gitAvailable && c.data.last_reviewed_commit) {
      for (const s of sourceEntries(c)) {
        const p = s.split('#')[0];
        if (!DOC_SOURCE.test(p) || !exists(p)) continue;
        if (changedSince(c.data.last_reviewed_commit, p))
          warn('stale-review', `${c.rel} 来源已晚于 last_reviewed_commit 变更：${p}`);
      }
    }
  }

  const taskIds = knownTaskIds();
  for (const c of cards) {
    for (const t of c.data.related_tasks ?? []) {
      if (t.endsWith('.md')) {
        if (!exists(t)) err('task-card', `${c.rel} related_tasks 指向不存在的卡 ${t}`);
        continue;
      }
      if (!/^T\d{2,3}[ab]?$/.test(t)) {
        err('task-card', `${c.rel} related_tasks 格式非法：${t}`);
        continue;
      }
      if (!taskIds.has(t)) err('task-card', `${c.rel} related_tasks 引用未在计划中出现的 ${t}`);
    }
    // depends_on 的 T-ID 分支同样按 D6 判 ERROR（.md 分支已在上面查过存在性）
    for (const t of c.data.depends_on ?? []) {
      if (t.endsWith('.md')) continue;
      if (!/^T\d{2,3}[ab]?$/.test(t)) err('task-card', `${c.rel} depends_on 格式非法：${t}`);
      else if (!taskIds.has(t)) err('task-card', `${c.rel} depends_on 引用未在计划中出现的 ${t}`);
    }
  }

  // D6③ 已完成卡仍被活跃卡引用（活跃卡不应再依赖已并入产物的 closed 卡）
  const statusById = new Map(cards.filter((c) => c.data.id).map((c) => [c.data.id, c.data.status]));
  for (const c of cards) {
    if (!ACTIVE.has(c.data.status)) continue;
    for (const t of [...(c.data.related_tasks ?? []), ...(c.data.depends_on ?? [])]) {
      const id = path.posix.basename(t).replace(/\.md$/, '');
      if (statusById.get(id) === 'closed') warn('closed-ref', `${c.rel} 仍依赖已 closed 的 ${id}`);
    }
  }

  // D6⑤ 历史文档（audit/archive）失效链接
  for (const rel of [...walkMd('docs/audit'), ...walkMd('docs/archive')]) {
    for (const m of read(rel).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(http|https|mailto):/.test(target)) continue;
      const t = target.split('#')[0];
      if (!t) continue;
      const absRel = path.posix.normalize(path.posix.join(path.posix.dirname(rel), t));
      if (!exists(absRel)) warn('history-link', `${rel} 链接不存在：${target}`);
    }
  }
}

/** 生成并比对 */
function runGen(write) {
  const cards = collectCards();
  const openDevs = parsePlanV2OpenDeviations();
  const openDecs = parseV3PendingOpen();
  const outputs = new Map([
    ['docs/status.md', genStatus(cards, openDevs, openDecs)],
    ['docs/backlog.md', genBacklog(cards, openDevs, openDecs)],
    ['docs/tasks/INDEX.md', genIndex(cards)],
  ]);
  lint(cards);

  // 开放决策未上浮（ADR-018 D6）：生成物必须包含每个开放项 ID
  const backlog = outputs.get('docs/backlog.md');
  for (const d of [...openDevs, ...openDecs]) {
    if (!backlog.includes(`| ${d.id} |`)) err('backlog', `开放项未上浮：${d.id}`);
  }

  if (write) {
    for (const [rel, content] of outputs) {
      const abs = path.join(ROOT, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content.endsWith('\n') ? content : content + '\n', 'utf8');
      console.log(`docs:gen → ${rel}`);
    }
    return;
  }
  for (const [rel, content] of outputs) {
    const abs = path.join(ROOT, rel);
    const next = content.endsWith('\n') ? content : content + '\n';
    if (!fs.existsSync(abs)) err('generated', `${rel} 不存在（先跑 npm run docs:gen）`);
    else if (read(rel).replace(/\r\n/g, '\n') !== next.replace(/\r\n/g, '\n')) {
      err('generated', `${rel} 与事实源不同步（跑 npm run docs:gen 后重新提交）`);
    }
  }
}

const mode = process.argv.includes('--gen') ? 'gen' : process.argv.includes('--check') ? 'check' : '';
if (!mode) {
  console.error('用法：node scripts/docs-lint.mjs --gen | --check');
  process.exit(2);
}
runGen(mode === 'gen');

for (const w of warnings) console.log(w);
for (const e of errors) console.log(e);
const openInfo = `扫描结果：${errors.length} ERROR / ${warnings.length} WARNING`;
console.log(openInfo);
process.exit(errors.length ? 1 : 0);
