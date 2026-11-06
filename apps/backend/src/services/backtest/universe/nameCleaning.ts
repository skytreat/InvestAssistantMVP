/**
 * 动态池名称清洗与分组 —— 逐条复现 `五福轮动ETF_v5.2.py` L430-L459 + L561-L620
 *
 * ⚠️ **已知偏差（必须在报告里披露）**：
 *   v5.2 在聚宽里用的是**当日** `display_name`；本地 `raw_symbol_name` 只有
 *   **当前快照**（ETF 2511 行 / class='etf' 共 2839 只，约 15.4% 末字是 U+FFFD 损坏、
 *   约 11.5% 完全没有名称行）。因此「按名称分组」在历史时点上是**用未来名称**做的，
 *   属于**轻度前视**：只影响「同组取成交额第一」的分组边界，不影响阈值与流动性判定。
 *   缓解：v5.2 的名称里出现的主要是基金公司词与品种词（历史改名以加/删公司后缀为主），
 *   分组键取「清洗后前两字」，改名通常不改变前两字 ⇒ 影响面小但**不为零**。
 *   → **不修正**（不擅自做名称历史重建），只在报告口径声明里列出。
 */

/** 基金公司 / 管理人词（先剔，避免「华夏」「南方」等把品种词吃掉）—— Python `FUND_COMPANIES` */
const FUND_COMPANIES_RAW: readonly string[] = [
  '易方达',
  '广发',
  '华夏',
  '华安',
  '嘉实',
  '富国',
  '招商',
  '鹏华',
  '南方',
  '汇添富',
  '国泰',
  '平安',
  '银华',
  '天弘',
  '建信',
  '工银',
  '华泰柏瑞',
  '博时',
  '景顺长城',
  '景顺',
  '华宝',
  '申万菱信',
  '万家',
  '中欧',
  '兴证全球',
  '浙商',
  '诺安',
  '前海开源',
  '泰康',
  '泰达宏利',
  '农银汇理',
  '交银',
  '东方红',
  '财通',
  '华商',
  '国联',
  '永赢',
  '金鹰',
  '德邦',
  '创金合信',
  '西部利得',
  '圆信永丰',
  '泓德',
  '汇安',
  '诺德',
  '恒生前海',
  '华润元大',
  '大成',
  '海富通',
  '摩根',
  '华泰',
  '中信',
  '中银',
  '兴全',
  '国信',
  '长城',
  '中金',
  '浙商证券',
  '东海',
  '东吴',
  '浦银安盛',
  '信达澳亚',
  '中加',
  '中航',
  '中融',
  '中邮',
  '中庚',
  '中信保诚',
  '中信建投',
  '中银国际',
  '中银证券',
  '九泰',
  '交银施罗德',
  '光大保德信',
  '兴银',
  '农银',
  '国投瑞银',
  '国海富兰克林',
  '国联安',
  '国金',
  '太平',
  '方正富邦',
  '民生加银',
  '汇丰晋信',
  '银河',
  '长信',
  '长安',
  '长盛',
  '长江证券',
  '鹏扬',
];

/**
 * 噪声词（型号/份额类别/后缀/口径词等）—— Python `NOISE_WORDS`
 * ⚠️ 里面含 `B`/`C`/`E`/`30`/`50`/`100`… 这类**单字符子串**，会误伤正常词（如 `B` 会从任何含拉丁 B 的名称里剔掉），
 *    这是 v5.2 的**原样行为**，复现时不修正（修正会让动态池与锚点对不上）。
 */
const NOISE_WORDS_RAW: readonly string[] = [
  '6666',
  '8888',
  '9999',
  'A类',
  'AH',
  'B',
  'BS',
  'C',
  'C类',
  'CS',
  'DB',
  'E',
  'E类',
  'ETF',
  'ETF基金',
  'ETF联接',
  'FG',
  'G60',
  'GF',
  'GT',
  'HGS',
  'LOF',
  'LOF基金',
  'LOF联接',
  'SG',
  'SZ',
  'TF',
  'TK',
  'WJ',
  'YH',
  'ZS',
  'ZZ',
  '板块',
  '策略',
  '产业',
  '场内',
  '场外',
  '低波',
  '基本面',
  '基金',
  '精选',
  '联接',
  '联接基金',
  '量化',
  '龙头',
  '民企',
  '民营',
  '国企',
  '央企',
  '智能',
  '全指',
  '上市开放式',
  '指基',
  '指增',
  '指数',
  '指数A',
  '指数C',
  '指数ETF',
  '指数基金',
  '主题',
  '增强',
  '上海',
  '黄',
  '30',
  '50',
  '100',
  '300',
  '500',
  '1000',
  '2000',
  '大',
  '新',
  '四川',
  '浙江',
  '湖北',
];

