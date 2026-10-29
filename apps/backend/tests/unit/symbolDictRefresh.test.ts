/**
 * symbolDictRefresh.test.ts — 标的字典全量刷新
 *
 * 钉死：
 *  - syncSymbolDict 全量 upsert（新增 + 改名同步）
 *  - DuckDB 不可读时**抛出**，不得伪装成 0 行
 *  - ensureSymbolDict 仍只在表为空时懒加载，表非空不重复拉全量
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDbPath = path.join(os.tmpdir(), `invest-symbol-dict-refresh-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

const { queryDuckDBMock } = vi.hoisted(() => ({ queryDuckDBMock: vi.fn() }));
vi.mock('../../src/db/duckdb.js', () => ({ queryDuckDB: queryDuckDBMock }));

import { ConfigStore } from '../../src/config/configStore.js';
import type Database from 'better-sqlite3';
import { ensureSymbolDict, syncSymbolDict } from '../../src/services/symbolDict.js';

let db: Database.Database;

beforeAll(() => {
  db = ConfigStore.getInstance().db;
});

beforeEach(() => {
  queryDuckDBMock.mockReset();
  db.prepare('DELETE FROM symbol_dict').run();
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  for (const f of [tmpDbPath, tmpDbPath + '-wal', tmpDbPath + '-shm']) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

function seed(symbol: string, name: string, class_: string = 'stock'): void {
  db.prepare(
    `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, class, asset_class)
     VALUES (?, ?, ?, '', ?, ?, 'risk')`,
  ).run(symbol, symbol.replace(/^[a-z]+/i, ''), name, symbol.slice(0, 2), class_);
}

describe('symbol_dict · 全量刷新', () => {
  it('新增标的并更新已有标的名称/拼音，class 写入真实值', async () => {
    seed('sh600000', '旧名称');
    queryDuckDBMock.mockResolvedValue([
      { symbol: 'sh600000', class: 'stock', name: '浦发银行' },
      { symbol: 'sz000001', class: 'stock', name: '平安银行' },
    ]);

    await expect(syncSymbolDict()).resolves.toBe(2);

    const rows = db.prepare('SELECT symbol, name, pinyin, class FROM symbol_dict ORDER BY symbol').all() as Array<{
      symbol: string;
      name: string;
      pinyin: string;
      class: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ symbol: 'sh600000', name: '浦发银行', class: 'stock' });
    expect(rows[0].pinyin.length).toBeGreaterThan(0);
    expect(rows[1]).toMatchObject({ symbol: 'sz000001', name: '平安银行', class: 'stock' });
  });

  it('unknown 类标的纳入字典（name 为空串，code6 搜索仍命中）', async () => {
    queryDuckDBMock.mockResolvedValue([
      { symbol: 'sz131810', class: 'unknown', name: null },
      { symbol: 'sh204001', class: 'unknown', name: null },
      { symbol: 'sh600000', class: 'stock', name: '浦发银行' },
    ]);

    await expect(syncSymbolDict()).resolves.toBe(3);

    const rows = db.prepare('SELECT symbol, name, class FROM symbol_dict ORDER BY symbol').all() as Array<{
      symbol: string;
      name: string;
      class: string;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows.find(r => r.symbol === 'sz131810')).toMatchObject({ class: 'unknown', name: '' });
    expect(rows.find(r => r.symbol === 'sh204001')).toMatchObject({ class: 'unknown', name: '' });
    expect(rows.find(r => r.symbol === 'sh600000')).toMatchObject({ class: 'stock', name: '浦发银行' });
  });

  it('DuckDB 不可读时抛出，不返回 0 伪装成功', async () => {
    queryDuckDBMock.mockRejectedValue(new Error('duckdb locked'));
    await expect(syncSymbolDict()).rejects.toThrow('duckdb locked');
    expect(db.prepare('SELECT COUNT(*) c FROM symbol_dict').get()).toEqual({ c: 0 });
  });

  it('ensureSymbolDict 表非空时不再重复全量拉取', async () => {
    seed('sh600000', '浦发银行');
    await ensureSymbolDict();
    expect(queryDuckDBMock).not.toHaveBeenCalled();
  });

  it('ensureSymbolDict 表为空时仍懒加载一次', async () => {
    queryDuckDBMock.mockResolvedValue([{ symbol: 'sh600000', class: 'stock', name: '浦发银行' }]);
    await expect(ensureSymbolDict()).resolves.toBe(1);
    expect(queryDuckDBMock).toHaveBeenCalledTimes(1);
  });
});
