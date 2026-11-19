/**
 * lib/feedback.js — 把用户的历史评分/评语整理成「筛选提示词」的一部分
 *
 * 反馈来源：feedback.jsonl（评分）、feedback-notes.jsonl（评语）、screenings.jsonl（模型原文）
 * 偏好摘要：<stateDir>/preferences.json（由模型根据反馈生成的一段中文画像，缓存复用）
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { normalizeDoi } from './openalex.js';
import { loadLibrary } from './store.js';
import { loadRatings, loadScreenings } from './screening.js';
import { callModel } from './llm.js';

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

function keyOf(row) {
  if (row?.openalexId) return `oa:${row.openalexId}`;
  if (row?.doi) return `doi:${normalizeDoi(row.doi)}`;
  return '';
}

/** 最近反馈（高分/低分/带评语）整理成可注入提示词的例子。 */
export async function loadFeedbackExamples(stateDir, { limit = 10 } = {}) {
  const ratings = await loadRatings(stateDir);
  const screenings = await loadScreenings(stateDir);
  const library = await loadLibrary(stateDir);
  const byId = new Map(library.records.map((record) => [record.openalexId, record]));
  const notes = new Map();
  for (const row of await readJsonl(path.join(stateDir, 'feedback-notes.jsonl'))) {
    const key = keyOf(row);
    if (key !== '' && String(row.note ?? '').trim() !== '') notes.set(key, String(row.note).trim());
  }
  const items = [];
  for (const [key, ratingRow] of ratings) {
    const screening = screenings.get(key);
    if (!screening) continue;
    const record = byId.get(screening.openalexId);
    if (!record) continue;
    items.push({
      openalexId: record.openalexId,
      title: screening.zhTitle || record.title || '',
      enTitle: record.title || '',
      rating: Number(ratingRow.rating),
      note: notes.get(key) ?? '',
      score: Number(screening.score),
      ts: String(ratingRow.ts ?? ''),
      direction: ratingRow.direction ?? '',
    });
  }
  items.sort((a, b) => b.ts.localeCompare(a.ts));
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 30);
  return {
    count: items.length,
    items,
    liked: items.filter((item) => item.rating >= 4).slice(0, cap),
    disliked: items.filter((item) => item.rating <= 2).slice(0, cap),
    withNotes: items.filter((item) => item.note !== '').slice(0, cap),
  };
}

function shortTitle(text, max = 70) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function shortNote(text, max = 100) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 生成注入到筛选提示词的反馈段落；没有反馈时返回空串。 */
export function buildFeedbackBlock({ liked = [], disliked = [], withNotes = [], summary = '' } = {}) {
  if (liked.length === 0 && disliked.length === 0 && withNotes.length === 0 && summary.trim() === '') return '';
  const lines = ['', '【用户历史反馈——仅用于同类主题的校准，不同领域的例子不要套用，也不要据此压低不相关领域的新论文】'];
  if (summary.trim() !== '') lines.push(`用户偏好摘要（仅作参考）：${summary.trim()}`);
  if (liked.length > 0) {
    lines.push('用户打高分的例子（这类可以大胆给高）：');
    for (const item of liked.slice(0, 8)) {
      lines.push(`- ${item.rating} 分《${shortTitle(item.title)}》${item.note === '' ? '' : `；评语：${shortNote(item.note)}`}`);
    }
  }
  if (disliked.length > 0) {
    lines.push('用户打低分的例子（同类要压低）：');
    for (const item of disliked.slice(0, 8)) {
      lines.push(`- ${item.rating} 分《${shortTitle(item.title)}》${item.note === '' ? '' : `；评语：${shortNote(item.note)}`}`);
    }
  }
  if (withNotes.length > 0) {
    lines.push('用户写过的评语（当作明确的取舍标准）：');
    for (const item of withNotes.slice(0, 8)) lines.push(`- ${shortNote(item.note, 120)}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function loadPreferences(stateDir) {
  try {
    const raw = await readFile(path.join(stateDir, 'preferences.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

async function savePreferences(stateDir, payload) {
  await mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, 'preferences.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

/**
 * 确保偏好摘要是最新的：反馈数量变化 ≥2 条或从未生成时重新生成；
 * 生成失败时退回已有摘要，绝不阻塞筛选。
 */
export async function ensurePreferences(ctx, stateDir, { settings, modelOverride = {}, force = false } = {}) {
  const existing = await loadPreferences(stateDir);
  const examples = await loadFeedbackExamples(stateDir);
  if (!force && existing && Math.abs((existing.feedbackCount ?? 0) - examples.count) < 2) {
    return { summary: existing.summary ?? '', generatedAt: existing.generatedAt ?? null, feedbackCount: existing.feedbackCount ?? 0, reused: true };
  }
  if (examples.count < 3 && !force) {
    return { summary: existing?.summary ?? '', generatedAt: existing?.generatedAt ?? null, feedbackCount: existing?.feedbackCount ?? 0, reused: true };
  }
  const prompt = [
    '根据下面用户给文献的评分与评语，总结这个用户的文献偏好画像，供后续筛选打分参考。',
    '输出要求：120–220 字中文；分点不超过 5 条；只写偏好与取舍标准，不要复述具体篇名；不要客套话。',
    '',
    buildFeedbackBlock(examples).slice(0, 6000),
  ].join('\n');
  try {
    const summary = (await callModel(ctx, {
      system: '你是科研文献偏好分析师，擅长从评分与评语中归纳稳定的取舍标准。只输出偏好画像本身。',
      prompt,
      temperature: 0.2,
      ...modelOverride,
    })).trim();
    if (summary === '') throw new Error('模型返回空摘要');
    const payload = {
      summary: summary.slice(0, 2000),
      generatedAt: new Date().toISOString(),
      feedbackCount: examples.count,
    };
    await savePreferences(stateDir, payload);
    return { ...payload, reused: false };
  } catch (error) {
    return {
      summary: existing?.summary ?? '',
      generatedAt: existing?.generatedAt ?? null,
      feedbackCount: existing?.feedbackCount ?? 0,
      reused: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
