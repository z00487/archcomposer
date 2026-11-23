/**
 * L3 领域层 · 中文数字与序号解析
 *
 * 自然语言编辑指令（开题报告 §3.3「说一句就能改」）里最常见的一类指代是
 * **序号**：「把斗拱放到第二步」「删掉第四步」「第 2 段讲得太复杂」。
 * 把这些写法统一解析成 1 起的整数，是指令解析器的地基。
 *
 * 覆盖的写法（刻意宽容，因为作者手写而非机器生成）：
 *  - 阿拉伯数字：`2`、`12`、`第3步`
 *  - 中文数字：`二`、`三`、`十一`、`二十三`
 *  - 全角数字：`２`
 *  - 混合：`第2步`
 *
 * **为什么不用现成的中文数字库**：解析范围很小（分镜的步骤数不会上百），
 * 三十行足够，且不会为一个词法细节引入依赖。
 */

const DIGITS: Record<string, number> = {
  零: 0, 〇: 0,
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

const UNITS: Record<string, number> = { 十: 10, 百: 100 };

/** 全角 → 半角（数字与常见标点）。作者常在中文输入法下打全角。 */
export function toHalfWidth(text: string): string {
  const punct: Record<string, string> = {
    '，': ',', '：': ':', '。': '.', '！': '!', '？': '?', '；': ';', '、': ',',
  };
  return text
    .replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10))
    .replace(/[，：。！？；、]/g, (c) => punct[c] ?? c);
}

/**
 * 解析一段纯中文数字，如 `二十三` → 23。认不出来返回 null。
 *
 * 只处理「十位 + 个位」这一档（`十`、`十一`、`二十`、`二十三`）。
 * 上百的写法在分镜场景里不存在，遇到就返回 null 而不是猜。
 */
export function parseChineseNumber(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);

  let total = 0;
  let current = 0;
  let sawAny = false;

  for (const ch of s) {
    if (ch in DIGITS) {
      current = DIGITS[ch];
      sawAny = true;
      continue;
    }
    if (ch in UNITS) {
      // 「十」前面没数字时视为 1（「十二」= 12）
      const unit = UNITS[ch];
      total += (current === 0 ? 1 : current) * unit;
      current = 0;
      sawAny = true;
      continue;
    }
    // 出现非数字字符 → 整段不认
    return null;
  }
  if (!sawAny) return null;
  return total + current;
}

/**
 * 从一句话里抽出第一个序号（1 起）。
 *
 * 优先级：「第N...步/段/个/条」这种带量词的写法最可信，先找它；
 * 找不到再退化到「N」这种孤立的数字。返回 null 表示这句话没提序号。
 */
export function extractOrdinal(text: string): number | null {
  // ⚠️ 先摘掉指代词组：「这一步 / 那一步 / 哪一步 / 每一步」里的「一」是**数量
  //    虚指**（相当于英语的 this/that），不是序号 1。不摘掉的话「这一步的旁白
  //    改成…」会被解析成「第 1 步」，而它与「当前步骤」在语义上其实一致——
  //    但那只是巧合；「那一步」被解成「第 1 步」就纯属错译了。
  //    摘掉之后自然落到 null，由调用方回退到「当前选中步骤」，行为才是对的。
  const s = toHalfWidth(text).replace(/[这那哪每同]一?步/g, ' ');

  // ① 带序数前缀 + 量词的写法：「第二步」「第 2 步」「第12段」
  const withPrefix = s.match(/第\s*([0-9]+|[零〇一二两三四五六七八九十百]+)\s*[步段个条节]?/);
  if (withPrefix) {
    const n = parseChineseNumber(withPrefix[1]);
    if (n !== null && n >= 1) return n;
  }

  // ② 「N 步 / N 段」这种量词在后的写法
  const withSuffix = s.match(/([0-9]+|[零〇一二两三四五六七八九十]+)\s*[步段个条节]/);
  if (withSuffix) {
    const n = parseChineseNumber(withSuffix[1]);
    if (n !== null && n >= 1) return n;
  }

  return null;
}

/** `N` → `N` 的中文写法（供界面回显「已移到第二步」）。只覆盖到 99。 */
export function toChineseNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 10) return Object.keys(DIGITS).find((k) => DIGITS[k] === n) ?? String(n);
  if (n === 10) return '十';
  if (n < 20) return `十${toChineseNumber(n - 10)}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${toChineseNumber(tens)}十${ones === 0 ? '' : toChineseNumber(ones)}`;
}
