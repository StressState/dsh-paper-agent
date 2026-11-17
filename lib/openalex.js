/**
 * lib/openalex.js — OpenAlex 客户端（免费计划）
 *
 * 硬约束（官方文档 + 实测）：
 *   · from_created_date / from_updated_date / 按 created_date 排序 = Member+/Partner 付费功能；
 *     免费 key 使用会返回 429 "Plan upgrade required"。
 *   · 免费可用：from_publication_date / to_publication_date、topics.id、keywords.id、
 *     title_and_abstract.search、type、sort=publication_date、cursor 分页（需要 key）。
 *   · per_page 最大 100；免费 key 每日 10,000 请求额度，单请求约 $0.0001–0.001。
 *
 * 本模块只做「一轮请求」，分页、重试、预算、错误分类都在这里；
 * 落库与去重在 lib/store.js，面向模型的工具在 lib/tools.js。
 */

export const OPENALEX_BASE = 'https://api.openalex.org';
export const PER_PAGE = 100;
export const SELECT_FIELDS = [
  'id',
  'doi',
  'title',
  'publication_date',
  'publication_year',
  'created_date',
  'updated_date',
  'type',
  'abstract_inverted_index',
  'authorships',
  'primary_location',
  'topics',
  'keywords',
  'cited_by_count',
].join(',');

