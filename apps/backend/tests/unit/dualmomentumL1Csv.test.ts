import { describe, expect, it } from 'vitest';
import {
  DECISION_HEADER,
  serializeDecisionsCsv,
} from '../../src/services/backtest/strategies/dualmomentum/l1/csv.js';
import { formatG17 } from '../../src/services/backtest/strategies/dualmomentum/l1/format.js';
import type { L1DecisionRow } from '../../src/services/backtest/strategies/dualmomentum/l1/types.js';

describe('decisions.csv 数值格式（复刻 Python .17g）', () => {
  it('与 Python format(v, ".17g") 逐字符一致', () => {
    const cases: Array<[number, string]> = [
      [0, '0'],
      [0.1, '0.10000000000000001'],
      [1.5, '1.5'],
      [123.456, '123.456'],
      [-2.5, '-2.5'],
      [1e-5, '1.0000000000000001e-05'],
      [1e-4, '0.0001'],
      [1e20, '1e+20'],
      [1e-20, '9.9999999999999995e-21'],
      [0.00012345678901234567, '0.00012345678901234567'],
      [Math.PI, '3.1415926535897931'],
    ];
    for (const [value, expected] of cases) {
      expect(formatG17(value), String(value)).toBe(expected);
    }
  });

  it('非有限值必须抛错，不能写出 nan', () => {
    expect(() => formatG17(Number.NaN)).toThrow(/非有限值/);
    expect(() => formatG17(Number.POSITIVE_INFINITY)).toThrow(/非有限值/);
  });
});

const PROXY_ROW: L1DecisionRow = {
  trade_date: '2020-01-01',
  symbol: 'sh510300',
  jq_code: '510300.XSHG',
  in_pool: true,
  has_bar: true,
  tradable_today: false,
  hfq_factor: null,
  close_raw: null,
  prev_close_raw: null,
  open_raw: null,
  ma5: null,
  ma10: null,
  ma20: null,
  ma60: null,
  wsm_v2: 0,
  nday_return: 0,
  rsrs_z: 0,
  momentum_primary: 0,
  momentum_secondary: 0,
  benchmark_primary: 0,
  filter_pass: false,
  reject_reason: 'POOL_ABSENT',
  rank: null,
  selected: false,
  cooldown_until: null,
};

describe('decisions.csv 行格式（§6.2）', () => {
  it('表头 33 列且顺序固定', () => {
    expect(DECISION_HEADER).toHaveLength(33);
    expect(DECISION_HEADER.slice(0, 25)).toEqual([
      'trade_date',
      'symbol',
      'jq_code',
      'in_pool',
      'has_bar',
      'tradable_today',
      'hfq_factor',
      'close_raw',
      'prev_close_raw',
      'open_raw',
      'ma5',
      'ma10',
      'ma20',
      'ma60',
      'wsm_v2',
      'nday_return',
      'rsrs_z',
      'momentum_primary',
      'momentum_secondary',
      'benchmark_primary',
      'filter_pass',
      'reject_reason',
      'rank',
      'selected',
      'cooldown_until',
    ]);
  });

  it('布尔 0/1、空值为空字段、L2 列占位', () => {
    const csv = serializeDecisionsCsv([PROXY_ROW]);
    const lines = csv.trimEnd().split('\n');
    expect(lines[0].split(',')).toHaveLength(33);
    const cells = lines[1].split(',');
    expect(cells).toHaveLength(33);
    expect(cells[3]).toBe('1');
    expect(cells[6]).toBe(''); // hfq_factor 空
    expect(cells[14]).toBe('0');
    expect(cells[20]).toBe('0');
    expect(cells[21]).toBe('POOL_ABSENT');
    expect(cells[22]).toBe(''); // rank 空
    expect(cells[23]).toBe('0');
    expect(cells[25]).toBe('0'); // target_weight 默认 0
    expect(cells[26]).toBe('NONE'); // action 不允许空
    expect(cells.slice(27)).toEqual(['', '', '', '', '', '']);
    expect(csv).not.toMatch(/nan|NULL/);
  });
});
