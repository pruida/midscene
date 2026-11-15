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
      // Live progress: the agent's aiAct progress bus carries structured
      // per-step events (plan_thinking / plan_planned / action_running /
      // action_done with durationMs). We keep a Midscene-report-like step
      // timeline and post it (throttled) with the tip so the chat page can
      // render plans and per-step durations in real time.
      interface ProgressStep { kind: string; text: string; status: 'running' | 'done' | 'failed'; durationMs?: number; ts: number }
      const steps: ProgressStep[] = [];
      let lastTip = '';
      let lastPostAt = 0;
      let lastPostSig = '';
      const postProgress = (force = false) => {
        const now = Date.now();
        // Send the tail: long tasks only need recent steps for live display.
        // 后端 steps 字段硬上限 6000 字节，超了整包 400 静默丢弃（进度就冻结在
        // 最后一次成功的样子）。这里按字节预算自适应：先砍每条文本长度、再砍条数。
        const byteLen = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
        const buildTail = (count: number, textLen: number) => steps.slice(-count).map(s => ({
          k: s.kind.slice(0, 40), t: s.text.slice(0, textLen), s: s.status, ts: s.ts,
          ...(s.durationMs != null ? { d: Math.round(s.durationMs) } : {}),
        }));
        let tail = buildTail(30, 160);
        for (const [count, len] of [[30, 80], [20, 80], [12, 60], [8, 40], [5, 40]] as const) {
          if (byteLen(tail) <= 5400) break;
          tail = buildTail(count, len);
        }
        const sig = `${lastTip}|${tail.length}|${tail.map(s => s.s + String(s.d ?? '')).join(',')}`;
        renderPanel();
        if (!force && (now - lastPostAt < 1500 || sig === lastPostSig)) return;
        lastPostAt = now; lastPostSig = sig;
        void request('progress', { tip: lastTip, steps: tail, totalSteps: steps.length }, abort.signal).catch(() => {});
      };
      // 侧边栏实时进度：本文件就跑在侧边栏页面里，直接把同一份步骤时间线
      // 渲染进面板 DOM，不看对话页也能跟踪任务。终态保留显示直到下个任务。
      let panelState: 'running' | 'done' | 'failed' | 'cancelled' = 'running';
      let panelResultText = '';
      const renderPanel = () => {
        try {
          if (typeof document === 'undefined') return;
          let root = document.getElementById('qiyuan-live-progress') as HTMLDivElement | null;
          if (!root) {
            root = document.createElement('div');
            root.id = 'qiyuan-live-progress';
            (document.body || document.documentElement).appendChild(root);
          }
          const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const fmtDur = (ms?: number) => {
            if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
            const s = ms / 1000;
            return s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : s >= 10 ? `${Math.round(s)}秒` : `${s.toFixed(1)}秒`;
          };
          const fmtTime = (ts: number) => { const d = new Date(ts); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
          const headMap = {
            running: ['#3b82f6', '● 任务执行中'],
            done: ['#22a06b', '✓ 任务已完成'],
            failed: ['#c00', '✗ 任务失败'],
            cancelled: ['#c00', '■ 任务已取消'],
          } as const;
          const [color, headText] = headMap[panelState];
          const rows = steps.slice(-60).map((s) => {
            const icon = s.status === 'done' ? '<span style="color:#22a06b">✓</span>'
              : s.status === 'failed' ? '<span style="color:#c00">✗</span>'
              : '<span style="color:#3b82f6">●</span>';
            const dur = s.durationMs != null ? `<span style="color:#999;margin-left:6px;white-space:nowrap">${fmtDur(s.durationMs)}</span>` : '';
            return `<div style="display:flex;gap:6px;align-items:baseline;padding:2px 0">${icon}<span style="color:#999;font-variant-numeric:tabular-nums;white-space:nowrap">${fmtTime(s.ts)}</span><div style="min-width:0"><b>${esc(s.kind)}</b> <span style="color:#555;overflow-wrap:anywhere">${esc(s.text)}</span>${dur}</div></div>`;
          }).join('');
          root.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:9999;overflow-y:auto;padding:16px;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;box-sizing:border-box';
          root.innerHTML = `<div style="font-size:15px;font-weight:600;color:${color};margin-bottom:6px">${headText}</div>`
            + (lastTip ? `<div style="color:#666;font-size:12px;margin-bottom:10px">${esc(lastTip)}</div>` : '')
            + (panelResultText ? `<div style="color:#333;font-size:13px;margin-bottom:10px;white-space:pre-wrap;overflow-wrap:anywhere">${esc(panelResultText)}</div>` : '')
            + `<div style="border-left:2px solid #e5e7eb;padding-left:10px">${rows}</div>`;
          root.scrollTop = root.scrollHeight;
        } catch { /* 面板渲染失败不影响任务 */ }
      };
      const pushTip = (tip: string) => {
        const clean = tip.replace(/\s+/g, ' ').trim().slice(0, 140);
        if (!clean) return;
        lastTip = clean;
        postProgress();
      };
      const lastRunning = (pred: (s: ProgressStep) => boolean) => { for (let i = steps.length - 1; i >= 0; i--) { if (steps[i].status === 'running' && pred(steps[i])) return steps[i]; } return undefined; };
      // 时间线里的动作名用中文展示（模型输出的是英文动作名）。
      const KIND_LABELS: Record<string, string> = {
        Plan: '规划', Navigate: '浏览', Scroll: '滚动', Sleep: '等待',
        Tap: '点击', DoubleClick: '双击', RightClick: '右键点击', MiddleClick: '中键点击',
        Hover: '悬停', Input: '输入', ClearInput: '清空输入', KeyboardPress: '按键',
        CursorMove: '移动光标', DragAndDrop: '拖拽', LongPress: '长按', Swipe: '滑动',
        Pinch: '捏合', Reload: '刷新', GoBack: '后退', GoForward: '前进',
        StopLoading: '停止加载', Finished: '完成', Error: '错误',
      };
      const kindLabel = (name: string) => KIND_LABELS[name] || name;
      const page = new ChromeExtensionProxyPage(true);
      await page.setActiveTabId(tab.id, { activate: false });
      // 链接语料库：Midscene 是纯视觉管线，模型只看截图、看不到 href。
      // 「每条带原文链接」类任务因此必然失败（模型只能诚实拒绝）。这里在
      // 执行过程中直接从 DOM 提取真实链接（锚文本+href+所在页面），汇总时
      // 交给模型配对，杜绝编造网址。
      const linkCorpus: Array<{ page: string; title: string; links: Array<{ t: string; h: string }> }> = [];
      const seenHrefs = new Set<string>();
      let lastHarvestAt = 0;
      const harvestLinks = async () => {
        try {
          const res: any = await page.evaluateJavaScript(`(() => {
            const out = [];
            for (const a of document.querySelectorAll('a[href]')) {
              const t = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim();
              if (t.length < 6) continue;
              const h = a.href;
              if (!/^https?:/.test(h) || h.includes('google.com/search') || h.includes('#')) continue;
              out.push({ t: t.slice(0, 120), h: h.slice(0, 300) });
              if (out.length >= 150) break;
            }
            return { url: location.href, title: (document.title || '').slice(0, 120), links: out };
          })()`);
          const val = res?.result?.value ?? res?.value ?? res;
          if (!val || !Array.isArray(val.links) || typeof val.url !== 'string') {
            console.warn('harvestLinks: unexpected evaluate result shape', res && Object.keys(res));
            return;
          }
          const fresh = val.links.filter((l: any) => l && typeof l.t === 'string' && typeof l.h === 'string' && !seenHrefs.has(l.h));
          if (!fresh.length) return;
          for (const l of fresh) seenHrefs.add(l.h);
          linkCorpus.push({ page: String(val.url).slice(0, 200), title: String(val.title || ''), links: fresh });
          // 总量护栏：最多留最近 8 页 / 400 条
          while (linkCorpus.length > 8) linkCorpus.shift();
          let total = linkCorpus.reduce((n, p) => n + p.links.length, 0);
          for (let i = 0; total > 400 && i < linkCorpus.length - 1; i++) {
            const drop = Math.min(linkCorpus[i].links.length, total - 400);
            linkCorpus[i].links.splice(0, drop);
            total -= drop;
          }
        } catch { /* 页面忙/导航中，跳过本次采集 */ }
      };
      const linkCorpusText = () => {
        const lines: string[] = [];
        for (const p of linkCorpus) {
          if (!p.links.length) continue;
          lines.push(`【页面】${p.title}（${p.page}）`);
          for (const l of p.links) lines.push(`- ${l.t} → ${l.h}`);
        }
        const text = lines.join('\n');
        return text.length > 20000 ? text.slice(-20000) : text;
      };
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
        // Structured per-step timeline straight from the aiAct progress bus.
        let planThinkingAt = 0;
        agent.addProgressListener((event: any) => {
          try {
            if (event?.scope !== 'aiAct') return;
            const d = event.data || {};
            if (event.phase === 'plan_thinking') {
              planThinkingAt = Date.now();
              steps.push({ kind: kindLabel('Plan'), text: `第 ${d.planIndex ?? '?'} 轮思考中…`, status: 'running', ts: Date.now() });
            } else if (event.phase === 'plan_planned') {
              const s = lastRunning(x => x.kind === kindLabel('Plan'));
              if (s) {
                s.status = 'done';
                const thought = String(d.thought || d.log || '').replace(/\s+/g, ' ').trim();
                if (thought) s.text = thought.slice(0, 160);
                if (planThinkingAt) s.durationMs = Date.now() - planThinkingAt;
              }
            } else if (event.phase === 'action_running') {
              const name = String(d.action?.name || 'Action');
              const target = String(d.action?.target ?? (d.action?.param != null ? JSON.stringify(d.action.param) : '')).replace(/\s+/g, ' ').trim();
              steps.push({ kind: kindLabel(name), text: target.slice(0, 160), status: 'running', ts: Date.now() });
            } else if (event.phase === 'action_done' || event.phase === 'action_failed') {
              const s = lastRunning(x => x.kind !== kindLabel('Plan'));
              if (s) {
                s.status = event.phase === 'action_done' ? 'done' : 'failed';
                if (typeof d.durationMs === 'number') s.durationMs = d.durationMs;
              }
              // 每个动作做完顺手采集当前页真实链接（节流到 5s 一次）
              if (event.phase === 'action_done' && Date.now() - lastHarvestAt > 5000) {
                lastHarvestAt = Date.now();
                void harvestLinks();
              }
            } else if (event.phase === 'plan_failed') {
              const s = lastRunning(() => true);
              if (s) s.status = 'failed';
            } else {
              return;
            }
            const runningNow = lastRunning(() => true);
            lastTip = `执行中 · 已进行 ${steps.length} 步${runningNow ? ' · ' + runningNow.kind + (runningNow.text ? ' ' + runningNow.text : '') : ''}`;
            postProgress();
          } catch { /* 进度事件解析失败不影响执行 */ }
        });
        return agent;
      } });
      reservation.sdk = sdk;
      abort.signal.throwIfAborted();
      pushTip('任务已下发，正在启动…');
      let outcome: unknown;
      // 模型只看截图看不到 href，「带链接」类需求会逼它诚实认输。提前声明：
      // 链接由系统自动提取，它只需浏览阅读，不用记录网址。
      const actPrompt = `${prompt}\n\n（提示：你只需浏览和阅读页面内容；如果任务要求附带原文链接，页面上的真实链接会在任务结束时由系统自动提取，不需要你逐个记录或抄写网址。）`;
      // 汇总提示：把执行中采集到的真实链接列表交给模型，只允许用这些链接。
      const buildSummaryPrompt = (limitNote: string) => {
        const links = linkCorpusText();
        const linkBlock = links
          ? `\n\n以下是执行过程中从页面 DOM 提取的真实链接列表（锚文本 → 网址）。如果任务要求附带链接：每一条结果的标题/来源必须写成可点击的 markdown 链接（格式：[标题](网址)），直接嵌在表格或列表的对应行里——读者看到感兴趣的条目要能立即点开原文，只把链接堆在文末是不可接受的。网址必须只取自下面列表，禁止编造或猜测任何不在列表中的链接；列表里找不到合适链接的条目，该行就不放链接（保留纯文本标题），并在末尾注明该条目链接缺失：\n${links}`
          : '\n\n注意：本次未能从页面提取到任何真实链接。如果任务要求附带链接，如实说明无法获取链接，绝对不要编造网址，也不要声称链接会由系统附上。';
        return `用户要求在网页上完成：「${prompt}」。${limitNote}请基于当前页面的实际内容和已完成的工作，用简洁中文汇总用户想要的结果本身（例如搜索到的主要信息/条目，逐条列出），不要描述执行了哪些操作；如果任务要求返回若干条结果（如前 N 条/列表），必须用 markdown 表格逐条列出（表头：| 序号 | 标题 | 来源 | 链接 |，一行一条结果），表格行数多没关系、不受字数限制，表格之外的说明文字 800 字以内；如果还没有收集到任何内容，就直接说"暂无有效结果"。${linkBlock}`;
      };
      // 确定性兜底：采集到的链接直接作为数据放进结果，不依赖模型自觉。
      const flattenLinks = () => {
        const out: Array<{ t: string; h: string; page: string }> = [];
        for (const p of linkCorpus) {
          for (const l of p.links) {
            out.push({ t: l.t, h: l.h, page: p.title || p.page });
            if (out.length >= 100) return out;
          }
        }
        return out;
      };
      try {
        // Hard cap: if the agent loop stalls (dead page, wedged navigation),
        // abort so /result is still posted while this context is alive. The
        // backend watchdog (15 min silence) is the fallback if WE die instead.
        const actSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(30 * 60_000)]);
        outcome = await sdk.executeAction('aiAct', { type: 'aiAct', prompt: actPrompt }, { requestId: message.taskId, abortSignal: actSignal });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // 任何 aiAct 失败（超步数、动作失败、模型放弃等）都不直接把英文报错
        // 糊给用户：先采集一次当前页链接，再基于已完成的工作汇总部分结果。
        pushTip(/planning cycle limit|replanningCycleLimit/i.test(errorMessage) ? '已达步数上限，正在汇总已完成部分…' : '任务中途受挫，正在汇总已完成部分…');
        await harvestLinks();
        let partialSummary = '';
        try {
          const asked: unknown = await sdk.executeAction('aiAsk', { type: 'aiAsk', prompt: buildSummaryPrompt('任务因故被提前结束。') }, { requestId: `${message.taskId}-partial`, abortSignal: abort.signal });
          partialSummary = typeof asked === 'string' ? asked : (asked && typeof asked === 'object' ? String((asked as Record<string, unknown>).result ?? (asked as Record<string, unknown>).thought ?? '') : '');
        } catch { /* 汇总失败时给出兜底文案 */ }
        outcome = { result: partialSummary.trim() || `任务未能完成：${errorMessage}`, partial: true };
      }
      // aiAct 只描述"做了什么动作"；用户要的是页面上的实际内容。
      // 任务成功后追加一次 aiAsk，基于当前页面总结与指令相关的内容。
      if (!(outcome && typeof outcome === 'object' && ('error' in (outcome as Record<string, unknown>) || 'partial' in (outcome as Record<string, unknown>)))) {
        pushTip('正在汇总结果…');
        await harvestLinks(); // 汇总前再采集一次，确保最后一页的链接也在语料库里
        pushTip(seenHrefs.size ? `已采集到 ${seenHrefs.size} 条页面真实链接，正在汇总…` : '未能从页面提取到链接，正在汇总…');
        try {
          const asked: unknown = await sdk.executeAction('aiAsk', { type: 'aiAsk', prompt: buildSummaryPrompt('') }, { requestId: `${message.taskId}-ask`, abortSignal: abort.signal });
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
          pushTip('动作已完成，正在本地生成回放视频…');
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
      // Ship the full step timeline (bounded) with the result so the final
      // conversation message can show every plan and its duration.
      const finalSteps = steps.slice(-60).map(s => ({
        k: s.kind.slice(0, 40), t: s.text.slice(0, 200), s: s.status, ts: s.ts,
        ...(s.durationMs != null ? { d: Math.round(s.durationMs) } : {}),
      }));
      const harvestedLinks = flattenLinks();
      const uploadOutcome = { videoAvailable, ...(videoError ? { videoError } : {}), ...(harvestedLinks.length ? { links: harvestedLinks } : {}), steps: finalSteps, totalSteps: steps.length };
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
      // 面板终态：和对话页同一口径（取消/失败/完成 + 结果摘要）。
      panelState = abort.signal.aborted ? 'cancelled'
        : (finalOutcome && typeof finalOutcome === 'object' && 'error' in finalOutcome ? 'failed' : 'done');
      panelResultText = String((finalOutcome as Record<string, unknown>).result ?? (finalOutcome as Record<string, unknown>).error ?? '').slice(0, 2000);
      postProgress(true); // flush the complete timeline before the terminal post
      await request('result', { outcome: finalOutcome, cancelled: abort.signal.aborted });
      } catch (error) {
        // 面板变量都声明在 try 块内、catch 里不可见；如果面板已渲染过，直接
        // 把标题翻成失败态即可。
        try {
          if (typeof document !== 'undefined') {
            const head = document.querySelector('#qiyuan-live-progress > div:first-child') as HTMLElement | null;
            if (head) { head.textContent = '✗ 任务失败'; head.style.color = '#c00'; }
          }
        } catch { /* ignore */ }
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
