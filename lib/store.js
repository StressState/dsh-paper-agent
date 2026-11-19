/**
 * lib/store.js — 工作区状态：方向配置、去重库、拉取进度、导出
 *
 * 文件全部放在 <workspace>/<stateDir>（默认 .paper-agent）：
 *   directions.json     方向配置（人/模型都可改）
 *   library.jsonl       去重后的文献库（一行一条；按 openalexId + DOI 去重）
 *   pull-state.json     每个方向/窗口的续拉状态
 *   usage.json          最近一次请求的额度信息
 *   candidates-*.json   导出给卡片台的候选
 *   exports/            每次导出的 deck/candidates（带时间戳）
 *
 * 插件的状态必须放在调用者工作区里（不能硬编码盘符），这是可迁移/可分享的前提。
 */

import { readFile, writeFile, mkdir, rename, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';

const DIRECTIONS_SCHEMA = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 从工具执行上下文里取调用者工作区。 */
export function resolveWorkspace(exec) {
  const fromAgent = exec?.agent?.session?.header?.cwd;
  if (typeof fromAgent === 'string' && fromAgent.trim() !== '') return path.resolve(fromAgent);
  if (typeof exec?.agent?.cwd === 'string' && exec.agent.cwd.trim() !== '') return path.resolve(exec.agent.cwd);
  return process.cwd();
}

/** 状态目录（相对工作区）。 */
export function resolveStateDir(workspace, config = {}) {
  const dir = typeof config.stateDir === 'string' && config.stateDir.trim() !== '' ? config.stateDir.trim() : '.paper-agent';
  return path.isAbsolute(dir) ? dir : path.resolve(workspace, dir);
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`${path.basename(file)} 解析失败：${error.message}`);
  }
}

/** 原子写：先写临时文件再 rename，避免中断损坏。 */
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

const locks = new Map();
/** 同进程内的读-改-写串行化（按绝对路径）。 */
export async function withLock(key, fn) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  locks.set(key, previous.then(() => gate));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === gate) locks.delete(key);
  }
}

// ---------------------------------------------------------------- 方向配置

export function emptyDirections() {
  return { schemaVersion: DIRECTIONS_SCHEMA, directions: [], updatedAt: new Date().toISOString() };
}

export async function loadDirections(stateDir) {
  const doc = await readJson(path.join(stateDir, 'directions.json'), emptyDirections());
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.directions)) return emptyDirections();
  return doc;
}

export async function saveDirections(stateDir, doc) {
  await ensureDir(stateDir);
  doc.schemaVersion = DIRECTIONS_SCHEMA;
  doc.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(stateDir, 'directions.json'), doc);
}

export function slugify(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? `direction-${Date.now()}` : slug;
}

/** 校验并规范化一个方向；返回 { direction, error }。 */
export function normalizeDirection(input, existing = []) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { error: '方向配置必须是对象' };
  const name = String(input.name ?? '').trim();
  if (name === '') return { error: '方向缺少名称 name' };
  const mode = input.mode;
  if (!['text', 'topics', 'keywords'].includes(mode)) return { error: 'mode 必须是 text / topics / keywords' };

  const id = String(input.id ?? '').trim() || slugify(name);
  if (existing.some((d) => d.id === id && d.id !== String(input.id ?? '').trim() && String(input.id ?? '').trim() !== '')) {
    return { error: `方向 id 冲突：${id}` };
  }

  const direction = {
    id,
    name,
    enabled: input.enabled !== false,
    description: {
      object: String(input.description?.object ?? '').trim(),
      focus: String(input.description?.focus ?? '').trim(),
      exclude: String(input.description?.exclude ?? '').trim(),
    },
    mode,
    types: ['article|review', 'article', 'review'].includes(String(input.types ?? '')) ? String(input.types) : '',
    language: /^[a-z]{2,3}$/i.test(String(input.language ?? '').trim()) ? String(input.language).trim().toLowerCase() : '',
    extraFilter: String(input.extraFilter ?? '').trim(),
    context: String(input.context ?? '').trim().slice(0, 4000),
    contextUpdatedAt: typeof input.contextUpdatedAt === 'string' ? input.contextUpdatedAt : null,
    contextFeedbackCount: Number.isFinite(Number(input.contextFeedbackCount)) ? Math.max(0, Math.round(Number(input.contextFeedbackCount))) : 0,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (mode === 'text') {
    const query = String(input.text?.query ?? '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (query === '') return { error: '文字检索模式缺少 text.query' };
    direction.text = { query };
  } else if (mode === 'topics') {
    const ids = (Array.isArray(input.topics?.ids) ? input.topics.ids : []).map((v) => String(v)).filter(Boolean);
    if (ids.length === 0) return { error: 'Topics 模式缺少 topics.ids' };
    direction.topics = { ids, match: input.topics?.match === 'all' ? 'all' : 'any' };
  } else {
    const ids = (Array.isArray(input.keywords?.ids) ? input.keywords.ids : []).map((v) => String(v)).filter(Boolean);
    if (ids.length === 0) return { error: 'Keywords 模式缺少 keywords.ids' };
    direction.keywords = { ids, match: input.keywords?.match === 'all' ? 'all' : 'any' };
  }
  return { direction };
}

// ---------------------------------------------------------------- 去重库

export async function loadLibrary(stateDir) {
  const file = path.join(stateDir, 'library.jsonl');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], byId: new Map(), byDoi: new Map() };
    throw error;
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim();
    if (entry === '') continue;
    try {
      const record = JSON.parse(entry);
      if (record && typeof record === 'object') records.push(record);
    } catch {
      /* 跳过坏行 */
    }
  }
  const byId = new Map();
  const byDoi = new Map();
  for (const record of records) {
    if (record.openalexId) byId.set(record.openalexId, record);
    if (record.doi) byDoi.set(String(record.doi).toLowerCase(), record);
  }
  return { records, byId, byDoi };
}

