/**
 * lib/llm.js — 在 host 侧调用 DSH 自己的模型（不需要用户回对话下指令）
 *
 * 依赖两个宿主服务：
 *   · ctx.get('llm')            —— 模型流式接口
 *   · ctx.get('agentDefaultModel') —— 用户当前默认模型（provider/model）
 */

export async function callModel(ctx, { system, prompt, temperature = 0.2, maxChars = 20000, provider: providerOverride = '', model: modelOverride = '', reasoningEffort: effortOverride = '' } = {}) {
  let llm;
  try {
    llm = ctx.get('llm');
  } catch {
    llm = undefined;
  }
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('当前 DSH 没有可用的模型服务（llm），无法自动配置/自动筛选');
  }
  let selection;
  try {
    selection = ctx.get('agentDefaultModel')?.currentSelection?.();
  } catch {
    selection = undefined;
  }
  const provider = providerOverride !== '' ? providerOverride : selection?.provider;
  const model = modelOverride !== '' ? modelOverride : selection?.model;
  if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') {
    throw new Error('没有找到默认模型（agentDefaultModel），请先在「设置 → Models」里选一个模型');
  }
  let out = '';
  const effort = effortOverride !== '' ? effortOverride : selection?.reasoningEffort;
  for await (const chunk of llm.stream({
    provider,
    model,
    ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}),
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature,
  })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      out += chunk.text;
      if (out.length > 200000) break;
    }
  }
  return out.slice(0, maxChars);
}

/** 从模型输出里抠出第一个 JSON 值（容忍 ```json 包裹和前后废话）。 */
export function extractJson(text, { array = false } = {}) {
  const raw = String(text ?? '');
  const open = array ? '[' : '{';
  const close = array ? ']' : '}';
  const start = raw.indexOf(open);
  if (start < 0) throw new Error('模型没有返回 JSON');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const slice = raw.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (error) {
          throw new Error(`模型返回的 JSON 解析失败：${error.message}`);
        }
      }
    }
  }
  throw new Error('模型返回的 JSON 不完整');
}
