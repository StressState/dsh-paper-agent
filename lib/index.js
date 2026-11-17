/**
 * lib/index.js — dsh-paper-agent host 入口
 *
 * name / inject / Config / apply 四要素；工具在 lib/tools.js，面板数据通道在 lib/bridge.js。
 * 用户的文献库与方向配置全部落在调用者工作区的 <stateDir> 下。
 */

const toolsModule = await import('@deepseek-ai/dsh-tools').catch(() => ({ defineTool: (definition) => definition }));
const schemastery = await import('@deepseek-ai/schemastery').catch(() => ({ default: undefined }));
const z = schemastery.default;

import { startBridge } from './bridge.js';
import { createService } from './service.js';
import { registerPaperTools } from './tools.js';

export const name = 'dsh-paper-agent';

export const inject = ['tools'];

export const Config = z === undefined
  ? undefined
  : z.object({
      stateDir: z.string().default('.paper-agent'),
      workspace: z.string().default(''),
      openalexKey: z.string().default(''),
      contactEmail: z.string().default(''),
    });

export function apply(ctx, rawConfig) {
  const config = {
    stateDir: typeof rawConfig?.stateDir === 'string' && rawConfig.stateDir.trim() !== '' ? rawConfig.stateDir.trim() : '.paper-agent',
    workspace: typeof rawConfig?.workspace === 'string' ? rawConfig.workspace : '',
    openalexKey: typeof rawConfig?.openalexKey === 'string' ? rawConfig.openalexKey : '',
    contactEmail: typeof rawConfig?.contactEmail === 'string' ? rawConfig.contactEmail : '',
  };
  const service = createService({ config, ctx });
  registerPaperTools({ ctx, defineTool: toolsModule.defineTool, config, service });
  // 桌面壳的 Web 服务只允许 GET/HEAD，插件 HTTP 路由不可用；
  // 面板数据走插件自己起在 127.0.0.1 的小服务（lib/bridge.js）。
  startBridge(ctx, { config, service });
}
