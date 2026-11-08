/**
 * T133 / PA-05 —— 组合配置仓储
 *
 * 覆盖：创建校验、CRUD 往返、条件替换与版本递增、软删不可见、参数 JSON 往返。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureComboTables } from '../../src/config/comboSchema.js';
import {
  ComboInputError,
  createCombo,
  deleteCombo,
  getCombo,
  listCombos,
  toggleCombo,
  updateCombo,
} from '../../src/services/comboRepo.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE user_account (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  db.prepare(`INSERT INTO user_account (id) VALUES (1)`).run();
  ensureComboTables(db);
});

afterEach(() => {
  db.close();
});

function baseInput() {
  return {
    userId: 1,
    name: 'MACD金叉+量能确认',
    conditions: [
      { pluginId: 'macd_cross', params: { fast: 12, slow: 26 } },
      { pluginId: 'volume_breakout', params: { ratio: 1.5 } },
    ],
  };
}

describe('combo repo', () => {
  it('创建后可按 id 读回，方向固定 AND、周期固定 daily', () => {
    const created = createCombo(db, baseInput());

    expect(created.name).toBe('MACD金叉+量能确认');
    expect(created.combineOp).toBe('AND');
    expect(created.period).toBe('daily');
    expect(created.enabled).toBe(true);
    expect(created.configVersion).toBe(1);
    expect(created.cooldownBars).toBe(3);
    expect(created.conditions.map((c) => c.pluginId)).toEqual(['macd_cross', 'volume_breakout']);
    expect(created.conditions.map((c) => c.seq)).toEqual([1, 2]);

    const fetched = getCombo(db, 1, created.id);
    expect(fetched).toEqual(created);
  });

  it('参数 JSON 往返一致（含嵌套对象）', () => {
    const created = createCombo(db, {
      ...baseInput(),
      conditions: [
        { pluginId: 'macd_cross', params: { fast: 12, nested: { a: 1 } } },
        { pluginId: 'volume_breakout', params: { ratio: 1.5, enabled: false } },
      ],
    });

    expect(created.conditions[0].params).toEqual({ fast: 12, nested: { a: 1 } });
    expect(created.conditions[1].params).toEqual({ ratio: 1.5, enabled: false });
  });

  it('条件少于 2 个 / pluginId 重复 / 名称为空 ⇒ PARAM_INVALID', () => {
    expect(() =>
      createCombo(db, {
        ...baseInput(),
        conditions: [{ pluginId: 'macd_cross' }],
      }),
    ).toThrow(ComboInputError);

    expect(() =>
      createCombo(db, {
        ...baseInput(),
        conditions: [{ pluginId: 'macd_cross' }, { pluginId: 'macd_cross' }],
      }),
    ).toThrow(/重复/);

    expect(() => createCombo(db, { ...baseInput(), name: '   ' })).toThrow(/名称/);
  });

  it('冷却根数越界 ⇒ PARAM_INVALID', () => {
    expect(() => createCombo(db, { ...baseInput(), cooldownBars: 0 })).toThrow(/1~20/);
    expect(() => createCombo(db, { ...baseInput(), cooldownBars: 21 })).toThrow(/1~20/);
  });

  it('更新条件会替换旧条件并递增 config_version', () => {
    const created = createCombo(db, baseInput());

    const updated = updateCombo(db, 1, created.id, {
      conditions: [
        { pluginId: 'rsi_oversold', params: { period: 14 } },
        { pluginId: 'volume_breakout', params: { ratio: 2 } },
      ],
    });

    expect(updated).not.toBeNull();
    expect(updated!.configVersion).toBe(2);
    expect(updated!.conditions.map((c) => c.pluginId)).toEqual(['rsi_oversold', 'volume_breakout']);
    expect(updated!.conditions).toHaveLength(2);
  });

  it('仅改名 / 启停不递增版本', () => {
    const created = createCombo(db, baseInput());

    const renamed = updateCombo(db, 1, created.id, { name: '新名字' });
    expect(renamed!.configVersion).toBe(1);

    const toggled = toggleCombo(db, 1, created.id, false);
    expect(toggled!.enabled).toBe(false);
    expect(toggled!.configVersion).toBe(1);
  });

  it('listCombos 默认只返回启用项，includeDisabled 可取全量', () => {
    const a = createCombo(db, { ...baseInput(), name: 'A' });
    createCombo(db, { ...baseInput(), name: 'B' });
    toggleCombo(db, 1, a.id, false);

    expect(listCombos(db, 1).map((c) => c.name)).toEqual(['B']);
    expect(listCombos(db, 1, { includeDisabled: true }).map((c) => c.name)).toEqual(['A', 'B']);
  });

  it('软删后不可见，但物理行仍在（is_deleted=1）', () => {
    const created = createCombo(db, baseInput());

    expect(deleteCombo(db, 1, created.id)).toBe(true);
    expect(getCombo(db, 1, created.id)).toBeNull();
    expect(listCombos(db, 1, { includeDisabled: true })).toHaveLength(0);
    expect(deleteCombo(db, 1, created.id)).toBe(false);

    const raw = db.prepare(`SELECT is_deleted FROM strategy_combo WHERE id = ?`).get(created.id) as {
      is_deleted: number;
    };
    expect(raw.is_deleted).toBe(1);
  });

  it('用户隔离：不同 user_id 读不到彼此的组合', () => {
    db.prepare(`INSERT INTO user_account (id) VALUES (2)`).run();
    const created = createCombo(db, baseInput());

    expect(getCombo(db, 2, created.id)).toBeNull();
    expect(listCombos(db, 2)).toHaveLength(0);
    expect(updateCombo(db, 2, created.id, { name: 'x' })).toBeNull();
    expect(deleteCombo(db, 2, created.id)).toBe(false);
  });
});
