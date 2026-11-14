import { PlaygroundSDK } from '@midscene/playground';
import {
  allScriptsFromDump,
  calculateFrameMap,
  exportBrandedVideoBlob,
} from '@midscene/visualizer';
import { ChromeExtensionProxyPage, ChromeExtensionProxyPageAgent } from '@midscene/web/chrome-extension';
import { saveReplayVideo } from '../replay-store';

// Prototype only: endpoints require a backend that does not yet exist.
const SITE = 'https://ai.qykaiwu.cn';
const PREFIX = '使用浏览器插件';
// Replay videos are rendered and stored locally (IndexedDB), never uploaded.
let active: { id: string; capability: string; sdk?: PlaygroundSDK; agent?: ChromeExtensionProxyPageAgent; abort: AbortController } | undefined;

export function installQiyuanBridge() {
  const listener = (message: any, sender: chrome.runtime.MessageSender, respond: (value: any) => void) => {
    if (sender.id !== chrome.runtime.id || sender.tab || message?.channel !== 'qiyuan-verified') return false;
    void (async () => {
      if (message.type === 'cancel') {
        if (!active || active.id !== message.taskId || active.capability !== message.capability) throw new Error('No matching task');
        active.abort.abort();
        await active.sdk?.cancelExecution(active.id);
        return { ok: true };
      }
      if (message.type !== 'run' || active) throw new Error('Invalid request or task running');
      if (typeof message.text !== 'string' || !message.text.startsWith(PREFIX)) throw new Error('Explicit plugin prefix required');
      const prompt = message.text.slice(PREFIX.length).trim();
      if (!prompt || prompt.length > 16000 || !/^[\w-]{1,128}$/.test(message.taskId) || !/^[A-Za-z0-9._~-]{16,4096}$/.test(message.capability)) throw new Error('Invalid task');
      const supportedFamilies = ['jev', 'ant-ling', 'step', 'doubao-vision', 'doubao-seed', 'gemini', 'qwen2.5-vl', 'qwen3-vl', 'qwen3', 'qwen3.5', 'qwen3.6', 'vlm-ui-tars', 'vlm-ui-tars-doubao', 'vlm-ui-tars-doubao-1.5', 'glm-v', 'auto-glm', 'auto-glm-multilingual', 'gpt-5', 'gpt-6', 'deepseek', 'tencent-hy', 'kimi', 'kimi3', 'xiaomi-mimo'];
      if (typeof message.modelFamily !== 'string' || !supportedFamilies.includes(message.modelFamily)) throw new Error('Unsupported or missing server model family');
      const reservation = { id: message.taskId as string, capability: message.capability as string, abort: new AbortController(), sdk: undefined as PlaygroundSDK | undefined, agent: undefined as ChromeExtensionProxyPageAgent | undefined };
      active = reservation;
      // Open a fresh tab for every task: the chat page and the user's other
      // tabs are never navigated, and the model drives this tab end to end.
      // The explicit 「使用浏览器插件」 prefix is the user's consent, so no
      // extra confirm dialog is needed.
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      reservation.abort.signal.throwIfAborted();
      if (!tab?.id) throw new Error('无法新建任务标签页');
      // Acknowledge immediately: the task may run for minutes, and an MV3
      // service worker waiting on this respond can be killed mid-wait, which
      // would leave the chat page stuck forever. From here on the page
      // tracks the task by polling the backend, so the final state must
      // always reach /result — even when the steps below fail.
      respond({ ok: true, taskId: message.taskId, started: true });
      const abort = reservation.abort;
      const url = `${SITE}/api/browser-plugin/tasks/${message.taskId}`;
      const request = async (path: string, data: unknown, signal?: AbortSignal) => {
        // Bound every backend call: an upstream stall must not freeze the task
        // forever (the chat page would wait silently for the full 2h TTL).
        const signals = [signal, AbortSignal.timeout(180_000)].filter((s): s is AbortSignal => !!s);
        const res = await fetch(`${url}/${path}`, { method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.any(signals), headers: { 'content-type': 'application/json', authorization: `Bearer ${message.capability}` }, body: JSON.stringify(data) });
        if (!res.ok) throw new Error(`Backend HTTP ${res.status}`);
        return res.json();
      };
      try {
      // Live progress: the SDK's onProgressUpdate is never fired by the local
      // adapter, so derive tips from the agent's execution dump instead —
      // each model round-trip updates it. Throttled + deduped posts.
      let lastTip = '';
      let lastTipAt = 0;
      const pushTip = (tip: string) => {
        const clean = tip.replace(/\s+/g, ' ').trim().slice(0, 140);
        const now = Date.now();
        if (!clean || (clean === lastTip && now - lastTipAt < 60_000) || now - lastTipAt < 1500) return;
        lastTip = clean; lastTipAt = now;
        void request('progress', { tip: clean }, abort.signal).catch(() => {});
      };
      const page = new ChromeExtensionProxyPage(true);
      await page.setActiveTabId(tab.id, { activate: false });
      const sdk = new PlaygroundSDK({ type: 'local-execution', agentFactory: () => {
        const agent = new ChromeExtensionProxyPageAgent(page, {
        // Multi-step collection tasks (e.g. "汇总50条结果") legitimately need
        // many planning rounds; the upstream default of 20 aborts them.
        replanningCycleLimit: 100,
        // SDK constructor requires a nonempty value; this sentinel is not a key
        // and the custom client never transmits it.
        modelConfig: { MIDSCENE_MODEL_NAME: 'gpt-6-astra', MIDSCENE_MODEL_FAMILY: message.modelFamily, MIDSCENE_MODEL_API_KEY: 'not-a-secret', MIDSCENE_MODEL_BASE_URL: `${SITE}/api/browser-plugin/tasks/${message.taskId}/model`, MIDSCENE_MODEL_STREAM_MODE: 'non-stream', MIDSCENE_MODEL_PROTOCOL: 'openai-responses' },
        createOpenAIClient: async (client: any) => new Proxy(client, { get(target, key, receiver) {
          if (key === 'responses') return { create: (body: any, options: any = {}) => {
            if (body.stream) throw new Error('Streaming unsupported');
            return request('model', body, options.signal || abort.signal);
          } };
          if (key === 'chat') throw new Error('Only Responses protocol is supported');
          return Reflect.get(target, key, receiver);
        } }),
      });
        reservation.agent = agent;
        agent.addDumpUpdateListener((_dumpStr: string, execDump: any) => {
          try {
            const executions = execDump?.executions || [];
            const latest = executions[executions.length - 1];
            const tasks = latest?.tasks || [];
            const current = [...tasks].reverse().find((t: any) => t?.status === 'running') || tasks[tasks.length - 1];
            const what = current?.thought || current?.name || '';
            pushTip(`执行中 · 第 ${executions.length} 轮${what ? ' · ' + what : ''}`);
          } catch { /* tip 推导失败不影响执行 */ }
        });
        return agent;
      } });
      reservation.sdk = sdk;
      abort.signal.throwIfAborted();
      pushTip('任务已下发，正在启动…');
      let outcome: unknown;
      try {
        outcome = await sdk.executeAction('aiAct', { type: 'aiAct', prompt }, { requestId: message.taskId, abortSignal: abort.signal });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (/planning cycle limit|replanningCycleLimit/i.test(errorMessage)) {
          // 超过规划轮次上限：不要把英文报错糊给用户，基于已完成的工作汇总部分结果。
          pushTip('已达步数上限，正在汇总已完成部分…');
          let partialSummary = '';
          try {
            const asked: unknown = await sdk.executeAction('aiAsk', { type: 'aiAsk', prompt: `用户要求在网页上完成：「${prompt}」。任务因步数较多被提前结束。请基于当前页面的实际内容和目前已完成的工作，用简洁中文汇总已经收集到的结果/进展（300 字以内）；如果还没有收集到任何内容，就直接说"暂无有效结果"。` }, { requestId: `${message.taskId}-partial`, abortSignal: abort.signal });
            partialSummary = typeof asked === 'string' ? asked : (asked && typeof asked === 'object' ? String((asked as Record<string, unknown>).result ?? (asked as Record<string, unknown>).thought ?? '') : '');
          } catch { /* 汇总失败时给出兜底文案 */ }
          outcome = { result: partialSummary.trim() || '任务因步数较多提前结束，未能收集到有效结果。', partial: true };
        } else {
          outcome = { error: errorMessage };
        }
      }
      // aiAct 只描述"做了什么动作"；用户要的是页面上的实际内容。
      // 任务成功后追加一次 aiAsk，基于当前页面总结与指令相关的内容。
      if (!(outcome && typeof outcome === 'object' && ('error' in (outcome as Record<string, unknown>) || 'partial' in (outcome as Record<string, unknown>)))) {
        pushTip('正在汇总结果…');
        try {
          const asked: unknown = await sdk.executeAction('aiAsk', { type: 'aiAsk', prompt: `用户刚才要求在网页上完成：「${prompt}」。请基于当前页面的实际内容，用简洁中文汇总用户想要的结果本身（例如搜索到的主要信息/条目），不要描述执行了哪些操作，300 字以内。` }, { requestId: `${message.taskId}-ask`, abortSignal: abort.signal });
          const answer = typeof asked === 'string' ? asked : (asked && typeof asked === 'object' ? String((asked as Record<string, unknown>).result ?? (asked as Record<string, unknown>).thought ?? '') : '');
          if (answer.trim()) {
            outcome = outcome && typeof outcome === 'object' && !Array.isArray(outcome)
              ? { ...(outcome as Record<string, unknown>), result: answer }
              : { result: answer };
          }
        } catch { /* 摘要失败不阻断，保留原 outcome */ }
      }
      // Best-effort terminal artifact: replay video. Rendered locally and kept
      // in the extension's IndexedDB — never uploaded, so the server spends
      // zero storage/bandwidth on videos. The chat page links to the local
      // replay player page instead.
      let videoAvailable = false;
      let videoError: string | undefined;
      const agent = reservation.agent;
      if (agent) {
        try {
          // The playground adapter finalizes the agent report after execution,
          // which releases dump memory; the action result carries its own dump.
          const resultDump = outcome && typeof outcome === 'object' && Array.isArray((outcome as { dump?: { executions?: unknown } }).dump?.executions)
            ? (outcome as { dump: unknown }).dump
            : JSON.parse(agent.dumpDataString());
          const info = allScriptsFromDump(resultDump as never);
          const scripts = info?.scripts ?? [];
          if (!scripts.length) throw new Error('No replay frames in dump');
          const frameMap = calculateFrameMap(scripts, { imageWidth: info?.width, imageHeight: info?.height });
          // The popup page may be hidden during the render; rAF never fires
          // there, so drive the render loop with timers. Cap the bitrate and
          // retry lower if needed to bound local disk usage.
          const TARGET_MAX = 32 * 1024 * 1024;
          let video = await exportBrandedVideoBlob(frameMap, { timerDriven: true, videoBitsPerSecond: 1_500_000 });
          if (video.size > TARGET_MAX) {
            video = await exportBrandedVideoBlob(frameMap, { timerDriven: true, videoBitsPerSecond: 500_000 });
          }
          if (video.size === 0) throw new Error('Empty video');
          if (video.size > TARGET_MAX) throw new Error('视频过大，无法保存');
          abort.signal.throwIfAborted();
          await saveReplayVideo(message.taskId, video);
          videoAvailable = true;
        } catch (error) {
          videoError = error instanceof Error ? error.message : String(error);
        }
      }
      const uploadOutcome = { videoAvailable, ...(videoError ? { videoError } : {}) };
      // The action outcome carries heavy fields (dump with base64 screenshots,
      // report HTML, logs) — far over the backend's 256KB result cap, and
      // unreadable in chat anyway. Summarize: drop known-heavy keys, drop
      // embedded images, truncate long strings, keep the model's actual answer.
      const HEAVY_KEYS = /^(dump|reportHTML|report|screenshots?|taskLog|logs?|elements?|pageData|rawResponse)$/i;
      const slim = (value: unknown, depth = 0): unknown => {
        if (value == null || depth > 6) return value == null ? value : undefined;
        if (typeof value === 'string') {
          if (/^data:image\//.test(value)) return undefined;
          return value.length > 3000 ? value.slice(0, 3000) + '…（已截断）' : value;
        }
        if (typeof value !== 'object') return value;
        if (Array.isArray(value)) {
          const arr = value.map(v => slim(v, depth + 1)).filter(v => v !== undefined);
          return arr.length > 50 ? arr.slice(0, 50) : arr;
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (HEAVY_KEYS.test(k)) continue;
          const s = slim(v, depth + 1);
          if (s !== undefined) out[k] = s;
        }
        return out;
      };
      let finalOutcome: Record<string, unknown> = outcome && typeof outcome === 'object' && !Array.isArray(outcome)
        ? { ...(slim(outcome) as Record<string, unknown>), ...uploadOutcome }
        : { result: slim(outcome), ...uploadOutcome };
      const byteLen = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).byteLength;
      if (byteLen(finalOutcome) > 200 * 1024) {
        // Still oversized: keep only the answer-shaped fields.
        const o = finalOutcome as Record<string, unknown>;
        finalOutcome = {
          result: String(o.result ?? o.thought ?? o.output ?? o.text ?? '任务已完成').slice(0, 8000),
          ...uploadOutcome,
        };
      }
      if (byteLen(finalOutcome) > 200 * 1024) {
        finalOutcome = { result: '任务已完成（结果超出对话容量，请回看过程视频）', ...uploadOutcome };
      }
      await request('result', { outcome: finalOutcome, cancelled: abort.signal.aborted });
      } catch (error) {
        // The chat page only learns the outcome from the backend; never let a
        // failure above (uploads, result post) leave the task unterminated.
        try { await request('result', { outcome: { error: error instanceof Error ? error.message : String(error) }, cancelled: reservation.abort.signal.aborted }); } catch { /* backend unreachable */ }
      } finally {
        if (active === reservation) active = undefined;
        // The task ran on an auto-created tab; bring the chat tab back into
        // focus so the user lands on the conversation with the result.
        if (typeof message.targetTabId === 'number' && message.targetTabId > 0) {
          try {
            const chatTab = await chrome.tabs.get(message.targetTabId);
            if (chatTab?.windowId != null) await chrome.windows.update(chatTab.windowId, { focused: true });
            await chrome.tabs.update(message.targetTabId, { active: true });
          } catch { /* chat tab already gone */ }
        }
      }
    })().then((value) => { if (value !== undefined) respond(value); }, (e) => respond({ ok: false, error: String(e?.message || e) }));
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