/** 两次请求之间的最小间隔（毫秒）——新账号有额度节流，避免连发 429。 */
const MIN_INTERVAL_MS = 1200;
let lastRequestAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenAlexError extends Error {
  constructor(message, { kind = 'unknown', status = 0, retryAfter = null, body = null } = {}) {
    super(message);
    this.name = 'OpenAlexError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

/** 把 OpenAlex 的 4xx/5xx 响应分类成可操作的种类。 */
export function classifyResponse(status, bodyText) {
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    /* 非 JSON 响应 */
  }
  const message = String(body?.message ?? body?.error ?? bodyText ?? '').slice(0, 500);
  const code = String(body?.code ?? '');
  if (status === 401 || code === 'invalid_key' || code === 'key_not_activated') {
    return { kind: 'auth', message, body, hint: 'API key 无效或未激活：先在 OpenAlex 邮件里点激活链接，或在设置里更换 key。' };
  }
  if (status === 403) {
    return { kind: 'auth', message, body, hint: '请求被拒（key 权限/未激活），请检查 OpenAlex key。' };
  }
  if (status === 429) {
    if (/Plan upgrade required|Member\+|Partner plan|daily sync/i.test(message)) {
      return { kind: 'plan', message, body, hint: '这个过滤/排序需要 OpenAlex 付费计划（Member+/Partner），免费额度不可用；请改用 publication_date 月份窗口。' };
    }
    if (/Insufficient budget|budget|remaining/i.test(message)) {
      return { kind: 'budget', message, body, hint: '今日 OpenAlex 额度用尽（UTC 午夜重置）；可等重置、换 key，或减少请求量。' };
    }
    return { kind: 'rate', message, body, hint: '请求过快或被节流：稍后重试（脚本会按 Retry-After 退避）。' };
  }
  if (status === 400 || status === 422) {
    return { kind: 'invalid', message, body, hint: '查询参数不合法：检查检索式（逗号/括号/字段名）与 Topics/Keywords ID。' };
  }
  if (status >= 500) {
    return { kind: 'server', message, body, hint: 'OpenAlex 服务端错误，稍后重试。' };
  }
  return { kind: 'unknown', message: message || `HTTP ${status}`, body, hint: '未知错误，请查看返回内容。' };
}

function readBudget(headers) {
  const limit = headers?.get?.('x-ratelimit-limit');
  const remaining = headers?.get?.('x-ratelimit-remaining');
  const reset = headers?.get?.('x-ratelimit-reset');
  const retryAfter = headers?.get?.('retry-after');
  return {
    limit: limit === null || limit === undefined ? null : Number(limit),
    remaining: remaining === null || remaining === undefined ? null : Number(remaining),
    resetSeconds: reset === null || reset === undefined ? null : Number(reset),
    retryAfterSeconds: retryAfter === null || retryAfter === undefined ? null : Number(retryAfter),
  };
}

/**
 * 单次 GET /works（或其它实体）。自动处理：
 *   · 最小请求间隔；
 *   · rate/budget/server 退避重试（plan/auth/invalid 直接抛错）。
 * 返回 { json, budget, costUsd, status }。
 */
export async function apiGet(path, params = {}, { apiKey = null, retries = 3, timeoutMs = 60000 } = {}) {
  const url = new URL(path.startsWith('http') ? path : `${OPENALEX_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  if (apiKey) url.searchParams.set('api_key', apiKey);

  let attempt = 0;
  while (true) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    let response;
    try {
      response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt < retries) {
        attempt += 1;
        await sleep(Math.min(3000 * attempt, 12000));
        continue;
      }
      throw new OpenAlexError(`网络错误：${error.message}`, { kind: 'network' });
    }

    const text = await response.text();
    const budget = readBudget(response.headers);
    if (response.ok) {
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        throw new OpenAlexError('OpenAlex 返回了非 JSON 内容', { kind: 'invalid', status: response.status, body: text.slice(0, 500) });
      }
      return { json, budget, costUsd: Number(json?.meta?.cost_usd ?? 0), status: response.status };
    }

    const info = classifyResponse(response.status, text);
    const retryable = info.kind === 'rate' || info.kind === 'server';
    if (retryable && attempt < retries) {
      attempt += 1;
      const delay = Math.min(Math.max((budget.retryAfterSeconds ?? 0) * 1000, 3000 * attempt), 20000);
      await sleep(delay);
      continue;
    }
    throw new OpenAlexError(info.message || `HTTP ${response.status}`, {
      kind: info.kind,
      status: response.status,
      retryAfter: budget.retryAfterSeconds,
      body: info,
    });
  }
}

// ---------------------------------------------------------------- 检索条件

const TOPIC_ID_RE = /T\d+/;
const KEYWORD_ID_RE = /keywords\/([a-z0-9-]+)/i;

/** 把用户输入的 Topic 引用（完整 URL / T 号）规整成 Txxxx。 */
export function normalizeTopicId(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return '';
  const match = raw.match(TOPIC_ID_RE);
  return match ? match[0] : '';
}

/** 把用户输入的 Keyword 引用（完整 URL / slug）规整成 keywords/<slug>。 */
export function normalizeKeywordId(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return '';
  const match = raw.match(KEYWORD_ID_RE);
  if (match) return `keywords/${match[1].toLowerCase()}`;
  if (/^[a-z0-9-]+$/i.test(raw)) return `keywords/${raw.toLowerCase()}`;
  return '';
}

/** 检索式里不能出现英文逗号（会切分 filter），统一换成空格。 */
export function sanitizeQuery(query) {
  return String(query ?? '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

const TYPES_ALLOWED = new Set(['article|review', 'article', 'review']);
const SYNC_FILTER_RE = /(from|to)_(created|updated)_date/i;

/** 清理高级过滤片段：禁止付费 sync 过滤器，去掉空项。 */
export function sanitizeExtraFilter(extraFilter) {
  const text = String(extraFilter ?? '').trim();
  if (text === '') return '';
  if (SYNC_FILTER_RE.test(text)) {
    throw new Error('额外过滤不能使用 from_created_date / updated_date 等付费 sync 过滤器；请改用 publication_date 或去掉');
  }
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .filter((part) => !SYNC_FILTER_RE.test(part))
    .join(',');
}

/** 按方向配置与时间窗生成 OpenAlex filter 字符串。 */
export function buildWorksFilter(direction, window, options = {}) {
  if (direction === null || typeof direction !== 'object') throw new Error('方向配置为空');
  const parts = [];
  if (window?.from) parts.push(`from_publication_date:${window.from}`);
  if (window?.to) parts.push(`to_publication_date:${window.to}`);

  const types = TYPES_ALLOWED.has(String(direction.types ?? '')) ? String(direction.types) : (options.defaultTypes ?? 'article|review');
  parts.push(`type:${TYPES_ALLOWED.has(types) ? types : 'article|review'}`);

  const language = String(direction.language ?? options.defaultLanguage ?? '').trim().toLowerCase();
  if (/^[a-z]{2,3}$/.test(language)) parts.push(`language:${language}`);

  const extra = sanitizeExtraFilter(direction.extraFilter ?? '');
  if (extra !== '') parts.push(extra);

  const mode = direction.mode;
  if (mode === 'text') {
    const query = sanitizeQuery(direction.text?.query);
    if (query === '') throw new Error('文字检索模式缺少 text.query');
    parts.push(`title_and_abstract.search:${query}`);
  } else if (mode === 'topics') {
    const ids = (direction.topics?.ids ?? []).map(normalizeTopicId).filter(Boolean);
    if (ids.length === 0) throw new Error('Topics 模式缺少有效的 topics.ids');
    if (direction.topics?.match === 'all') {
      for (const id of ids) parts.push(`topics.id:${id}`);
    } else {
      parts.push(`topics.id:${ids.join('|')}`);
    }
  } else if (mode === 'keywords') {
    const ids = (direction.keywords?.ids ?? []).map(normalizeKeywordId).filter(Boolean);
    if (ids.length === 0) throw new Error('Keywords 模式缺少有效的 keywords.ids');
    if (direction.keywords?.match === 'all') {
      for (const id of ids) parts.push(`keywords.id:${id}`);
    } else {
      parts.push(`keywords.id:${ids.join('|')}`);
    }
  } else {
    throw new Error(`未知检索模式：${String(mode)}`);
  }
  return parts.join(',');
}

/** 人类可读的生效条件（给预览/报告用）。 */
export function describeCondition(direction, window, options = {}) {
  const modeText = direction.mode === 'text'
    ? `文字检索：${direction.text?.query ?? ''}`
    : direction.mode === 'topics'
      ? `Topics（${direction.topics?.match === 'all' ? '全部满足' : '任一满足'}）：${(direction.topics?.ids ?? []).join(', ')}`
      : `Keywords（${direction.keywords?.match === 'all' ? '全部满足' : '任一满足'}）：${(direction.keywords?.ids ?? []).join(', ')}`;
  return {
    mode: direction.mode,
    condition: modeText,
    window: `${window.from} — ${window.to}`,
    types: direction.types ?? options.defaultTypes ?? 'article|review',
    language: direction.language ?? options.defaultLanguage ?? '',
    extraFilter: direction.extraFilter ?? '',
    filter: buildWorksFilter(direction, window, options),
  };
}

// ---------------------------------------------------------------- 数据映射

export function normalizeDoi(doi) {
  if (!doi) return '';
  return String(doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
}

export function invertAbstract(inverted) {
  if (inverted === null || typeof inverted !== 'object') return '';
  const slots = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const position of positions ?? []) slots[position] = word;
  }
  return slots.filter((word) => word !== undefined).join(' ').trim();
}

/** OpenAlex work → 本地记录（去重与导出都用这个形状）。 */
export function mapWork(work) {
  const idUrl = String(work?.id ?? '');
  const openalexId = idUrl.split('/').pop() ?? '';
  const doi = normalizeDoi(work?.doi);
  const publicationDate = work?.publication_date ? String(work.publication_date).slice(0, 10) : null;
  const year = Number.isFinite(Number(work?.publication_year))
    ? Number(work.publication_year)
    : publicationDate
      ? Number(publicationDate.slice(0, 4))
      : null;
  return {
    openalexId,
    doi,
    title: String(work?.title ?? work?.display_name ?? '').replace(/\s+/g, ' ').trim(),
    authors: (work?.authorships ?? []).map((item) => item?.author?.display_name).filter(Boolean),
    journal: work?.primary_location?.source?.display_name ?? '',
    year,
    publicationDate,
    createdDate: work?.created_date ? String(work.created_date).slice(0, 19) : null,
    updatedDate: work?.updated_date ? String(work.updated_date).slice(0, 19) : null,
    abstract: invertAbstract(work?.abstract_inverted_index),
    topics: (work?.topics ?? []).map((t) => ({ id: String(t?.id ?? '').split('/').pop() ?? '', name: t?.display_name ?? '', score: t?.score ?? null })),
    keywords: (work?.keywords ?? []).map((k) => ({ id: String(k?.id ?? '').replace('https://openalex.org/', ''), name: k?.display_name ?? '', score: k?.score ?? null })),
    citedBy: Number.isFinite(Number(work?.cited_by_count)) ? Number(work.cited_by_count) : null,
    type: work?.type ?? null,
    url: doi !== '' ? `https://doi.org/${doi}` : idUrl || null,
  };
}

// ---------------------------------------------------------------- 预览 / 拉取

function worksParams(filter, extra = {}) {
  return { filter, select: SELECT_FIELDS, ...extra };
}

/** 测试拉取：只发 1 个请求，返回命中总数 + 最多 limit 篇样本。 */
export async function previewWorks(direction, { window, limit = 10, apiKey = null, filterOptions = {} } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 10);
  const filter = buildWorksFilter(direction, window, filterOptions);
  const { json, budget, costUsd } = await apiGet('/works', worksParams(filter, { 'per-page': String(safeLimit) }), { apiKey });
  return {
    count: Number(json?.meta?.count ?? 0),
    costUsd,
    budget,
    filter,
    items: (json?.results ?? []).map(mapWork),
  };
}

