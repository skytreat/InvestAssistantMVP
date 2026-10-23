/**
 * restoreDrill.test.ts — G10.4 / T103
 *
 * `scripts/restore-drill.sh` 在 ENABLE_QUOTE_BACKUP=false（无 parquet）时：
 *   - 行情段 WARN 跳过，SQLite 段仍完整校验 → EXIT=0
 *   - 缺 SQLite 备份 → EXIT≠0
 *   - SQLite 校验失败时即使无 parquet 也 → EXIT≠0（不得因跳过行情段而放过业务库）
 *
 * ⚠️ 依赖 bash；Windows 上跳过。sqlite3 CLI 用临时 stub 顶替（CI 不保证安装）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../../../scripts/restore-drill.sh');
const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('restore-drill.sh — 无 parquet 时跳过行情段', () => {
  let tmpDir = '';

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-restore-drill-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDirs(name: string): { backupDir: string; workDir: string; binDir: string } {
    const root = path.join(tmpDir, name);
    const backupDir = path.join(root, 'backup');
    const workDir = path.join(root, 'work');
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    return { backupDir, workDir, binDir };
  }

  function stubSqlite3(binDir: string, output: string): void {
    const bin = path.join(binDir, 'sqlite3');
    fs.writeFileSync(bin, `#!/usr/bin/env bash\necho '${output}'\n`, { mode: 0o755 });
  }

  function run(backupDir: string, workDir: string, binDir: string) {
    return spawnSync('bash', [SCRIPT], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        BACKUP_DIR: backupDir,
        TMPDIR: workDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
  }

  it('仅 SQLite 备份（无 parquet）→ 行情段 SKIP，SQLite 段通过，EXIT=0', () => {
    const { backupDir, workDir, binDir } = makeDirs('only-sqlite');
    fs.writeFileSync(path.join(backupDir, 'business.db.2026-10-23'), 'fake-sqlite');
    stubSqlite3(binDir, 'ok');

    const result = run(backupDir, workDir, binDir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('找不到 DuckDB 行情 parquet 备份');
    expect(result.stdout).toContain('SQLite integrity_check = ok');
    expect(result.stdout).toContain('SKIP（无 parquet 备份）');
  });

  it('缺 SQLite 备份 → EXIT≠0（即使也没有 parquet）', () => {
    const { backupDir, workDir, binDir } = makeDirs('missing-sqlite');
    stubSqlite3(binDir, 'ok');

    const result = run(backupDir, workDir, binDir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('找不到 SQLite 备份');
  });

  it('无 parquet 时 SQLite 校验失败仍必须 EXIT≠0（跳过行情段不得放过业务库）', () => {
    const { backupDir, workDir, binDir } = makeDirs('bad-sqlite');
    fs.writeFileSync(path.join(backupDir, 'business.db.2026-10-23'), 'fake-sqlite');
    stubSqlite3(binDir, 'corrupt');

    const result = run(backupDir, workDir, binDir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('SQLite integrity_check 失败');
  });
});
