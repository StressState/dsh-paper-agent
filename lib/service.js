/**
 * lib/service.js — 服务层：工具（模型）与 HTTP 路由（面板）共用同一套逻辑
 *
 * 所有操作都显式接收工作区路径；插件不保存任何全局用户状态。
 */

import path from 'node:path';
import { stat } from 'node:fs/promises';

import {
  OpenAlexError,
  describeCondition,
  previewWorks,
  pullWorks,
  resolveKeywords,
  resolveTopics,
} from './openalex.js';
import { defaultWindow, hkToday, resolveWindow } from './time.js';
import {
  ensureDir,
  exportCandidates,
  loadDirections,
  loadLibrary,
  loadPullState,
  loadUsage,
  mergeRecords,
  normalizeDirection,
  resolveStateDir,
  saveDirections,
  saveLibrary,
  savePullState,
  saveUsage,
} from './store.js';
import { describeKey, loadSettings, publicSettings, resolveApiKey, updateSettings as updateSettingsFile } from './settings.js';
import { cardQueue, deckSummary, listHistory, loadScreenings, recordRating, saveScreenings, screenQueue } from './screening.js';
import { buildFeedbackBlock, ensurePreferences, loadFeedbackExamples, loadPreferences } from './feedback.js';
import { callModel, extractJson } from './llm.js';

const MAX_PULL_PAGES = 200;

function errorInfo(error) {
  if (error instanceof OpenAlexError) {
    return { kind: error.kind, message: error.message, status: error.status, hint: error.body?.hint ?? null };
  }
  return { kind: 'internal', message: error instanceof Error ? error.message : String(error), hint: null };
}

