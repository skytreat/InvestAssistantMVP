import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  queryDuckDB,
  closeDuckDBInstance,
  isDuckDBWriting,
  syncDuckDBWriteSentinel,
  startDuckDBWriteSentinelWatcher,
  stopDuckDBWriteSentinelWatcher,
} from '../../src/db/duckdb.js';

/**
 * T104 回归：方向 A —— 外部 tdx2db 写窗口（哨兵）必须让 Node 释放 DuckDB instance。
 *
 * 2026-10-23 生产实测：tdx2db 17:00 因 `Conflicting lock is held in /usr/bin/node` 失败，
 * 因为 Node 只实现了方向 B（自己触发补跑），从未轮询外部写进程的哨兵。
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-sentinel-'));
const SENTINEL = path.join(tmpDir, '.tdx2db-writing');
const ORIGINAL_SENTINEL = process.env.TDX2DB_WRITE_SENTINEL;

beforeAll(() => {
  process.env.TDX2DB_WRITE_SENTINEL = SENTINEL;
});

afterAll(async () => {
  stopDuckDBWriteSentinelWatcher();
  await closeDuckDBInstance();
  if (ORIGINAL_SENTINEL !== undefined) process.env.TDX2DB_WRITE_SENTINEL = ORIGINAL_SENTINEL;
  else delete process.env.TDX2DB_WRITE_SENTINEL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

describe('T104 DuckDB 方向 A 哨兵让锁', () => {
  it('哨兵出现 → 释放 instance 并拒绝新查询；哨兵消失 → 查询自动恢复', async () => {
    await expect(queryDuckDB<{ ok: number }>('SELECT 1 AS ok')).resolves.toHaveLength(1);

    fs.writeFileSync(SENTINEL, '');
    await syncDuckDBWriteSentinel();

    expect(isDuckDBWriting()).toBe(true);
    await expect(queryDuckDB('SELECT 1 AS ok')).rejects.toThrow(/tdx2db sentinel/);

    fs.unlinkSync(SENTINEL);
    await syncDuckDBWriteSentinel();

    expect(isDuckDBWriting()).toBe(false);
    const rows = await queryDuckDB<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  }, 20_000);

  it('未经过 sync 时，查询入口也会自行发现哨兵并放弃 instance', async () => {
    await queryDuckDB<{ ok: number }>('SELECT 1 AS ok');

    fs.writeFileSync(SENTINEL, '');
    await expect(queryDuckDB('SELECT 1 AS ok')).rejects.toThrow(/tdx2db sentinel/);
    expect(isDuckDBWriting()).toBe(true);

    fs.unlinkSync(SENTINEL);
    await syncDuckDBWriteSentinel();
    await expect(queryDuckDB<{ ok: number }>('SELECT 1 AS ok')).resolves.toHaveLength(1);
  }, 20_000);

  it('watcher 轮询可自动进入/退出外部写窗口（幂等启动）', async () => {
    await queryDuckDB<{ ok: number }>('SELECT 1 AS ok');

    startDuckDBWriteSentinelWatcher(5);
    startDuckDBWriteSentinelWatcher(5); // 幂等：不会注册第二个定时器

    fs.writeFileSync(SENTINEL, '');
    await waitUntil(() => isDuckDBWriting());
    await expect(queryDuckDB('SELECT 1 AS ok')).rejects.toThrow(/tdx2db sentinel/);

    fs.unlinkSync(SENTINEL);
    await waitUntil(() => !isDuckDBWriting());
    await expect(queryDuckDB<{ ok: number }>('SELECT 1 AS ok')).resolves.toHaveLength(1);

    stopDuckDBWriteSentinelWatcher();
  }, 20_000);
});
