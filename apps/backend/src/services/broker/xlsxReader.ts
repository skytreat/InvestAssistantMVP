/**
 * 最小 xlsx 读取器（T121，V3.1）—— 零新依赖（AGENTS.md「新增 npm 依赖必须说明理由」：
 * xlsx = zip(DEFLATE) + OOXML，用 node:zlib inflateRawSync 手写 zip 读路径，
 * 避免为解析券商导出文件引入 sheetjs 级重依赖。解析目标文件面受限（券商导出，结构固定）。
 *
 * 只支持解析所需的最小集合：
 * - zip：local file header + central directory（method 0/8）
 * - xl/sharedStrings.xml（可选）+ xl/worksheets/sheet1.xml
 * - 单元格 t="s"(shared) / t="str"(公式字符串) / t="inlineStr" / 数值
 *
 * ⚠️ 不是通用 xlsx 实现：多 sheet / 压缩流损坏 / 加密文件 → 抛结构化错误（parseBrokerFile 捕获）。
 */
import zlib from 'node:zlib';

/** 读 zip 内存镜像：返回 文件名 → 原始字节 */
export function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  // 1) 找 End of Central Directory（PK\x05\x06，从尾部 22+ 字节内扫）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.subarray(i, i + 4).equals(ZIP_EOCD_SIG)) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('XLSX_INVALID: 非 zip 结构（EOCD 缺失）');

  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const cdCount = buffer.readUInt16LE(eocd + 10);

  // 2) 遍历 central directory，收集 (文件名, method, 压缩大小, 本地头偏移)
  const entries = new Map<string, Buffer>();
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (!buffer.subarray(p, p + 4).equals(ZIP_CENTRAL_SIG)) {
      throw new Error('XLSX_INVALID: central directory 损坏');
    }
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString('utf-8');

    // 3) 本地头：签名 + name/extra 长度前缀之后是数据
    const local = buffer.subarray(localOffset);
    if (!local.subarray(0, 4).equals(ZIP_LOCAL_SIG)) {
      throw new Error(`XLSX_INVALID: 本地文件头缺失（${name}）`);
    }
    const lNameLen = local.readUInt16LE(26);
    const lExtraLen = local.readUInt16LE(28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buffer.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      entries.set(name, Buffer.from(comp));
    } else if (method === 8) {
      entries.set(name, zlib.inflateRawSync(comp));
    } else {
      throw new Error(`XLSX_UNSUPPORTED: 压缩方法 ${method}（${name}）`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const ZIP_EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_CENTRAL_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const ZIP_LOCAL_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
export function isZipBuffer(b: Buffer): boolean {
  return b.length > 4 && b.subarray(0, 4).equals(ZIP_MAGIC);
}

/** 列字母 → 下标（A=0, B=1, …, Z=25, AA=26） */
function colLetterToIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64);
    else break;
  }
  return n - 1;
}

/**
 * 读 xlsx 第一个工作表 → 字符串二维数组（稀疏单元格补 ''）。
 * 只做文本化（数值保留原始字面量，不转数字）—— 语义转换归解析器/归一化层。
 */
export function readXlsxSheet(buffer: Buffer): string[][] {
  const entries = readZipEntries(buffer);

  const shared: string[] = [];
  const ssEntry = [...entries.keys()].find((n) => /xl\/sharedStrings\.xml$/.test(n));
  if (ssEntry) {
    const xml = entries.get(ssEntry)!.toString('utf-8');
    // 逐 <si>…</si> 取全部 <t>（含富文本 <r><t>）拼接
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(
        (m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
          .map((t) => unescapeXml(t.replace(/<t[^>]*>|<\/t>/g, '')))
          .join(''),
      );
    }
  }

  const sheetEntry = [...entries.keys()].find((n) => /xl\/worksheets\/sheet1\.xml$/.test(n));
  if (!sheetEntry) throw new Error('XLSX_INVALID: 缺少 xl/worksheets/sheet1.xml');
  const xml = entries.get(sheetEntry)!.toString('utf-8');
  const sheetData = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sheetData) throw new Error('XLSX_INVALID: 缺少 <sheetData>');

  const rows: string[][] = [];
  for (const rowMatch of sheetData[1].matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowIdxAttr = rowMatch[0].match(/<row[^>]*\sr="(\d+)"/)?.[1];
    const rowIdx = rowIdxAttr ? Number(rowIdxAttr) - 1 : rows.length;
    const cells: string[] = new Array(rowIdx === rows.length ? 0 : Math.max(0, rowIdx - rows.length)).fill(
      '',
    );
    // 简单处理：sheet1 无空行跳跃（券商导出连续行）；有跳跃时按 r 对齐
    if (rowIdx >= 1 && rowIdx > rows.length) {
      rows.length = rowIdx;
      for (let i = rows.length; i < rowIdx; i++) rows.push(['']);
    }
    for (const cMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g)) {
      const attrs = cMatch[1] ?? cMatch[3] ?? '';
      const inner = cMatch[2] ?? '';
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const col = ref ? colLetterToIndex(ref) : cells.length;
      const t = attrs.match(/\bt="([^"]+)"/)?.[1];
      let val = '';
      if (t === 's') {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        val = v !== undefined ? (shared[Number(v)] ?? '') : '';
      } else if (t === 'inlineStr') {
        val = (inner.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
          .map((x) => unescapeXml(x.replace(/<t[^>]*>|<\/t>/g, '')))
          .join('');
      } else {
        // 数值 / 公式字符串：原样取 <v>
        val = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
      }
      // 行内按列号写入（补洞）
      while (cells.length < col) cells.push('');
      cells[col] = val;
    }
    rows[rowIdx] = cells;
  }
  return rows;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
