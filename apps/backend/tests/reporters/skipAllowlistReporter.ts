/**
 * 🔒 **skip 白名单审计 reporter**（2026-11-07）
 *
 * 目的：**不允许任何静默跳过**。
 *   `vitest.config.ts` 已挂载本 reporter；日常套件跑完后遍历全部任务，
 *   收集所有 `skip` / `todo`（含 `describe.skipIf` 继承下来的）用例，
 *   与 `tests/skip-allowlist.json` 逐条比对：
 *     · 命中白名单 → 放行（白名单条目必须写明「环境条件 + 原因」，随代码 review）；
 *     · **不在白名单 → 打印并 `process.exitCode = 1`**（整轮红灯，CI 也拦）。
 *
 * 为什么不用「在 setup.ts 里查」：`skip` 的用例**根本不会执行**，
 *   setup 的 beforeAll/afterAll 看不到它们；只有跑完后的任务树（reporter）
 *   才拿得到全量状态。
 *
 * 为什么不把白名单写死在代码里：`skip-allowlist.json` 是**可审阅的清单**，
 *   改它=改测试契约，diff 会出现在 PR 里。
 *
 * ⚠️ 只挂在**日常**配置（`vitest.config.ts`）。anchors / pe2 / http 配置各有自己的
 *   环境前提（如 anchors 是「环境不对就抛错」，本就不产生 skip），不重复挂载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { File, Task } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** apps/backend 根（用于把绝对路径归一到「相对路径」） */
const BACKEND_ROOT = path.resolve(HERE, '../..');
const ALLOWLIST_PATH = path.resolve(HERE, '../skip-allowlist.json');

interface AllowlistEntry {
  file: string;
  suites: string[];
  test: string;
  condition: string;
  reason: string;
}

interface AllowlistFile {
  entries: AllowlistEntry[];
}

function loadAllowlist(): AllowlistEntry[] {
  const raw = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as AllowlistFile;
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`[skip-audit] ${ALLOWLIST_PATH} 缺少 entries 数组`);
  }
  return parsed.entries;
}

function keyOf(file: string, suites: string[], test: string): string {
  return JSON.stringify([file, suites, test]);
}

/** 把一个任务（可能是 suite 或 test）是否被跳过判定出来 */
function isSkipped(task: Task, inheritedSkip: boolean): boolean {
  const mode = (task as unknown as { mode?: string }).mode;
  if (inheritedSkip || mode === 'skip' || mode === 'todo') return true;
  const state = (task as unknown as { result?: { state?: string } }).result?.state;
  return state === 'skip' || state === 'skipped' || state === 'todo';
}

export default class SkipAllowlistReporter {
  onFinished(files: File[] = []): void {
    const entries = loadAllowlist();
    const allowed = new Map<string, AllowlistEntry>();
    for (const e of entries) allowed.set(keyOf(e.file, e.suites, e.test), e);

    const violations: Array<{ file: string; suites: string[]; test: string }> = [];
    let allowedHits = 0;

    const walk = (task: Task, file: string, suites: string[], inheritedSkip: boolean): void => {
      const skipped = isSkipped(task, inheritedSkip);

      if (task.type === 'suite') {
        const nextSuites = [...suites, task.name];
        for (const child of task.tasks ?? []) walk(child, file, nextSuites, skipped);
        return;
      }
      if (task.type !== 'test' || !skipped) return;

      const k = keyOf(file, suites, task.name);
      if (allowed.has(k)) allowedHits++;
      else violations.push({ file, suites, test: task.name });
    };

    for (const file of files) {
      const abs = (file as unknown as { filepath?: string }).filepath ?? file.name;
      const rel = path.relative(BACKEND_ROOT, abs).split(path.sep).join('/');
      for (const t of file.tasks ?? []) walk(t, rel, [], false);
    }

    if (violations.length === 0) {
      if (allowedHits > 0) {
        console.log(`[skip-audit] ✅ ${allowedHits} 条 skip 均已登记在 tests/skip-allowlist.json 内`);
      }
      return;
    }

    const lines = violations.map((v, i) => {
      const full = [...v.suites, v.test].join(' > ');
      return `  ${i + 1}) ${v.file} > ${full}`;
    });
    const msg = [
      '',
      `[skip-audit] ❌ 发现 ${violations.length} 条**未登记**的 skip：`,
      ...lines,
      '',
      '  规则（2026-11-07 用户决策）：任何 skip 都必须登记在 `tests/skip-allowlist.json`，',
      '  并写明「环境条件 + 原因」。清单之外一律判为失败，不能静默忽略。',
      '  优先考虑改成「环境不对就抛错」（如 anchors 套件的做法），而不是 skip。',
      '',
    ].join('\n');

    console.error(msg);
    // 双保险：reporter 抛错 + 直接置退出码（vitest 主流程正常退出时会沿用 exitCode）
    process.exitCode = 1;
    throw new Error(`[skip-audit] ${violations.length} 条 skip 未登记（见上方清单）`);
  }
}
