/**
 * 回测/纸面账本库路径解析（生产打包产物回归）
 *
 * 背景：生产后端运行的是 tsup 产物 `app/dist/*.js`，`backtestDb.ts` 里的
 * `__dirname` 变成 `app/dist`，原「向上 6 级到仓库根」会解析到 `/data/backtest.db`
 * ⇒ 纸面账户接口报 `unable to open database file`。
 * 修复后默认锚定 `SQLITE_DB_PATH` 的同目录。
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBacktestDbPath } from '../../src/services/backtest/store/backtestDb.js';

const originalBacktest = process.env.BACKTEST_DB_PATH;
const originalBusiness = process.env.SQLITE_DB_PATH;

afterEach(() => {
  if (originalBacktest === undefined) delete process.env.BACKTEST_DB_PATH;
  else process.env.BACKTEST_DB_PATH = originalBacktest;
  if (originalBusiness === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = originalBusiness;
});

describe('resolveBacktestDbPath', () => {
  it('显式 BACKTEST_DB_PATH 优先于业务库目录', () => {
    process.env.BACKTEST_DB_PATH = path.resolve('/tmp/invest-explicit/paper.db');
    process.env.SQLITE_DB_PATH = path.resolve('/opt/invol/IA_Prod/data/business.db');
    expect(resolveBacktestDbPath()).toBe(path.resolve('/tmp/invest-explicit/paper.db'));
  });

  it('未显式指定时与业务库同目录（生产 bundle 不再落到 /data）', () => {
    delete process.env.BACKTEST_DB_PATH;
    process.env.SQLITE_DB_PATH = path.resolve('/opt/invol/IA_Prod/data/business.db');
    expect(resolveBacktestDbPath()).toBe(path.resolve('/opt/invol/IA_Prod/data/backtest.db'));
  });

  it('SQLITE_DB_PATH=:memory: 时回落到仓库 data/backtest.db', () => {
    delete process.env.BACKTEST_DB_PATH;
    process.env.SQLITE_DB_PATH = ':memory:';
    expect(resolveBacktestDbPath().replaceAll('\\', '/')).toMatch(/\/data\/backtest\.db$/);
  });
});