/** 排除词（宽基/债券/货币/现金流/ESG 等「不做轮动」的品种）—— Python `exclude_keywords` */
const EXCLUDE_KEYWORDS_RAW: readonly string[] = [
  '300',
  '500',
  '1000',
  '2000',
  '800',
  '30',
  '50',
  '100',
  '180',
  '200',
  '沪深',
  '中证',
  '上证',
  '深证',
  '深成',
  'A50',
  'A100',
  'A500',
  '深100',
  '短融',
  '可转债',
  '转债',
  '双债',
  '利率债',
  '国债',
  '地债',
  '政金债',
  '国开债',
  '基准国债',
  '新综债',
  '信用债',
  '企业债',
  '公司债',
  '城投债',
  '城投',
  '美元债',
  '沪公司债',
  '科创债',
  '科债',
  '科创AAA',
  '自由现金流',
  '现金流',
  '现金流E',
  '现金流基',
  '现金流TF',
  '现金流全',
  '300现金流',
  '800现金流',
  '货币',
  '现金',
  '快线',
  '快钱',
  '中银现金',
  '500现金',
  '800现金',
  '现金800',
  '现金自由',
  '现金指数',
  '全指现金',
  '现金全指',
  'ESG',
  'MSCI',
  'MS',
  '债',
];

