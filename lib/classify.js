/**
 * lib/classify.js — 判断一篇论文更属于哪个研究方向
 *
 * 背景：一篇论文可能被多个方向拉到（library.record.directions 有多个），
 * 之前直接取 directions[0] 当分类，会出现「增材制造论文归到同步辐射」这类错误。
 * 这里用方向名/对象/关注点/上下文与标题+摘要做词面匹配，选得分最高的方向。
 */

const CN_SPLIT = /[^\u4e00-\u9fff]+/;
const EN_WORD = /[a-z][a-z0-9-]{2,}/g;

// 中英同义词组：中文方向描述与英文论文标题之间靠这些桥梁匹配。
const SYNONYM_GROUPS = [
  ['增材制造', 'additive manufacturing', 'additively manufactured', 'additive', 'lpbf', 'slm', 'laser powder bed fusion', 'selective laser melting', '3d printing'],
  ['同步辐射', 'synchrotron', 'x-ray diffraction', 'xrd', 'x-ray imaging', 'tomography', 'beamline'],
  ['水系锌离子电池', 'aqueous zinc', 'zinc ion battery', 'zinc metal battery', 'azib', 'zinc anode', 'zn anode'],
  ['锂离子电池', 'lithium ion battery', 'li-ion', 'lithium metal'],
  ['钠离子电池', 'sodium ion battery', 'na-ion'],
  ['高温合金', 'superalloy', 'inconel', 'nickel-based'],
  ['非晶', 'amorphous', 'metallic glass'],
  ['机器学习', 'machine learning', 'deep learning'],
  ['原位表征', 'in situ', 'operando'],
];

function normalize(text) {
  return String(text ?? '').toLowerCase();
}

/** 从方向配置里提取带权重的匹配片段。 */
function directionSegments(direction) {
  const segments = [];
  const push = (text, weight) => {
    const value = normalize(text).trim();
    if (value === '') return;
    segments.push({ text: value, weight });
    // 同义词扩展：中文描述里出现某概念时，把对应的英文写法也加入到匹配片段
    for (const group of SYNONYM_GROUPS) {
      if (group.some((term) => value.includes(term.toLowerCase()))) {
        segments.push({ text: group.join(' '), weight: weight * 0.8 });
      }
    }
  };
  push(direction.name, 3);
  push(direction.description?.object, 2);
  push(direction.description?.focus, 2.5);
  push(direction.context, 1.5);
  push(direction.mode === 'text' ? direction.text?.query : '', 1);
  if (direction.mode === 'topics') for (const id of direction.topics?.ids ?? []) push(id, 1);
  if (direction.mode === 'keywords') for (const id of direction.keywords?.ids ?? []) push(String(id).replace(/^keywords\//, ''), 2);
  return segments;
}

function recordText(record) {
  const names = (list) => (Array.isArray(list) ? list : []).map((item) => (typeof item === 'string' ? item : item?.name ?? '')).filter(Boolean);
  return normalize([
    record.title,
    record.abstract,
    ...names(record.keywords),
    ...names(record.topics),
  ].filter(Boolean).join(' '));
}

const CN_STOP = new Set(['的', '和', '与', '及', '在', '对', '为', '中', '等', '或', '以', '其', '之']);

/** 中文连续的 2–4 字片段（跳过停用字组合）。 */
function chineseGrams(text) {
  const grams = new Set();
  for (const run of String(text).split(CN_SPLIT)) {
    const clean = run.replace(/[^\u4e00-\u9fff]/g, '');
    if (clean.length < 2) continue;
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index + size <= clean.length; index += 1) {
        const gram = clean.slice(index, index + size);
        if (CN_STOP.has(gram)) continue;
        grams.add(gram);
      }
    }
  }
  return grams;
}

function englishWords(text) {
  return new Set(String(text).match(EN_WORD) ?? []);
}

/** 方向与论文的匹配得分（只用于排序，不需要绝对准确）。 */
export function scoreDirection(record, direction) {
  const text = recordText(record);
  if (text === '') return 0;
  const textWords = englishWords(text);
  let score = 0;
  for (const segment of directionSegments(direction)) {
    const words = englishWords(segment.text);
    let hit = 0;
    for (const word of words) {
      // 允许词形变化：additive / additively、microstructure / microstructures
      for (const candidate of textWords) {
        if (candidate === word || candidate.startsWith(word) || word.startsWith(candidate)) {
          hit += 1.2;
          break;
        }
      }
    }
    let cnHit = 0;
    const grams = chineseGrams(segment.text);
    if (grams.size > 0) {
      const recordGrams = chineseGrams(text);
      for (const gram of grams) if (recordGrams.has(gram)) cnHit += gram.length >= 3 ? 1.4 : 0.8;
    }
    score += (hit + Math.min(cnHit, 12)) * segment.weight;
  }
  return score;
}

/** 在候选方向里选最匹配的一个；全部得分为 0 时退回第一个候选。 */
export function pickDirection(record, directions = [], allowedIds = null) {
  const candidates = allowedIds && allowedIds.length > 0
    ? directions.filter((direction) => allowedIds.includes(direction.id))
    : directions;
  if (candidates.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const direction of candidates) {
    const score = scoreDirection(record, direction);
    if (score > bestScore) {
      best = direction;
      bestScore = score;
    }
  }
  if (bestScore <= 0) return candidates[0] ?? null;
  return best;
}
