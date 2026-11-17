/**
 * lib/dispatch.js — 面板数据通道的动作分发（与传输方式解耦）
 *
 * 当前桌面壳的 Web 服务只允许 GET/HEAD，插件 HTTP 路由不可用；
 * 因此由 lib/bridge.js 起一个 127.0.0.1 小服务，把 JSON 动作交给这里处理。
 */

import { loadLastWorkspace, rememberWorkspace } from './lastworkspace.js';
import { createService, errorInfo } from './service.js';

export function createDispatcher({ config = {}, service = createService({ config }) } = {}) {
  const jobs = new Map();
  const JOB_TTL_MS = 60 * 60 * 1000;

  function cleanupJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (now - job.startedAt > JOB_TTL_MS) jobs.delete(id);
    }
  }

  const REMEMBER_ACTIONS = new Set(['directions', 'settings', 'pull', 'auto-config', 'auto-screen', 'rate']);

  async function dispatch(action, body = {}) {
    if (REMEMBER_ACTIONS.has(action) && typeof body?.workspace === 'string' && body.workspace.trim() !== '') {
      try {
        await rememberWorkspace(body.workspace);
      } catch {
        /* 记忆失败不影响主流程 */
      }
    }
    switch (action) {
      case 'default-workspace': {
        if (typeof body?.workspace === 'string' && body.workspace.trim() !== '') {
          try { await rememberWorkspace(body.workspace); } catch { /* ignore */ }
          return { ok: true, workspace: body.workspace.trim() };
        }
        return { ok: true, workspace: await loadLastWorkspace() };
      }
      case 'auto-config':
        return service.autoConfigure(body?.workspace, { description: body?.description, mode: body?.mode });
      case 'preferences':
        return service.getPreferences(body?.workspace, { refresh: body?.refresh === true });
      case 'request-key':
        return service.requestKey(body?.workspace, { email: body?.email });
      case 'auto-screen': {
        cleanupJobs();
        const jobId = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const job = {
          id: jobId,
          kind: 'auto-screen',
          status: 'running',
          startedAt: Date.now(),
          progress: { screened: 0, skipped: 0, batch: 0, batches: 0, total: 0 },
          result: null,
          error: null,
        };
        jobs.set(jobId, job);
        Promise.resolve()
          .then(() => service.autoScreen(body?.workspace, {
            limit: body?.limit,
            onProgress: (progress) => { job.progress = { ...progress }; },
          }))
          .then((result) => {
            job.status = 'done';
            job.result = result;
          })
          .catch((error) => {
            job.status = 'error';
            job.error = errorInfo(error);
          });
        return { ok: true, jobId };
      }
      case 'auto-screen-status': {
        cleanupJobs();
        const job = jobs.get(String(body?.jobId ?? ''));
        if (!job) return { ok: false, error: { kind: 'not_found', message: '任务不存在或已过期', hint: null } };
        return { ok: true, job };
      }
      case 'state':
        return service.getState(body?.workspace);
      case 'directions': {
        const op = String(body?.op ?? 'list');
        if (op === 'save') return service.saveDirection(body?.workspace, body?.direction);
        if (op === 'delete') return service.deleteDirection(body?.workspace, String(body?.id ?? ''));
        const state = await service.getState(body?.workspace);
        return { ok: true, directions: state.directions };
      }
      case 'resolve':
        return service.resolveEntity(body?.workspace, { kind: body?.kind, search: body?.search });
      case 'preview':
        return service.preview(body?.workspace, {
          directionId: String(body?.directionId ?? ''),
          from: body?.from,
          to: body?.to,
          limit: body?.limit,
        });
      case 'pull': {
        cleanupJobs();
        const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const job = {
          id: jobId,
          status: 'running',
          startedAt: Date.now(),
          progress: { fetched: 0, count: null, added: 0, directionName: null },
          result: null,
          error: null,
        };
        jobs.set(jobId, job);
        Promise.resolve()
          .then(() => service.pull(body?.workspace, {
            directionIds: body?.directionIds,
            from: body?.from,
            to: body?.to,
            maxPages: body?.maxPages,
            resume: body?.resume,
            onProgress: (progress) => { job.progress = { ...progress }; },
          }))
          .then((result) => {
            job.status = 'done';
            job.result = result;
          })
          .catch((error) => {
            job.status = 'error';
            job.error = errorInfo(error);
          });
        return { ok: true, jobId };
      }
      case 'pull-status': {
        cleanupJobs();
        const job = jobs.get(String(body?.jobId ?? ''));
        if (!job) return { ok: false, error: { kind: 'not_found', message: '任务不存在或已过期', hint: null } };
        return { ok: true, job };
      }
      case 'settings': {
        if (body?.openalexKey !== undefined) return service.setKey(body?.workspace, body?.openalexKey);
        if (body?.settings !== undefined) return service.updateSettings(body?.workspace, body.settings);
        const state = await service.getState(body?.workspace);
        return { ok: true, key: state.key, settings: state.settings, workspace: state.workspace };
      }
      case 'library':
        return service.listLibrary(body?.workspace, { limit: body?.limit });
      case 'screen-queue':
        return service.getScreenQueue(body?.workspace, { limit: body?.limit });
      case 'screen-save':
        return service.saveScreeningResults(body?.workspace, body?.screenings);
      case 'cards':
        return service.getCards(body?.workspace, {
          minScore: body?.minScore,
          limit: body?.limit,
          hideRead: body?.hideRead !== false && body?.hideRated !== false,
        });
      case 'deck-summary':
        return service.getDeckSummary(body?.workspace);
      case 'history':
        return service.getHistory(body?.workspace, {
          directionId: body?.directionId,
          kind: body?.kind,
          limit: body?.limit,
        });
      case 'models':
        return service.getModels(body?.workspace);
      case 'rate':
        return service.rateCard(body?.workspace, {
          openalexId: body?.openalexId,
          doi: body?.doi,
          direction: body?.direction,
          rating: body?.rating,
          note: body?.note,
        });
      default:
        return { ok: false, error: { kind: 'invalid', message: `未知动作：${action}`, hint: null } };
    }
  }

  return { dispatch, jobs };
}
