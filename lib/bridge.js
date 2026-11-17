/**
 * lib/bridge.js — 面板的本地数据通道
 *
 * 这台 DSH 桌面壳的 Web 服务只接受 GET/HEAD（POST 一律 405），插件 HTTP 路由不可用。
 * 因此插件在 host 侧起一个只绑定 127.0.0.1 的小服务，面板通过它读写数据。
 *
 * 约定：
 *   · 端口从 43117 起顺延（最多 10 个），面板会依次探测 /ping 找到本插件。
 *   · 只允许 localhost 来源（CORS 反射 Origin），请求体只收 JSON。
 *   · 动作分发在 lib/dispatch.js，与传输方式解耦。
 */

import http from 'node:http';

import { createDispatcher } from './dispatch.js';

const PORTS = [43117, 43118, 43119, 43120, 43121, 43122, 43123, 43124, 43125, 43126];
/** DSH 桌面页面用 dsh-app:// 自定义来源；本地调试页面是 http://127.0.0.1 或 localhost。 */
const ALLOWED_ORIGIN = /^(dsh-app:|https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$)/i;
const MAX_BODY = 2 * 1024 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': res.__corsOrigin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function listenOn(port, handler) {
  return await new Promise((resolve) => {
    const server = http.createServer(handler);
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export function startBridge(ctx, { config = {}, service } = {}) {
  const dispatcher = createDispatcher({ config, service });
  let server = null;
  let port = null;
  let disposed = false;

  const handler = async (req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (origin !== '') {
      if (!ALLOWED_ORIGIN.test(origin)) {
        res.__corsOrigin = 'null';
        sendJson(res, 403, { ok: false, error: { kind: 'forbidden', message: `不允许的来源：${origin}`, hint: null } });
        return;
      }
      res.__corsOrigin = origin;
    } else {
      res.__corsOrigin = '*';
    }

    if (req.method === 'OPTIONS') {
      sendJson(res, 204, { ok: true });
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port ?? 0}`);
    if (req.method === 'GET' && url.pathname === '/ping') {
      sendJson(res, 200, { ok: true, app: 'dsh-paper-agent', port });
      return;
    }

    // JSONP 兜底：页面来源是 dsh-app:// 时可能无法直连本机端口，用 script 标签绕过 CORS。
    if (req.method === 'GET' && url.pathname === '/jsonp') {
      const callback = String(url.searchParams.get('callback') ?? '');
      const action = String(url.searchParams.get('action') ?? '');
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(callback)) {
        sendJson(res, 400, { ok: false, error: { kind: 'invalid', message: 'callback 不合法', hint: null } });
        return;
      }
      let body = {};
      try {
        body = JSON.parse(url.searchParams.get('body') ?? '{}');
      } catch {
        body = {};
      }
      let payload;
      try {
        payload = action === 'ping'
          ? { ok: true, app: 'dsh-paper-agent', port }
          : await dispatcher.dispatch(action, body);
      } catch (error) {
        payload = { ok: false, error: { kind: 'internal', message: error instanceof Error ? error.message : String(error), hint: null } };
      }
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`${callback}(${JSON.stringify(payload)});`);
      return;
    }

    if (req.method !== 'POST' || !url.pathname.startsWith('/paper-agent/')) {
      sendJson(res, 404, { ok: false, error: { kind: 'not_found', message: `未知路径：${req.method} ${url.pathname}`, hint: null } });
      return;
    }

    const action = url.pathname.slice('/paper-agent/'.length);
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 200, { ok: false, error: { kind: 'invalid', message: error.message, hint: null } });
      return;
    }
    try {
      const result = await dispatcher.dispatch(action, body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 200, { ok: false, error: { kind: 'internal', message: error instanceof Error ? error.message : String(error), hint: null } });
    }
  };

  const start = async () => {
    for (const candidate of PORTS) {
      if (disposed) return;
      const bound = await listenOn(candidate, handler);
      if (bound !== null) {
        server = bound;
        port = candidate;
        ctx.logger?.('dsh-paper-agent')?.info?.(`面板数据通道已启动：http://127.0.0.1:${candidate}`);
        return;
      }
    }
    ctx.logger?.('dsh-paper-agent')?.warn?.('面板数据通道启动失败：43117–43126 都被占用');
  };

  ctx.effect(() => {
    start();
    return () => {
      disposed = true;
      server?.close();
      server = null;
      port = null;
    };
  }, 'paper-agent: local bridge');

  return { getPort: () => port };
}
