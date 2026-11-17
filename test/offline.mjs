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
});
await checkAsync('卡片队列默认只返回未读', async () => {
  const cards = await dispatcher.dispatch('cards', { workspace });
  assert.equal(cards.total, 1);
  assert.equal(cards.items[0].openalexId, 'W1001');
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
          if (prompt.includes('用户的研究描述')) {
            yield {
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
});
await checkAsync('一键配置：文字检索模式', async () => {
  const config = await aiService.autoConfigure(aiWorkspace, { description: '激光粉末床熔融 IN718 的组织与疲劳', mode: 'text' });
  assert.equal(config.mode, 'text');
  assert.ok(config.saved.condition.query.includes('LPBF'));
});

// ---------------------------------------------------------------- 清理
for (const dir of [workspace, aiWorkspace]) {
  await fsp.rm(dir, { recursive: true, force: true });
}
delete globalThis.window;

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exitCode = failures === 0 ? 0 : 1;