/**
 * 正式拉取（一个月窗内的全部命中）：
 *   · 有 key 用 cursor 分页；无 key 用 page 参数（最多 10,000 条，超出标记未完成）。
 *   · 每页回调 onPage({ records, page, fetched, count, costUsd, budget, nextCursor })。
 *   · 返回完整状态；中断时把已取记录与 cursor 交回调用方保存，便于续拉。
 */
export async function pullWorks(direction, { window, apiKey = null, maxPages = 200, cursor = null, page = 1, onPage = null, filterOptions = {} } = {}) {
  const filter = buildWorksFilter(direction, window, filterOptions);
  const useCursor = Boolean(apiKey);
  let nextCursor = cursor;
  let currentPage = Math.max(1, Number(page) || 1);
  let fetched = 0;
  let count = null;
  let totalCost = 0;
  let lastBudget = null;
  const records = [];
  const pages = [];

  while (pages.length < maxPages) {
    const params = worksParams(filter, { 'per-page': String(PER_PAGE) });
    if (useCursor) {
      params.cursor = nextCursor ?? '*';
    } else {
      if (currentPage > 100) {
        return {
          records, pages, fetched, count, totalCost, budget: lastBudget,
          complete: false,
          stoppedReason: 'paging_limit',
          hint: '无 key 时最多只能翻 10,000 条（100 页 × 100 条）；请配置免费 OpenAlex key 用游标分页拉完。',
          nextCursor, nextPage: currentPage,
        };
      }
      params.page = String(currentPage);
    }

    const { json, budget, costUsd } = await apiGet('/works', params, { apiKey });
    if (count === null) count = Number(json?.meta?.count ?? 0);
    lastBudget = budget;
    totalCost += costUsd;
    const pageRecords = (json?.results ?? []).map(mapWork);
    fetched += pageRecords.length;
    records.push(...pageRecords);
    pages.push({ page: pages.length + 1, returned: pageRecords.length, costUsd });

    const metaNext = json?.meta?.next_cursor ?? null;
    if (onPage) {
      await onPage({
        records: pageRecords,
        page: pages.length,
        fetched,
        count,
        costUsd,
        budget,
        nextCursor: metaNext,
      });
    }

    if (pageRecords.length === 0) {
      return { records, pages, fetched, count, totalCost, budget: lastBudget, complete: true, stoppedReason: 'empty_page', nextCursor: null, nextPage: currentPage };
    }
    if (useCursor) {
      if (metaNext === null) {
        return { records, pages, fetched, count, totalCost, budget: lastBudget, complete: true, stoppedReason: 'end_of_results', nextCursor: null, nextPage: currentPage };
      }
      nextCursor = metaNext;
    } else {
      if (fetched >= 10000 || fetched >= count) {
        return {
          records, pages, fetched, count, totalCost, budget: lastBudget,
          complete: fetched >= count, stoppedReason: fetched >= count ? 'end_of_results' : 'paging_limit',
          hint: fetched >= count ? null : '无 key 时最多只能取 10,000 条；请配置 key 用游标拉完。',
          nextCursor: null, nextPage: currentPage,
        };
      }
      currentPage += 1;
    }
  }

  return {
    records, pages, fetched, count, totalCost, budget: lastBudget,
    complete: false, stoppedReason: 'max_pages',
    hint: `达到本次 maxPages=${maxPages} 上限，可重试续拉。`,
    nextCursor, nextPage: currentPage,
  };
}

/** 解析 Topics（按关键词），返回候选 ID 列表。 */
export async function resolveTopics(search, { apiKey = null, perPage = 8 } = {}) {
  const { json } = await apiGet('/topics', { search, 'per-page': String(Math.min(Math.max(perPage, 1), 25)) }, { apiKey });
  return (json?.results ?? []).map((t) => ({
    id: String(t.id ?? '').split('/').pop() ?? '',
    name: t.display_name ?? '',
    worksCount: t.works_count ?? null,
    description: t.description ?? '',
  }));
}

/** 解析 Keywords（按关键词），返回候选 ID 列表。 */
export async function resolveKeywords(search, { apiKey = null, perPage = 8 } = {}) {
  const { json } = await apiGet('/keywords', { search, 'per-page': String(Math.min(Math.max(perPage, 1), 25)) }, { apiKey });
  return (json?.results ?? []).map((k) => ({
    id: String(k.id ?? '').replace('https://openalex.org/', ''),
    name: k.display_name ?? '',
    worksCount: k.works_count ?? null,
  }));
}
