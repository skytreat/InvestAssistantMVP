/**
 * broker_parser.test.ts — T121（V3.1）券商文件解析器
 * 对应 SDD_v3 §12.1：INV-S2-1~4（探测/表头定位/编码/伪 xls）、INV-S2-5~6（废单/原始行）、
 * INV-S2-7/8（未知类型/敏感字段）
 *
 * 载体 = tests/fixtures/broker-samples/（脱敏样本，V3-B7）；gate G1（6 份全解析）+ G2（编码/包裹/表头）。
 * ⚠️ 本套件 sequence.shuffle=true ⇒ 用例间无共享可变状态（每个用例独立读文件/构造 buffer）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseBrokerFile, stripCellWrap } from '../../src/services/broker/brokerParser.js';
import type { BrokerFileInput } from '../../src/services/broker/types.js';

const FIXTURES = path.resolve(__dirname, '../../../../tests/fixtures/broker-samples');

function fixtureFile(name: string): BrokerFileInput {
  return { buffer: fs.readFileSync(path.join(FIXTURES, name)), filename: name };
}

const SENSITIVE = ['资金账号', '股东代码', '营业部名称', '用户名', '结算汇率'];

describe('T121 · gate G1：6 份样本全部解析成功', () => {
  it('国泰 4 份真 xlsx（表头非首行：前 4 行元数据 + 第 5 行列名）', async () => {
    const files: Array<[string, 'settlement' | 'trade', number]> = [
      ['2026-10-20-国泰ETF交割单.xlsx', 'settlement', 134],
      ['2026-10-20-国泰ETF成交.xlsx', 'trade', 125],
      ['2026-10-20-国泰股票交割单.xlsx', 'settlement', 14],
      ['2026-10-20-国泰股票成交.xlsx', 'trade', 12],
    ];
    for (const [name, kind, dataRows] of files) {
      const r = await parseBrokerFile(fixtureFile(name));
      expect(r.ok, name).toBe(true);
      expect(r.fileKind, `${name} kind`).toBe(kind);
      // 国泰导出把 r=5 的空行从 XML 省略 ⇒ 表头物理在 r=6（0 基 grid 索引 5），
      // 与 SDD_v3 §3.6「表头在第 6 行（非首行）」一致
      expect(r.headerRowIndex, `${name} header`).toBe(5);
      expect(r.rows.length, `${name} rows`).toBe(dataRows);
      // 元数据 4 行不入数据行（第一条数据行 rowIndex = 6）
      expect(r.rows[0].rowIndex).toBe(6);
    }
  });

  it('华宝 2 份伪 .xls（GBK 文本 TSV，表头首行）', async () => {
    const files: Array<[string, 'settlement' | 'trade', number]> = [
      ['20261020_华宝交割单.xls', 'settlement', 671],
      ['20261020_华宝成交.xls', 'trade', 671],
    ];
    for (const [name, kind, dataRows] of files) {
      const r = await parseBrokerFile(fixtureFile(name));
      expect(r.ok, name).toBe(true);
      expect(r.fileKind, `${name} kind`).toBe(kind);
      expect(r.headerRowIndex, `${name} header`).toBe(0);
      expect(r.encoding, `${name} encoding`).toBe('gb18030');
      expect(r.rows.length, `${name} rows`).toBe(dataRows);
    }
  });
});

describe('T121 · gate G2：编码 / 包裹 / 表头非首行 / 敏感丢弃', () => {
  it('敏感列整列丢弃（只记列号，cells 对应位置为空串，不回显值）', async () => {
    const r = await parseBrokerFile(fixtureFile('2026-10-20-国泰ETF交割单.xlsx'));
    expect(r.ok).toBe(true);
    const sensitiveCols = r.columns.filter((c) => c.dropped);
    // 交割单表头含 资金账号 / 股东代码 / 结算汇率 ⇒ 至少 3 列被丢弃
    expect(sensitiveCols.length).toBeGreaterThanOrEqual(3);
    for (const c of sensitiveCols) {
      expect(SENSITIVE.some((s) => c.header.includes(s) || c.header === s)).toBe(true);
    }
    const idx = sensitiveCols[0].index;
    for (const row of r.rows) {
      expect(row.cells[idx], `敏感列 ${idx} 必须为空串`).toBe('');
    }
    // 映射建议的敏感列号清单非空
    expect(r.mappingSuggestion.sensitiveDropped.length).toBe(sensitiveCols.length);
    // warnings 记录了丢弃事件
    expect(r.warnings.some((w) => w.code === 'SENSITIVE_DROPPED')).toBe(true);
  });

  it('三种包裹风格幂等去包裹（§3.4：`="v"` / `"v"` / 原生）', () => {
    expect(stripCellWrap('="20260128"')).toBe('20260128');
    expect(stripCellWrap('"20260128"')).toBe('20260128');
    expect(stripCellWrap('20260128')).toBe('20260128');
    // 幂等：再处理一次不变
    expect(stripCellWrap(stripCellWrap('="1.465"'))).toBe('1.465');
    expect(stripCellWrap(stripCellWrap('"1.465"'))).toBe('1.465');
    // 数字被引号包裹（实测 "0.0000"）
    expect(stripCellWrap('"0.0000"')).toBe('0.0000');
  });

  it('数值字段的去包裹值可直接转 number（§3.4 实现要求）', async () => {
    const r = await parseBrokerFile(fixtureFile('20261020_华宝成交.xls'));
    // 逆回购行（204001 GC001）：1.465 × 14 手 = 14000.00（gate G9 利息基线源数据）
    const symCol = r.mappingSuggestion.byField.symbol?.column;
    expect(symCol).toBeTypeOf('number');
    const repoRow = r.rows.find((row) => row.cells[symCol!] === '204001');
    expect(repoRow).toBeDefined();
    const priceCol = r.mappingSuggestion.byField.price?.column;
    const qtyCol = r.mappingSuggestion.byField.quantity?.column;
    expect(priceCol).toBeTypeOf('number');
    expect(qtyCol).toBeTypeOf('number');
    expect(Number(repoRow!.cells[priceCol!])).toBe(1.465);
    expect(Number(repoRow!.cells[qtyCol!])).toBe(14);
  });

  it('未知列名给出候选而非静默忽略（§3.5 / INV-S2-7）', async () => {
    const text =
      '日期\t交易类别\t证券代码\t证券名称\t某特殊列\t成交价格\t成交数量\n20260101\t买入\t600519\t贵州茅台\tX\t10\t100\n';
    const r = await parseBrokerFile({ buffer: Buffer.from(text, 'utf-8'), filename: 'unknown.xlsx' });
    expect(r.ok).toBe(true);
    const special = r.columns.find((c) => c.header === '某特殊列');
    expect(special).toBeDefined();
    expect(special!.semantic).toBeNull(); // 无匹配
    expect(r.mappingSuggestion.unmapped).toContain(special!.index); // 进 unmapped 清单，不静默
  });

  it('50 行内无表头特征 → ok=false + HEADER_NOT_FOUND（INV-S2-1）', async () => {
    const junk = Array.from({ length: 60 }, (_, i) => `row${i}\tvalue${i}`).join('\n');
    const r = await parseBrokerFile({ buffer: Buffer.from(junk, 'utf-8'), filename: 'noheader.xls' });
    expect(r.ok).toBe(false);
    expect(r.fileKind).toBe('unknown');
    expect(r.errors.some((e) => e.code === 'HEADER_NOT_FOUND')).toBe(true);
  });

  it('UTF-8 BOM 识别（§3.3 顺序 1）', async () => {
    const body =
      '成交日期\t成交时间\t证券代码\t证券名称\t交易类别\t成交价格\t成交数量\n20260101\t09:30:00\t600519\t贵州茅台\t买入\t10\t100\n';
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf-8')]);
    const r = await parseBrokerFile({ buffer, filename: 'bom.txt' });
    expect(r.ok).toBe(true);
    expect(r.encoding).toBe('utf-8-bom');
  });

  it('严格 UTF-8 失败 → GB18030 兜底（§3.3 顺序 3，宽容解码）', async () => {
    // GB18030 字节（成交日期\t证券代码）：严格 UTF-8 必失败 ⇒ 走 gb18030
    // （Buffer.from 不支持 gb18030 标签，字节为离线生成值）
    const buffer = Buffer.from('b3c9bdbbc8d5c6da09d6a4c8afb4fac2eb', 'hex');
    const r = await parseBrokerFile({ buffer, filename: 'gbk.txt' });
    expect(r.ok).toBe(true);
    expect(r.encoding).toBe('gb18030');
    expect(r.headerRowIndex).toBe(0);
    expect(r.columns.map((c) => c.header)).toEqual(['成交日期', '证券代码']);
  });
});

/**
 * T151①（V3.8a）· 券商名推断（detectBrokerName）
 * 元数据行 → 公司名（已知清单 / 「中文名+证券」兜底）；推断不出 → undefined。
 * ⚠️ 敏感边界：脱敏样本（国泰 4 份 xlsx 元数据=占位值）必须**推断不出**（不回敏感值）。
 */