export async function saveLibrary(stateDir, library) {
  await ensureDir(stateDir);
  const file = path.join(stateDir, 'library.jsonl');
  const tmp = `${file}.${process.pid}.tmp`;
  const lines = library.records.map((record) => JSON.stringify(record)).join('\n');
  await writeFile(tmp, lines === '' ? '' : `${lines}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * 把一批 OpenAlex 记录合并进库：
 *   · 主键 openalexId；没有 ID 时用规范化 DOI；都没有则跳过。
 *   · 已存在则只更新元数据（保留 firstSeen），并记录方向归属与变更。
 */
export function mergeRecords(library, records, directionId, now = new Date().toISOString()) {
  let added = 0;
  let updated = 0;
  const touched = [];
  const addedRecords = [];
  for (const raw of records) {
    const candidate = { ...raw };
    if (!candidate.openalexId && !candidate.doi) continue;
    const existing = (candidate.openalexId && library.byId.get(candidate.openalexId))
      || (candidate.doi && library.byDoi.get(String(candidate.doi).toLowerCase()))
      || null;

    if (existing === null) {
      const record = {
        ...candidate,
        firstSeen: now,
        lastSeen: now,
        updatedCount: 0,
        directions: directionId ? [directionId] : [],
        changes: [],
      };
      library.records.push(record);
      if (record.openalexId) library.byId.set(record.openalexId, record);
      if (record.doi) library.byDoi.set(String(record.doi).toLowerCase(), record);
      added += 1;
      touched.push(record);
      addedRecords.push(record);
      continue;
    }

    const changed = [];
    for (const field of ['title', 'doi', 'journal', 'year', 'publicationDate', 'updatedDate', 'type']) {
      const before = JSON.stringify(existing[field] ?? null);
      const after = JSON.stringify(candidate[field] ?? null);
      if (before !== after) changed.push({ field, from: existing[field] ?? null, to: candidate[field] ?? null });
    }
    if (candidate.abstract && candidate.abstract !== existing.abstract) {
      existing.abstract = candidate.abstract;
      changed.push({ field: 'abstract', to: 'updated' });
    }
    if (Array.isArray(candidate.topics) && candidate.topics.length > 0) existing.topics = candidate.topics;
    if (Array.isArray(candidate.keywords) && candidate.keywords.length > 0) existing.keywords = candidate.keywords;
    existing.lastSeen = now;
    existing.updatedCount = (existing.updatedCount ?? 0) + (changed.length > 0 ? 1 : 0);
    existing.directions = Array.isArray(existing.directions) ? existing.directions : [];
    if (directionId && !existing.directions.includes(directionId)) existing.directions.push(directionId);
    if (changed.length > 0) {
      existing.changes = Array.isArray(existing.changes) ? existing.changes : [];
      existing.changes.push({ at: now, changes: changed.slice(0, 8) });
      if (existing.changes.length > 10) existing.changes = existing.changes.slice(-10);
      updated += 1;
    }
    touched.push(existing);
  }
  return { added, updated, touched, addedRecords };
}

// ---------------------------------------------------------------- 拉取进度 / 额度

export async function loadPullState(stateDir) {
  return readJson(path.join(stateDir, 'pull-state.json'), {});
}

export async function savePullState(stateDir, state) {
  await ensureDir(stateDir);
  await writeJsonAtomic(path.join(stateDir, 'pull-state.json'), state);
}

export async function loadUsage(stateDir) {
  return readJson(path.join(stateDir, 'usage.json'), {});
}

export async function saveUsage(stateDir, usage) {
  await ensureDir(stateDir);
  await writeJsonAtomic(path.join(stateDir, 'usage.json'), { updatedAt: new Date().toISOString(), ...usage });
}

// ---------------------------------------------------------------- 导出

/** 把记录导出成卡片台可直接导入的候选数组。 */
export function toCandidateRecord(record, directionLabel) {
  return {
    openalexId: record.openalexId,
    doi: record.doi || null,
    title: record.title,
    authors: record.authors ?? [],
    journal: record.journal ?? '',
    year: record.year ?? null,
    abstract: record.abstract || null,
    direction: directionLabel,
    url: record.url ?? (record.doi ? `https://doi.org/${record.doi}` : null),
    createdAt: record.publicationDate ?? record.createdDate ?? null,
    publicationDate: record.publicationDate ?? null,
    topics: (record.topics ?? []).map((t) => t.name).filter(Boolean),
    keywords: (record.keywords ?? []).map((k) => k.name).filter(Boolean),
    source: 'openalex',
  };
}

/**
 * 导出：<stateDir>/exports/candidates-<stamp>.json（给卡片台导入）
 * 返回文件路径与条数。
 */
export async function exportCandidates(stateDir, records, { stamp = new Date().toISOString().slice(0, 10), directionLabels = {} } = {}) {
  const dir = path.join(stateDir, 'exports');
  await ensureDir(dir);
  const payload = records.map((record) => toCandidateRecord(record, directionLabels[record.directions?.[0]] ?? ''));
  const file = path.join(dir, `candidates-${stamp}.json`);
  await writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { file, count: payload.length };
}

export { ensureDir, readJson, writeJsonAtomic };
