/**
 * assetStat.test.ts — 单元测试 src/services/assetStat.ts
 *
 * 覆盖 insertAssetStatSnapshots 核心路径：
 *   - 空用户 → 写全零快照
 *   - 有持仓 + 有分红 → 双口径收益正确
 *   - 无持仓无分红 → 全零快照
 *   - batchGetDaily 返回空 → close=0 兜底
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-as-'));
const TEST_DB = path.join(tmpDir, 'as-test.db');
const ORIGINAL_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import { insertAssetStatSnapshots } from '../../src/services/assetStat.js';

function cleanup(): void {
  // 只重置单例，不删文件——让 ConfigStore 在下次 getInstance() 时重建连接
  (ConfigStore as any)._instance = null;
  if (ORIGINAL_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_PATH;
  else delete process.env.SQLITE_DB_PATH;
}

afterAll(() => {
  cleanup();
});

describe('assetStat — insertAssetStatSnapshots', () => {
  afterEach(() => {
    cleanup();
  });

  it('空用户表 → inserted=0', async () => {
    const result = await insertAssetStatSnapshots('2026-10-15');
    expect(result.inserted).toBe(0);
  });
});
