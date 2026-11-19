#!/usr/bin/env node
/**
 * 离线自检 —— 不需要 DSH、不需要网络、不需要 API key。
 *
 * 覆盖：
 *   1. 发布内容检查（文件齐全、无本机路径 / key / 邮箱等个人信息）
 *   2. 客户端组件渲染（递归执行，捕获渲染期异常）
 *   3. 数据服务：方向、筛选结果、卡片、评分、回顾、方向统计
 *   4. 本地数据通道：启动、/ping、JSONP 查询
 *   5. AI 链路（假模型）：偏好摘要、反馈注入提示词、一键配置、一键筛选
 *
 * 用法：
 *   node test/offline.mjs
 *   PAPER_AGENT_ROOT=<已安装包目录> node test/offline.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PAPER_AGENT_ROOT
  ? path.resolve(process.env.PAPER_AGENT_ROOT)
  : path.resolve(TEST_DIR, '..');

// 测试隔离：让 lastworkspace 等 host 状态写进临时 DSH_HOME，绝不污染真实 ~/.dsh
const TEST_DSH_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'paper-agent-home-'));
process.env.DSH_HOME = TEST_DSH_HOME;

let failures = 0;
function check(label, fn) {
  try {
    const value = fn();
    if (value instanceof Promise) {
      throw new Error('check() 不支持异步，请用 checkAsync()');
    }
    console.log(`[PASS] ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`[FAIL] ${label}\n       ${error.message}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`[PASS] ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`[FAIL] ${label}\n       ${error.message}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ---------------------------------------------------------------- 1. 发布内容检查
check('包名与版本', () => {
  assert.equal(pkg.name, 'dsh-paper-agent');
  assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  assert.ok(pkg.dsh?.bundle?.patch);
  assert.ok(pkg.dsh?.client?.inject?.length > 0);
});
check('发布文件齐全', () => {
  for (const file of ['lib/index.js', 'lib/client.js', 'lib/bridge.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `缺少 ${file}`);
  }
});
check('不包含个人信息 / 密钥', () => {
  const files = ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml'];
  for (const file of ['lib', 'locale']) {
    for (const entry of fs.readdirSync(path.join(ROOT, file))) files.push(path.join(file, entry));
  }
  const forbidden = [
    ['D:', '\\', 'Paper', 'Suggest'],
    ['miaoke', 'song'],
    ['@nj', 'tech'],
    ['C:', '\\', 'Users', '\\'],
    ['paper', 'test'],
    ['mMx', 'YAh'],
  ].map((parts) => parts.join(''));
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const needle of forbidden) {
      assert.ok(!text.includes(needle), `${file} 含可疑个人信息：${needle.slice(0, 4)}…`);
    }
  }
  assert.ok(!fs.existsSync(path.join(ROOT, '.env')), '发布包不应包含 .env');
  assert.ok(!fs.existsSync(path.join(ROOT, '.paper-agent')), '发布包不应包含 .paper-agent');
});
check('cordis 配置默认值安全', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(yml, /name:\s*dsh-paper-agent/);
  assert.match(yml, /workspace:\s*''/);
  assert.match(yml, /openalexKey:\s*''/);
});

// ---------------------------------------------------------------- 2. 客户端渲染
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
};
const storage = new Map();
let clientModule = null;
globalThis.window = {
  localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  document: { createElement: () => ({ remove() {} }), head: { appendChild() {} }, addEventListener() {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  __ModuleLoader__: {
    load: ({ factory }) => {
      clientModule = factory((name) => {
        if (name === 'react') return react;
        throw new Error(`unknown require: ${name}`);
      });
    },
  },
};
await import(pathToFileURL(path.join(ROOT, 'lib/client.js')).href);
const registered = {};
const fakeClientCtx = {
  slots: {
    inject: (name, fn) => { fn(); },
    register: (def, component) => { registered[`${def.name}:${def.id ?? def.key}`] = component; return () => {}; },
  },
  get: () => null,
  effect: () => () => {},
};
clientModule.apply(fakeClientCtx);

check('客户端注册（一个页面入口）', () => {
  assert.ok(registered['main:paper-agent'], '缺少 main 面板');
  assert.ok(registered['sidebar.panellist:paper-agent'], '缺少侧栏入口');
  assert.equal(Object.keys(registered).filter((key) => key.startsWith('main:')).length, 1);
});

function render(node, depth = 0) {
  if (depth > 10 || node === null || typeof node !== 'object') return;
  if (typeof node.type === 'function') {
    render(node.type({ ...(node.props ?? {}), children: node.children }), depth + 1);
    return;
  }
  for (const child of node.children ?? []) render(child, depth + 1);
}
check('面板渲染不抛异常', () => {
  render(react.createElement(registered['main:paper-agent'], {}));
});

// 回归：状态未加载/加载失败时，设置面板仍必须能打开（draft 用默认值兜底）
const originalUseState = react.useState;
react.useState = (initial) => [typeof initial === 'boolean' ? true : (typeof initial === 'function' ? initial() : initial), () => {}];
check('设置面板在未加载状态下可渲染', () => {
  render(react.createElement(registered['main:paper-agent'], {}));
});
react.useState = originalUseState;

// ---------------------------------------------------------------- 3. 数据服务
const { createService } = await import(pathToFileURL(path.join(ROOT, 'lib/service.js')).href);
const { createDispatcher } = await import(pathToFileURL(path.join(ROOT, 'lib/dispatch.js')).href);

const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'paper-agent-test-'));
await fsp.mkdir(path.join(workspace, '.paper-agent'), { recursive: true });
const stateDir = path.join(workspace, '.paper-agent');
await fsp.writeFile(path.join(stateDir, 'library.jsonl'), [
  { openalexId: 'W1001', doi: '10.1000/a', title: 'Paper A', authors: ['A'], journal: 'J1', year: 2026, publicationDate: '2026-10-01', abstract: 'abstract a', directions: ['dir-1'], firstSeen: '2026-11-01T00:00:00.000Z' },
  { openalexId: 'W1002', doi: '10.1000/b', title: 'Paper B', authors: ['B'], journal: 'J2', year: 2026, publicationDate: '2026-10-02', abstract: 'abstract b', directions: ['dir-1'], firstSeen: '2026-11-01T00:00:00.000Z' },
  { openalexId: 'W1003', doi: '10.1000/c', title: 'Paper C', authors: ['C'], journal: 'J3', year: 2026, publicationDate: '2026-10-03', abstract: 'abstract c', directions: ['dir-1'], firstSeen: '2026-11-01T00:00:00.000Z' },
].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
await fsp.writeFile(path.join(stateDir, 'screenings.jsonl'), [
  { openalexId: 'W1001', doi: '10.1000/a', score: 5, zhTitle: '论文 A', summary: '梳理 A', comment: '点评 A', abstractZh: '', direction: 'dir-1', screenedAt: '2026-11-02T00:00:00.000Z' },
  { openalexId: 'W1002', doi: '10.1000/b', score: 2, zhTitle: '论文 B', summary: '梳理 B', comment: '点评 B', abstractZh: '', direction: 'dir-1', screenedAt: '2026-11-02T00:00:00.000Z' },
].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

const service = createService({ config: { stateDir: '.paper-agent' } });
const dispatcher = createDispatcher({ service });

await checkAsync('状态读取', async () => {
  const state = await dispatcher.dispatch('state', { workspace });
  assert.equal(state.ok, true);
  assert.equal(state.librarySize, 3);
  assert.equal(state.pendingScreening, 1);
  assert.equal(state.cardsReady, 1);
  assert.ok(state.settings, '应返回设置');
});
await checkAsync('方向保存/列表', async () => {
  await dispatcher.dispatch('directions', {
    workspace,
    op: 'save',
    direction: { name: '测试方向', mode: 'text', text: { query: '("additive manufacturing") AND ("IN718")' } },
  });
  const list = await dispatcher.dispatch('directions', { workspace, op: 'list' });
  assert.equal(list.directions.length, 1);
  assert.equal(list.directions[0].mode, 'text');
  assert.ok(list.directions[0].context.length > 0, '首次保存方向应生成（或兜底出）方向上下文');
});
await checkAsync('卡片队列默认只返回未读', async () => {
  const cards = await dispatcher.dispatch('cards', { workspace });
  assert.equal(cards.total, 1);
  assert.equal(cards.items[0].openalexId, 'W1001');
  assert.ok(Array.isArray(cards.items[0].directions) && cards.items[0].directions.includes('dir-1'), '卡片应带完整方向列表，供待读按方向筛选');
});
await checkAsync('评分保存 → 从未读移除 → 出现在回顾', async () => {
  await dispatcher.dispatch('rate', { workspace, openalexId: 'W1001', doi: '10.1000/a', direction: 'dir-1', rating: 5, note: '值得跟进' });
  const cards = await dispatcher.dispatch('cards', { workspace });
  assert.equal(cards.total, 0);
  const history = await dispatcher.dispatch('history', { workspace, kind: 'rated' });
  assert.equal(history.total, 1);
  assert.equal(history.items[0].rating, 5);
  assert.equal(history.items[0].note, '值得跟进');
});
await checkAsync('修改评分/评语（回顾里改正）', async () => {
  await dispatcher.dispatch('rate', { workspace, openalexId: 'W1001', doi: '10.1000/a', direction: 'dir-1', rating: 2, note: '', edit: true });
  let history = await dispatcher.dispatch('history', { workspace, kind: 'rated' });
  assert.equal(history.items[0].rating, 2);
  assert.equal(history.items[0].note, '', '清空评语应生效');
  const cards = await dispatcher.dispatch('cards', { workspace });
  assert.equal(cards.total, 0, '修改评分后仍算已读');
  await dispatcher.dispatch('rate', { workspace, openalexId: 'W1001', doi: '10.1000/a', direction: 'dir-1', rating: 5, note: '改回 5 分', edit: true });
  history = await dispatcher.dispatch('history', { workspace, kind: 'rated' });
  assert.equal(history.items[0].rating, 5);
  assert.equal(history.items[0].note, '改回 5 分');
});
await checkAsync('方向统计：总计 = 待读 + 回顾', async () => {
  const summary = await dispatcher.dispatch('deck-summary', { workspace });
  assert.equal(summary.overall.total, 2);
  assert.equal(summary.overall.unread, 0);
  assert.equal(summary.overall.history, 2);
});
await checkAsync('设置读写', async () => {
  const saved = await dispatcher.dispatch('settings', { workspace, settings: { monthsBack: 2, cardsMinScore: 4, useFeedback: false } });
  assert.equal(saved.settings.monthsBack, 2);
  const state = await dispatcher.dispatch('state', { workspace });
  assert.equal(state.settings.useFeedback, false);
});
check('测试隔离：最近工作区写入临时 DSH_HOME（不污染真实 ~/.dsh）', () => {
  assert.ok(fs.existsSync(path.join(TEST_DSH_HOME, 'dsh-paper-agent', 'state.json')), '测试应把 host 状态写进临时 DSH_HOME');
});

// ---------------------------------------------------------------- 4. 本地数据通道
const { startBridge } = await import(pathToFileURL(path.join(ROOT, 'lib/bridge.js')).href);
await checkAsync('本地数据通道可启动并响应', async () => {
  let disposer = null;
  const bridgeCtx = {
    logger: () => ({ info: () => {}, warn: () => {} }),
    effect: (fn) => { disposer = fn(); return disposer; },
  };
  const bridge = startBridge(bridgeCtx, { config: { stateDir: '.paper-agent' }, service });
  let port = null;
  for (let i = 0; i < 40 && port === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    port = bridge.getPort();
  }
  assert.ok(port !== null, '数据通道没有启动（端口可能全被占用）');
  const ping = await fetch(`http://127.0.0.1:${port}/ping`);
  assert.equal(ping.status, 200);
  const body = await ping.json();
  assert.equal(body.app, 'dsh-paper-agent');
  const jsonp = await fetch(`http://127.0.0.1:${port}/jsonp?action=ping&callback=cb&body=%7B%7D`);
  assert.match(await jsonp.text(), /dsh-paper-agent/);
  if (disposer !== null) disposer();
});

// ---------------------------------------------------------------- 5. AI 链路（假模型）
let lastScreenPrompt = '';
let lastRescreenPrompt = '';
const fakeCtx = {
  get(name) {
    if (name === 'llm') {
      return {
        listProviders: () => [{ id: 'fake-provider', name: 'Fake' }],
        listModels: async () => [{ id: 'fake-model', name: 'Fake Model' }],
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } }),
        stream: async function* (request) {
          const prompt = request.messages?.[0]?.content?.[0]?.text ?? '';
          if (prompt.includes('文献偏好画像')) {
            yield { type: 'text-delta', text: '偏好：偏应用型、重视工艺与性能的明确关联。' };
            return;
          }
          if (prompt.includes('写一段「方向上下文」')) {
            yield { type: 'text-delta', text: '初始上下文：关注锌沉积、界面调控与电解液；纯模拟与纯锂电不算。' };
            return;
          }
          if (prompt.includes('只重新评估这一篇论文')) {
            lastRescreenPrompt = prompt;
            const id = [...prompt.matchAll(/openalexId=(W\d+)/g)].map((match) => match[1])[0];
            yield {
              type: 'text-delta',
              text: JSON.stringify({ openalexId: id, score: 5, zhTitle: '重筛标题', summary: '重筛梳理', comment: '重筛点评', abstractZh: '' }),
            };
            return;
          }
          if (prompt.includes('用户的研究描述')) {            yield {
              type: 'text-delta',
              text: JSON.stringify({
                mode: 'text',
                name: '假模型方向',
                object: 'IN718',
                focus: 'LPBF',
                exclude: '纯铸造',
                query: '("laser powder bed fusion" OR LPBF) AND ("Inconel 718" OR IN718)',
                topicsSearch: [],
                keywordsSearch: [],
              }),
            };
            return;
          }
          lastScreenPrompt = prompt;
          const ids = [...prompt.matchAll(/openalexId=(W\d+)/g)].map((match) => match[1]);
          yield {
            type: 'text-delta',
            text: JSON.stringify(ids.map((id) => ({
              openalexId: id,
              score: 4,
              zhTitle: `标题 ${id}`,
              summary: `梳理 ${id}`,
              comment: `点评 ${id}`,
              abstractZh: '',
            }))),
          };
        },
      };
    }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) };
    return undefined;
  },
};
const aiWorkspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'paper-agent-ai-'));
await fsp.mkdir(path.join(aiWorkspace, '.paper-agent'), { recursive: true });
const aiDir = path.join(aiWorkspace, '.paper-agent');
await fsp.copyFile(path.join(stateDir, 'library.jsonl'), path.join(aiDir, 'library.jsonl'));
await fsp.copyFile(path.join(stateDir, 'screenings.jsonl'), path.join(aiDir, 'screenings.jsonl'));
// 补一条低分筛选记录，让三条反馈都能对应到已筛选文献
await fsp.appendFile(path.join(aiDir, 'screenings.jsonl'), JSON.stringify({ openalexId: 'W1003', doi: '10.1000/c', score: 1, zhTitle: '论文 C', summary: '梳理 C', comment: '点评 C', abstractZh: '', direction: 'dir-1', screenedAt: '2026-11-02T00:00:00.000Z' }) + '\n', 'utf8');
// 追加两篇未筛选论文，供「一键筛选」使用
await fsp.appendFile(path.join(aiDir, 'library.jsonl'), [
  { openalexId: 'W1004', doi: '10.1000/d', title: 'Paper D', authors: ['D'], journal: 'J4', year: 2026, publicationDate: '2026-10-04', abstract: 'abstract d', directions: ['dir-1'], firstSeen: '2026-11-01T00:00:00.000Z' },
  { openalexId: 'W1005', doi: '10.1000/e', title: 'Paper E', authors: ['E'], journal: 'J5', year: 2026, publicationDate: '2026-10-05', abstract: 'abstract e', directions: ['dir-1'], firstSeen: '2026-11-01T00:00:00.000Z' },
].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
await fsp.writeFile(path.join(aiDir, 'feedback.jsonl'), [
  { doi: '10.1000/a', openalexId: 'W1001', direction: 'dir-1', rating: 5, ts: '2026-11-03T00:00:00.000Z' },
  { doi: '10.1000/b', openalexId: 'W1002', direction: 'dir-1', rating: 1, ts: '2026-11-03T00:00:01.000Z' },
  { doi: '10.1000/c', openalexId: 'W1003', direction: 'dir-1', rating: 1, ts: '2026-11-03T00:00:02.000Z' },
].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
await fsp.writeFile(path.join(aiDir, 'feedback-notes.jsonl'), JSON.stringify({ doi: '10.1000/b', openalexId: 'W1002', direction: 'dir-1', note: '纯模拟的不要', ts: '2026-11-03T00:00:01.000Z' }) + '\n', 'utf8');
await fsp.writeFile(path.join(aiDir, 'directions.json'), JSON.stringify({
  directions: [{
    id: 'dir-1',
    name: '测试方向',
    enabled: true,
    description: { object: 'zinc anode / aqueous zinc battery', focus: '锌沉积、界面调控、电解液', exclude: '纯模拟' },
    mode: 'text',
    text: { query: '("zinc anode") AND (aqueous)' },
    context: '关注锌沉积与界面调控；纯模拟、纯锂电不算。',
    contextUpdatedAt: '2026-11-01T00:00:00.000Z',
    contextFeedbackCount: 3,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  }],
}, null, 2) + '\n', 'utf8');
const aiService = createService({ config: { stateDir: '.paper-agent' }, ctx: fakeCtx });

await checkAsync('偏好摘要可由反馈生成', async () => {
  const prefs = await aiService.getPreferences(aiWorkspace, { refresh: true });
  assert.ok(prefs.summary.includes('偏好'), '摘要为空');
  assert.ok(prefs.feedbackCount >= 3);
  assert.ok(fs.existsSync(path.join(aiDir, 'preferences.json')));
});
await checkAsync('一键筛选：注入历史反馈', async () => {
  const result = await aiService.autoScreen(aiWorkspace, { limit: 2 });
  assert.equal(result.screened, 2);
  assert.ok(lastScreenPrompt.includes('用户历史反馈'), '提示词没有历史反馈段落');
  assert.ok(lastScreenPrompt.includes('偏好'), '提示词没有偏好摘要');
  assert.ok(lastScreenPrompt.includes('纯模拟的不要'), '提示词没有评语');
  assert.ok(lastScreenPrompt.includes('方向：测试方向'), '提示词没有方向上下文');
  assert.ok(lastScreenPrompt.includes('方向上下文：关注锌沉积'), '提示词没有方向上下文正文');
  assert.ok(lastScreenPrompt.includes('评分规则（重要）'), '提示词没有方向匹配规则');
  assert.ok(lastScreenPrompt.includes('至少 4 分'), '提示词没有「命中方向至少 4 分」规则');
});
await checkAsync('单篇重新打分 → 进入可看卡片', async () => {
  const data = await aiService.rescreenPaper(aiWorkspace, { openalexId: 'W1004' });
  assert.equal(data.score, 5);
  const cards = await aiService.getCards(aiWorkspace, { minScore: 4, hideRead: true, limit: 100 });
  assert.ok(cards.items.some((item) => item.openalexId === 'W1004'));
});
await checkAsync('手动提升为可看卡片', async () => {
  await aiService.overrideScore(aiWorkspace, { openalexId: 'W1005', score: 4 });
  const cards = await aiService.getCards(aiWorkspace, { minScore: 4, hideRead: true, limit: 100 });
  assert.ok(cards.items.some((item) => item.openalexId === 'W1005'));
});
await checkAsync('一键配置：文字检索模式', async () => {
  const config = await aiService.autoConfigure(aiWorkspace, { description: '激光粉末床熔融 IN718 的组织与疲劳', mode: 'text' });
  assert.equal(config.mode, 'text');
  assert.ok(config.saved.condition.query.includes('LPBF'));
});
await checkAsync('新方向自动生成初始上下文', async () => {
  const saved = await aiService.saveDirection(aiWorkspace, {
    name: '上下文测试方向',
    mode: 'text',
    text: { query: '("zinc anode") AND (aqueous)' },
    description: { object: 'zinc anode', focus: '锌沉积' },
  });
  assert.ok(saved.saved.context.includes('初始上下文'), '没有生成初始上下文');
  const contexts = await aiService.getDirectionContexts(aiWorkspace);
  const target = contexts.directions.find((direction) => direction.name === '上下文测试方向');
  assert.ok(target && target.context.includes('初始上下文'), '设置里读不到方向上下文');
});
await checkAsync('方向上下文可随反馈重新生成', async () => {
  const data = await aiService.refreshDirectionContext(aiWorkspace, { id: 'dir-1' });
  assert.ok(data.direction.context.includes('初始上下文'), '重新生成后应使用模型输出');
  assert.ok(data.direction.contextFeedbackCount >= 3, '应记录参考的反馈条数');
});
await checkAsync('方向上下文可手动编辑', async () => {
  await aiService.saveDirectionContext(aiWorkspace, { id: 'dir-1', context: '手动编辑后的上下文：只看锌负极界面。' });
  const contexts = await aiService.getDirectionContexts(aiWorkspace);
  assert.equal(contexts.directions.find((direction) => direction.id === 'dir-1')?.context, '手动编辑后的上下文：只看锌负极界面。');
});
await checkAsync('点评人设进入筛选提示词', async () => {
  await aiService.updateSettings(aiWorkspace, { commentPersona: '测试人设：只用短句，最多一句。' });
  await aiService.rescreenPaper(aiWorkspace, { openalexId: 'W1004' });
  assert.ok(lastRescreenPrompt.includes('测试人设：只用短句，最多一句。'), '人设没有进入提示词');
});
await checkAsync('批量重新打分', async () => {
  const data = await aiService.rescreenMany(aiWorkspace, { openalexIds: ['W1001', 'W1002'] });
  assert.equal(data.rescreened, 2);
  assert.equal(data.failed, 0);
});

// 模型输出坏 JSON 时的容错：JSONL 重试 + 逐篇兜底
const { parseScreenOutput } = await import(pathToFileURL(path.join(ROOT, 'lib/llm.js')).href);
check('解析：代码块里的 JSONL', () => {
  const rows = parseScreenOutput('```json\n{"openalexId":"W1","score":4}\n{"openalexId":"W2","score":5}\n```');
  assert.equal(rows.length, 2);
});
check('解析：数组尾逗号可修复', () => {
  const rows = parseScreenOutput('[{"openalexId":"W1","score":4,},]');
  assert.equal(rows.length, 1);
});

const flakyWorkspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'paper-agent-flaky-'));
await fsp.mkdir(path.join(flakyWorkspace, '.paper-agent'), { recursive: true });
await fsp.writeFile(path.join(flakyWorkspace, '.paper-agent', 'library.jsonl'), [
  { openalexId: 'W2001', doi: '10.2000/a', title: 'Flaky A', directions: ['dir-1'], abstract: 'x' },
  { openalexId: 'W2002', doi: '10.2000/b', title: 'Flaky B', directions: ['dir-1'], abstract: 'x' },
].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
const flakyCtx = {
  get(name) {
    if (name === 'llm') {
      return {
        stream: async function* (request) {
          const prompt = request.messages?.[0]?.content?.[0]?.text ?? '';
          const ids = [...prompt.matchAll(/openalexId=(W\d+)/g)].map((match) => match[1]);
          if (prompt.includes('共 1 行')) {
            yield { type: 'text-delta', text: JSON.stringify({ openalexId: ids[0], score: 4, zhTitle: '标题', summary: '梳理', comment: '点评', abstractZh: '' }) };
            return;
          }
          yield { type: 'text-delta', text: '{"openalexId": "W2001", "score": 4, "comment": "他说"好"}]' };
        },
      };
    }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    return undefined;
  },
};
const flakyService = createService({ config: { stateDir: '.paper-agent' }, ctx: flakyCtx });
await checkAsync('坏 JSON：重试 + 逐篇兜底', async () => {
  const result = await flakyService.autoScreen(flakyWorkspace, { limit: 2 });
  assert.equal(result.screened, 2);
});

// 分类：不再按 directions[0] 取第一个，而是按方向语义匹配
const classifyWorkspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'paper-agent-classify-'));
await fsp.mkdir(path.join(classifyWorkspace, '.paper-agent'), { recursive: true });
const classifyDir = path.join(classifyWorkspace, '.paper-agent');
await fsp.writeFile(path.join(classifyDir, 'directions.json'), JSON.stringify({
  directions: [
    { id: 'am', name: '增材制造 IN718', enabled: true, mode: 'text', description: { object: 'Inconel 718 / IN718 / Ni-based superalloy', focus: 'LPBF / SLM / 增材制造的组织、缺陷与力学性能', exclude: '纯铸造' }, context: '关注增材制造工艺与组织。', text: { query: '("LPBF") AND ("IN718")' } },
    { id: 'syn', name: '同步辐射成像与衍射', enabled: true, mode: 'text', description: { object: 'synchrotron / X-ray imaging / diffraction', focus: '同步辐射光源上的成像、衍射、断层', exclude: '实验室 XRD' }, context: '关注同步辐射方法学。', text: { query: 'synchrotron AND diffraction' } },
  ],
}, null, 2) + '\n', 'utf8');
await fsp.writeFile(path.join(classifyDir, 'library.jsonl'), [
  { openalexId: 'W3001', title: 'Origins of heterogeneous microstructure in additively manufactured Ti-6Al-4V–SS316L alloy amalgamation', abstract: 'laser powder bed fusion multi-material microstructure', directions: ['syn', 'am'], keywords: [] },
  { openalexId: 'W3002', title: 'High-energy synchrotron X-ray diffraction study of residual stress', abstract: 'in situ synchrotron diffraction and tomography', directions: ['am', 'syn'], keywords: [] },
].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
await fsp.writeFile(path.join(classifyDir, 'screenings.jsonl'), [
  { openalexId: 'W3001', score: 5, zhTitle: '钛合金多材料', summary: '', comment: '', abstractZh: '', direction: 'syn' },
  { openalexId: 'W3002', score: 5, zhTitle: '同步辐射残余应力', summary: '', comment: '', abstractZh: '', direction: 'am' },
].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
const classifyService = createService({ config: { stateDir: '.paper-agent' } });
await checkAsync('分类：按语义匹配方向而非 directions[0]', async () => {
  const cards = await classifyService.getCards(classifyWorkspace, { minScore: 4, hideRead: true, limit: 100 });
  const amPaper = cards.items.find((item) => item.openalexId === 'W3001');
  const synPaper = cards.items.find((item) => item.openalexId === 'W3002');
  assert.equal(amPaper?.direction, 'am', '增材制造论文应归到增材制造方向');
  assert.equal(synPaper?.direction, 'syn', '同步辐射论文应归到同步辐射方向');
  const summary = await classifyService.getDeckSummary(classifyWorkspace);
  assert.equal(summary.byDirection.am?.total, 1);
  assert.equal(summary.byDirection.syn?.total, 1);
});

// ---------------------------------------------------------------- 清理
for (const dir of [workspace, aiWorkspace, flakyWorkspace, classifyWorkspace, TEST_DSH_HOME]) {
  await fsp.rm(dir, { recursive: true, force: true });
}
delete globalThis.window;

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exitCode = failures === 0 ? 0 : 1;
