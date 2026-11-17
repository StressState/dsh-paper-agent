/**
 * lib/settings.js — 插件设置
 *
 * key 解析顺序：插件配置 openalexKey > 环境变量 OPENALEX_API_KEY > <stateDir>/settings.json
 * 其余可调项（时间窗月数、卡片阈值、拉取页数、预览条数、默认类型/语言）也存 settings.json，
 * 全部只在本机工作区，不会上传。
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  monthsBack: 1,
  cardsMinScore: 4,
  pullMaxPages: 200,
  previewLimit: 10,
  defaultTypes: 'article|review',
  defaultLanguage: '',
  llmProvider: '',
  llmModel: '',
  llmReasoningEffort: '',
  useFeedback: true,
};

const TYPES_ALLOWED = new Set(['article|review', 'article', 'review']);

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

/** 规范化设置（非法值回退默认）。 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const settings = { ...DEFAULT_SETTINGS };
  settings.monthsBack = clampInt(source.monthsBack, 1, 12, DEFAULT_SETTINGS.monthsBack);
  settings.cardsMinScore = clampInt(source.cardsMinScore, 1, 5, DEFAULT_SETTINGS.cardsMinScore);
  settings.pullMaxPages = clampInt(source.pullMaxPages, 1, 200, DEFAULT_SETTINGS.pullMaxPages);
  settings.previewLimit = clampInt(source.previewLimit, 1, 10, DEFAULT_SETTINGS.previewLimit);
  settings.defaultTypes = TYPES_ALLOWED.has(String(source.defaultTypes ?? '')) ? String(source.defaultTypes) : DEFAULT_SETTINGS.defaultTypes;
  const language = String(source.defaultLanguage ?? '').trim().toLowerCase();
  settings.defaultLanguage = /^[a-z]{2,3}$/.test(language) ? language : '';
  const provider = String(source.llmProvider ?? '').trim();
  const model = String(source.llmModel ?? '').trim();
  settings.llmProvider = /^[a-z0-9._-]{1,64}$/i.test(provider) ? provider : '';
  settings.llmModel = /^[a-z0-9._:-]{1,120}$/i.test(model) ? model : '';
  if (settings.llmProvider === '') settings.llmModel = '';
  const effort = String(source.llmReasoningEffort ?? '').trim();
  settings.llmReasoningEffort = /^[a-z0-9._-]{1,32}$/i.test(effort) ? effort : '';
  settings.useFeedback = source.useFeedback !== false;
  if (typeof source.openalexKey === 'string' && source.openalexKey.trim() !== '') settings.openalexKey = source.openalexKey.trim();
  return settings;
}

export async function loadSettings(stateDir) {
  try {
    const raw = await readFile(path.join(stateDir, 'settings.json'), 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(stateDir, settings) {
  await mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, 'settings.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

export async function updateSettings(stateDir, patch) {
  const current = await loadSettings(stateDir);
  const next = normalizeSettings({ ...current, ...(patch ?? {}) });
  if (patch && typeof patch.openalexKey === 'string' && patch.openalexKey.trim() === '') delete next.openalexKey;
  if (patch && patch.openalexKey === null) delete next.openalexKey;
  await saveSettings(stateDir, next);
  return next;
}

/** 解析实际使用的 key。 */
export async function resolveApiKey(stateDir, config) {
  const fromConfig = typeof config?.openalexKey === 'string' ? config.openalexKey.trim() : '';
  if (fromConfig !== '') return { key: fromConfig, source: 'config' };
  const fromEnv = typeof process.env.OPENALEX_API_KEY === 'string' ? process.env.OPENALEX_API_KEY.trim() : '';
  if (fromEnv !== '') return { key: fromEnv, source: 'env' };
  const settings = await loadSettings(stateDir);
  const fromSettings = typeof settings.openalexKey === 'string' ? settings.openalexKey.trim() : '';
  if (fromSettings !== '') return { key: fromSettings, source: 'settings' };
  return { key: null, source: 'anonymous' };
}

/** 给界面看的状态：只暴露是否已配置与来源，不返回 key 明文。 */
export async function describeKey(stateDir, config) {
  const { key, source } = await resolveApiKey(stateDir, config);
  return {
    configured: key !== null,
    source,
    masked: key === null ? null : `${key.slice(0, 4)}…${key.slice(-4)}`,
  };
}

/** 给界面看的安全设置（去掉 key）。 */
export async function publicSettings(stateDir) {
  const settings = await loadSettings(stateDir);
  const { openalexKey, ...rest } = settings;
  return rest;
}