export function createService({ config = {}, ctx = null } = {}) {
  /** 工作区：调用方显式给，或插件配置里的默认值。 */
  async function resolveWorkspace(input) {
    const raw = typeof input === 'string' && input.trim() !== ''
      ? input.trim()
      : typeof config.workspace === 'string' && config.workspace.trim() !== ''
        ? config.workspace.trim()
        : '';
    if (raw === '') throw new Error('还没有设置工作区：在「文献拉取」面板的设置里填工作区路径');
    const workspace = path.resolve(raw);
    const info = await stat(workspace).catch(() => null);
    if (info === null || !info.isDirectory()) throw new Error(`工作区不存在或不是目录：${workspace}`);
    return workspace;
  }

  function stateDirOf(workspace) {
    return resolveStateDir(workspace, config);
  }

  function findDirection(doc, id) {
    const direction = (doc.directions ?? []).find((item) => item.id === id);
    if (!direction) throw new Error(`找不到方向：${id}`);
    return direction;
  }

  function summarizeDirection(direction) {
    return {
      id: direction.id,
      name: direction.name,
      enabled: direction.enabled !== false,
      mode: direction.mode,
      description: direction.description ?? {},
      types: direction.types ?? '',
      language: direction.language ?? '',
      extraFilter: direction.extraFilter ?? '',
      condition: direction.mode === 'text'
        ? { query: direction.text?.query ?? '' }
        : direction.mode === 'topics'
          ? { ids: direction.topics?.ids ?? [], match: direction.topics?.match ?? 'any' }
          : { ids: direction.keywords?.ids ?? [], match: direction.keywords?.match ?? 'any' },
      updatedAt: direction.updatedAt ?? null,
    };
  }

  async function getState(workspaceInput) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const [doc, library, pullState, usage, key, screenings, settings] = await Promise.all([
      loadDirections(stateDir),
      loadLibrary(stateDir),
      loadPullState(stateDir),
      loadUsage(stateDir),
      describeKey(stateDir, config),
      loadScreenings(stateDir),
      loadSettings(stateDir),
    ]);
    const cardsInfo = await cardQueue(stateDir, { minScore: settings.cardsMinScore, limit: 1 });
    return {
      ok: true,
      workspace,
      stateDir,
      defaultWindow: defaultWindow(settings.monthsBack),
      today: hkToday(),
      directions: doc.directions.map(summarizeDirection),
      librarySize: library.records.length,
      pendingScreening: Math.max(0, library.records.length - screenings.size),
      cardsReady: cardsInfo.total,
      pendingPulls: Object.values(pullState).filter((item) => item && item.complete === false).length,
      usage,
      key,
      settings: await publicSettings(stateDir),
    };
  }

  async function saveDirection(workspaceInput, directionInput) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const doc = await loadDirections(stateDir);
    const { direction, error } = normalizeDirection(directionInput, doc.directions);
    if (error) throw new Error(error);
    const index = doc.directions.findIndex((item) => item.id === direction.id);
    if (index >= 0) {
      direction.createdAt = doc.directions[index].createdAt ?? direction.createdAt;
      doc.directions[index] = direction;
    } else {
      doc.directions.push(direction);
    }
    await saveDirections(stateDir, doc);
    return { ok: true, saved: summarizeDirection(direction), directions: doc.directions.map(summarizeDirection) };
  }

  async function deleteDirection(workspaceInput, id) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const doc = await loadDirections(stateDir);
    const index = doc.directions.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`找不到方向：${id}`);
    const [removed] = doc.directions.splice(index, 1);
    await saveDirections(stateDir, doc);
    return { ok: true, removed: summarizeDirection(removed), directions: doc.directions.map(summarizeDirection) };
  }

  async function resolveEntity(workspaceInput, { kind, search }) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const { key } = await resolveApiKey(stateDir, config);
    const normalizedKind = kind === 'keywords' ? 'keywords' : 'topics';
    const query = String(search ?? '').trim();
    if (query === '') throw new Error('解析需要关键词');
    const items = normalizedKind === 'keywords'
      ? await resolveKeywords(query, { apiKey: key })
      : await resolveTopics(query, { apiKey: key });
    return { ok: true, kind: normalizedKind, search: query, items };
  }

  async function preview(workspaceInput, { directionId, from, to, limit }) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const doc = await loadDirections(stateDir);
    const direction = findDirection(doc, directionId);
    const settings = await loadSettings(stateDir);
    const filterOptions = { defaultTypes: settings.defaultTypes, defaultLanguage: settings.defaultLanguage };
    const window = resolveWindow({ from, to }, settings.monthsBack);
    const { key } = await resolveApiKey(stateDir, config);
    const size = Math.min(Math.max(Number(limit) || settings.previewLimit, 1), 10);
    const result = await previewWorks(direction, { window, limit: size, apiKey: key, filterOptions });
    await saveUsage(stateDir, { directionId, window, count: result.count, budget: result.budget, costUsd: result.costUsd });
    return {
      ok: true,
      direction: summarizeDirection(direction),
      condition: describeCondition(direction, window, filterOptions),
      count: result.count,
      sample: result.items.map((item) => ({
        openalexId: item.openalexId,
        title: item.title,
        journal: item.journal,
        publicationDate: item.publicationDate,
        doi: item.doi || null,
        hasAbstract: item.abstract !== '',
        url: item.url,
      })),
      costUsd: result.costUsd,
      budget: result.budget,
    };
  }

  async function pull(workspaceInput, { directionIds, from, to, maxPages, resume, onProgress } = {}) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    await ensureDir(stateDir);
    const doc = await loadDirections(stateDir);
    if (doc.directions.length === 0) throw new Error('还没有任何研究方向，先新增一个方向');
    const requested = Array.isArray(directionIds) && directionIds.length > 0
      ? doc.directions.filter((item) => directionIds.includes(item.id))
      : doc.directions.filter((item) => item.enabled !== false);
    if (requested.length === 0) throw new Error('没有匹配的方向（检查选择或启用状态）');

    const settings = await loadSettings(stateDir);
    const filterOptions = { defaultTypes: settings.defaultTypes, defaultLanguage: settings.defaultLanguage };
    const window = resolveWindow({ from, to }, settings.monthsBack);
    const pageLimit = Math.min(Math.max(Number(maxPages) || settings.pullMaxPages, 1), MAX_PULL_PAGES);
    const useResume = resume !== false;
    const { key } = await resolveApiKey(stateDir, config);
    const library = await loadLibrary(stateDir);
    const pullState = await loadPullState(stateDir);
    const directionLabels = Object.fromEntries(doc.directions.map((item) => [item.id, item.name]));
    const summaries = [];

    for (const direction of requested) {
      const stateKey = `${direction.id}::${window.from}::${window.to}`;
      const saved = useResume ? pullState[stateKey] : null;
      const condition = describeCondition(direction, window, filterOptions);
      let added = 0;
      let updated = 0;
      const addedRecords = [];
      let result;
      try {
        result = await pullWorks(direction, {
          window,
          apiKey: key,
          maxPages: pageLimit,
          filterOptions,
          cursor: saved && !saved.complete ? saved.cursor ?? null : null,
          page: saved && !saved.complete ? saved.page ?? 1 : 1,
          onPage: async (pageInfo) => {
            const merged = mergeRecords(library, pageInfo.records, direction.id, new Date().toISOString());
            added += merged.added;
            updated += merged.updated;
            for (const record of merged.addedRecords) {
              if (!addedRecords.some((item) => item.openalexId === record.openalexId)) addedRecords.push(record);
            }
            await saveLibrary(stateDir, library);
            pullState[stateKey] = {
              directionId: direction.id,
              from: window.from,
              to: window.to,
              cursor: pageInfo.nextCursor ?? null,
              page: pageInfo.page,
              fetched: pageInfo.fetched,
              count: pageInfo.count,
              complete: false,
              updatedAt: new Date().toISOString(),
            };
            await savePullState(stateDir, pullState);
            if (typeof onProgress === 'function') {
              onProgress({
                directionId: direction.id,
                directionName: direction.name,
                page: pageInfo.page,
                fetched: pageInfo.fetched,
                count: pageInfo.count,
                added,
                costUsd: pageInfo.costUsd,
                budget: pageInfo.budget,
              });
            }
          },
        });
      } catch (error) {
        pullState[stateKey] = {
          directionId: direction.id,
          from: window.from,
          to: window.to,
          cursor: null,
          page: 1,
          fetched: 0,
          count: null,
          complete: false,
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        await savePullState(stateDir, pullState);
        summaries.push({ id: direction.id, name: direction.name, condition, error: errorInfo(error), added, updated, fetched: 0, complete: false });
        continue;
      }

      pullState[stateKey] = {
        directionId: direction.id,
        from: window.from,
        to: window.to,
        cursor: result.nextCursor ?? null,
        page: result.nextPage ?? 0,
        fetched: result.fetched,
        count: result.count,
        complete: result.complete,
        stoppedReason: result.stoppedReason,
        updatedAt: new Date().toISOString(),
      };
      await savePullState(stateDir, pullState);

      let exportFile = null;
      if (addedRecords.length > 0) {
        const exported = await exportCandidates(stateDir, addedRecords, {
          stamp: `${hkToday()}-${direction.id}`,
          directionLabels,
        });
        exportFile = exported.file;
      }
      summaries.push({
        id: direction.id,
        name: direction.name,
        condition,
        count: result.count,
        fetched: result.fetched,
        added,
        updated,
        complete: result.complete,
        stoppedReason: result.stoppedReason,
        hint: result.hint ?? null,
        pages: result.pages.length,
        costUsd: Number(result.totalCost.toFixed(6)),
        budget: result.budget,
        exportFile,
      });
      await saveUsage(stateDir, { directionId: direction.id, window, budget: result.budget, costUsd: result.totalCost });
    }

    await saveLibrary(stateDir, library);
    return {
      ok: true,
      window,
      apiKey: key === null ? 'anonymous' : 'configured',
      directions: summaries,
      allComplete: summaries.every((item) => item.error === undefined && item.complete === true),
      librarySize: library.records.length,
      workspace,
      stateDir,
    };
  }

  async function listLibrary(workspaceInput, { limit = 30 } = {}) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const library = await loadLibrary(stateDir);
    const size = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const recent = [...library.records]
      .sort((a, b) => String(b.firstSeen ?? '').localeCompare(String(a.firstSeen ?? '')))
      .slice(0, size)
      .map((record) => ({
        openalexId: record.openalexId,
        doi: record.doi || null,
        title: record.title,
        journal: record.journal,
        publicationDate: record.publicationDate,
        firstSeen: record.firstSeen,
        directions: record.directions ?? [],
        hasAbstract: Boolean(record.abstract),
      }));
    return { ok: true, librarySize: library.records.length, recent };
  }

  async function setKey(workspaceInput, openalexKey) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    await updateSettingsFile(stateDir, { openalexKey: openalexKey ?? null });
    return { ok: true, key: await describeKey(stateDir, config) };
  }

  // ------------------------------------------------------------ 筛选 / 卡片

  async function getScreenQueue(workspaceInput, { limit = 10 } = {}) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const result = await screenQueue(stateDir, { limit });
    return { ok: true, workspace, ...result };
  }

  async function saveScreeningResults(workspaceInput, entries) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const result = await saveScreenings(stateDir, entries);
    return { ok: true, workspace, ...result };
  }

  async function getCards(workspaceInput, { minScore, limit = 100, hideRead = true } = {}) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const settings = await loadSettings(stateDir);
    const floor = minScore === undefined || minScore === null ? settings.cardsMinScore : minScore;
    const result = await cardQueue(stateDir, { minScore: floor, limit, hideRead });
    return { ok: true, workspace, ...result };
  }

  async function getDeckSummary(workspaceInput) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const settings = await loadSettings(stateDir);
    const result = await deckSummary(stateDir, { minScore: settings.cardsMinScore });
    return { ok: true, workspace, ...result };
  }

  async function updateSettings(workspaceInput, patch) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const settings = await updateSettingsFile(stateDir, patch ?? {});
    return { ok: true, settings, key: await describeKey(stateDir, config), workspace };
  }

  async function rateCard(workspaceInput, payload) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const result = await recordRating(workspace, stateDir, payload ?? {});
    return { ...result, workspace };
  }

  // ------------------------------------------------------------ 模型选择

  /** 可用模型列表（provider 分组）+ 当前默认/本插件选定的模型。 */
  async function getModels(workspaceInput) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const llm = (() => { try { return ctx.get('llm'); } catch { return undefined; } })();
    if (!llm || typeof llm.listProviders !== 'function') throw new Error('当前 DSH 没有模型服务（llm），无法列出模型');
    const settings = await loadSettings(stateDir);
    const providers = llm.listProviders();
    const groups = [];
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id);
        const entries = [];
        for (const model of models) {
          let reasoning = null;
          try {
            const resolved = typeof llm.resolveModelInfo === 'function' ? await llm.resolveModelInfo(provider.id, model.id) : null;
            if (resolved?.reasoning) {
              reasoning = {
                efforts: (resolved.reasoning.efforts ?? []).map((effort) => ({ id: effort.id, name: effort.name ?? effort.id })),
                defaultEffort: resolved.reasoning.defaultEffort ?? null,
              };
            }
          } catch {
            reasoning = null;
          }
          entries.push({ id: model.id, name: model.name ?? model.id, badge: model.badge ?? null, reasoning });
        }
        groups.push({ provider: provider.id, providerName: provider.name ?? provider.id, models: entries });
      } catch {
        /* 单个 provider 失败不影响整体 */
      }
    }
    let defaults = null;
    try {
      defaults = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null;
    } catch {
      defaults = null;
    }
    return {
      ok: true,
      workspace,
      groups,
      defaultSelection: defaults,
      selected: { provider: settings.llmProvider, model: settings.llmModel, reasoningEffort: settings.llmReasoningEffort },
    };
  }

  function modelOverrideOf(settings) {
    if (settings.llmProvider === '' || settings.llmModel === '') return {};
    return {
      provider: settings.llmProvider,
      model: settings.llmModel,
      ...(settings.llmReasoningEffort !== '' ? { reasoningEffort: settings.llmReasoningEffort } : {}),
    };
  }

  // ------------------------------------------------------------ 回顾列表

  async function getHistory(workspaceInput, { directionId, kind, limit } = {}) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const settings = await loadSettings(stateDir);
    const result = await listHistory(stateDir, {
      directionId: typeof directionId === 'string' ? directionId : '',
      kind: typeof kind === 'string' ? kind : 'all',
      limit,
      minScore: settings.cardsMinScore,
    });
    return { ok: true, workspace, ...result };
  }

  // ------------------------------------------------------------ 一键 AI 配置 / 筛选

  /** 用邮箱向 OpenAlex 申请免费 API key，申请成功后直接保存到当前工作区。 */
  async function requestKey(workspaceInput, { email } = {}) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const address = String(email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('邮箱格式不对，请填写你自己的邮箱');
    let response;
    try {
      response = await fetch('https://api.openalex.org/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: address, agent: 'DeepSeek Harness', name: 'DeepSeek Harness user' }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new Error(`连接 OpenAlex 失败：${error.message}`);
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const code = payload?.code ?? payload?.error ?? `HTTP ${response.status}`;
      if (String(code).includes('account_exists')) {
        throw new Error('这个邮箱已经有 OpenAlex 账户了：请登录 openalex.org → Settings → API key 复制 key，再手动填到上面');
      }
      if (String(code).includes('activation_pending')) {
        throw new Error('这个邮箱已申请过 key、还在等激活：去邮箱点「Activate your OpenAlex API key」即可；或等邮件重发');
      }
      throw new Error(`OpenAlex 拒绝了申请（${code}）：${String(payload?.message ?? text).slice(0, 200)}`);
    }
    const key = typeof payload?.api_key === 'string' ? payload.api_key : '';
    if (key === '') throw new Error('OpenAlex 没有返回 key，请稍后重试或改用手动填写');
    const saved = await setKey(workspace, key);
    return {
      ok: true,
      email: address,
      status: payload?.status ?? 'pending_activation',
      message: payload?.message ?? '已发送激活邮件',
      key: saved.key,
      activationExpires: payload?.activation_link_expires ?? null,
    };
  }

  /** 用一段自然语言描述自动生成研究方向（检索式 + 描述），并保存。 */
  async function autoConfigure(workspaceInput, { description, mode = 'auto' } = {}) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const text = String(description ?? '').trim();
    if (text.length < 5) throw new Error('先用一句话描述你的研究方向（至少 5 个字）');
    const requestedMode = ['auto', 'text', 'topics', 'keywords'].includes(String(mode)) ? String(mode) : 'auto';
    const doc = await loadDirections(stateDir);
    const existing = doc.directions.map((item) => item.name).join('、') || '（暂无）';
    const system = [
      '你是学术文献检索配置助手，服务对象是材料/化学/物理方向的研究者。',
      '把用户的一段自然语言研究描述，转成 OpenAlex 的检索配置。只输出一个 JSON 对象，不要任何解释。',
    ].join('\n');
    const prompt = [
      `用户的研究描述：${text}`,
      `已有方向（避免重名）：${existing}`,
      `用户希望的检索方式：${requestedMode === 'auto' ? '由你判断最合适的一种' : { text: '文字检索', topics: 'Topics 主题', keywords: 'Keywords 关键词' }[requestedMode]}`,
      '',
      '输出 JSON 字段：',
      '{',
      '  "mode": "text | topics | keywords（你判断最合适的一种）",',
      '  "name": "简短中文方向名（6–20 字）",',
      '  "object": "研究对象（材料/体系/关键词，中英文均可）",',
      '  "focus": "关注内容（性能/方法/问题）",',
      '  "exclude": "排除范围（可为空字符串）",',
      '  "query": "OpenAlex 布尔检索式，作用于标题+摘要",',
      '  "topicsSearch": ["1–2 个英文主题词，用于解析 OpenAlex Topics（可为空数组）"],',
      '  "keywordsSearch": ["1–3 个英文关键词，用于解析 OpenAlex Keywords（可为空数组）"]',
      '}',
      '',
      '检索方式怎么选：',
      '- topics：研究方向成熟、OpenAlex 有明确主题分类时（宽口径、召回多）；',
      '- keywords：关注具体材料/工艺/方法关键词时（精确、误检少）；',
      '- text：需要复杂布尔组合或排除条件时；',
      '- 三种方式都要顺手给出 query / topicsSearch / keywordsSearch，便于随时切换。',
      '',
      '检索式要求：',
      '- 用 AND / OR / NOT、双引号短语、括号分组；不要出现逗号；',
      '- 至少包含「对象」与「关注点」两组概念，组内 OR、组间 AND；',
      '- 英文检索词命中率最高，中文概念请转成英文；',
      '- 示例：("laser powder bed fusion" OR LPBF OR "additive manufacturing") AND ("Inconel 718" OR IN718 OR "Ni-based superalloy")',
    ].join('\n');
    const raw = await callModel(ctx, { system, prompt, temperature: 0.2, ...modelOverrideOf(await loadSettings(stateDir)) });
    const parsed = extractJson(raw);
    const name = String(parsed.name ?? '').trim();
    if (name === '') throw new Error('模型返回的配置缺少方向名，请换个描述再试');
    const query = String(parsed.query ?? '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const parsedMode = ['text', 'topics', 'keywords'].includes(String(parsed.mode ?? '')) ? String(parsed.mode) : 'text';
    let chosenMode = requestedMode === 'auto' ? parsedMode : requestedMode;
    const apiKey = (await resolveApiKey(stateDir, config)).key;
    const suggestions = { topics: [], keywords: [] };
    try {
      for (const term of (Array.isArray(parsed.topicsSearch) ? parsed.topicsSearch : []).slice(0, 2)) {
        if (String(term).trim() === '') continue;
        suggestions.topics.push(...(await resolveTopics(String(term).trim(), { apiKey, perPage: 5 })));
      }
      for (const term of (Array.isArray(parsed.keywordsSearch) ? parsed.keywordsSearch : []).slice(0, 3)) {
        if (String(term).trim() === '') continue;
        suggestions.keywords.push(...(await resolveKeywords(String(term).trim(), { apiKey, perPage: 5 })));
      }
    } catch {
      /* 建议解析失败不影响保存 */
    }
    const descriptionBlock = {
      object: String(parsed.object ?? '').trim(),
      focus: String(parsed.focus ?? '').trim(),
      exclude: String(parsed.exclude ?? '').trim(),
    };
    const uniqueTopics = [...new Set(suggestions.topics.map((item) => item.id))].slice(0, 8);
    const uniqueKeywords = [...new Set(suggestions.keywords.map((item) => item.id))].slice(0, 10);
    let directionInput;
    if (chosenMode === 'topics' && uniqueTopics.length > 0) {
      directionInput = { name, description: descriptionBlock, mode: 'topics', topics: { ids: uniqueTopics, match: 'any' }, ...(query !== '' ? { text: { query } } : {}) };
    } else if (chosenMode === 'keywords' && uniqueKeywords.length > 0) {
      directionInput = { name, description: descriptionBlock, mode: 'keywords', keywords: { ids: uniqueKeywords, match: 'any' }, ...(query !== '' ? { text: { query } } : {}) };
    } else {
      if (query === '') throw new Error('模型没生成可用检索式：请换个描述，或改选 Topics/Keywords');
      chosenMode = 'text';
      directionInput = { name, description: descriptionBlock, mode: 'text', text: { query } };
    }
    const saved = await saveDirection(workspace, directionInput);
    return {
      ok: true,
      workspace,
      mode: saved.saved.mode,
      requestedMode,
      saved: saved.saved,
      directions: saved.directions,
      suggestions,
      modelText: raw.slice(0, 2000),
    };
  }

  /** 查看/生成偏好摘要（反馈如何影响筛选的可见入口）。 */
  async function getPreferences(workspaceInput, { refresh = false } = {}) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const settings = await loadSettings(stateDir);
    let prefs;
    if (refresh) {
      prefs = await ensurePreferences(ctx, stateDir, { settings, modelOverride: modelOverrideOf(settings), force: true });
    } else {
      prefs = (await loadPreferences(stateDir)) ?? { summary: '', generatedAt: null, feedbackCount: 0 };
    }
    const examples = await loadFeedbackExamples(stateDir);
    return {
      ok: true,
      workspace,
      enabled: settings.useFeedback !== false,
      summary: prefs.summary ?? '',
      generatedAt: prefs.generatedAt ?? null,
      feedbackCount: examples.count,
      likes: examples.liked.length,
      dislikes: examples.disliked.length,
      notes: examples.withNotes.length,
      error: prefs.error ?? null,
    };
  }

  /** 用模型批量筛选待筛选论文，生成评分与中文卡片内容。 */
  async function autoScreen(workspaceInput, { limit = 10, onProgress } = {}) {
    const workspace = await resolveWorkspace(workspaceInput);
    const stateDir = stateDirOf(workspace);
    const total = Math.min(Math.max(Number(limit) || 10, 1), 30);
    const queue = await screenQueue(stateDir, { limit: total });
    if (queue.items.length === 0) {
      return { ok: true, workspace, screened: 0, skipped: 0, cardsReady: 0, note: '没有待筛选论文：先拉取，或全部已筛选。' };
    }
    const system = [
      '你是学术文献筛选助手，服务对象是材料/化学/物理方向的研究者。',
      '按 rubric 给论文打分，并生成中文卡片内容。只输出 JSON 数组，不要任何解释。',
      'rubric：5=同题直接命中；4=方法或对象交叉可用；3=同领域邻近；2=仅词面相关；1=无关。',
      '每篇必须引用标题或摘要里的一句作为依据；没有摘要时最高 3 分，abstractZh 输出空字符串。',
      '如果用户提供了历史反馈，请让评分与之一致；但没有明确证据时仍以 rubric 为准。',
    ].join('\n');
    // 反馈注入：历史评分/评语 + 偏好摘要（缓存，反馈变化≥2 条才重算）
    const screenSettings = await loadSettings(stateDir);
    const screenModel = modelOverrideOf(screenSettings);
    let feedbackBlock = '';
    if (screenSettings.useFeedback !== false) {
      try {
        const examples = await loadFeedbackExamples(stateDir);
        const prefs = await ensurePreferences(ctx, stateDir, { settings: screenSettings, modelOverride: screenModel });
        feedbackBlock = buildFeedbackBlock({ ...examples, summary: prefs.summary ?? '' });
      } catch {
        feedbackBlock = '';
      }
    }
    const batchSize = 4;
    const batches = [];
    for (let start = 0; start < queue.items.length; start += batchSize) {
      batches.push(queue.items.slice(start, start + batchSize));
    }
    if (typeof onProgress === 'function') {
      onProgress({ screened: 0, skipped: 0, batch: 0, batches: batches.length, total: queue.items.length, done: 0 });
    }
    let screened = 0;
    let skipped = 0;
    let done = 0;
    const collected = [];
    const runBatch = async (slice) => {
      const papers = slice.map((item, index) => [
        `#${index + 1} openalexId=${item.openalexId} | doi=${item.doi ?? '无'} | ${item.journal ?? ''} | ${item.publicationDate ?? ''}`,
        `标题：${item.title}`,
        `摘要：${(item.abstract || '（无摘要）').slice(0, 900)}`,
      ].join('\n')).join('\n\n');
      const prompt = [
        feedbackBlock,
        '待筛选论文：',
        papers,
        '',
        `输出 JSON 数组，长度 ${slice.length}，每项字段：`,
        '{ "openalexId": "与上面一致的 ID", "score": 1-5 的整数, "zhTitle": "中文标题",',
        '  "summary": "2–3 句中文内容梳理（有摘要按摘要写，无摘要只按标题）",',
        '  "comment": "一句小师妹口吻的点评（活泼、短句、可带一点吐槽，但不失准确）",',
        '  "abstractZh": "摘要的忠实中文翻译；无摘要则空字符串" }',
        '注意：openalexId 必须逐字使用上面给出的值，不要杜撰。',
      ].join('\n');
      const raw = await callModel(ctx, { system, prompt, temperature: 0.3, ...screenModel });
      const parsed = extractJson(raw, { array: true });
      const entries = parsed.map((entry) => ({
        openalexId: String(entry?.openalexId ?? ''),
        score: Number(entry?.score),
        zhTitle: String(entry?.zhTitle ?? ''),
        summary: String(entry?.summary ?? ''),
        comment: String(entry?.comment ?? ''),
        abstractZh: String(entry?.abstractZh ?? ''),
      })).filter((entry) => slice.some((item) => item.openalexId === entry.openalexId) && Number.isFinite(entry.score));
      collected.push(...entries);
      done += 1;
      screened = collected.length;
      if (typeof onProgress === 'function') {
        onProgress({ screened, skipped, batch: done, batches: batches.length, total: queue.items.length, done });
      }
    };
    // 两路并发：每批 4 篇，10 篇大约 3 批 → 两轮完成，明显更快。
    // 注意：写文件只在全部批次结束后做一次，避免并发读改写互相覆盖。
    const queueBatches = [...batches];
    const workers = Array.from({ length: Math.min(2, queueBatches.length) }, async () => {
      while (queueBatches.length > 0) {
        const slice = queueBatches.shift();
        await runBatch(slice);
      }
    });
    await Promise.all(workers);
    const savedAll = collected.length === 0 ? { saved: 0, problems: [] } : await saveScreenings(stateDir, collected);
    screened = savedAll.saved;
    skipped = queue.items.length - savedAll.saved + savedAll.problems.length;
    if (typeof onProgress === 'function') {
      onProgress({ screened, skipped, batch: batches.length, batches: batches.length, total: queue.items.length, done: batches.length });
    }
    const cards = await cardQueue(stateDir, { minScore: 4, limit: 1, hideRead: true });
    return { ok: true, workspace, screened, skipped, cardsReady: cards.total, queued: queue.items.length };
  }

  return {
    resolveWorkspace,
    getState,
    saveDirection,
    deleteDirection,
    resolveEntity,
    preview,
    pull,
    listLibrary,
    setKey,
    updateSettings,
    getScreenQueue,
    saveScreeningResults,
    getCards,
    getHistory,
    getDeckSummary,
    getModels,
    rateCard,
    autoConfigure,
    autoScreen,
    getPreferences,
    requestKey,
    defaultWindow,
    hkToday,
  };
}

export { errorInfo };