describe('T151① · 券商名推断（detectBrokerName）', () => {
  it('元数据行含已知券商名 → 命中（最长优先）', async () => {
    const body =
      '国泰君安证券股份有限公司证券交割单\n客户查询\n成交日期\t证券代码\t证券名称\t交易类别\t成交价格\t成交数量\n20260101\t600519\t贵州茅台\t买入\t10\t100\n';
    const r = await parseBrokerFile({ buffer: Buffer.from(body, 'utf-8'), filename: 'gt.csv' });
    expect(r.ok).toBe(true);
    expect(r.brokerNameHint).toBe('国泰君安证券');
  });

  it('未知券商 → 兜底「中文名+证券」形态（首个）', async () => {
    const body =
      '某某证券 交易明细\n成交日期\t证券代码\t证券名称\t交易类别\t成交价格\t成交数量\n20260101\t600519\t贵州茅台\t买入\t10\t100\n';
    const r = await parseBrokerFile({ buffer: Buffer.from(body, 'utf-8'), filename: 'xx.csv' });
    expect(r.ok).toBe(true);
    expect(r.brokerNameHint).toBe('某某证券');
  });

  it('元数据只含敏感占位（脱敏样本）→ 推断不出（不回敏感值）', async () => {
    const r = await parseBrokerFile(fixtureFile('2026-10-20-国泰ETF交割单.xlsx'));
    expect(r.ok).toBe(true);
    expect(r.brokerNameHint).toBeUndefined();
  });

  it('表头首行（无元数据）→ 不推断', async () => {
    const body =
      '成交日期\t证券代码\t证券名称\t交易类别\t成交价格\t成交数量\n20260101\t600519\t贵州茅台\t买入\t10\t100\n';
    const r = await parseBrokerFile({ buffer: Buffer.from(body, 'utf-8'), filename: 'h0.csv' });
    expect(r.brokerNameHint).toBeUndefined();
  });
});
