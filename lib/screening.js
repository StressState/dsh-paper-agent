/**
 * lib/screening.js — LLM 筛选结果、卡片队列、评分回写
 *
 * 数据流：
 *   library.jsonl（OpenAlex 拉取结果）
 *     → 助手用 paper_screen_queue 取待筛选论文（带摘要）
 *     → 助手用 paper_screen_save 写回评分与中文内容（screenings.jsonl）
 *     → 卡片台用 /cards 读取 score >= 阈值的卡片并按分数降序推送
 *     → 用户在卡片台评分/写评语 → feedback.jsonl + feedback-notes.jsonl
 *       （同时镜像到工作区 state/，供 learn.mjs / prefs.mjs 使用）
 */

import { readFile, appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeDoi } from './openalex.js';
import { loadLibrary } from './store.js';

async function readJsonl(file) {
  try {
    const text = await readFile(file, 'utf8');
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const entry = line.trim();
      if (entry === '') continue;
      try {
        const record = JSON.parse(entry);
        if (record !== null && typeof record === 'object') rows.push(record);
      } catch {
        /* 跳过坏行 */
      }
    }
    return rows;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeJsonlAtomic(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length === 0 ? '' : '\n'), 'utf8');
  await rename(tmp, file);
}

function keyOf(record) {
  if (record.openalexId) return `oa:${record.openalexId}`;
  if (record.doi) return `doi:${normalizeDoi(record.doi)}`;
  return `title:${String(record.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()}`;
}

export async function loadScreenings(stateDir) {
  const rows = await readJsonl(path.join(stateDir, 'screenings.jsonl'));
  const byKey = new Map();
  for (const row of rows) {
    if (!row) continue;
    if (!Number.isFinite(Number(row.score))) continue;
    byKey.set(keyOf(row), row);
  }
  return byKey;
}

/** 待筛选队列：库中还没有 screening 的记录，按首次发现时间倒序。 */
export async function screenQueue(stateDir, { limit = 10 } = {}) {
  const library = await loadLibrary(stateDir);
  const screenings = await loadScreenings(stateDir);
  const size = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const pending = library.records
    .filter((record) => !screenings.has(keyOf(record)))
    .sort((a, b) => String(b.firstSeen ?? '').localeCompare(String(a.firstSeen ?? '')))
    .slice(0, size)
    .map((record) => ({
      openalexId: record.openalexId,
      doi: record.doi || null,
      title: record.title,
      authors: record.authors ?? [],
      journal: record.journal ?? '',
      year: record.year ?? null,
      publicationDate: record.publicationDate ?? null,
      abstract: record.abstract || '',
      topics: (record.topics ?? []).map((t) => t.name).filter(Boolean).slice(0, 6),
      keywords: (record.keywords ?? []).map((k) => k.name).filter(Boolean).slice(0, 8),
      directions: record.directions ?? [],
      firstSeen: record.firstSeen ?? null,
    }));
  return { pending: pending.length, remaining: library.records.length - screenings.size, items: pending };
}

/** 保存一组筛选结果（按 openalexId / DOI 覆盖）。 */
export async function saveScreenings(stateDir, entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('screenings 必须是非空数组');
  const file = path.join(stateDir, 'screenings.jsonl');
  const screenings = await loadScreenings(stateDir);
  const library = await loadLibrary(stateDir);
  const byId = new Map(library.records.map((record) => [record.openalexId, record]));
  let saved = 0;
  const problems = [];
  for (const entry of entries) {
    const score = Number(entry?.score);
    const target = entry?.openalexId ? byId.get(String(entry.openalexId)) : null;
    if (target === undefined || target === null) {
      problems.push(`${entry?.openalexId ?? '(无 ID)'}：库里找不到这篇`);
      continue;
    }
    if (!Number.isFinite(score) || score < 1 || score > 5) {
      problems.push(`${entry.openalexId}：score 必须是 1–5`);
      continue;
    }
    const row = {
      openalexId: target.openalexId,
      doi: target.doi || null,
      score: Math.round(score),
      zhTitle: String(entry.zhTitle ?? '').trim(),
      summary: String(entry.summary ?? '').trim(),
      comment: String(entry.comment ?? '').trim(),
      abstractZh: String(entry.abstractZh ?? '').trim(),
      direction: target.directions?.[0] ?? '',
      screenedAt: new Date().toISOString(),
    };
    screenings.set(keyOf(row), row);
    saved += 1;
  }
  await writeJsonlAtomic(file, [...screenings.values()]);
  return { saved, problems };
}

