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
const REPORT_MAX_BYTES = 8 * 1024 * 1024;
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
      try {
      // Open a fresh tab for every task: the chat page and the user's other
      // tabs are never navigated, and the model drives this tab end to end.
      // The explicit 「使用浏览器插件」 prefix is the user's consent, so no
      // extra confirm dialog is needed.
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      reservation.abort.signal.throwIfAborted();
      if (!tab?.id) throw new Error('无法新建任务标签页');
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
      // Best-effort terminal artifacts: report HTML and replay video.
      // Failures here must never mask the task result; they are recorded
      // as extension fields on the reported outcome instead.
      let reportUploaded = false;
      let videoUploaded = false;
      let reportError: string | undefined;
      let videoError: string | undefined;
      const agent = reservation.agent;
      if (agent) {
        try {
          const html = agent.reportHTMLString();
          if (!html) throw new Error('Empty report');
          if (new TextEncoder().encode(html).byteLength > REPORT_MAX_BYTES) throw new Error('Report exceeds 8MB limit');
          await request('report', { html }, abort.signal);
          reportUploaded = true;
        } catch (error) {
          reportError = error instanceof Error ? error.message : String(error);
        }
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
      const uploadOutcome = { reportUploaded, videoUploaded, ...(reportError ? { reportError } : {}), ...(videoError ? { videoError } : {}) };
      const finalOutcome = outcome && typeof outcome === 'object' && !Array.isArray(outcome)
        ? { ...(outcome as Record<string, unknown>), ...uploadOutcome }
        : { result: outcome, ...uploadOutcome };
      await request('result', { outcome: finalOutcome, cancelled: abort.signal.aborted });
      return { ok: true, taskId: message.taskId, cancelled: abort.signal.aborted };
      } finally { if (active === reservation) active = undefined; }
    })().then(respond, (e) => respond({ ok: false, error: String(e?.message || e) }));
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
