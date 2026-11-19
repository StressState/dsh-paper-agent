window.__ModuleLoader__.load({
  id: 'dsh-paper-agent',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const PANEL_ID = 'paper-agent';
    const DECK_ID = 'paper-cards';
    const LS_WORKSPACE = 'paper-agent.workspace';
    const DEFAULT_COMMENT_PERSONA = '小师妹口吻：活泼、短句，可以带一点专业吐槽，但不失准确；不编造信息、不做人身攻击。';
    const SETTINGS_DEFAULTS = {
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
      commentPersona: DEFAULT_COMMENT_PERSONA,
    };
    const BRIDGE_PORTS = [43117, 43118, 43119, 43120, 43121, 43122, 43123, 43124, 43125, 43126];
    let bridgePort = null;
    let bridgeMode = 'fetch';

    /** JSONP 兜底（script 标签不受 CORS 限制）。 */
    function jsonpRequest(port, action, body, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        const callback = `__pa_cb_${Math.random().toString(36).slice(2)}`;
        const script = window.document.createElement('script');
        let done = false;
        const timer = window.setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          reject(new Error('JSONP 超时'));
        }, timeoutMs);
        function cleanup() {
          window.clearTimeout(timer);
          try { delete window[callback]; } catch { window[callback] = undefined; }
          script.remove();
        }
        window[callback] = (data) => {
          if (done) return;
          done = true;
          cleanup();
          resolve(data);
        };
        script.onerror = () => {
          if (done) return;
          done = true;
          cleanup();
          reject(new Error('JSONP 加载失败'));
        };
        const params = new URLSearchParams({
          action,
          body: JSON.stringify(body ?? {}),
          callback,
        });
        script.src = `http://127.0.0.1:${port}/jsonp?${params.toString()}`;
        window.document.head.appendChild(script);
      });
    }

    async function findBridge(force = false) {
      if (bridgePort !== null && !force) return bridgePort;
      const failures = [];
      for (const port of BRIDGE_PORTS) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/ping`, {
            mode: 'cors',
            cache: 'no-store',
            signal: AbortSignal.timeout(900),
          });
          if (response.ok) {
            const data = await response.json();
            if (data && data.app === 'dsh-paper-agent') {
              bridgePort = port;
              bridgeMode = 'fetch';
              return port;
            }
            failures.push(`${port}: 不是本插件`);
            continue;
          }
          failures.push(`${port}: HTTP ${response.status}`);
        } catch (error) {
          // fetch 被来源/跨域策略拦截时，试 JSONP 兜底
          try {
            const data = await jsonpRequest(port, 'ping', {}, 1200);
            if (data && data.app === 'dsh-paper-agent') {
              bridgePort = port;
              bridgeMode = 'jsonp';
              return port;
            }
            failures.push(`${port}: JSONP 不是本插件`);
          } catch (inner) {
            failures.push(`${port}: fetch 失败(${error.name === 'TimeoutError' ? '超时' : (error.message ?? '')}) / JSONP 失败`);
          }
        }
      }
      bridgePort = null;
      if (failures.length > 0) window.__paperAgentBridgeError = failures.join('；');
      return null;
    }

    async function api(path, body, timeoutMs) {
      const port = await findBridge();
      if (port === null) {
        const detail = window.__paperAgentBridgeError ? `（探测结果：${window.__paperAgentBridgeError}）` : '';
        throw new Error(`本地数据通道未启动${detail}。请重启 DSH；若重启后仍如此，说明页面无法直连本机端口。`);
      }
      if (bridgeMode === 'jsonp') {
        const data = await jsonpRequest(port, path.replace(/^\//, ''), body, timeoutMs ?? 20000);
        if (data && data.ok === false && data.error) {
          const hint = data.error.hint ? `（${data.error.hint}）` : '';
          throw new Error(`${data.error.message ?? '请求失败'}${hint}`);
        }
        return data;
      }
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${port}/paper-agent${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
      } catch (error) {
        bridgePort = null;
        throw new Error(`连接数据通道失败：${error.message}`);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}：${response.statusText}`);
      let data = null;
      try {
        data = await response.json();
      } catch {
        throw new Error('数据通道返回的不是 JSON');
      }
      if (data && data.ok === false && data.error) {
        const hint = data.error.hint ? `（${data.error.hint}）` : '';
        throw new Error(`${data.error.message ?? '请求失败'}${hint}`);
      }
      return data;
    }

    // ------------------------------------------------------------ styles
    const CSS = [
      '.pa-page{box-sizing:border-box;height:100%;overflow:auto;padding:18px clamp(16px,3vw,34px) 44px;color:var(--dsw-alias-label-primary);font:inherit}',
      '.pa-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}',
      '.pa-head h1{margin:0;font-size:18px;font-weight:600;flex:1}',
      '.pa-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:4px 0 0}',
      '.pa-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer}',
      '.pa-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.pa-btn.primary{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)));border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.pa-btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)))}',
      '.pa-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l2))}',
      '.pa-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.pa-card{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);padding:14px 16px;margin-bottom:14px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}',
      '.pa-card h2{margin:0 0 10px;font-size:14px;font-weight:600}',
      '.pa-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0}',
      '.pa-label{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:86px}',
      '.pa-input,.pa-select,.pa-textarea{box-sizing:border-box;padding:7px 10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.pa-input{flex:1;min-width:220px}',
      '.pa-textarea{width:100%;min-height:70px;resize:vertical;line-height:1.5}',
      '.pa-select{min-width:130px}',
      '.pa-dir{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:12px 14px;margin:10px 0}',
      '.pa-dir-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.pa-dir-name{font-size:13.5px;font-weight:600}',
      '.pa-chip{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.pa-chip.mode{color:var(--dsw-alias-label-primary)}',
      '.pa-cond{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:5px;word-break:break-all}',
      '.pa-actions{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}',
      '.pa-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.pa-err{padding:9px 12px;border-radius:var(--dsw-radius-md);margin:10px 0;font-size:12.5px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l2))}',
      '.pa-ok{padding:9px 12px;border-radius:var(--dsw-radius-md);margin:10px 0;font-size:12.5px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);border:1px solid var(--dsw-alias-border-l2)}',
      '.pa-progress{height:8px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden;margin:8px 0}',
      '.pa-progress > span{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s}',
      '.pa-sample{font-size:12.5px;line-height:1.55;padding:7px 0;border-top:1px dashed var(--dsw-alias-border-l1)}',
      '.pa-sample:first-child{border-top:0}',
      '.pa-keyline{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pa-setup{max-width:560px}',
      '.pa-scroll{max-height:260px;overflow:auto}',
      '.pa-deck-stage{position:relative;display:flex;justify-content:center;align-items:flex-start;padding-top:10px}',
      '.pa-deck-behind{position:absolute;top:18px;left:50%;transform:translateX(-50%) scale(.965);opacity:.45;pointer-events:none;width:min(700px,100%);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:20px 22px;overflow:hidden;max-height:120px}',
      '.pa-deck-card{position:relative;z-index:1;width:min(700px,100%);box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:20px 22px 16px;box-shadow:0 14px 40px rgba(0,0,0,.10);transition:transform .18s ease,opacity .18s ease}',
      '.pa-deck-card.burning{animation:pa-burn .62s cubic-bezier(.3,.1,.4,1) forwards}',
      '@keyframes pa-burn{0%{opacity:1;transform:translateY(0) scale(1);filter:none}28%{opacity:.97;transform:translateY(-5px) scale(1.006);filter:sepia(.25) saturate(1.2)}100%{opacity:0;transform:translateY(-52px) scale(.93) rotate(-1.4deg);filter:sepia(.7) blur(.4px)}}',
      '.pa-deck-title{margin:0;font-size:20px;line-height:1.4;font-weight:650}',
      '.pa-deck-en{margin:6px 0 0;font-size:13px;line-height:1.45;color:var(--dsw-alias-label-secondary)}',
      '.pa-deck-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.pa-deck-chip{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.pa-deck-chip.hot{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l2))}',
      '.pa-deck-block{margin-top:14px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l1)}',
      '.pa-deck-eyebrow{font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}',
      '.pa-deck-body{margin-top:5px;font-size:13.5px;line-height:1.7}',
      '.pa-deck-comment{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);border-left:2px solid var(--dsw-alias-brand-primary);padding:10px 12px;border-radius:0 8px 8px 0}',
      '.pa-deck-abstract-toggle{display:flex;justify-content:space-between;width:100%;background:transparent;border:0;padding:6px 0;color:inherit;font:inherit;font-size:12.5px;cursor:pointer}',
      '.pa-deck-abstract-toggle:hover{color:var(--dsw-alias-label-primary)}',
      '.pa-deck-abstract{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);margin-top:4px;max-height:220px;overflow:auto}',
      '.pa-deck-note{width:100%;box-sizing:border-box;margin-top:6px;min-height:56px;resize:vertical;padding:8px 10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}',
      '.pa-deck-controls{display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap}',
      '.pa-deck-slider{flex:1;min-width:160px;accent-color:var(--dsw-alias-brand-primary)}',
      '.pa-deck-score{font-size:13px;font-weight:600;min-width:34px;text-align:center}',
      '.pa-deck-actions{display:flex;gap:8px;margin-left:auto}',
      '.pa-deck-stats{width:min(700px,100%);margin:10px auto 0}',
      '.pa-deck-dist{display:flex;gap:10px;margin-top:8px}',
      '.pa-deck-dist > div{flex:1;text-align:center;padding:8px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font-size:12px}',
      '.pa-hub{display:flex;flex-direction:column;height:100%}',
      '.pa-hub-tabs{display:flex;gap:4px;padding:12px clamp(16px,3vw,34px) 0;flex:none}',
      '.pa-tab{padding:8px 18px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;transition:background .16s ease,color .16s ease}',
      '.pa-tab:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}',
      '.pa-tab.active{background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))),color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))));color:var(--dsw-alias-label-primary);font-weight:600;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1));box-shadow:0 2px 12px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}',
      '.pa-hub .pa-page{height:calc(100% - 47px);padding-top:10px}',
      '.pa-hub .pa-head h1,.pa-hub .pa-head .pa-sub{display:none}',
      '.pa-hub .pa-head{padding-top:4px}',

      // ---- 视觉升级（叠在上面规则之后，优先级更高）----
      '.pa-page{background:radial-gradient(880px 420px at 6% -10%,color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent),transparent 62%),radial-gradient(720px 380px at 100% 2%,color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,transparent),transparent 55%)}',
      '.pa-head h1{font-size:20px;font-weight:700;letter-spacing:.01em}',
      '.pa-card{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)) 97%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)) 90%,transparent));border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 82%,transparent);border-radius:16px;padding:16px 18px;box-shadow:0 10px 28px color-mix(in srgb,#000 9%,transparent)}',
      '.pa-card h2{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;letter-spacing:.02em;margin-bottom:8px}',
      '.pa-card h2::before{content:"";width:3px;height:14px;border-radius:2px;background:linear-gradient(180deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent))}',
      '.pa-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:12px 0 6px}',
      '.pa-metric{position:relative;overflow:hidden;border-radius:14px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--dsw-alias-border-l1));background:linear-gradient(155deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)) 72%,transparent))}',
      '.pa-metric::after{content:"";position:absolute;right:-34px;bottom:-44px;width:96px;height:96px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent),transparent 70%);pointer-events:none}',
      '.pa-metric-label{position:relative;z-index:1;font-size:11.5px;letter-spacing:.05em;color:var(--dsw-alias-label-secondary)}',
      '.pa-metric-value{position:relative;z-index:1;margin-top:4px;font-size:27px;line-height:1.08;font-weight:750;font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
      '.pa-metric-value small{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);margin-left:4px}',
      '.pa-metric-value.range{font-size:14px;font-weight:600;line-height:1.4;letter-spacing:0}',
      '.pa-metric-sub{position:relative;z-index:1;margin-top:3px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.pa-btn{border-radius:10px;transition:background .16s ease,border-color .16s ease,transform .12s ease}',
      '.pa-btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,var(--dsw-alias-border-l2))}',
      '.pa-btn:active:not(:disabled){transform:translateY(1px)}',
      '.pa-btn.primary{background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))),color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l2));box-shadow:0 2px 12px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}',
      '.pa-dir{border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)) 60%,transparent);transition:border-color .16s ease,box-shadow .16s ease}',
      '.pa-dir:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,var(--dsw-alias-border-l1));box-shadow:0 6px 18px color-mix(in srgb,#000 7%,transparent)}',
      '.pa-deck-card{box-shadow:0 24px 60px color-mix(in srgb,#000 16%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,var(--dsw-alias-border-l1));border-radius:18px}',
      '.pa-deck-title{font-size:21px;letter-spacing:.01em}',
      '.pa-deck-chip.hot{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.pa-deck-dist > div{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)) 70%,transparent)}',
      '.pa-deck-layout{display:flex;gap:16px;align-items:flex-start;margin-top:8px}',
      '.pa-deck-main{flex:1;min-width:0}',
      '.pa-deck-side{width:220px;flex:none;position:sticky;top:8px;border-radius:16px;padding:12px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 80%,transparent);background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)) 95%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)) 86%,transparent));box-shadow:0 10px 26px color-mix(in srgb,#000 8%,transparent)}',
      '.pa-deck-side-title{font-size:11px;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary);margin:2px 4px 8px}',
      '.pa-deck-side-item{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:8px 10px;border-radius:10px;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);border:1px solid transparent;transition:background .14s ease}',
      '.pa-deck-side-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}',
      '.pa-deck-side-item.active{background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))),color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1));color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 4px 14px color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}',
      '.pa-deck-side-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pa-deck-side-count{font-size:10.5px;color:var(--dsw-alias-label-tertiary);flex:none}',
      '.pa-deck-side-sep{height:1px;margin:10px 4px;background:var(--dsw-alias-border-l1)}',
      '.pa-history-list{display:flex;flex-direction:column;gap:6px;margin-top:8px}',
      '.pa-history-item{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden}',
      '.pa-history-line{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer}',
      '.pa-history-item.open .pa-history-line{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}',
      '.pa-history-score{width:26px;height:26px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:12.5px;flex:none;border:1px solid var(--dsw-alias-border-l2)}',
      '.pa-history-score.pass{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l2))}',
      '.pa-history-score.fail{opacity:.65}',
      '.pa-history-title{flex:1;font-size:13px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pa-history-tags{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.pa-history-detail{padding:4px 12px 12px 48px;font-size:12.5px;line-height:1.6}',
      '.pa-history-edit{margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1)}',
      '.pa-deck-side-item{flex-direction:column;align-items:stretch;gap:3px;padding:10px 12px}',
      '.pa-deck-side-name{font-weight:600}',
      '.pa-deck-side-stats{display:flex;gap:10px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.pa-deck-side-unread{color:color-mix(in srgb,var(--dsw-alias-brand-primary) 80%,var(--dsw-alias-label-secondary))}',
      '.pa-metric.clickable{cursor:pointer;transition:transform .14s ease,border-color .14s ease}',
      '.pa-metric.clickable:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1))}',
      '.pa-auto-status{margin:6px 0 2px}',
      '.pa-auto-status .pa-progress{height:6px}',
      '.pa-deck-rec{display:flex;gap:8px;align-items:center;margin-left:auto}',
      '.pa-pref{margin:6px 0;padding:10px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent);font-size:12.5px;line-height:1.65;white-space:pre-wrap}',
      '.pa-dir-context{margin:8px 0;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)) 55%,transparent)}',
      '.pa-context-text{margin-top:6px;font-size:12.5px;line-height:1.65;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}',
    ].join('\n');

    // ------------------------------------------------------------ bits
    function Glyph(props) {
      const size = props?.size ?? 16;
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 2.5h6l3 3v8H3z', stroke: 'currentColor', strokeWidth: '1.3', strokeLinejoin: 'round' }),
        h('path', { d: 'M9 2.5v3h3', stroke: 'currentColor', strokeWidth: '1.3', strokeLinejoin: 'round' }),
        h('path', { d: 'M5.2 8.6h5.6M5.2 11h3.6', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round' }));
    }

    function modeLabel(mode) {
      return mode === 'text' ? '文字检索' : mode === 'topics' ? 'Topics' : 'Keywords';
    }

    function conditionText(direction) {
      const c = direction.condition || {};
      if (direction.mode === 'text') return c.query || '（未填检索式）';
      const ids = Array.isArray(c.ids) ? c.ids.join(' | ') : '';
      return `${c.match === 'all' ? '全部满足' : '任一满足'}：${ids}`;
    }

    function emptyForm() {
      return { id: '', name: '', object: '', focus: '', exclude: '', mode: 'text', query: '', idsText: '', match: 'any', types: '', language: '', extraFilter: '' };
    }

    function formFrom(direction) {
      const form = emptyForm();
      form.id = direction.id;
      form.name = direction.name;
      form.object = direction.description?.object ?? '';
      form.focus = direction.description?.focus ?? '';
      form.exclude = direction.description?.exclude ?? '';
      form.mode = direction.mode;
      form.types = direction.types ?? '';
      form.language = direction.language ?? '';
      form.extraFilter = direction.extraFilter ?? '';
      if (direction.mode === 'text') form.query = direction.condition?.query ?? '';
      if (direction.mode === 'topics') {
        form.idsText = (direction.condition?.ids ?? []).join('\n');
        form.match = direction.condition?.match ?? 'any';
      }
      if (direction.mode === 'keywords') {
        form.idsText = (direction.condition?.ids ?? []).join('\n');
        form.match = direction.condition?.match ?? 'any';
      }
      return form;
    }

    function splitIds(text) {
      return String(text ?? '')
        .split(/[\n,;]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    // ------------------------------------------------------------ panel
    function PaperAgentPanel(props) {
      const onLeave = typeof props?.onLeave === 'function' ? props.onLeave : null;
      const [workspace, setWorkspace] = useState(() => {
        try {
          return window.localStorage.getItem(LS_WORKSPACE) ?? '';
        } catch {
          return '';
        }
      });
      const [workspaceDraft, setWorkspaceDraft] = useState(workspace);
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [keyDraft, setKeyDraft] = useState('');
      const [keyEmail, setKeyEmail] = useState('');
      const [keyRequestNote, setKeyRequestNote] = useState('');
      const [autoLimit, setAutoLimit] = useState(10);
      const [autoLimitCustom, setAutoLimitCustom] = useState('');
      const [models, setModels] = useState(null);
      const [preferences, setPreferences] = useState(null);
      const [prefBusy, setPrefBusy] = useState(false);
      const [directionContexts, setDirectionContexts] = useState(null);
      const [contextDrafts, setContextDrafts] = useState({});
      const [ctxBusy, setCtxBusy] = useState(false);
      const [settingsDraft, setSettingsDraft] = useState(null);
      // 即使状态还没加载/加载失败，设置面板也必须能打开：用默认值兜底。
      const draft = settingsDraft ?? { ...SETTINGS_DEFAULTS, ...(state?.settings ?? {}) };
      const patchDraft = (patch) => setSettingsDraft({ ...(settingsDraft ?? { ...SETTINGS_DEFAULTS, ...(state?.settings ?? {}) }), ...patch });
      const [form, setForm] = useState(null);
      const [resolveSearch, setResolveSearch] = useState('');
      const [resolveItems, setResolveItems] = useState([]);
      const [previewFor, setPreviewFor] = useState('');
      const [preview, setPreview] = useState(null);
      const [job, setJob] = useState(null);
      const [autoDesc, setAutoDesc] = useState('');
      const [autoMode, setAutoMode] = useState('auto');
      const [autoConfigResult, setAutoConfigResult] = useState('');
      const [autoJob, setAutoJob] = useState(null);
      const [autoElapsed, setAutoElapsed] = useState(0);
      const pollRef = useRef(null);
      const autoPollRef = useRef(null);

      const saveWorkspace = useCallback((value) => {
        const next = String(value ?? '').trim();
        try {
          window.localStorage.setItem(LS_WORKSPACE, next);
        } catch {
          /* ignore */
        }
        if (next !== '') api('/default-workspace', { workspace: next }).catch(() => {});
        setWorkspace(next);
        setState(null);
        setPreview(null);
        setJob(null);
        setNotice('');
        setError('');
      }, []);

      // DSH 端口变化会让 localStorage 丢失/过期：以 host 记住的工作区为准（只初始化一次）。
      const bootedRef = useRef(false);
      useEffect(() => {
        if (bootedRef.current) return;
        bootedRef.current = true;
        api('/default-workspace', {}).then((data) => {
          if (data && typeof data.workspace === 'string' && data.workspace !== '' && data.workspace !== workspace) {
            try { window.localStorage.setItem(LS_WORKSPACE, data.workspace); } catch { /* ignore */ }
            setWorkspace(data.workspace);
            return;
          }
          if (data?.stale) {
            try {
              if (window.localStorage.getItem(LS_WORKSPACE) === data.stale) window.localStorage.removeItem(LS_WORKSPACE);
            } catch { /* ignore */ }
            if (workspace === data.stale) {
              setWorkspace('');
              setNotice('原来记住的工作区已不存在，请重新填写工作区路径');
            }
          }
        }).catch(() => {});
      }, [workspace]);

      const loadState = useCallback(async (target = workspace) => {
        if (target === '') return;
        setBusy(true);
        setError('');
        try {
          const data = await api('/state', { workspace: target });
          setState(data);
          // 工作区是空的（没方向也没文献）时，自动切到最近使用的工作区，避免「看着一片空」。
          if (data && (data.directions?.length ?? 0) === 0 && (data.librarySize ?? 0) === 0) {
            const fallback = await api('/default-workspace', {}).catch(() => null);
            if (fallback && typeof fallback.workspace === 'string' && fallback.workspace !== '' && fallback.workspace !== target) {
              try { window.localStorage.setItem(LS_WORKSPACE, fallback.workspace); } catch { /* ignore */ }
              setWorkspace(fallback.workspace);
              setNotice(`当前工作区是空的，已自动切换到最近使用的工作区：${fallback.workspace}（可在设置里更换）`);
              return;
            }
          }
        } catch (err) {
          const message = err?.message ?? '';
          if (/工作区不存在|不是目录/.test(message)) {
            try { window.localStorage.removeItem(LS_WORKSPACE); } catch { /* ignore */ }
            setWorkspace('');
            setNotice('原工作区不可用（可能已被删除），请重新填写工作区路径');
            setState(null);
          } else {
            setError(message);
            setState(null);
          }
        } finally {
          setBusy(false);
        }
      }, [workspace]);

      useEffect(() => {
        if (workspace !== '') loadState(workspace);
      }, [workspace, loadState]);

      useEffect(() => {
        if (state?.settings) setSettingsDraft({ ...state.settings });
      }, [state]);

      useEffect(() => {
        if (workspace === '') return;
        api('/models', { workspace }).then(setModels).catch(() => setModels({ groups: [] }));
        loadPreferences();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- loadPreferences 在下方声明，effect 回调执行时已初始化
      }, [workspace]);

      useEffect(() => {
        return () => {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          if (autoPollRef.current !== null) window.clearInterval(autoPollRef.current);
        };
      }, []);

      const flash = (message, isError) => {
        if (isError) {
          setError(message);
          setNotice('');
        } else {
          setNotice(message);
          setError('');
        }
      };

      const saveDirection = useCallback(async () => {
        if (form === null) return;
        if (form.name.trim() === '') {
          flash('方向名称不能为空', true);
          return;
        }
        const direction = {
          id: form.id || undefined,
          name: form.name.trim(),
          enabled: true,
          description: { object: form.object.trim(), focus: form.focus.trim(), exclude: form.exclude.trim() },
          mode: form.mode,
          types: form.types ?? '',
          language: form.language ?? '',
          extraFilter: form.extraFilter ?? '',
        };
        if (form.mode === 'text') {
          if (form.query.trim() === '') {
            flash('文字检索模式要填检索式', true);
            return;
          }
          direction.text = { query: form.query.trim() };
        } else {
          const ids = splitIds(form.idsText);
          if (ids.length === 0) {
            flash(`${form.mode === 'topics' ? 'Topics' : 'Keywords'} 至少填一个 ID`, true);
            return;
          }
          direction[form.mode] = { ids, match: form.match === 'all' ? 'all' : 'any' };
        }
        setBusy(true);
        try {
          await api('/directions', { workspace, op: 'save', direction });
          flash('已保存方向');
          setForm(null);
          await loadState();
        } catch (err) {
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [form, loadState, workspace]);

      const deleteDirection = useCallback(async (id) => {
        if (!window.confirm('删除这个方向？已拉取的文献不会删除。')) return;
        setBusy(true);
        try {
          await api('/directions', { workspace, op: 'delete', id });
          flash('已删除方向');
          if (previewFor === id) setPreview(null);
          await loadState();
        } catch (err) {
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [loadState, previewFor, workspace]);

      const runPreview = useCallback(async (directionId) => {
        setBusy(true);
        setPreview(null);
        setPreviewFor(directionId);
        try {
          const data = await api('/preview', { workspace, directionId, ...(state?.defaultWindow ?? {}) });
          setPreview(data);
          flash(`命中 ${data.count} 篇`);
        } catch (err) {
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [state, workspace]);

      const startPull = useCallback(async (directionIds) => {
        setBusy(true);
        setJob({ status: 'running', progress: { fetched: 0, count: null, added: 0 } });
        try {
          const data = await api('/pull', { workspace, directionIds, ...(state?.defaultWindow ?? {}) });
          const jobId = data.jobId;
          setJob({ id: jobId, status: 'running', progress: { fetched: 0, count: null, added: 0 } });
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          pollRef.current = window.setInterval(async () => {
            try {
              const status = await api('/pull-status', { jobId });
              const current = status.job;
              setJob({ id: jobId, ...current });
              if (current.status !== 'running') {
                window.clearInterval(pollRef.current);
                pollRef.current = null;
                await loadState();
                flash(current.status === 'done' ? '拉取完成' : `拉取失败：${current.error?.message ?? ''}`, current.status !== 'done');
              }
            } catch (err) {
              window.clearInterval(pollRef.current);
              pollRef.current = null;
              flash(err.message, true);
            }
          }, 1200);
        } catch (err) {
          setJob(null);
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [loadState, state, workspace]);

      const saveKey = useCallback(async (value) => {
        setBusy(true);
        try {
          await api('/settings', { workspace, openalexKey: value });
          setKeyDraft('');
          flash(value === '' ? '已清除 OpenAlex key（回到匿名模式）' : '已保存 OpenAlex key');
          await loadState();
        } catch (err) {
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [loadState, workspace]);

      const requestKeyByEmail = useCallback(async () => {
        if (keyEmail.trim() === '') {
          flash('先填一个邮箱', true);
          return;
        }
        setBusy(true);
        setKeyRequestNote('正在向 OpenAlex 申请…');
        try {
          const data = await api('/request-key', { workspace, email: keyEmail.trim() });
          setKeyRequestNote(`已申请并保存（状态：${data.status}）。去邮箱点「Activate your OpenAlex API key」，激活后点「刷新」。`);
          flash('已向 OpenAlex 申请 key，注意查收激活邮件');
          await loadState();
        } catch (err) {
          setKeyRequestNote('');
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [keyEmail, loadState, workspace]);

      const saveSettings = useCallback(async () => {
        if (workspace === '') {
          flash('先设置工作区，再保存参数', true);
          return;
        }
        setBusy(true);
        try {
          const data = await api('/settings', { workspace, settings: draft });
          setSettingsDraft({ ...data.settings });
          flash('设置已保存');
          await loadState();
        } catch (err) {
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [draft, loadState, workspace]);

      const changeModel = useCallback(async (value) => {
        const idx = String(value).indexOf('::');
        const provider = idx >= 0 ? value.slice(0, idx) : '';
        const model = idx >= 0 ? value.slice(idx + 2) : '';
        setBusy(true);
        try {
          await api('/settings', { workspace, settings: { llmProvider: provider, llmModel: model, llmReasoningEffort: '' } });
          await loadState();
          flash(provider === '' ? '已改为跟随 DSH 默认模型' : `已选择模型：${model}`);
        } catch (err) {
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [loadState, workspace]);

      const changeEffort = useCallback(async (value) => {
        setBusy(true);
        try {
          await api('/settings', { workspace, settings: { llmReasoningEffort: value } });
          await loadState();
          flash(value === '' ? '推理强度：跟随模型默认' : `推理强度：${value}`);
        } catch (err) {
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [loadState, workspace]);

      const runAutoConfig = useCallback(async () => {
        if (autoDesc.trim() === '') return;
        setBusy(true);
        setAutoConfigResult('');
        try {
          const data = await api('/auto-config', { workspace, description: autoDesc.trim(), mode: autoMode });
          const query = data.saved?.condition?.query ?? '';
          const modeLabel = { text: '文字检索', topics: 'Topics', keywords: 'Keywords' }[data.mode] ?? data.mode;
          setAutoConfigResult(`已生成「${data.saved?.name ?? ''}」（${modeLabel}）${query === '' ? '' : `：${query}`}`);
          setAutoDesc('');
          await loadState();
        } catch (err) {
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [autoDesc, autoMode, loadState, workspace]);

      const loadPreferences = useCallback(async () => {
        if (workspace === '') return;
        try {
          const data = await api('/preferences', { workspace });          setPreferences(data);
        } catch {
          setPreferences(null);
        }
      }, [workspace]);

      const refreshPreferences = useCallback(async () => {
        setPrefBusy(true);
        try {
          const data = await api('/preferences', { workspace, refresh: true });
          setPreferences(data);
          flash(data.error ? `偏好摘要生成失败：${data.error}` : '偏好摘要已更新，下次筛选会参考');
          await loadState();
        } catch (err) {
          flash(err.message, true);
        } finally {
          setPrefBusy(false);
        }
      }, [loadState, workspace]);

      const loadContexts = useCallback(async () => {
        if (workspace === '') return;
        try {
          const data = await api('/direction-contexts', { workspace });
          setDirectionContexts(data);
          setContextDrafts(Object.fromEntries((data.directions ?? []).map((direction) => [direction.id, direction.context ?? ''])));
        } catch {
          setDirectionContexts(null);
        }
      }, [workspace]);

      const saveContext = useCallback(async (id, text) => {
        setCtxBusy(true);
        try {
          await api('/direction-contexts', { workspace, op: 'save', id, context: text });
          await loadContexts();
          flash('方向上下文已保存，下次筛选会使用');
        } catch (err) {
          flash(err.message, true);
        } finally {
          setCtxBusy(false);
        }
      }, [loadContexts, workspace]);

      const refreshContext = useCallback(async (id) => {
        setCtxBusy(true);
        try {
          await api('/direction-contexts', { workspace, op: 'refresh', id });
          await loadContexts();
          await loadState();
          flash('方向上下文已更新，下次筛选会使用新上下文');
        } catch (err) {
          flash(err.message, true);
        } finally {
          setCtxBusy(false);
        }
      }, [loadContexts, loadState, workspace]);

      useEffect(() => {
        loadContexts();
      }, [loadContexts, state?.directions]);

      const startAutoScreen = useCallback(async (limit = autoLimit) => {
        setBusy(true);
        setError('');
        setAutoJob({ status: 'running', progress: { screened: 0, batch: 0, batches: 0, total: 0 } });
        try {
          const data = await api('/auto-screen', { workspace, limit });
          const jobId = data.jobId;
          if (autoPollRef.current !== null) window.clearInterval(autoPollRef.current);
          autoPollRef.current = window.setInterval(async () => {
            try {
              const status = await api('/auto-screen-status', { jobId });
              const current = status.job;
              setAutoJob({ id: jobId, ...current });
              if (current.status !== 'running') {
                window.clearInterval(autoPollRef.current);
                autoPollRef.current = null;
                await loadState();
                if (current.status === 'done') {
                  flash(`自动筛选完成：筛了 ${current.result?.screened ?? 0} 篇，可推送 ${current.result?.cardsReady ?? 0} 张`);
                } else {
                  flash(`自动筛选失败：${current.error?.message ?? '未知错误'}`, true);
                }
              }
            } catch (err) {
              window.clearInterval(autoPollRef.current);
              autoPollRef.current = null;
              flash(err.message, true);
            }
          }, 1500);
        } catch (err) {
          setAutoJob(null);
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [autoLimit, loadState, workspace]);

      useEffect(() => {
        if (autoJob?.status !== 'running') {
          setAutoElapsed(0);
          return undefined;
        }
        const started = Date.now();
        const timer = window.setInterval(() => setAutoElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => window.clearInterval(timer);
      }, [autoJob?.status]);

      const doResolve = useCallback(async () => {
        if (resolveSearch.trim() === '' || form === null || form.mode === 'text') return;
        setBusy(true);
        try {
          const data = await api('/resolve', { workspace, kind: form.mode, search: resolveSearch.trim() });
          setResolveItems(data.items ?? []);
          if ((data.items ?? []).length === 0) flash('没找到匹配的标签，换个英文关键词试试');
        } catch (err) {
          flash(err.message, true);
        } finally {
          setBusy(false);
        }
      }, [form, resolveSearch, workspace]);

      // ---------------------------------------------------------- render
      const header = h('div', { className: 'pa-head' },
        h('div', { style: { flex: 1 } },
          h('h1', null, '文献拉取（OpenAlex）'),
          h('p', { className: 'pa-sub' }, state?.stateDir ? `状态目录：${state.stateDir}` : '按研究方向从 OpenAlex 拉取论文，助手筛选后推送到「文献卡片台」')),
        h('button', { type: 'button', className: 'pa-btn', onClick: () => loadState(), disabled: busy || workspace === '' }, '刷新'),
        h('button', {
          type: 'button',
          className: `pa-btn${settingsOpen ? ' primary' : ''}`,
          onClick: () => {
            const next = !settingsOpen;
            setSettingsOpen(next);
            if (next && state === null && workspace !== '') loadState();
            if (next && state === null && workspace === '') flash('先设置工作区路径', true);
          },
        }, settingsOpen ? '收起设置' : '设置'));

      const banners = [
        error === '' ? null : h('div', { className: 'pa-err', key: 'err' }, error),
        notice === '' ? null : h('div', { className: 'pa-ok', key: 'ok' }, notice),
      ];

      if (workspace === '') {
        return h('div', { className: 'pa-page' },
          h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
          header,
          banners,
          h('div', { className: 'pa-card pa-setup' },
            h('h2', null, '先设置工作区'),
            h('p', { className: 'pa-muted' }, '插件会把方向配置和文献库写到你填的工作区目录下的 .paper-agent 文件夹。'),
            h('div', { className: 'pa-row' },
              h('span', { className: 'pa-label' }, '工作区'),
              h('input', {
                className: 'pa-input',
                value: workspaceDraft,
                placeholder: '工作区绝对路径，例如 D:\\Papers',
                onChange: (event) => setWorkspaceDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && workspaceDraft.trim() !== '') saveWorkspace(workspaceDraft.trim());
                },
              }),
              h('button', { type: 'button', className: 'pa-btn primary', onClick: () => saveWorkspace(workspaceDraft), disabled: workspaceDraft.trim() === '' }, '保存工作区'))));
      }

      const key = state?.key;
      const budget = state?.usage?.budget;
      const selProvider = state?.settings?.llmProvider ?? '';
      const selModel = state?.settings?.llmModel ?? '';
      const selGroup = (models?.groups ?? []).find((group) => group.provider === selProvider);
      const selEntry = selGroup?.models?.find((model) => model.id === selModel) ?? null;
      const selEfforts = selEntry?.reasoning?.efforts ?? [];
      const metric = (label, value, unit, sub, range, onClick) => h('div', {
        className: `pa-metric${onClick ? ' clickable' : ''}`,
        onClick,
        title: onClick ? '点击跳转到文献卡片台' : undefined,
      },
        h('div', { className: 'pa-metric-label' }, label),
        h('div', { className: `pa-metric-value${range ? ' range' : ''}` }, value, unit ? h('small', null, unit) : null),
        h('div', { className: 'pa-metric-sub' }, sub));
      const info = state === null ? null : h('div', { className: 'pa-card' },
        h('div', { className: 'pa-row', style: { marginTop: 0 } },
          h('span', { className: 'pa-label', style: { minWidth: 'auto' } }, '工作区'),
          h('span', { className: 'pa-muted', style: { wordBreak: 'break-all', flex: 1 } }, state.workspace),
          h('button', { type: 'button', className: 'pa-btn', onClick: () => { setWorkspaceDraft(''); saveWorkspace(''); } }, '更换')),
        h('div', { className: 'pa-metrics' },
          metric('已收录论文', String(state.librarySize), '篇', '本地库累计，跨次去重'),
          metric('等 AI 打分', String(state.pendingScreening ?? 0), '篇', '拉回来还没筛选'),
          metric('可看卡片', String(state.cardsReady ?? 0), '张', '已达标、还没看 · 点击去卡片台', false, props?.onOpenDeck),
          metric('下次拉取范围', `${state.defaultWindow.from} — ${state.defaultWindow.to}`, '', '设置里可调月数', true)),
        h('div', { className: 'pa-row', style: { marginBottom: 0 } },
          h('span', { className: 'pa-label', style: { minWidth: 'auto' } }, 'OpenAlex 密钥'),
          h('span', { className: 'pa-keyline' }, key?.configured ? `已配置（来源 ${key.source}${key.masked ? `，${key.masked}` : ''}）` : '未配置（匿名模式，额度很低）'),
          budget?.remaining !== undefined && budget?.remaining !== null ? h('span', { className: 'pa-muted' }, `剩余 ${budget.remaining} / ${budget.limit ?? '?'}`) : null));

      const settingsPanel = settingsOpen ? h('div', { className: 'pa-card' },
        h('h2', null, '设置'),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '工作区'),
          h('input', {
            className: 'pa-input',
            value: workspaceDraft,
            placeholder: '工作区绝对路径，例如 D:\\Papers',
            onChange: (event) => setWorkspaceDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && workspaceDraft.trim() !== '') saveWorkspace(workspaceDraft.trim());
            },
          }),
          h('button', {
            type: 'button',
            className: 'pa-btn primary',
            disabled: busy,
            onClick: () => {
              if (workspaceDraft.trim() === '') {
                flash('先填工作区路径', true);
                return;
              }
              saveWorkspace(workspaceDraft.trim());
            },
          }, '保存工作区')),
        h('p', { className: 'pa-muted' }, '方向、文献库、评分都会写进该工作区的 .paper-agent/ 下；换工作区不会删除旧数据。'),
        workspace === ''
          ? h('p', { className: 'pa-muted' }, '还没有设置工作区：先在上面填工作区路径并保存，参数会写进该工作区的 .paper-agent/settings.json。')
          : state === null
            ? h('p', { className: 'pa-muted' }, '工作区数据还没加载成功：点上方「刷新」重试；下面的参数仍可先调整。')
            : null,
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, 'OpenAlex key'),
          h('input', {
            className: 'pa-input',
            type: 'password',
            value: keyDraft,
            placeholder: state?.key?.configured ? '已配置；留空不变，填新 key 会覆盖' : '粘贴免费 key；留空保存＝回到匿名模式',
            onChange: (event) => setKeyDraft(event.target.value),
          }),
          h('button', { type: 'button', className: 'pa-btn primary', onClick: () => saveKey(keyDraft.trim()) }, '保存'),
          h('button', { type: 'button', className: 'pa-btn', onClick: () => saveKey('') }, '清除')),
        h('p', { className: 'pa-keyline', style: { marginTop: 2 } },
          h('span', { style: { color: state?.key?.configured ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-tertiary)' } },
            state?.key?.configured ? '● ' : '○ '),
          state?.key?.configured
            ? `当前已配置（来源 ${state.key.source}${state.key.masked ? `，${state.key.masked}` : ''}）`
            : '当前未配置：匿名模式额度很低，建议申请或粘贴 key'),
        h('p', { className: 'pa-muted' }, 'key 只保存在本机工作区的 .paper-agent/settings.json，不会上传。免费 key 每日 10,000 请求，匿名模式额度很低。'),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '邮箱一键申请'),
          h('input', {
            className: 'pa-input',
            value: keyEmail,
            placeholder: 'your@email.com（用你自己的邮箱）',
            onChange: (event) => setKeyEmail(event.target.value),
          }),
          h('button', { type: 'button', className: 'pa-btn primary', onClick: requestKeyByEmail, disabled: busy }, '申请并保存')),
        keyRequestNote === '' ? null : h('p', { className: 'pa-muted' }, keyRequestNote),
        h('h2', { style: { marginTop: 16 } }, '可调参数'),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '时间窗月数'),
          h('input', { className: 'pa-input', type: 'number', min: 1, max: 12, value: draft.monthsBack, onChange: (e) => patchDraft({ monthsBack: Number(e.target.value) }) }),
          h('span', { className: 'pa-muted' }, '1 = 上月 + 本月；2 = 前两个月起')),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '卡片分数门槛'),
          h('input', { className: 'pa-input', type: 'number', min: 1, max: 5, value: draft.cardsMinScore, onChange: (e) => patchDraft({ cardsMinScore: Number(e.target.value) }) }),
          h('span', { className: 'pa-muted' }, '只推送 >= 该分数的卡片（默认 4）')),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '单次最多翻页'),
          h('input', { className: 'pa-input', type: 'number', min: 1, max: 200, value: draft.pullMaxPages, onChange: (e) => patchDraft({ pullMaxPages: Number(e.target.value) }) }),
          h('span', { className: 'pa-muted' }, '每页 100 条；到上限会标记未完成、可续拉')),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '预览样本数'),
          h('input', { className: 'pa-input', type: 'number', min: 1, max: 10, value: draft.previewLimit, onChange: (e) => patchDraft({ previewLimit: Number(e.target.value) }) })),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '默认文献类型'),
          h('select', { className: 'pa-select', value: draft.defaultTypes, onChange: (e) => patchDraft({ defaultTypes: e.target.value }) },
            h('option', { value: 'article|review' }, 'article + review'),
            h('option', { value: 'article' }, '仅 article'),
            h('option', { value: 'review' }, '仅 review'))),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '默认语言'),
          h('input', { className: 'pa-input', value: draft.defaultLanguage, placeholder: '留空=不限；en / zh / ja…', onChange: (e) => patchDraft({ defaultLanguage: e.target.value }) })),
        h('h2', { style: { marginTop: 16 } }, '点评人设（小师妹）'),
        h('p', { className: 'pa-muted' }, '这段会进入一键筛选提示词，决定卡片上「小师妹」点评的语气与边界。留空保存会恢复默认。'),
        h('textarea', {
          className: 'pa-textarea',
          value: draft.commentPersona ?? DEFAULT_COMMENT_PERSONA,
          placeholder: DEFAULT_COMMENT_PERSONA,
          onChange: (event) => patchDraft({ commentPersona: event.target.value }),
        }),
        h('div', { className: 'pa-row' },
          h('button', { type: 'button', className: 'pa-btn', onClick: () => patchDraft({ commentPersona: DEFAULT_COMMENT_PERSONA }) }, '恢复默认人设')),
        h('h2', { style: { marginTop: 16 } }, '反馈学习'),
        h('div', { className: 'pa-row' },
          h('label', { className: 'pa-row', style: { gap: 8, margin: 0 } },
            h('input', {
              type: 'checkbox',
              checked: draft.useFeedback !== false,
              onChange: (event) => patchDraft({ useFeedback: event.target.checked }),
            }),
            h('span', null, '筛选时使用我的历史评分 / 评语'))),
        preferences === null
          ? h('p', { className: 'pa-muted' }, '读取反馈中…')
          : h('div', null,
            h('p', { className: 'pa-muted' }, `已有反馈 ${preferences.feedbackCount} 条（高分 ${preferences.likes} / 低分 ${preferences.dislikes} / 评语 ${preferences.notes}）`),
            preferences.summary === ''
              ? h('p', { className: 'pa-muted' }, '还没有偏好摘要：多写几条评语后点「更新偏好摘要」。')
              : h('div', { className: 'pa-pref' }, preferences.summary),
            h('div', { className: 'pa-row' },
              h('button', { type: 'button', className: 'pa-btn', onClick: refreshPreferences, disabled: prefBusy }, prefBusy ? '生成中…' : '更新偏好摘要'),
              preferences.generatedAt ? h('span', { className: 'pa-muted' }, `更新于 ${String(preferences.generatedAt).slice(0, 16).replace('T', ' ')}`) : null)),
        h('h2', { style: { marginTop: 16 } }, '方向上下文（进入筛选提示词）'),
        h('p', { className: 'pa-muted' }, '每个方向第一次创建时会自动生成；筛选时会连同方向配置一起给模型。反馈变化后可以手动更新。'),
        directionContexts === null
          ? h('p', { className: 'pa-muted' }, '读取中…')
          : directionContexts.directions.length === 0
            ? h('p', { className: 'pa-muted' }, '还没有方向：去「一键配置方向」创建，会自动生成初始上下文。')
            : directionContexts.directions.map((direction) => h('div', { key: direction.id, className: 'pa-dir-context' },
              h('div', { className: 'pa-row', style: { marginTop: 0 } },
                h('span', { className: 'pa-dir-name' }, direction.name),
                h('span', { className: 'pa-muted' }, `反馈 ${direction.feedbackCount} 条`),
                h('button', {
                  type: 'button',
                  className: 'pa-btn',
                  disabled: ctxBusy,
                  onClick: () => refreshContext(direction.id),
                }, ctxBusy ? '更新中…' : '更新上下文')),
              h('textarea', {
                className: 'pa-textarea',
                value: contextDrafts[direction.id] ?? direction.context ?? '',
                placeholder: '这个方向进入筛选提示词的上下文（可手动编辑）…',
                onChange: (event) => setContextDrafts((drafts) => ({ ...drafts, [direction.id]: event.target.value })),
              }),
              h('div', { className: 'pa-row' },
                h('button', {
                  type: 'button',
                  className: 'pa-btn primary',
                  disabled: ctxBusy,
                  onClick: () => saveContext(direction.id, contextDrafts[direction.id] ?? direction.context ?? ''),
                }, ctxBusy ? '保存中…' : '保存上下文'),
                h('button', {
                  type: 'button',
                  className: 'pa-btn',
                  disabled: ctxBusy,
                  onClick: () => refreshContext(direction.id),
                }, '用反馈重新生成'),
                direction.contextUpdatedAt
                  ? h('span', { className: 'pa-muted' }, `更新于 ${String(direction.contextUpdatedAt).slice(0, 16).replace('T', ' ')} · 生成时参考了 ${direction.contextFeedbackCount ?? 0} 条反馈`)
                  : null))),
        h('div', { className: 'pa-row' },
          h('button', { type: 'button', className: 'pa-btn primary', onClick: saveSettings, disabled: busy }, '保存参数'))) : null;

      const editor = form === null ? null : h('div', { className: 'pa-card' },
        h('h2', null, form.id === '' ? '新增方向' : '编辑方向'),
        h('div', { className: 'pa-row' }, h('span', { className: 'pa-label' }, '名称'), h('input', { className: 'pa-input', value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) })),
        h('div', { className: 'pa-row' }, h('span', { className: 'pa-label' }, '研究对象'), h('input', { className: 'pa-input', value: form.object, placeholder: '例如 Inconel 718 / IN718 / 镍基高温合金', onChange: (e) => setForm({ ...form, object: e.target.value }) })),
        h('div', { className: 'pa-row' }, h('span', { className: 'pa-label' }, '关注内容'), h('input', { className: 'pa-input', value: form.focus, placeholder: '例如 LPBF 的组织与性能', onChange: (e) => setForm({ ...form, focus: e.target.value }) })),
        h('div', { className: 'pa-row' }, h('span', { className: 'pa-label' }, '排除范围'), h('input', { className: 'pa-input', value: form.exclude, placeholder: '例如 纯焊接、纯铸造', onChange: (e) => setForm({ ...form, exclude: e.target.value }) })),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '文献类型'),
          h('select', { className: 'pa-select', value: form.types, onChange: (e) => setForm({ ...form, types: e.target.value }) },
            h('option', { value: '' }, '跟随全局'),
            h('option', { value: 'article|review' }, 'article + review'),
            h('option', { value: 'article' }, '仅 article'),
            h('option', { value: 'review' }, '仅 review')),
          h('span', { className: 'pa-label', style: { minWidth: 'auto' } }, '语言'),
          h('select', { className: 'pa-select', value: form.language, onChange: (e) => setForm({ ...form, language: e.target.value }) },
            h('option', { value: '' }, '跟随全局/不限'),
            h('option', { value: 'en' }, '英文'),
            h('option', { value: 'zh' }, '中文'))),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '额外过滤'),
          h('input', { className: 'pa-input', value: form.extraFilter, placeholder: '高级：额外 OpenAlex filter，例如 primary_location.source.country_code:CN', onChange: (e) => setForm({ ...form, extraFilter: e.target.value }) })),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '检索模式'),
          h('select', { className: 'pa-select', value: form.mode, onChange: (e) => setForm({ ...form, mode: e.target.value }) },
            h('option', { value: 'text' }, '文字检索'),
            h('option', { value: 'topics' }, 'Topics'),
            h('option', { value: 'keywords' }, 'Keywords'))),
        form.mode === 'text'
          ? h('div', null,
            h('p', { className: 'pa-muted' }, '布尔检索式（AND/OR/引号），会作用于标题和摘要：'),
            h('textarea', { className: 'pa-textarea', value: form.query, onChange: (e) => setForm({ ...form, query: e.target.value }) }))
          : h('div', null,
            h('div', { className: 'pa-row' },
              h('span', { className: 'pa-label' }, `${form.mode === 'topics' ? 'Topics' : 'Keywords'} ID`),
              h('span', { className: 'pa-muted' }, '一行一个；不确定就用下面的解析')),
            h('textarea', { className: 'pa-textarea', value: form.idsText, placeholder: form.mode === 'topics' ? 'T11690' : 'keywords/zinc-anode', onChange: (e) => setForm({ ...form, idsText: e.target.value }) }),
            h('div', { className: 'pa-row' },
              h('select', { className: 'pa-select', value: form.match, onChange: (e) => setForm({ ...form, match: e.target.value }) },
                h('option', { value: 'any' }, '任一满足'),
                h('option', { value: 'all' }, '全部满足')),
              h('input', {
                className: 'pa-input',
                value: resolveSearch,
                placeholder: form.mode === 'topics' ? '解析标签：英文主题词，例如 aqueous zinc ion battery' : '解析标签：英文关键词，例如 zinc anode',
                onChange: (e) => setResolveSearch(e.target.value),
              }),
              h('button', { type: 'button', className: 'pa-btn', onClick: doResolve, disabled: busy }, '解析')),
            resolveItems.length > 0 ? h('div', { className: 'pa-scroll' }, resolveItems.map((item) => h('div', { className: 'pa-row', key: item.id },
              h('span', { className: 'pa-chip' }, item.id),
              h('span', { style: { flex: 1 } }, item.name),
              h('span', { className: 'pa-muted' }, `${item.worksCount ?? '?'} 篇`),
              h('button', { type: 'button', className: 'pa-btn', onClick: () => handleAddId(item.id) }, '加入')))) : null),
        h('div', { className: 'pa-row' },
          h('button', { type: 'button', className: 'pa-btn primary', onClick: saveDirection, disabled: busy }, '保存方向'),
          h('button', { type: 'button', className: 'pa-btn', onClick: () => setForm(null) }, '取消')));
      // placeholder resolved below via closure-safe function

      function handleAddId(id) {
        if (form === null) return;
        const ids = splitIds(form.idsText);
        if (!ids.includes(id)) ids.push(id);
        setForm({ ...form, idsText: ids.join('\n') });
      }

      const directions = state?.directions ?? [];
      const list = h('div', { className: 'pa-card' },
        h('div', { className: 'pa-row' },
          h('h2', { style: { margin: 0, flex: 1 } }, `研究方向（${directions.length}）`),
          h('button', { type: 'button', className: 'pa-btn primary', onClick: () => { setForm(emptyForm()); setResolveItems([]); } }, '新增方向')),
        directions.length === 0 ? h('p', { className: 'pa-muted' }, '还没有方向。点「新增方向」，或让助手用 paper_directions 工具创建。') : null,
        directions.map((direction) => h('div', { className: 'pa-dir', key: direction.id },
          h('div', { className: 'pa-dir-head' },
            h('span', { className: 'pa-dir-name' }, direction.name),
            h('span', { className: 'pa-chip mode' }, modeLabel(direction.mode)),
            direction.enabled === false ? h('span', { className: 'pa-chip' }, '已停用') : null,
            h('span', { className: 'pa-chip' }, direction.id),
            h('div', { className: 'pa-actions' },
              h('button', { type: 'button', className: 'pa-btn', onClick: () => runPreview(direction.id), disabled: busy }, '测试拉取'),
              h('button', { type: 'button', className: 'pa-btn', onClick: () => startPull([direction.id]), disabled: busy || job?.status === 'running' }, '拉取'),
              h('button', { type: 'button', className: 'pa-btn', onClick: () => { setForm(formFrom(direction)); setResolveItems([]); setResolveSearch(''); } }, '编辑'),
              h('button', { type: 'button', className: 'pa-btn danger', onClick: () => deleteDirection(direction.id) }, '删除'))),
          h('div', { className: 'pa-cond' }, conditionText(direction)))));

      const previewPanel = preview === null ? null : h('div', { className: 'pa-card' },
        h('h2', null, `测试结果：命中 ${preview.count} 篇`),
        h('p', { className: 'pa-muted' }, `${preview.condition.condition} ｜ 窗口 ${preview.condition.window} ｜ 花费 $${preview.costUsd}${preview.budget?.remaining !== undefined ? ` ｜ 剩余额度 ${preview.budget.remaining}` : ''}`),
        h('p', { className: 'pa-muted' }, '按 publication_date 排序的前 10 篇样本（日期只有年月的期刊会显示为月初）：'),
        preview.sample.map((item) => h('div', { className: 'pa-sample', key: item.openalexId },
          h('div', null, item.title),
          h('div', { className: 'pa-muted' }, `${item.journal || '—'} · ${item.publicationDate || '—'} · ${item.doi || '无 DOI'}${item.hasAbstract ? ' · 有摘要' : ''}`))));

      const pullPanel = job === null ? null : h('div', { className: 'pa-card' },
        h('h2', null, job.status === 'running' ? '拉取中…' : job.status === 'done' ? '拉取完成' : '拉取出错'),
        h('div', { className: 'pa-progress' },
          h('span', { style: { width: `${progressPercent(job)}%` } })),
        h('p', { className: 'pa-muted' }, `已取 ${job.progress?.fetched ?? 0} / ${job.progress?.count ?? '?'} 篇（新增 ${job.progress?.added ?? 0}）`),
        job.status === 'done' && job.result
          ? h('div', null,
            job.result.directions.map((item) => h('div', { className: 'pa-sample', key: item.id },
              h('div', null, `${item.name}：命中 ${item.count ?? '?'}，取回 ${item.fetched}，新增 ${item.added}${item.complete ? '（完整）' : `（未完成：${item.stoppedReason ?? ''}）`}`),
              item.exportFile ? h('div', { className: 'pa-muted' }, `原始候选：${item.exportFile}`) : null)),
            h('p', { className: 'pa-muted' }, '下一步：点上方的「一键筛选」，模型会打分并生成中文卡片内容；完成后去「文献卡片台」刷新。'))
          : null,
        job.status === 'error' ? h('p', null, job.error?.message ?? '未知错误') : null,
        h('div', { className: 'pa-row' },
          h('button', { type: 'button', className: 'pa-btn', onClick: () => setJob(null) }, '关闭')));

      const autoConfigPanel = h('div', { className: 'pa-card' },
        h('h2', null, '一键配置方向'),
        h('p', { className: 'pa-muted' }, '用一段自然语言描述你的研究方向，点「自动配置」生成检索式并保存（不需要回对话）。'),
        h('textarea', {
          className: 'pa-textarea',
          value: autoDesc,
          placeholder: '例如：我在做激光粉末床熔融 IN718 的工艺-组织-疲劳性能关系，关注缺陷和残余应力，不看纯焊接和铸造',
          onChange: (event) => setAutoDesc(event.target.value),
        }),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '检索方式'),
          h('select', {
            className: 'pa-select',
            value: autoMode,
            onChange: (event) => setAutoMode(event.target.value),
          },
            h('option', { value: 'auto' }, '自动（模型判断）'),
            h('option', { value: 'text' }, '文字检索'),
            h('option', { value: 'topics' }, 'Topics 主题'),
            h('option', { value: 'keywords' }, 'Keywords 关键词'))),
        h('div', { className: 'pa-row' },
          h('button', { type: 'button', className: 'pa-btn primary', onClick: runAutoConfig, disabled: busy || autoDesc.trim() === '' }, '自动配置'),
          autoConfigResult === '' ? null : h('span', { className: 'pa-muted', style: { flex: 1, wordBreak: 'break-all' } }, autoConfigResult)));

      const autoScreenPanel = h('div', { className: 'pa-card' },
        h('h2', null, '一键筛选'),
        h('p', { className: 'pa-muted' }, '用当前模型给待筛选论文打分，并生成中文标题/梳理/点评/摘要翻译；完成后去「文献卡片台」刷新。'),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '打分模型'),
          models === null
            ? h('span', { className: 'pa-muted' }, '读取模型列表…')
            : h('select', {
              className: 'pa-select',
              style: { minWidth: 260 },
              value: state?.settings?.llmProvider ? `${state.settings.llmProvider}::${state.settings.llmModel}` : '',
              onChange: (event) => changeModel(event.target.value),
              disabled: busy,
            },
              h('option', { value: '' }, `跟随 DSH 默认${models.defaultSelection?.model ? `（${models.defaultSelection.model}）` : ''}`),
              (models.groups ?? []).map((group) => h('optgroup', { key: group.provider, label: group.providerName },
                group.models.map((model) => h('option', { key: `${group.provider}::${model.id}`, value: `${group.provider}::${model.id}` }, model.name)))))),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '推理强度'),
          selProvider === ''
            ? h('span', { className: 'pa-muted' }, '跟随 DSH 默认（选具体模型后可调）')
            : selEfforts.length === 0
              ? h('span', { className: 'pa-muted' }, '该模型没有可调的推理强度')
              : h('select', {
                className: 'pa-select',
                style: { minWidth: 180 },
                value: state?.settings?.llmReasoningEffort ?? '',
                onChange: (event) => changeEffort(event.target.value),
                disabled: busy,
              },
                h('option', { value: '' }, `模型默认${selEntry?.reasoning?.defaultEffort ? `（${selEntry.reasoning.defaultEffort}）` : ''}`),
                selEfforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name)))),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, '筛几篇'),
          [1, 5, 10, 20].map((n) => h('button', {
            key: `limit-${n}`,
            type: 'button',
            className: `pa-btn${autoLimit === n ? ' primary' : ''}`,
            onClick: () => setAutoLimit(n),
            disabled: autoJob?.status === 'running',
          }, `${n} 篇`)),
          h('input', {
            className: 'pa-input',
            style: { maxWidth: 120 },
            type: 'number',
            min: 1,
            max: 30,
            value: autoLimitCustom,
            placeholder: '自定义',
            onChange: (event) => setAutoLimitCustom(event.target.value),
          })),
        h('div', { className: 'pa-row' },
          h('button', {
            type: 'button',
            className: 'pa-btn primary',
            onClick: () => startAutoScreen(Number(autoLimitCustom) > 0 ? Math.min(Number(autoLimitCustom), 30) : autoLimit),
            disabled: busy || autoJob?.status === 'running',
          }, autoJob?.status === 'running' ? '筛选进行中…' : `自动筛选 ${Number(autoLimitCustom) > 0 ? Math.min(Number(autoLimitCustom), 30) : autoLimit} 篇`),
          autoJob === null ? null : h('span', { className: 'pa-muted' },
            autoJob.status === 'running'
              ? `已筛 ${autoJob.progress?.screened ?? 0}/${autoJob.progress?.total ?? 0} 篇`
              : autoJob.status === 'done'
                ? `完成：筛了 ${autoJob.result?.screened ?? 0} 篇，可推送 ${autoJob.result?.cardsReady ?? 0} 张`
                : `失败：${autoJob.error?.message ?? ''}`)),
        autoJob?.status === 'running'
          ? h('div', { className: 'pa-auto-status' },
            h('div', { className: 'pa-progress' },
              h('span', {
                style: {
                  width: `${(() => {
                    const total = Number(autoJob.progress?.total ?? 0);
                    const done = Number(autoJob.progress?.screened ?? 0) + Number(autoJob.progress?.skipped ?? 0);
                    return total > 0 ? Math.min(Math.round((done / total) * 100), 100) : 4;
                  })()}%`,
                },
              })),
            h('div', { className: 'pa-muted' },
              `模型思考中… 第 ${autoJob.progress?.done ?? 0}/${autoJob.progress?.batches ?? 0} 批 · 已用 ${autoElapsed}s（每批约 5–15 秒，两批并行）`))
          : null);

      const pullAll = h('div', { className: 'pa-row' },
        h('button', {
          type: 'button',
          className: 'pa-btn primary',
          disabled: busy || job?.status === 'running' || directions.length === 0,
          onClick: () => startPull(directions.filter((d) => d.enabled !== false).map((d) => d.id)),
        }, '拉取全部启用方向'));

      return h('div', { className: 'pa-page' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        header,
        banners,
        info,
        settingsPanel,
        autoConfigPanel,
        autoScreenPanel,
        pullAll,
        list,
        editor,
        previewPanel,
        pullPanel);
    }

    function progressPercent(job) {
      const fetched = Number(job?.progress?.fetched ?? 0);
      const count = Number(job?.progress?.count ?? 0);
      if (!Number.isFinite(count) || count <= 0) return fetched > 0 ? 5 : 0;
      return Math.min(100, Math.round((fetched / count) * 100));
    }

    function PaperAgentIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 18;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 18 18',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { d: 'M3 2.6h7l4 4v8.8H3z', stroke: 'currentColor', strokeWidth: '1.4', strokeLinejoin: 'round' }),
        h('path', { d: 'M10 2.6v4h4', stroke: 'currentColor', strokeWidth: '1.4', strokeLinejoin: 'round' }),
        h('path', { d: 'M5.6 9.4h6.8M5.6 12.2h4.4', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' }));
    }

    // ------------------------------------------------------------ deck panel
    function CardDeckPanel(props) {
      const onLeave = typeof props?.onLeave === 'function' ? props.onLeave : null;
      const [workspace, setWorkspace] = useState(() => {
        try {
          return window.localStorage.getItem(LS_WORKSPACE) ?? '';
        } catch {
          return '';
        }
      });
      const [cards, setCards] = useState([]);
      const [index, setIndex] = useState(0);
      const [rating, setRating] = useState(3);
      const [note, setNote] = useState('');
      const [openAbstract, setOpenAbstract] = useState(false);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [exiting, setExiting] = useState(false);
      const [history, setHistory] = useState([]);
      const [meta, setMeta] = useState(null);
      const [directions, setDirections] = useState([]);
      const [selectedDir, setSelectedDir] = useState('');
      const [viewUnread, setViewUnread] = useState(false);
      const [viewHistory, setViewHistory] = useState(false);
      const [historyKind, setHistoryKind] = useState('all');
      const [historyData, setHistoryData] = useState(null);
      const [dirStats, setDirStats] = useState({});
      const [summary, setSummary] = useState(null);
      const [batch, setBatch] = useState(null);
      const [batchSize, setBatchSize] = useState(10);
      const [savedHint, setSavedHint] = useState('');
      const [expandedId, setExpandedId] = useState('');
      const [editScore, setEditScore] = useState(3);
      const [editNote, setEditNote] = useState('');
      const [editBusy, setEditBusy] = useState(false);
      const [selectedIds, setSelectedIds] = useState([]);
      const [batchJob, setBatchJob] = useState(null);
      const batchPollRef = useRef(null);
      const timer = useRef(null);

      const loadCards = useCallback(async () => {
        if (workspace === '') return;
        setLoading(true);
        setError('');
        try {
          const data = await api('/cards', { workspace, minScore: 4, hideRead: true, limit: 300 });
          setCards(data.items ?? []);
          setMeta({ total: data.total ?? 0, minScore: data.minScore ?? 4 });
          // 刷新回到待读列表：旧批次里可能还留着刚评过的卡片，继续用旧下标会让人误以为评分没保存。
          setBatch(null);
          setIndex(0);
          setHistory([]);
          setRating(3);
          setNote('');
          setOpenAbstract(false);
        } catch (err) {
          const message = err?.message ?? '';
          if (/工作区不存在|不是目录/.test(message)) {
            try { window.localStorage.removeItem(LS_WORKSPACE); } catch { /* ignore */ }
            setWorkspace('');
            setError('原工作区不可用（可能已被删除），请回「文献拉取」重新设置工作区');
          } else {
            setError(message);
          }
        } finally {
          setLoading(false);
        }
      }, [workspace]);

      // 与拉取分页一致：打开时以 host 记住的工作区为准，避免 localStorage 过期。
      const deckBootedRef = useRef(false);
      useEffect(() => {
        if (deckBootedRef.current) return;
        deckBootedRef.current = true;
        api('/default-workspace', {}).then((data) => {
          if (data && typeof data.workspace === 'string' && data.workspace !== '' && data.workspace !== workspace) {
            try { window.localStorage.setItem(LS_WORKSPACE, data.workspace); } catch { /* ignore */ }
            setWorkspace(data.workspace);
            return;
          }
          if (data?.stale) {
            try { window.localStorage.removeItem(LS_WORKSPACE); } catch { /* ignore */ }
            if (workspace === data.stale) setWorkspace('');
          }
        }).catch(() => {});
      }, [workspace]);

      useEffect(() => {
        loadCards();
      }, [loadCards]);

      // 方向列表 + 方向统计（总计 / 待读 / 回顾）
      const refreshStats = useCallback(() => {
        if (workspace === '') return;
        api('/deck-summary', { workspace }).then((data) => {
          setSummary(data);
          setDirStats(data.byDirection ?? {});
        }).catch(() => {});
      }, [workspace]);

      const matchesDirection = (item, dir) => dir === ''
        || (Array.isArray(item.directions) && item.directions.includes(dir))
        || item.direction === dir;

      const startBatch = useCallback(() => {
        const pool = selectedDir === '' ? cards : cards.filter((item) => matchesDirection(item, selectedDir));
        const size = Math.min(Math.max(Number(batchSize) || 10, 1), 50);
        setBatch(pool.slice(0, size));
        setIndex(0);
        setHistory([]);
        setExpandedId('');
        setSavedHint('');
      }, [batchSize, cards, selectedDir]);

      useEffect(() => {
        if (workspace === '') return;
        api('/state', { workspace }).then((data) => setDirections(data.directions ?? [])).catch(() => {});
        refreshStats();
      }, [refreshStats, workspace]);

      const loadHistory = useCallback(async (kind = historyKind) => {
        if (workspace === '') return;
        setLoading(true);
        setError('');
        try {
          const data = await api('/history', { workspace, directionId: selectedDir, kind, limit: 300 });
          setHistoryData(data);
          setDirStats(data.byDirection ?? {});
        } catch (err) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      }, [historyKind, selectedDir, workspace]);

      useEffect(() => {
        loadHistory(historyKind);
      }, [historyKind, loadHistory]);

      // 回顾里修改已评分/已写评语的记录（手滑打错分数时可以改）
      const saveHistoryEdit = useCallback(async (item) => {        setEditBusy(true);
        try {
          await api('/rate', {
            workspace,
            openalexId: item.openalexId,
            doi: item.doi,
            direction: item.direction,
            rating: editScore,
            note: editNote,
            edit: true,
          });
          setSavedHint(`已修改：${(item.zhTitle || item.enTitle || '').slice(0, 24)} · ${editScore} 分`);
          await loadHistory(historyKind);
          refreshStats();
        } catch (err) {
          setError(err.message);
        } finally {
          setEditBusy(false);
        }
      }, [editNote, editScore, historyKind, loadHistory, refreshStats, workspace]);

      // 单篇重新打分 / 手动提升为可看卡片（修正误筛）
      const rescreenItem = useCallback(async (item) => {
        setEditBusy(true);
        try {
          const data = await api('/rescreen', { workspace, openalexId: item.openalexId });
          setSavedHint(`重新打分：${data.score} 分${data.cardReady ? '，已进入可看卡片' : '，仍低于卡片门槛'}`);
          await loadHistory(historyKind);
          refreshStats();
        } catch (err) {
          setError(err.message);
        } finally {
          setEditBusy(false);
        }
      }, [historyKind, loadHistory, refreshStats, workspace]);

      const overrideItem = useCallback(async (item) => {
        setEditBusy(true);
        try {
          await api('/override-score', { workspace, openalexId: item.openalexId, score: 4 });
          setSavedHint('已手动提升为可看卡片（4 分），去「待读」就能看到');
          await loadHistory(historyKind);
          refreshStats();
        } catch (err) {
          setError(err.message);
        } finally {
          setEditBusy(false);
        }
      }, [historyKind, loadHistory, refreshStats, workspace]);

      const toggleSelect = useCallback((id) => {
        setSelectedIds((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));
      }, []);
      const selectAllHistory = useCallback((items = []) => {
        setSelectedIds(items.map((item) => item.openalexId));
      }, []);
      const clearSelection = useCallback(() => setSelectedIds([]), []);
      const startBatchRescreen = useCallback(async () => {
        if (selectedIds.length === 0) return;
        setEditBusy(true);
        setError('');
        setBatchJob({ status: 'running', progress: { done: 0, total: selectedIds.length } });
        try {
          const data = await api('/rescreen-batch', { workspace, openalexIds: selectedIds });
          const jobId = data.jobId;
          if (batchPollRef.current !== null) window.clearInterval(batchPollRef.current);
          batchPollRef.current = window.setInterval(async () => {
            try {
              const status = await api('/rescreen-batch-status', { jobId });
              const job = status.job;
              setBatchJob({ id: jobId, ...job });
              if (job.status !== 'running') {
                window.clearInterval(batchPollRef.current);
                batchPollRef.current = null;
                await loadHistory(historyKind);
                refreshStats();
                setSelectedIds([]);
                setEditBusy(false);
                setSavedHint(job.status === 'done'
                  ? `批量重筛完成：成功 ${job.result?.rescreened ?? 0} 篇，失败 ${job.result?.failed ?? 0} 篇`
                  : `批量重筛失败：${job.error?.message ?? ''}`);
              }
            } catch (err) {
              window.clearInterval(batchPollRef.current);
              batchPollRef.current = null;
              setEditBusy(false);
              setError(err.message);
            }
          }, 1500);
        } catch (err) {
          setBatchJob(null);
          setEditBusy(false);
          setError(err.message);
        }
      }, [historyKind, loadHistory, refreshStats, selectedIds, workspace]);

      useEffect(() => {
        return () => {
          if (timer.current !== null) window.clearTimeout(timer.current);
          if (batchPollRef.current !== null) window.clearInterval(batchPollRef.current);
        };
      }, []);

      const visibleCards = batch ?? [];
      const card = index < visibleCards.length ? visibleCards[index] : null;

      const confirmCard = useCallback(() => {
        if (card === null || exiting) return;
        const current = card;
        setExiting(true);
        api('/rate', {
          workspace,
          openalexId: current.openalexId,
          doi: current.doi,
          direction: current.direction,
          rating,
          note,
        })
          .then(() => {
            setHistory((items) => [...items, { rating, direction: current.direction }]);
            setCards((items) => items.filter((item) => item.openalexId !== current.openalexId));
            setSavedHint(`已保存：${(current.zhTitle || current.enTitle || '').slice(0, 24)} · ${rating} 分`);
            refreshStats();
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => {
              timer.current = null;
              setExiting(false);
              setIndex((value) => value + 1);
              setRating(3);
              setNote('');
              setOpenAbstract(false);
            }, 640);
          })
          .catch((err) => {
            // 保存失败就停在当前卡片，不前进，避免评分悄悄丢掉。
            setError(err.message);
            setExiting(false);
          });
      }, [card, exiting, note, rating, refreshStats, workspace]);

      const skipCard = useCallback(() => {
        if (card === null || exiting) return;
        setIndex((value) => value + 1);
        setRating(3);
        setNote('');
        setOpenAbstract(false);
        setSavedHint('');
      }, [card, exiting]);

      const summaryByDir = summary?.byDirection ?? {};
      const overall = summary?.overall ?? { total: 0, unread: 0, history: 0 };
      const statsOf = (dir) => (dir === '' ? overall : (summaryByDir[dir] ?? { total: 0, unread: 0, history: 0 }));
      const selectedStats = statsOf(selectedDir);

      const header = h('div', { className: 'pa-head' },
        h('div', { style: { flex: 1 } },
          h('h1', null, '文献卡片台'),
          h('p', { className: 'pa-sub' }, '左侧按方向筛选；点「看看推荐」开始一组未读卡片的堆叠阅读，也可以在「回顾」里重看已评分或被筛掉的文献。'),
        ),
        h('select', {
          className: 'pa-select',
          value: batchSize,
          onChange: (event) => setBatchSize(Number(event.target.value)),
          title: '本轮推荐篇数',
        }, [5, 10, 20, 50].map((n) => h('option', { key: n, value: n }, `${n} 篇`))),
        h('button', { type: 'button', className: 'pa-btn primary', onClick: startBatch, disabled: loading || cards.length === 0 }, '看看推荐'),
        h('button', { type: 'button', className: 'pa-btn', onClick: loadCards, disabled: loading }, '刷新（回到待读）'));

      const banners = [
        error === '' ? null : h('div', { className: 'pa-err', key: 'err' }, error),
      ];

      const sideItem = (label, dir) => {
        const stats = statsOf(dir);
        return h('div', {
          key: `side-${dir === '' ? 'all' : dir}`,
          className: `pa-deck-side-item${selectedDir === dir ? ' active' : ''}`,
          onClick: () => {
            setSelectedDir(dir);
            setIndex(0);
            setExpandedId('');
            setBatch(null);
            // 点「全部」= 去掉所有选中（方向 + 待读/回顾）
            if (dir === '') {
              setViewUnread(false);
              setViewHistory(false);
              setSelectedIds([]);
            }
          },
          title: label,
        },
          h('div', { className: 'pa-deck-side-name' }, label),
          h('div', { className: 'pa-deck-side-stats' },
            h('span', null, `总计 ${stats.total}`),
            h('span', { className: 'pa-deck-side-unread' }, `待读 ${stats.unread}`),
            h('span', null, `回顾 ${stats.history}`)));
      };

      const viewItem = (label, kind, active, countText) => h('div', {
        className: `pa-deck-side-item${active ? ' active' : ''}`,
        onClick: () => {
          if (kind === 'unread') setViewUnread(!viewUnread);
          else setViewHistory(!viewHistory);
          setBatch(null);
          setExpandedId('');
        },
        title: '再点一次取消选中',
      },
        h('div', { className: 'pa-deck-side-name' }, label),
        h('div', { className: 'pa-deck-side-stats' }, h('span', null, countText)));

      const sidebar = h('aside', { className: 'pa-deck-side' },
        h('div', { className: 'pa-deck-side-title' }, '研究方向'),
        sideItem('全部', ''),
        directions.length === 0
          ? h('p', { className: 'pa-muted', style: { padding: '4px 2px' } }, '还没有方向：去「文献拉取」一键配置。')
          : directions.map((direction) => sideItem(direction.name, direction.id)),
        h('div', { className: 'pa-deck-side-sep' }),
        h('div', { className: 'pa-deck-side-title' }, '列表（可多选/再点取消）'),
        viewItem('待读', 'unread', viewUnread, `未读 ${overall.unread} 篇`),
        viewItem('回顾', 'history', viewHistory, `已打分/被筛掉 ${overall.history} 条`));

      const page = (main) => h('div', { className: 'pa-page' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        header,
        banners,
        h('div', { className: 'pa-deck-layout' }, sidebar, h('div', { className: 'pa-deck-main' }, main)));

      if (workspace === '') {
        return page(h('div', { className: 'pa-card' }, h('p', { className: 'pa-muted' }, '还没有设置工作区：先去左侧栏「文献拉取」里设置工作区路径。')));
      }

      const dirMatch = (item) => matchesDirection(item, selectedDir);
      const floor = historyData?.minScore ?? 4;
      const unreadPool = cards.filter(dirMatch).map((item) => ({ ...item, kind: 'unread', read: false }));
      const historyPool = (historyData?.items ?? [])
        .filter((item) => dirMatch(item) && (item.read === true || item.score < floor))
        .map((item) => ({ ...item, kind: 'history' }));
      const unionById = new Map();
      for (const item of historyPool) unionById.set(item.openalexId, item);
      for (const item of unreadPool) unionById.set(item.openalexId, item);
      let listItems;
      if (viewUnread && !viewHistory) listItems = [...unreadPool];
      else if (viewHistory && !viewUnread) listItems = [...historyPool];
      else listItems = [...unionById.values()];
      listItems.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)
        || String(b.publicationDate ?? '').localeCompare(String(a.publicationDate ?? '')));
      const listLabel = viewUnread && viewHistory ? '待读 + 回顾' : viewUnread ? '待读' : viewHistory ? '回顾' : '全部文献';

      const listView = h('div', { className: 'pa-card pa-history' },
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-label' }, `${listLabel} · ${selectedDir === '' ? '全部方向' : selectedDir}`),
          h('span', { className: 'pa-muted' }, `共 ${listItems.length} 篇`),
          h('div', { className: 'pa-deck-rec' },
            h('select', {
              className: 'pa-select',
              value: batchSize,
              onChange: (event) => setBatchSize(Number(event.target.value)),
              title: '本轮推荐篇数',
            }, [5, 10, 20, 50].map((n) => h('option', { key: n, value: n }, `${n} 篇`))),
            h('button', { type: 'button', className: 'pa-btn primary', onClick: startBatch, disabled: loading || cards.length === 0 }, '看看推荐'))),
        h('div', { className: 'pa-row' },
          h('span', { className: 'pa-muted' }, `已选 ${selectedIds.length} 篇`),
          h('button', { type: 'button', className: 'pa-btn', onClick: () => selectAllHistory(listItems), disabled: listItems.length === 0 }, '全选本页'),
          h('button', { type: 'button', className: 'pa-btn', onClick: clearSelection, disabled: selectedIds.length === 0 }, '清空选择'),
          h('button', {
            type: 'button',
            className: 'pa-btn primary',
            onClick: startBatchRescreen,
            disabled: editBusy || selectedIds.length === 0,
          }, editBusy ? '处理中…' : `批量重新打分（${selectedIds.length}）`),
          batchJob?.status === 'running'
            ? h('span', { className: 'pa-muted' }, `进度 ${batchJob.progress?.done ?? 0}/${batchJob.progress?.total ?? 0}`)
            : null,
          savedHint === '' ? null : h('span', { className: 'pa-muted' }, savedHint)),
        listItems.length === 0
          ? h('p', { className: 'pa-muted' }, loading ? '读取中…' : '当前筛选没有文献。')
          : h('div', { className: 'pa-history-list' }, listItems.map((item) => h('div', {
            key: item.openalexId,
            className: `pa-history-item${expandedId === item.openalexId ? ' open' : ''}`,
          },
            h('div', {
              className: 'pa-history-line',
              title: item.kind === 'unread' ? '点开这篇开始读' : '点开可查看/修改评分与评语',
              onClick: () => {
                if (item.kind === 'unread') {
                  setBatch([item]);
                  setIndex(0);
                  setHistory([]);
                  setExpandedId('');
                  return;
                }
                if (expandedId === item.openalexId) {
                  setExpandedId('');
                  return;
                }
                setExpandedId(item.openalexId);
                setEditScore(Number(item.rating ?? item.score ?? 3));
                setEditNote(item.note ?? '');
              },
            },
              h('input', {
                type: 'checkbox',
                checked: selectedIds.includes(item.openalexId),
                onClick: (event) => event.stopPropagation(),
                onChange: () => toggleSelect(item.openalexId),
              }),
              h('span', { className: `pa-history-score${item.score >= floor ? ' pass' : ' fail'}` }, String(item.score)),
              h('span', { className: 'pa-history-title' }, item.zhTitle || item.enTitle || item.title || '（无标题）'),
              h('span', { className: 'pa-history-tags' },
                item.kind === 'unread' ? '待读' : item.rated ? `已评 ${item.rating} 分` : '未评',
                item.score < floor ? ' · 被筛掉' : '',
                item.direction === '' ? '' : ` · ${item.direction}`)),
            item.kind !== 'unread' && expandedId === item.openalexId ? h('div', { className: 'pa-history-detail' },
              h('div', { className: 'pa-muted' }, item.enTitle),
              h('div', { className: 'pa-muted' }, `${item.journal || '—'} · ${item.publicationDate ?? '—'} · 筛选于 ${String(item.screenedAt ?? '').slice(0, 10)}`),
              item.summary ? h('p', { className: 'pa-deck-body' }, item.summary) : null,
              item.comment ? h('p', { className: 'pa-deck-body pa-muted' }, item.comment) : null,
              item.note ? h('p', { className: 'pa-deck-body' }, `评语：${item.note}`) : null,
              h('div', { className: 'pa-history-edit' },
                h('div', { className: 'pa-row' },
                  h('span', { className: 'pa-label' }, '我的评分'),
                  h('select', {
                    className: 'pa-select',
                    value: editScore,
                    onChange: (event) => setEditScore(Number(event.target.value)),
                  }, [1, 2, 3, 4, 5].map((score) => h('option', { key: score, value: score }, `${score} 分`))),
                  h('button', {
                    type: 'button',
                    className: 'pa-btn primary',
                    disabled: editBusy,
                    onClick: () => saveHistoryEdit(item),
                  }, editBusy ? '保存中…' : '保存修改')),
                h('textarea', {
                  className: 'pa-deck-note',
                  value: editNote,
                  placeholder: '评语（留空保存 = 清除评语）',
                  onChange: (event) => setEditNote(event.target.value),
                }),
                h('p', { className: 'pa-muted' }, '保存后以最新一次为准；分数改错、评语写错都可以在这里改。'),
                h('div', { className: 'pa-row' },
                  h('button', {
                    type: 'button',
                    className: 'pa-btn',
                    disabled: editBusy,
                    onClick: () => rescreenItem(item),
                  }, editBusy ? '处理中…' : '重新打分'),
                  h('button', {
                    type: 'button',
                    className: 'pa-btn',
                    disabled: editBusy,
                    onClick: () => overrideItem(item),
                  }, '提升为可看卡片（4 分）'))),
              item.url ? h('a', { className: 'pa-btn', href: item.url, target: '_blank', rel: 'noreferrer noopener' }, '看原文') : null) : null))));

      const rated = history.length;
      const average = rated === 0 ? 0 : history.reduce((sum, item) => sum + item.rating, 0) / rated;
      const doneView = rated === 0
        ? h('div', { className: 'pa-card' },
          h('h2', null, '这一组读完了'),
          h('p', { className: 'pa-muted' }, '没有记录到评分（可能都跳过了）。可以刷新候选后继续看下一组，或去「回顾」里重看已筛文献。'),
          h('div', { className: 'pa-row' },
            h('button', { type: 'button', className: 'pa-btn primary', onClick: () => { setBatch(null); loadCards(); } }, '刷新候选'),
            h('button', { type: 'button', className: 'pa-btn', onClick: () => { setBatch(null); setViewHistory(true); setViewUnread(false); } }, '去回顾')))
        : h('div', { className: 'pa-card pa-deck-stats' },
          h('h2', null, `本轮读完了：${rated} 张`),
          h('p', { className: 'pa-muted' }, `平均 ${average.toFixed(1)} 分`),
          h('div', { className: 'pa-deck-dist' },
            [1, 2, 3, 4, 5].map((score) => h('div', { key: score },
              h('div', { style: { fontSize: 18, fontWeight: 600 } }, history.filter((item) => item.rating === score).length),
              h('div', { className: 'pa-muted' }, `${score} 分`)))),
          h('div', { className: 'pa-row', style: { marginTop: 14 } },
            h('button', { type: 'button', className: 'pa-btn primary', onClick: () => { setBatch(null); startBatch(); } }, '再来一组'),
            h('button', { type: 'button', className: 'pa-btn', onClick: () => { setBatch(null); setViewHistory(true); setViewUnread(false); } }, '去回顾')));

      if (loading && batch === null && cards.length === 0) {
        return page(h('div', { className: 'pa-card' }, h('p', { className: 'pa-muted' }, '正在读取卡片…')));
      }

      if (batch === null) {
        return page(listView);
      }

      if (card === null) {
        return page(doneView);
      }

      const behind = index + 1 < visibleCards.length ? visibleCards[index + 1] : null;

      return page(h('div', null,
        h('p', { className: 'pa-muted', style: { margin: '0 0 6px' } }, `第 ${index + 1} 张 / 共 ${visibleCards.length} 张${selectedDir === '' ? '' : ` · 方向：${selectedDir}`}`),
        savedHint === '' ? null : h('p', { className: 'pa-muted', style: { margin: '0 0 6px', color: 'var(--dsw-alias-brand-primary)' } }, savedHint),
        h('div', { className: 'pa-deck-stage' },
          behind === null ? null : h('div', { className: 'pa-deck-behind' },
            h('div', { className: 'pa-deck-title', style: { fontSize: 16 } }, behind.zhTitle || behind.enTitle),
            h('div', { className: 'pa-deck-en' }, behind.enTitle)),
          h('article', { className: `pa-deck-card${exiting ? ' burning' : ''}` },
            h('h2', { className: 'pa-deck-title' }, card.zhTitle || card.enTitle),
            h('p', { className: 'pa-deck-en' }, card.enTitle),
            h('div', { className: 'pa-deck-meta' },
              h('span', null, `${(card.authors ?? []).slice(0, 3).join('; ')}${(card.authors ?? []).length > 3 ? ' 等' : ''}`),
              h('span', null, `${card.journal || '—'} · ${card.year ?? '—'}`),
              h('span', { className: 'pa-deck-chip hot' }, `小师妹打分 ${card.score}`),
              card.direction === '' ? null : h('span', { className: 'pa-deck-chip' }, card.direction)),
            (card.abstract !== '' || card.abstractZh !== '')
              ? h('div', { className: 'pa-deck-block' },
                h('button', { type: 'button', className: 'pa-deck-abstract-toggle', onClick: () => setOpenAbstract(!openAbstract) },
                  h('span', { className: 'pa-deck-eyebrow' }, '摘要 / 中文翻译'),
                  h('span', { className: 'pa-muted' }, openAbstract ? '收起' : '展开')),
                openAbstract
                  ? h('div', null,
                    card.abstract === '' ? null : h('div', { className: 'pa-deck-abstract' }, card.abstract),
                    card.abstractZh === '' ? null : h('div', { className: 'pa-deck-abstract', style: { marginTop: 8 } }, card.abstractZh))
                  : null)
              : null,
            h('div', { className: 'pa-deck-block' },
              h('div', { className: 'pa-deck-eyebrow' }, '内容梳理'),
              h('div', { className: 'pa-deck-body' }, card.summary || '（未生成）')),
            h('div', { className: 'pa-deck-block pa-deck-comment' },
              h('div', { className: 'pa-deck-eyebrow' }, '小师妹'),
              h('div', { className: 'pa-deck-body' }, card.comment || '（未生成）')),
            h('div', { className: 'pa-deck-block' },
              h('div', { className: 'pa-deck-eyebrow' }, '给小师妹的评语（可选）'),
              h('textarea', {
                className: 'pa-deck-note',
                value: note,
                placeholder: '这类只做模拟的不看；这套工艺路线我想跟进……',
                onChange: (event) => setNote(event.target.value),
              })),
            h('div', { className: 'pa-deck-controls' },
              h('span', { className: 'pa-deck-eyebrow' }, '相关性'),
              h('input', {
                type: 'range',
                className: 'pa-deck-slider',
                min: 1,
                max: 5,
                step: 1,
                value: rating,
                onChange: (event) => setRating(Number(event.target.value)),
              }),
              h('span', { className: 'pa-deck-score' }, String(rating)),
              h('div', { className: 'pa-deck-actions' },
                card.url ? h('a', { className: 'pa-btn', href: card.url, target: '_blank', rel: 'noreferrer noopener' }, '看原文') : null,
                h('button', { type: 'button', className: 'pa-btn', onClick: skipCard, disabled: exiting }, '跳过'),
                h('button', { type: 'button', className: 'pa-btn primary', onClick: confirmCard, disabled: exiting }, exiting ? '记录中…' : '确认并消掉')))))));

    }

    function DeckIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 18;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 18 18',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('rect', { x: '3', y: '4.5', width: '12', height: '9', rx: '1.6', stroke: 'currentColor', strokeWidth: '1.4' }),
        h('path', { d: 'M3 8.2h12', stroke: 'currentColor', strokeWidth: '1.2' }),
        h('path', { d: 'M6.4 6.2h.01M8.9 6.2h.01', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round' }));
    }

    // ------------------------------------------------------------ hub（一个页面两个分页）
    function PaperHubPanel(props) {
      const [tab, setTab] = useState('fetch');
      return h('div', { className: 'pa-hub' },
        h('div', { className: 'pa-hub-tabs' },
          h('button', {
            type: 'button',
            className: `pa-tab${tab === 'fetch' ? ' active' : ''}`,
            onClick: () => setTab('fetch'),
          }, '文献拉取'),
          h('button', {
            type: 'button',
            className: `pa-tab${tab === 'cards' ? ' active' : ''}`,
            onClick: () => setTab('cards'),
          }, '文献卡片台')),
        tab === 'fetch'
          ? h(PaperAgentPanel, { ...props, embedded: true, onOpenDeck: () => setTab('cards') })
          : h(CardDeckPanel, { ...props, embedded: true }));
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({
            onLeave: () => {
              const layout = ctx.get('layout');
              if (layout !== undefined && layout !== null) layout.selectPanel(null);
            },
          }),
        }, PaperHubPanel));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 31,
          label: () => '文献助手',
        }, PaperAgentIcon));

        ctx.effect(() => {
          return () => {
            try {
              const layout = ctx.get('layout');
              const active = layout?.panelInfo?.getSnapshot?.().activePanelId;
              if (layout !== undefined && layout !== null && active === PANEL_ID) {
                layout.selectPanel(null);
              }
            } catch {
              /* layout may be disposed already */
            }
          };
        }, 'paper-agent: leave panel on dispose');
      },
    };
  },
});
