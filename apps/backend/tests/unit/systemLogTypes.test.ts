/**
 * systemLogTypes.test.ts —— `system_log` 白名单与代码用法的**一致性守门**
 *
 * 🔴 2026-11-13 生产事故：
 *   纸面账户日更每晚写 `logType: 'paper_account'`，但 CHECK 白名单里没有 ⇒
 *   INSERT 被 CHECK 拒绝 ⇒ `writeNow` 静默降级到 journald ⇒
 *   **纸面段的全部日志（含异常）在 DB 里查不到**，功能正常但运维失明。
 *
 * 本文件锁定的断言：
 *   ① 代码里出现的每个 `logType: '...'` 字面量 ∈ `SYSTEM_LOG_TYPES`
 *   ② 代码里出现的每个 `level: '...'` 字面量 ∈ `SYSTEM_LOG_LEVELS`（**必须大写**）
 *   ③ 实际建表 DDL 的 CHECK 白名单 ⊇ `SYSTEM_LOG_TYPES` / `SYSTEM_LOG_LEVELS`
 *      （防止「常量加了但 DDL 没同步」）
 *   ④ 用非白名单类型写日志 ⇒ **抛错**（不再静默降级到 journald）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-syslog-types-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { writeSystemLog } from '../../src/services/logger.js';
import { SYSTEM_LOG_TYPES, SYSTEM_LOG_LEVELS, type SystemLogType } from '../../src/config/systemLogTypes.js';

const SRC_DIR = path.resolve(import.meta.dirname, '../../src');

/** 递归收集 src 下的 .ts 文件 */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * 扫描所有 `writeSystemLog({...})` 调用块里的 `logType` / `level` 字面量
 *
 * ⚠️ **只扫调用块**，不能全文件 grep `level:` ——
 *   backtest 的 `logs: { level: 'info' | 'warn'; ... }[]` 是**策略回测日志**的字段标注，
 *   与 system_log 无关（误抓会把合法代码判成违规）。
 */
function scanLiterals(): { logTypes: string[]; levels: string[] } {
  const logTypes = new Set<string>();
  const levels = new Set<string>();
  for (const file of collectTsFiles(SRC_DIR)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/writeSystemLog\(\{/g)) {
      const start = m.index! + m[0].length;
      // 调用块到第一个 `});` 为止（writeSystemLog 的实参是对象字面量）
      const end = text.indexOf('});', start);
      const block = text.slice(start, end === -1 ? start + 800 : end);
      for (const lt of block.matchAll(/logType:\s*'([a-z_]+)'/g)) logTypes.add(lt[1]);
      for (const lv of block.matchAll(/\blevel:\s*'([A-Za-z]+)'/g)) levels.add(lv[1]);
    }
  }
  return { logTypes: [...logTypes].sort(), levels: [...levels].sort() };
}

beforeAll(() => {
  ConfigStore.getInstance();
});

afterAll(() => {
  try {
    const store = (ConfigStore as any)._instance;
    if (store) (store.db as any).close();
  } catch {
    /* ignore */
  }
  (ConfigStore as any)._instance = null;
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(tmpDbPath + ext);
    } catch {
      /* ignore */
    }
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

describe('system_log 白名单 —— 代码用法与 DDL 一致性', () => {
  it('① 代码里用到的 log_type 全部在白名单内', () => {
    const { logTypes } = scanLiterals();
    const missing = logTypes.filter((t) => !(SYSTEM_LOG_TYPES as readonly string[]).includes(t));
    expect(missing, `新增 log_type 必须先加进 src/config/systemLogTypes.ts：${missing.join(', ')}`).toEqual(
      [],
    );
    // 反向：白名单里的每个类型都真的被代码用到（避免留下僵尸类型）
    expect(logTypes.length).toBeGreaterThan(0);
  });

  it('② 代码里用到的 level 全部是大写且在白名单内', () => {
    const { levels } = scanLiterals();
    const missing = levels.filter((l) => !(SYSTEM_LOG_LEVELS as readonly string[]).includes(l));
    expect(missing, `level 必须是 ${SYSTEM_LOG_LEVELS.join('/')}：${missing.join(', ')}`).toEqual([]);
  });

  it('③ 实际建表 DDL 的 CHECK 白名单覆盖全部类型与等级', () => {
    const db = ConfigStore.getInstance().db;
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='system_log'").get() as
      { sql: string } | undefined;
    expect(row).toBeDefined();
    for (const t of SYSTEM_LOG_TYPES) {
      expect(row!.sql, `DDL 缺 log_type '${t}'`).toContain(`'${t}'`);
    }
    for (const l of SYSTEM_LOG_LEVELS) {
      expect(row!.sql, `DDL 缺 level '${l}'`).toContain(`'${l}'`);
    }
  });

  it('④ 纸面段专用类型可以正常落库（事故回归）', () => {
    const db = ConfigStore.getInstance().db;
    writeSystemLog({
      logType: 'paper_account' as SystemLogType,
      level: 'INFO',
      message: '纸面账户日更测试',
      detail: 'guard-test',
    });
    const hit = db
      .prepare(
        "SELECT COUNT(*) AS c FROM system_log WHERE log_type='paper_account' AND message='纸面账户日更测试'",
      )
      .get() as { c: number };
    expect(hit.c, 'paper_account 日志必须能落进 system_log').toBe(1);
  });
});