/**
 * 卡片队列：screenings 中 score >= minScore 的卡片，按分数降序；
 * 默认隐藏已评分的（hideRated=true）。
 */
export async function cardQueue(stateDir, { minScore = 4, limit = 100, hideRead = true } = {}) {
  const screenings = await loadScreenings(stateDir);
  const library = await loadLibrary(stateDir);
  const byId = new Map(library.records.map((record) => [record.openalexId, record]));
  const readKeys = await loadReadKeys(stateDir);
  const floor = Math.min(Math.max(Number(minScore) || 4, 1), 5);
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const cards = [];
  for (const screening of screenings.values()) {
    if (screening.score < floor) continue;
    const key = keyOf(screening);
    if (hideRead && readKeys.has(key)) continue;
    const record = byId.get(screening.openalexId);
    if (!record) continue;
    cards.push({
      openalexId: record.openalexId,
      doi: record.doi || null,
      zhTitle: screening.zhTitle || '',
      enTitle: record.title,
      authors: record.authors ?? [],
      journal: record.journal ?? '',
      year: record.year ?? null,
      publicationDate: record.publicationDate ?? null,
      direction: record.directions?.[0] ?? '',
      score: screening.score,
      summary: screening.summary || '',
      comment: screening.comment || '',
      abstract: record.abstract || '',
      abstractZh: screening.abstractZh || '',
      url: record.doi ? `https://doi.org/${record.doi}` : null,
    });
  }
  cards.sort((a, b) => b.score - a.score || String(b.publicationDate ?? '').localeCompare(String(a.publicationDate ?? '')));
  return { total: cards.length, items: cards.slice(0, cap), minScore: floor };
}

/** 已评分记录：openalexId/DOI → 最近一次评分。 */
export async function loadRatings(stateDir) {
  const feedback = await readJsonl(path.join(stateDir, 'feedback.jsonl'));
  const map = new Map();
  for (const row of feedback) {
    const key = row?.openalexId ? `oa:${row.openalexId}` : row?.doi ? `doi:${normalizeDoi(row.doi)}` : '';
    if (key !== '') map.set(key, row);
  }
  return map;
}

/** 「已读」= 有评分 或 写过评语（推送过但没反馈的仍算未读）。 */
export async function loadReadKeys(stateDir) {
  const keys = new Set();
  for (const row of await readJsonl(path.join(stateDir, 'feedback.jsonl'))) {
    const key = row?.openalexId ? `oa:${row.openalexId}` : row?.doi ? `doi:${normalizeDoi(row.doi)}` : '';
    if (key !== '') keys.add(key);
  }
  for (const row of await readJsonl(path.join(stateDir, 'feedback-notes.jsonl'))) {
    const key = row?.openalexId ? `oa:${row.openalexId}` : row?.doi ? `doi:${normalizeDoi(row.doi)}` : '';
    if (key !== '') keys.add(key);
  }
  return keys;
}

/** 方向维度统计：总计（已筛选）= 待读 + 回顾；待读 = 达标且无评分/评语。 */
export async function deckSummary(stateDir, { minScore = 4 } = {}) {
  const screenings = await loadScreenings(stateDir);
  const readKeys = await loadReadKeys(stateDir);
  const floor = Math.min(Math.max(Number(minScore) || 4, 1), 5);
  const byDirection = {};
  const overall = { total: 0, unread: 0, history: 0 };
  for (const screening of screenings.values()) {
    const direction = screening.direction ?? '';
    const bucket = (byDirection[direction] = byDirection[direction] ?? { total: 0, unread: 0, history: 0 });
    bucket.total += 1;
    overall.total += 1;
    const unread = screening.score >= floor && !readKeys.has(keyOf(screening));
    if (unread) {
      bucket.unread += 1;
      overall.unread += 1;
    } else {
      bucket.history += 1;
      overall.history += 1;
    }
  }
  return { ok: true, byDirection, overall, minScore: floor };
}

/**
 * 回顾列表：已打分（含被筛掉的低分）的文献，可按方向过滤。
 * kind = all | rated（已评分） | discarded（分数低于门槛） | unrated（达标但还没评）
 */
