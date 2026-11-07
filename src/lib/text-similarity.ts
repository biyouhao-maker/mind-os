/**
 * 轻量文本相似度：字符二元组 Jaccard。
 * 用于候选画像线索与已有线索的近似去重（标题精确匹配的升级版）。
 * 注意：不使用 unicode property escapes，兼容 ES2017 target。
 */
export function normalizeForCompare(text: string): string {
  return text
    .replace(/【[^】]*】/g, " ")
    .replace(/[\s，。？！、：；“”‘’（）()【】\[\]{}…·—\-_|/\\]+/g, "")
    .toLowerCase();
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  if (text.length === 1) {
    set.add(text);
    return set;
  }
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

/** 相似度 0~1（Jaccard）。两段文本完全一致 → 1；完全无重叠 → 0。 */
export function textSimilarity(a: string, b: string): number {
  const left = bigrams(normalizeForCompare(a));
  const right = bigrams(normalizeForCompare(b));
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/** 高于该阈值视为与已有线索重复 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.55;

export function isSimilarToAny(candidate: string, existing: string[], threshold = DUPLICATE_SIMILARITY_THRESHOLD): boolean {
  const target = normalizeForCompare(candidate);
  return existing.some(item => textSimilarity(target, normalizeForCompare(item)) >= threshold);
}