/** `sorted(list(set(x)), key=len, reverse=True)` 的等价实现（JS 的 sort 是稳定排序，与原脚本一致） */
function sortedByLenDesc(words: readonly string[]): string[] {
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

/** 基金公司词（长度降序，保证「华泰柏瑞」先于「华泰」「华」被替换） */
export const FUND_COMPANIES: readonly string[] = sortedByLenDesc(FUND_COMPANIES_RAW);
/** 噪声词（长度降序） */
export const NOISE_WORDS: readonly string[] = sortedByLenDesc(NOISE_WORDS_RAW);
/** 排除词（长度降序；只用于 `includes` 判定，顺序不影响结果） */
export const EXCLUDE_KEYWORDS: readonly string[] = sortedByLenDesc(EXCLUDE_KEYWORDS_RAW);

export interface SpecialGroupDef {
  name: string;
  keywords: readonly string[];
  removeWords: readonly string[];
}

/** 四个特别组（顺序 = Python 的 `sorted(..., key=max(len(kw)), reverse=True)`） */
export const SPECIAL_GROUPS: readonly SpecialGroupDef[] = [
  {
    name: '香港组',
    keywords: sortedByLenDesc([
      '恒生',
      '恒指',
      '港股',
      '港股通',
      'H股',
      '香港',
      '港',
      'HKC',
      'HK',
      'HGS',
      'H',
      '中概',
      'HS科技',
    ]),
    removeWords: sortedByLenDesc([
      '恒生',
      '恒指',
      '港股',
      '港股通',
      'H股',
      '香港',
      '港',
      'HKC',
      'HK',
      'HGS',
      'H',
      '中概',
      'HS',
    ]),
  },
  {
    name: '科创组',
    keywords: sortedByLenDesc(['科创', '科创板', '科综', 'KC', 'K C', '双创', '科创创业', '创创']),
    removeWords: sortedByLenDesc([
      '科创',
      '科创板',
      '科综',
      'KC',
      'K C',
      '双创',
      '科创创业',
      '创创',
      '债券',
      '债汇',
      '债指',
      '债沪',
      '债易',
      '债基',
      '债兴',
      '债摩',
      '债',
      'AAA',
    ]),
  },
  {
    name: '美指组',
    keywords: sortedByLenDesc(['标普', '纳指', '纳斯达克']),
    removeWords: sortedByLenDesc(['标普', '纳指', '纳斯达克']),
  },
  {
    name: '创业组',
    keywords: sortedByLenDesc(['创业板', '创业', '创板', '创成长']),
    removeWords: sortedByLenDesc(['创业板', '创业', '创板', '创成长']),
  },
];

/**
 * 命中哪个特别组（按 {@link SPECIAL_GROUPS} 顺序，首个命中的组胜出）
 * 注意 `H` / `港` 是**单字符**关键词，会命中任何含这些字符的名称（v5.2 原样行为）
 */
export function matchSpecialGroup(name: string): string | null {
  for (const group of SPECIAL_GROUPS) {
    for (const kw of group.keywords) {
      if (name.includes(kw)) return group.name;
    }
  }
  return null;
}

/** 是否命中排除词（命中即不进动态池） */
export function isExcludedName(name: string): boolean {
  return EXCLUDE_KEYWORDS.some((kw) => name.includes(kw));
}

/**
 * 清洗名称 —— Python `clean_name`
 * 顺序：基金公司词 → （特别组时）组内剔除词 → 噪声词，最后 trim
 */
export function cleanName(originalName: string, matchedGroup: string | null): string {
  let cleaned = originalName;
  for (const company of FUND_COMPANIES) cleaned = cleaned.split(company).join('');
  if (matchedGroup) {
    const def = SPECIAL_GROUPS.find((g) => g.name === matchedGroup);
    if (def) {
      for (const word of def.removeWords) cleaned = cleaned.split(word).join('');
    }
  }
  for (const noise of NOISE_WORDS) cleaned = cleaned.split(noise).join('');
  return cleaned.trim();
}

/** Python `cleaned[:2]`：按**码点**切（与 JS 的 UTF-16 切片不同，用 Array.from 保证等价） */
function firstCodePoints(text: string, n: number): string {
  return Array.from(text).slice(0, n).join('');
}

export interface NameClassification {
  /** 是否被排除词命中（命中则不进动态池） */
  excluded: boolean;
  /** 命中的特别组名；`null` = 普通组 */
  specialGroup: string | null;
  cleanedName: string;
  /** 组内键：普通组 = 清洗后前两字；特别组 = 前两字 */
  industryKey: string;
  /** 最终分组键：普通组 = industryKey；特别组 = `${组名}_${industryKey}` */
  groupKey: string;
  /** 清洗后为空 ⇒ 按 v5.2 行为跳过该标的 */
  skipped: boolean;
}

/** 对单个标的名称做完整分类（纯函数，便于单测） */
export function classifyName(name: string): NameClassification {
  const specialGroup = matchSpecialGroup(name);
  const excluded = isExcludedName(name);
  const cleanedName = cleanName(name, specialGroup);
  const industryKey = cleanedName.length >= 2 ? firstCodePoints(cleanedName, 2) : cleanedName;
  const groupKey = specialGroup ? `${specialGroup}_${industryKey}` : industryKey;
  return {
    excluded,
    specialGroup,
    cleanedName,
    industryKey,
    groupKey,
    skipped: cleanedName === '',
  };
}

/** 动态池候选（输入 = 已通过阈值的标的） */
export interface DynamicPoolCandidate {
  symbol: string;
  /** 当前快照名称；`null` 时按 v5.2 行为用代码本身当名称 */
  name: string | null;
  /** 近 3 日日均成交额（分母固定 3，与 v5.2 一致） */
  avgAmount: number;
}

export interface DynamicPoolMember extends DynamicPoolCandidate {
  /** 实际参与清洗的名称（`name ?? symbol`） */
  effectiveName: string;
  cleanedName: string;
  groupKey: string;
  specialGroup: string | null;
}

export interface DynamicPoolGroup {
  groupKey: string;
  specialGroup: string | null;
  /** 组内成员（按成交额降序，与 v5.2 的 `sorted(items, key=money, reverse=True)` 同序） */
  members: DynamicPoolMember[];
  /** 组内成交额第一（并列时取排序更靠前者，等同 Python 稳定排序） */
  picked: DynamicPoolMember;
}

export interface DynamicPoolResult {
  /** 全部组（**未截断**，锚点「140 组」看这个） */
  groups: DynamicPoolGroup[];
  /** 组内第一 → 按成交额降序 → 取前 topN */
  pool: DynamicPoolMember[];
  /** 被排除词剔掉的标的数 */
  excludedCount: number;
  /** 清洗后为空被跳过的标的数 */
  skippedCount: number;
  /** 特别组/普通组的标的数（清洗前） */
  specialCount: number;
  normalCount: number;
}

/**
 * 构建动态池 —— 逐条复现 v5.2 `update_sector_pool` 的分组与取一逻辑
 *
 * @param candidates 已通过流动性阈值的候选（**不排序也可**，本函数内部按成交额降序排）
 * @param topN 最终截断数量（v5.2 默认 300）
 */
export function buildDynamicPool(
  candidates: readonly DynamicPoolCandidate[],
  topN: number,
): DynamicPoolResult {
  // 与 v5.2 一致：先按成交额降序（稳定排序 ⇒ 并列保持输入顺序）
  const sorted = [...candidates].sort((a, b) => b.avgAmount - a.avgAmount);

  let excludedCount = 0;
  let skippedCount = 0;
  let specialCount = 0;
  let normalCount = 0;

  // Map 的插入顺序 = 组首次出现的顺序（v5.2 用 dict 也是这个语义）
  const groupMap = new Map<string, DynamicPoolMember[]>();

  for (const c of sorted) {
    const effectiveName = c.name ?? c.symbol;
    const cls = classifyName(effectiveName);
    if (cls.excluded) {
      excludedCount++;
      continue;
    }
    if (cls.specialGroup) specialCount++;
    else normalCount++;
    if (cls.skipped) {
      skippedCount++;
      continue;
    }
    const member: DynamicPoolMember = {
      ...c,
      effectiveName,
      cleanedName: cls.cleanedName,
      groupKey: cls.groupKey,
      specialGroup: cls.specialGroup,
    };
    const list = groupMap.get(cls.groupKey);
    if (list) list.push(member);
    else groupMap.set(cls.groupKey, [member]);
  }

  const groups: DynamicPoolGroup[] = [];
  for (const [groupKey, members] of groupMap) {
    // 成员已按成交额降序（进入 Map 前的全局排序保证），组内第一 = members[0]
    groups.push({
      groupKey,
      specialGroup: members[0].specialGroup,
      members,
      picked: members[0],
    });
  }

  const pickedAll = groups.map((g) => g.picked);
  // 组内第一再全局排序（并列时按组出现顺序，与 Python 稳定排序一致）
  pickedAll.sort((a, b) => b.avgAmount - a.avgAmount);

  return {
    groups,
    pool: pickedAll.slice(0, topN),
    excludedCount,
    skippedCount,
    specialCount,
    normalCount,
  };
}
