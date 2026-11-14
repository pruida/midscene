import { PlaygroundSDK } from '@midscene/playground';
import {
  allScriptsFromDump,
  calculateFrameMap,
  exportBrandedVideoBlob,
} from '@midscene/visualizer';
import { ChromeExtensionProxyPage, ChromeExtensionProxyPageAgent } from '@midscene/web/chrome-extension';

// Prototype only: endpoints require a backend that does not yet exist.
const SITE = 'https://ai.qykaiwu.cn';
const PREFIX = '使用浏览器插件';
const VIDEO_MAX_BYTES = 32 * 1024 * 1024;
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
        const res = await fetch(`${url}/${path}`, { method: 'POST', credentials: 'omit', redirect: 'error', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${message.capability}` }, body: JSON.stringify(data) });
        if (!res.ok) throw new Error(`Backend HTTP ${res.status}`);
        return res.json();
      };
      const requestBinary = async (path: string, body: Blob, signal?: AbortSignal) => {
        const res = await fetch(`${url}/${path}`, { method: 'POST', credentials: 'omit', redirect: 'error', signal, headers: { 'content-type': 'video/webm', authorization: `Bearer ${message.capability}` }, body });
        if (!res.ok) throw new Error(`Backend HTTP ${res.status}`);
        return res.json();
      };
      try {
      const page = new ChromeExtensionProxyPage(true);
      await page.setActiveTabId(tab.id, { activate: false });
      const sdk = new PlaygroundSDK({ type: 'local-execution', agentFactory: () => {
        const agent = new ChromeExtensionProxyPageAgent(page, {
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
        return agent;
      } });
      reservation.sdk = sdk;
      abort.signal.throwIfAborted();
      sdk.onProgressUpdate((tip: string) => { void request('progress', { tip }, abort.signal).catch(() => {}); });
      let outcome: unknown;
      try {
        outcome = await sdk.executeAction('aiAct', { type: 'aiAct', prompt }, { requestId: message.taskId, abortSignal: abort.signal });
      } catch (error) {
        outcome = { error: error instanceof Error ? error.message : String(error) };
      }
      // Best-effort terminal artifact: replay video. The result text itself is
      // posted to /result and shown in the conversation; no report page.
      let videoUploaded = false;
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
          // The popup page may be hidden during upload; rAF never fires
          // there, so drive the render loop with timers.
          const video = await exportBrandedVideoBlob(frameMap, { timerDriven: true });
          if (video.size === 0) throw new Error('Empty video');
          if (video.size > VIDEO_MAX_BYTES) throw new Error('Video exceeds 32MB limit');
          await requestBinary('video', video, abort.signal);
          videoUploaded = true;
        } catch (error) {
          videoError = error instanceof Error ? error.message : String(error);
        }
      }
      const uploadOutcome = { videoUploaded, ...(videoError ? { videoError } : {}) };
      // The action outcome carries a `dump` with base64 screenshots — far over
      // the backend's 256KB result cap. Strip it (and any oversize residue);
      // the video upload above is the durable artifact.
      const slim = (value: unknown): unknown => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const { dump: _dump, ...rest } = value as Record<string, unknown>;
          return rest;
        }
        return value;
      };
      let finalOutcome: Record<string, unknown> = outcome && typeof outcome === 'object' && !Array.isArray(outcome)
        ? { ...(slim(outcome) as Record<string, unknown>), ...uploadOutcome }
        : { result: slim(outcome), ...uploadOutcome };
      if (new TextEncoder().encode(JSON.stringify(finalOutcome)).byteLength > 200 * 1024) {
        finalOutcome = { note: '结果过大已省略，请回看过程视频', ...uploadOutcome };
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
