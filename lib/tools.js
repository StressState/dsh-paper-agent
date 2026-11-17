/**
 * lib/tools.js — 面向模型的工具（薄封装）
 *
 * 真正的逻辑在 lib/service.js，与 HTTP 路由共用。
 */

import { resolveWorkspace } from './store.js';
import { createService, errorInfo } from './service.js';

function execWorkspace(exec) {
  return resolveWorkspace(exec);
}

export function registerPaperTools({ ctx, defineTool, config = {}, service = createService({ config }) }) {
  const toolResult = (value) => {
    const payload = value !== null && typeof value === 'object' ? value : { ok: true, value };
    return { presentationMeta: { kind: 'paper-agent/result', ...payload }, ...payload };
  };

  const errorResult = (error) => ({ ok: false, error: errorInfo(error) });

  ctx.tools.register(defineTool({
    name: 'paper_directions',
    description: [
      '管理 OpenAlex 文献拉取的研究方向（list / save / delete），并解析 Topics、Keywords 的 OpenAlex ID（resolve）。',
      '保存方向时按 mode 提供条件：',
      '· text：{ text: { query: "布尔检索式，例如 (\\"laser powder bed fusion\\" OR LPBF) AND (\\"Inconel 718\\" OR IN718)" } }',
      '· topics：{ topics: { ids: ["T11690"], match: "any"|"all" } }',
      '· keywords：{ keywords: { ids: ["keywords/zinc-anode"], match: "any"|"all" } }',
      '不确定 ID 时先用 op=resolve（kind=topics|keywords + search），再把确认的 ID 保存进方向。',
      '方向配置保存在调用者工作区的 stateDir/directions.json，可手改、可迁移。',
    ].join('\n'),
    parameters: {
      op: { type: 'string', enum: ['list', 'save', 'delete', 'resolve'], required: true, description: 'list / save / delete / resolve' },
      direction: { type: 'object', additionalProperties: true, description: 'op=save：{ id?, name, enabled?, description:{object,focus,exclude}, mode, text?/topics?/keywords?, types?, language?, extraFilter? }' },
      id: { type: 'string', description: 'op=delete：方向 id' },
      kind: { type: 'string', enum: ['topics', 'keywords'], description: 'op=resolve：解析哪类实体' },
      search: { type: 'string', description: 'op=resolve：关键词（英文效果最好）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        const workspace = execWorkspace(exec);
        const op = String(args?.op ?? '');
        if (op === 'resolve') {
          return toolResult(await service.resolveEntity(workspace, { kind: args?.kind, search: args?.search }));
        }
        if (op === 'list' || op === '') {
          const state = await service.getState(workspace);
          return toolResult({ ok: true, workspace: state.workspace, stateDir: state.stateDir, count: state.directions.length, directions: state.directions, librarySize: state.librarySize, key: state.key });
        }
        if (op === 'save') {
          return toolResult(await service.saveDirection(workspace, args?.direction));
        }
        if (op === 'delete') {
          return toolResult(await service.deleteDirection(workspace, String(args?.id ?? '')));
        }
        return errorResult(new Error(`未知 op：${op}（可用 list / save / delete / resolve）`));
      } catch (error) {
        return errorResult(error);
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'paper_preview',
    description: [
      '测试拉取：用指定方向的条件发 1 个请求，返回生效条件、命中总数和最多 10 篇样本（标题/期刊/日期/DOI）。',
      '不拉全量、不写库；默认窗口是「上月 1 日 — 本月末」。',
    ].join('\n'),
    parameters: {
      directionId: { type: 'string', required: true, description: '方向 id' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（可选）' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD（可选）' },
      limit: { type: 'integer', description: '样本条数 1–10，默认 10' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        return toolResult(await service.preview(execWorkspace(exec), {
          directionId: String(args?.directionId ?? ''),
          from: args?.from,
          to: args?.to,
          limit: args?.limit,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'paper_pull',
    description: [
      '正式拉取：对指定方向按「月份窗口」分页拉取全部命中，按 OpenAlex ID + DOI 去重写入工作区文献库，并导出候选 JSON 供卡片台导入。',
      '窗口默认上月 1 日 — 本月末；分页：有 key 用 cursor 拉完，无 key 用 page（最多 10,000 条并标未完成）。',
      '中断/限速会保存进度，再次调用默认续拉；不会因为遇到已见论文而提前停止。',
    ].join('\n'),
    parameters: {
      directionIds: { type: 'array', items: { type: 'string' }, description: '方向 id 数组；省略则拉所有启用方向' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（可选）' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD（可选）' },
      maxPages: { type: 'integer', description: '本次最多翻页数（1–200，默认 200）' },
      resume: { type: 'boolean', description: '是否续拉上次未完成的进度（默认 true）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 900000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        return toolResult(await service.pull(execWorkspace(exec), {
          directionIds: args?.directionIds,
          from: args?.from,
          to: args?.to,
          maxPages: args?.maxPages,
          resume: args?.resume,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'paper_status',
    description: '查看研究方向、文献库规模、最近拉取状态与 OpenAlex 额度；不发起网络请求。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      try {
        const state = await service.getState(execWorkspace(exec));
        return toolResult({ ok: true, ...state });
      } catch (error) {
        return errorResult(error);
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'paper_screen_queue',
    description: [
      '取待筛选论文：返回库里还没有筛选结果的论文（带标题、作者、期刊、日期、摘要、OpenAlex ID、方向），按首次发现时间倒序。',
      '拿到后按 rubric 逐篇打分（5=同题直接命中；4=方法或对象交叉可用；3=同领域邻近；2=仅词面相关；1=无关），',
      '并为每篇生成中文标题、2–3 句中文梳理、小师妹点评（有摘要时一并给出中文摘要翻译），再用 paper_screen_save 写回。',
      '每篇必须引用标题或摘要里的一句作为依据；没有摘要时最高 3 分。score>=4 的才会进入「文献卡片台」推送队列。',
    ].join('\n'),
    parameters: {
      limit: { type: 'integer', description: '最多取几条（1–50，默认 10）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        return toolResult(await service.getScreenQueue(execWorkspace(exec), { limit: args?.limit ?? 10 }));
      } catch (error) {
        return errorResult(error);
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'paper_screen_save',
    description: [
      '保存筛选结果：数组，每项 { openalexId, score(1–5), zhTitle, summary, comment, abstractZh? }。',
      'score>=4 的论文会进入「文献卡片台」的推送队列；1–2 分会被丢弃但仍记录，便于后续演化。',
      'openalexId 必须来自 paper_screen_queue 返回的条目。',
    ].join('\n'),
    parameters: {
      screenings: {
        type: 'array',
        required: true,
        description: '筛选结果数组，每项 { openalexId, score, zhTitle, summary, comment, abstractZh? }',
        items: { type: 'object', additionalProperties: true },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        return toolResult(await service.saveScreeningResults(execWorkspace(exec), args?.screenings));
      } catch (error) {
        return errorResult(error);
      }
    },
  }));
}