export async function listHistory(stateDir, { directionId = '', kind = 'all', limit = 200, minScore = 4 } = {}) {
  const screenings = await loadScreenings(stateDir);
  const library = await loadLibrary(stateDir);
  const byId = new Map(library.records.map((record) => [record.openalexId, record]));
  const ratings = await loadRatings(stateDir);
  const noteRows = await readJsonl(path.join(stateDir, 'feedback-notes.jsonl'));
  const notes = new Map();
  for (const row of noteRows) {
    const key = row?.openalexId ? `oa:${row.openalexId}` : row?.doi ? `doi:${normalizeDoi(row.doi)}` : '';
    if (key !== '') notes.set(key, String(row.note ?? ''));
  }
  const readKeys = await loadReadKeys(stateDir);
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const floor = Math.min(Math.max(Number(minScore) || 4, 1), 5);
  const byDirection = {};
  const all = [];
  for (const screening of screenings.values()) {
    const record = byId.get(screening.openalexId);
    if (!record) continue;
    const direction = record.directions?.[0] ?? screening.direction ?? '';
    const key = keyOf(screening);
    const rating = ratings.get(key) ?? null;
    const isRead = readKeys.has(key);
    const score = Number(screening.score);
    byDirection[direction] = byDirection[direction] ?? { total: 0, rated: 0, discarded: 0 };
    byDirection[direction].total += 1;
    if (isRead) byDirection[direction].rated += 1;
    if (score < floor) byDirection[direction].discarded += 1;
    if (kind === 'rated' && !isRead) continue;
    if (kind === 'discarded' && score >= floor) continue;
    if (kind === 'unrated' && (isRead || score < floor)) continue;
    if (directionId !== '' && direction !== directionId) continue;
    all.push({
      openalexId: record.openalexId,
      doi: record.doi || null,
      enTitle: record.title ?? '',
      zhTitle: screening.zhTitle || '',
      journal: record.journal ?? '',
      publicationDate: record.publicationDate ?? null,
      direction,
      score,
      read: isRead,
      rated: rating !== null,
      rating: rating?.rating ?? null,
      note: notes.get(key) ?? '',
      summary: screening.summary || '',
      comment: screening.comment || '',
      abstractZh: screening.abstractZh || '',
      screenedAt: screening.screenedAt ?? null,
      ratedAt: rating?.ts ?? null,
      url: record.doi ? `https://doi.org/${record.doi}` : null,
    });
  }
  all.sort((a, b) => String(b.ratedAt ?? b.screenedAt ?? '').localeCompare(String(a.ratedAt ?? a.screenedAt ?? '')));
  return { total: all.length, items: all.slice(0, cap), byDirection, minScore: floor };
}

/** 评分 + 评语回写；同时镜像到工作区 state/ 供 learn.mjs / prefs.mjs 使用。 */
export async function recordRating(workspace, stateDir, { openalexId, doi, direction, rating, note }) {
  const value = Number(rating);
  if (!Number.isFinite(value) || value < 1 || value > 5) throw new Error('rating 必须是 1–5');
  const ts = new Date().toISOString();
  const feedback = {
    doi: doi ? normalizeDoi(doi) : '',
    openalexId: openalexId ?? null,
    direction: String(direction ?? ''),
    rating: Math.round(value),
    ts,
  };
  const noteRow = String(note ?? '').trim() === ''
    ? null
    : { doi: feedback.doi, openalexId: feedback.openalexId, direction: feedback.direction, note: String(note).trim(), ts };

  await mkdir(stateDir, { recursive: true });
  await appendFile(path.join(stateDir, 'feedback.jsonl'), JSON.stringify(feedback) + '\n', 'utf8');
  if (noteRow !== null) {
    await appendFile(path.join(stateDir, 'feedback-notes.jsonl'), JSON.stringify(noteRow) + '\n', 'utf8');
  }

  // 镜像到工作区 state/（存在或可创建时），保持与现有 learn.mjs / prefs.mjs 兼容。
  try {
    const mirrorDir = path.join(workspace, 'state');
    await mkdir(mirrorDir, { recursive: true });
    await appendFile(path.join(mirrorDir, 'feedback.jsonl'), JSON.stringify({ doi: feedback.doi, direction: feedback.direction, rating: feedback.rating, ts }) + '\n', 'utf8');
    if (noteRow !== null) {
      await appendFile(path.join(mirrorDir, 'feedback-notes.jsonl'), JSON.stringify({ doi: noteRow.doi, direction: noteRow.direction, note: noteRow.note, ts }) + '\n', 'utf8');
    }
  } catch {
    /* 镜像失败不影响主流程 */
  }

  return { ok: true, saved: feedback, noteSaved: noteRow !== null };
}
