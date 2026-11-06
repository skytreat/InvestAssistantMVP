import { describe, expect, it } from 'vitest';
import {
  EXCLUDE_KEYWORDS,
  SPECIAL_GROUPS,
  buildDynamicPool,
  classifyName,
  cleanName,
  isExcludedName,
  matchSpecialGroup,
} from '../../src/services/backtest/universe/nameCleaning.js';

describe('名称清洗 —— 基金公司词 / 噪声词', () => {
  it('基金公司词先剔除（含多字公司名，避免「华泰」吃掉「华泰柏瑞」）', () => {
    expect(cleanName('华夏半导体ETF', null)).toBe('半导体');
    expect(cleanName('华泰柏瑞红利ETF', null)).toBe('红利');
    // ⚠️ `中证` 不在噪声词表里（它在排除词表）⇒ 清洗不会去掉，这是 v5.2 原样行为
    expect(cleanName('国泰中证军工ETF', null)).toBe('中证军工');
  });

  it('噪声词（含单字母）按长度降序剔除', () => {
    expect(cleanName('半导体设备ETF联接', null)).toBe('半导体设备');
    // ⚠️ 复现 v5.2 的「误伤」：噪声词表里有单字「新」⇒「创新药」被洗成「创药」
    expect(cleanName('创新药指数基金', null)).toBe('创药');
    // ⚠️ 复现 v5.2 的「误伤」：单字母 B 会被从任意含拉丁 B 的名称里剔掉
    expect(cleanName('ABC科技', null)).toBe('A科技');
  });

  it('特别组会额外剔除组内词（恒生/纳指/创业板…）', () => {
    expect(cleanName('恒生科技', '香港组')).toBe('科技');
    expect(cleanName('纳斯达克生物科技', '美指组')).toBe('生物科技');
    // 创业板成长 → 先剔「创业板」剩「成长」，噪声词表里没有「成长」⇒ 结果非空
    expect(cleanName('创业板成长', '创业组')).toBe('成长');
  });
});

describe('特别组命中（4 组，按组顺序首个命中）', () => {
  it('四组都能命中', () => {
    expect(matchSpecialGroup('恒生科技')).toBe('香港组');
    expect(matchSpecialGroup('科创芯片')).toBe('科创组');
    expect(matchSpecialGroup('纳斯达克100')).toBe('美指组');
    expect(matchSpecialGroup('创业板人工智能')).toBe('创业组');
  });

  it('不含任何特别组关键词 ⇒ null（普通组）', () => {
    expect(matchSpecialGroup('半导体设备')).toBeNull();
    expect(matchSpecialGroup('军工')).toBeNull();
  });

  it('单字符关键词 `H` / `港` 原样生效（v5.2 行为，不修正）', () => {
    expect(matchSpecialGroup('AH500')).toBe('香港组');
    expect(matchSpecialGroup('港股通汽车')).toBe('香港组');
  });

  it('组顺序 = 关键词最大长度降序（香港组/科创组/美指组 并列在前，创业组最后）', () => {
    expect(SPECIAL_GROUPS.map((g) => g.name)).toEqual(['香港组', '科创组', '美指组', '创业组']);
  });
});

describe('排除词 —— 宽基 / 债券 / 货币 / 现金流 / ESG', () => {
  it('宽基与代码数字被排除', () => {
    expect(isExcludedName('沪深300ETF')).toBe(true);
    expect(isExcludedName('中证500')).toBe(true);
    expect(isExcludedName('科创100ETF')).toBe(true);
    expect(isExcludedName('A500ETF')).toBe(true);
  });

  it('债券/货币/现金流/ESG 被排除', () => {
    expect(isExcludedName('国债ETF')).toBe(true);
    expect(isExcludedName('可转债ETF')).toBe(true);
    expect(isExcludedName('货币ETF')).toBe(true);
    expect(isExcludedName('自由现金流ETF')).toBe(true);
    expect(isExcludedName('ESG主题')).toBe(true);
  });

  it('行业主题不被排除', () => {
    expect(isExcludedName('半导体ETF')).toBe(false);
    expect(isExcludedName('军工ETF')).toBe(false);
    expect(isExcludedName('恒生科技')).toBe(false);
  });

  it('排除词表非空且含「债」（最后一层兜底）', () => {
    expect(EXCLUDE_KEYWORDS.length).toBeGreaterThan(50);
    expect(EXCLUDE_KEYWORDS).toContain('债');
  });
});

describe('classifyName —— 组键生成', () => {
  it('普通组：组键 = 清洗后前两字', () => {
    const c = classifyName('半导体设备ETF');
    expect(c).toMatchObject({
      excluded: false,
      specialGroup: null,
      cleanedName: '半导体设备',
      industryKey: '半导',
      groupKey: '半导',
      skipped: false,
    });
  });

  it('特别组：组键 = `${组名}_${前两字}`', () => {
    const c = classifyName('恒生科技');
    expect(c.specialGroup).toBe('香港组');
    expect(c.groupKey).toBe('香港组_科技');
  });

  it('清洗后为空 ⇒ skipped（v5.2 `if cleaned == "": continue`）', () => {
    expect(classifyName('纳斯达克ETF').skipped).toBe(true);
    expect(classifyName('创业板ETF').skipped).toBe(true);
  });

  it('命中排除词时 excluded=true（即便清洗结果非空）', () => {
    const c = classifyName('科创100ETF');
    expect(c.excluded).toBe(true);
    expect(c.specialGroup).toBe('科创组');
  });
});

describe('动态池构建 —— 组内取一 → top N', () => {
  const candidates = [
    { symbol: 's1', name: '半导体ETF', avgAmount: 5000 },
    { symbol: 's2', name: '半导体设备ETF', avgAmount: 9000 },
    { symbol: 's3', name: '军工ETF', avgAmount: 1000 },
    { symbol: 's4', name: '恒生科技', avgAmount: 7000 },
    { symbol: 's5', name: '恒生医药', avgAmount: 4000 },
    { symbol: 's6', name: '科创100ETF', avgAmount: 20000 },
    { symbol: 's7', name: null, avgAmount: 3000 },
  ];

  it('分组数 = 组键个数（不含被排除标的）', () => {
    const r = buildDynamicPool(candidates, 300);
    expect(r.groups.map((g) => g.groupKey)).toEqual(['半导', '香港组_科技', '香港组_医药', 's7', '军工']);
    expect(r.excludedCount).toBe(1);
    expect(r.specialCount).toBe(2);
    expect(r.normalCount).toBe(4);
    expect(r.skippedCount).toBe(0);
  });

  it('组内取成交额第一（不是取平均）', () => {
    const r = buildDynamicPool(candidates, 300);
    expect(r.groups.find((g) => g.groupKey === '半导')?.picked.symbol).toBe('s2');
    expect(r.groups.find((g) => g.groupKey === '半导')?.members.map((m) => m.symbol)).toEqual(['s2', 's1']);
  });

  it('pool = 各组第一按成交额降序（topN 截断）', () => {
    expect(buildDynamicPool(candidates, 300).pool.map((m) => m.symbol)).toEqual([
      's2',
      's4',
      's5',
      's7',
      's3',
    ]);
    expect(buildDynamicPool(candidates, 3).pool.map((m) => m.symbol)).toEqual(['s2', 's4', 's5']);
  });

  it('无名称标的用代码当名称（v5.2 `etf_names_dict.get(code, str(code))`）', () => {
    const r = buildDynamicPool([{ symbol: 's9', name: null, avgAmount: 1 }], 300);
    expect(r.groups[0].groupKey).toBe('s9');
    expect(r.groups[0].picked.effectiveName).toBe('s9');
  });

  it('同组同额时取输入顺序靠前者（等价 Python 稳定排序）', () => {
    const r = buildDynamicPool(
      [
        { symbol: 'x1', name: '军工ETF', avgAmount: 500 },
        { symbol: 'x2', name: '军工ETF', avgAmount: 500 },
      ],
      300,
    );
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].picked.symbol).toBe('x1');
  });

  it('全部被排除 ⇒ 空池（不抛错）', () => {
    const r = buildDynamicPool([{ symbol: 'z', name: '沪深300ETF', avgAmount: 1 }], 300);
    expect(r.groups).toHaveLength(0);
    expect(r.pool).toHaveLength(0);
    expect(r.excludedCount).toBe(1);
  });

  it('清洗后为空 ⇒ skipped 计数（不进组）', () => {
    const r = buildDynamicPool([{ symbol: 'n', name: '纳斯达克ETF', avgAmount: 1 }], 300);
    expect(r.skippedCount).toBe(1);
    expect(r.groups).toHaveLength(0);
  });
});
