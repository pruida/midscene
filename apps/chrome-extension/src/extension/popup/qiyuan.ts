import { PlaygroundSDK } from '@midscene/playground';
import {
  allScriptsFromDump,
  calculateFrameMap,
  exportBrandedVideoBlob,
} from '@midscene/visualizer';
import { ChromeExtensionProxyPage, ChromeExtensionProxyPageAgent } from '@midscene/web/chrome-extension';
import { saveReplayVideo } from '../replay-store';
import { clarificationAction } from './clarification';
import { navigateWithFailover, selectStartUrls } from './qiyuan-navigation';
import { collectionPlatforms, normalizeObservations, observationBatches, type Observation } from './qiyuan-observations';

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
      // ACK only after validation and reservation, before any navigation or other
      // potentially slow browser API. The worker can then release its channel.
      respond({ ok: true, taskId: message.taskId, started: true, version: chrome.runtime.getManifest().version });
      const abort = reservation.abort;
      const url = `${SITE}/api/browser-plugin/tasks/${message.taskId}`;
      const request = async (path: string, data: unknown, signal?: AbortSignal) => {
        const signals = [signal, AbortSignal.timeout(180_000)].filter((s): s is AbortSignal => !!s);
        const res = await fetch(`${url}/${path}`, { method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.any(signals), headers: { 'content-type': 'application/json', authorization: `Bearer ${message.capability}` }, body: JSON.stringify(data) });
        if (!res.ok) throw new Error(`Backend HTTP ${res.status}`);
        return res.json();
      };
      try {
      void request('progress', { tip: '正在启动浏览器任务', steps: [], totalSteps: 0 }, abort.signal).catch(() => {});
      // Open a fresh tab for every task: the chat page and the user's other
      // tabs are never navigated, and the model drives this tab end to end.
      // The explicit 「使用浏览器插件」 prefix is the user's consent, so no
      // extra confirm dialog is needed.
      // 起始页：点名平台时直接进该站；未指定搜索站时默认百度，失败后有界切换。
      // 只匹配用户本次的指令文本，不匹配对话上下文里提到的旧站点。
      const userIntent = prompt.split('【对话上下文')[0];
      const startUrls = selectStartUrls(userIntent);
      const observationPlatforms = collectionPlatforms(userIntent);
      const observations: Observation[] = [];
      const observationKeys = new Set<string>();
      let observationQueue: Promise<void> = Promise.resolve();
      const saveObservations = (items: Observation[]) => {
        const fresh = items.filter(item => {
          const key = `${item.platform}|${item.title}`;
          if (observationKeys.has(key)) return false;
          observationKeys.add(key);
          return true;
        });
        observations.push(...fresh);
        for (const batch of observationBatches(fresh)) {
          observationQueue = observationQueue.then(async () => {
            try { await request('progress', { tip: '正在保存已读记录', observations: batch }, undefined); } catch { /* result retains the evidence */ }
          });
        }
      };
      const navigationNotices: string[] = [];
      // Reuse only a page explicitly identified in this turn, never a URL in chat history.
      const existing = /(?:已经?|当前|正在)(?:在浏览器(?:中|里)?)?(?:打开|开启)(?:着)?的|已打开的/.exec(userIntent);
      let tab: chrome.tabs.Tab;
      if (existing) {
        const after = userIntent.slice(existing.index + existing[0].length);
        const raw = /^[\s页面网页标签地址链接：:「“]*(https?:\/\/[^\s，。；、」”<>]+)/i.exec(after)?.[1];
        if (!raw) throw new Error('请提供已打开页面的完整网址；不会新建标签页。');
        const target = new URL(raw);
        const matches = (await chrome.tabs.query({ currentWindow: true })).filter(t =>
          t.id !== message.targetTabId && t.url === target.href && !t.pendingUrl && !t.discarded);
        const match = matches.length === 1 ? matches[0] : matches.find(t => t.active);
        if (!match?.id) throw new Error(matches.length ? '有多个相同页面，请选中要使用的标签页后重试。' : '当前窗口未找到指定的已打开页面，请确认网址和窗口后重试。');
        tab = await chrome.tabs.update(match.id, { active: true });
        if (tab.url !== target.href || tab.pendingUrl) throw new Error('目标页面已变化，请重新确认。');
      } else {
        tab = await chrome.tabs.create({ url: 'about:blank', active: true });
        if (!tab.id) throw new Error('无法新建任务标签页');
        tab = await navigateWithFailover(tab.id, startUrls, reservation.abort.signal, {
          onFallback: ({ from, to }) => {
            const host = (value: string) => new URL(value).hostname.replace(/^www\./, '');
            navigationNotices.push(`${host(from)} 起始页访问失败，已自动切换到 ${host(to)}。`);
          },
        });
      }
      reservation.abort.signal.throwIfAborted();
      if (!tab?.id) throw new Error('无法新建任务标签页');
      // 等起始页加载完再接管：页面还在 loading 时 debugger 截图会报
      // "Unable to capture screenshot"，首个动作直接失败。
      try {
        const tabId = tab.id;
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
          const t = await chrome.tabs.get(tabId).catch(() => null);
          if (!t || t.status === 'complete') break;
          await new Promise(r => setTimeout(r, 200));
        }
      } catch { /* 页面消失或查询失败，继续由后续步骤报错 */ }
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
      // 停止按钮的二次确认状态：第一次点击进入"再点一次确认"，5 秒不点自动还原。
      let stopArmed = false;
      let stopArmTimer: ReturnType<typeof setTimeout> | undefined;
      // 等待用户回答的澄清问题：卡片渲染在面板顶部，用户可在侧边栏直接回答。
      let pendingClarification: { questionId: string; question: string; status: 'waiting' | 'submitting' | 'error'; draft: string; errorText?: string } | null = null;
      const clarificationDraftById: Record<string, string> = {};
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
          const formatResult = (text: string) => {
            const inline = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            const cells = (s: string) => s.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
            const lines = text.split(/\r?\n/), out: string[] = [];
            for (let i=0;i<lines.length;i++) {
              if(lines[i].includes('|') && lines[i+1]?.includes('|') && cells(lines[i+1]).every(c=>/^:?-{2,}:?$/.test(c))) {
                const row=(line:string,tag:'th'|'td')=>'<tr>'+cells(line).map(c=>`<${tag} style="padding:5px;border:1px solid #ddd;vertical-align:top">${inline(c)}</${tag}>`).join('')+'</tr>';
                const rows=[row(lines[i++],'th')]; while(lines[i+1]?.includes('|')) rows.push(row(lines[++i],'td'));
                out.push('<div style="overflow-x:auto"><table style="border-collapse:collapse">'+rows.join('')+'</table></div>');
              } else if(lines[i].trim()) out.push('<p style="margin:6px 0">'+inline(lines[i])+'</p>');
            }
            return out.join('');
          };
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
          // 状态头 sticky 吸顶：面板自动滚到底部展示最新步骤时，完成/失败
          // 横幅仍然可见；终态再额外在时间线末尾放一条横幅，双保险。
          const stopBtn = panelState === 'running'
            ? `<button id="qiyuan-stop-btn" style="margin-left:12px;font-size:12px;padding:2px 12px;border:1px solid ${stopArmed ? '#c00' : '#ccc'};border-radius:6px;background:${stopArmed ? '#c00' : '#fff'};color:${stopArmed ? '#fff' : '#c00'};cursor:pointer;vertical-align:2px">${stopArmed ? '再点一次确认停止' : '停止任务'}</button>`
            : '';
          const headBlock = `<div style="position:sticky;top:-16px;background:#fff;padding:8px 0 6px;margin:-8px 0 6px;border-bottom:1px solid #eee;z-index:1">`
            + `<div style="font-size:15px;font-weight:600;color:${color}">${headText}${stopBtn}</div>`
            + (lastTip && panelState === 'running' ? `<div style="color:#666;font-size:12px;margin-top:2px">${esc(lastTip)}</div>` : '')
            + (panelResultText ? `<div style="color:#333;font-size:13px;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow-y:auto">${formatResult(panelResultText)}</div>` : '')
            + `</div>`;
          const tailBanner = panelState === 'running' ? ''
            : `<div style="margin-top:12px;padding:10px 12px;border:1px solid ${color};border-radius:8px;color:${color};font-weight:600">${headText}，完整结果与回放视频见对话页</div>`;
          // 待答问题卡片：任务暂停等待用户输入，可在此处或对话页回答。
          const clarBlock = pendingClarification && panelState === 'running'
            ? `<div style="margin:8px 0 10px;padding:12px;border:1px solid #f59e0b;background:#fffbeb;border-radius:10px">`
              + `<div style="font-weight:600;color:#92400e;margin-bottom:6px">❓ 任务需要你确认后才能继续</div>`
              + `<div style="color:#333;white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:8px">${esc(pendingClarification.question)}</div>`
              + `<div style="display:flex;gap:8px"><input id="qiyuan-clar-input" type="text" placeholder="输入你的回答…" value="${esc(pendingClarification.draft)}" style="flex:1;padding:6px 10px;border:1px solid #d97706;border-radius:6px;font-size:13px">`
              + `<button id="qiyuan-clar-submit" style="padding:6px 14px;border:none;border-radius:6px;background:#f59e0b;color:#fff;font-size:13px;cursor:pointer" ${pendingClarification.status === 'submitting' ? 'disabled' : ''}>${pendingClarification.status === 'submitting' ? '提交中…' : '提交回答'}</button></div>`
              + (pendingClarification.errorText ? `<div style="color:#c00;font-size:12px;margin-top:6px">${esc(pendingClarification.errorText)}</div>` : '')
              + `</div>`
            : '';
          const clarHadFocus = (document.activeElement as HTMLElement | null)?.id === 'qiyuan-clar-input';
          root.innerHTML = headBlock
            + clarBlock
            + `<div style="border-left:2px solid #e5e7eb;padding-left:10px">${rows}</div>`
            + tailBanner;
          // 待答卡片：保留草稿与焦点（进度刷新会重建 DOM），提交走 capability
          // 授权的 /answer，提交成功后扩展轮询到回答即自动继续。
          const clarInput = root.querySelector('#qiyuan-clar-input') as HTMLInputElement | null;
          const clarSubmit = root.querySelector('#qiyuan-clar-submit') as HTMLButtonElement | null;
          if (clarInput && pendingClarification) {
            clarInput.oninput = () => {
              if (!pendingClarification) return;
              pendingClarification.draft = clarInput.value;
              clarificationDraftById[pendingClarification.questionId] = clarInput.value;
            };
            const submitClarification = async () => {
              const pending = pendingClarification;
              if (!pending || pending.status === 'submitting') return;
              const answer = (clarInput.value || '').trim();
              if (!answer) { pending.errorText = '请输入回答内容'; renderPanel(); return; }
              pending.status = 'submitting';
              pending.errorText = undefined;
              renderPanel();
              try {
                const resp = await fetch(`${url}/answer`, {
                  method: 'POST', credentials: 'omit', redirect: 'error',
                  signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
                  headers: { authorization: `Bearer ${message.capability}`, 'content-type': 'application/json' },
                  body: JSON.stringify({ questionId: pending.questionId, answer }),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                if (pendingClarification === pending) { pendingClarification.status = 'waiting'; pendingClarification.errorText = undefined; renderPanel(); }
              } catch (e) {
                if (pendingClarification === pending) {
                  pendingClarification.status = 'error';
                  pendingClarification.errorText = `提交失败（${e instanceof Error ? e.message : String(e)}），请重试或在对话页回答`;
                  renderPanel();
                }
              }
            };
            if (clarSubmit) clarSubmit.onclick = () => { void submitClarification(); };
            clarInput.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); void submitClarification(); } };
            // 重新渲染后恢复焦点（用户正在输入时进度刷新不打断）
            if (clarHadFocus) {
              clarInput.focus();
              clarInput.setSelectionRange(clarInput.value.length, clarInput.value.length);
            }
          }
          // 停止按钮：第一次点击进入确认态（重渲染后由 stopArmed 保持文案），
          // 确认态下再点才真正 abort；确认后任务走取消终态并照常回传 /result。
          const stopEl = root.querySelector('#qiyuan-stop-btn') as HTMLButtonElement | null;
          if (stopEl) {
            stopEl.onclick = () => {
              if (!stopArmed) {
                stopArmed = true;
                clearTimeout(stopArmTimer);
                stopArmTimer = setTimeout(() => { stopArmed = false; renderPanel(); }, 5000);
                renderPanel();
                return;
              }
              clearTimeout(stopArmTimer);
              stopArmed = false;
              pushTip('用户请求停止，正在收尾…');
              try { abort.abort(); } catch { /* 已停止 */ }
              renderPanel();
            };
          }
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
      let clarificationFailed = false;
      const originalActionSpace = page.actionSpace.bind(page);
      page.actionSpace = () => [...originalActionSpace(), clarificationAction({
        url, capability: message.capability, signal: abort.signal,
        onWaiting: (info) => {
          pushTip('等待用户回答问题…');
          pendingClarification = { ...info, status: 'waiting', draft: clarificationDraftById[info.questionId] || '' };
          renderPanel();
        },
        onAnswered: () => {
          if (pendingClarification) {
            delete clarificationDraftById[pendingClarification.questionId];
            pendingClarification = null;
            renderPanel();
          }
        },
        // Midscene normally replans after action errors. Stop instead: retrying
        // after an uncertain question submission can repeat unrelated actions.
        onFailure: () => { clarificationFailed = !abort.signal.aborted; abort.abort(); },
      })];
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
            // 只采集正文区链接：导航/侧栏/页头页脚里的链接（备案、协议、
            // 无关会话列表等）与任务无关，混进语料会让汇总附上无关链接。
            const CHROME_SEL = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [class*="sidebar" i], [class*="side-bar" i], [id*="sidebar" i], [class*="site-footer" i], [class*="page-footer" i]';
            for (const a of document.querySelectorAll('a[href]')) {
              if (a.closest(CHROME_SEL)) continue;
              let t = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim();
              if (/[⌘⇧⌥⌃]/.test(t)) continue; // 带快捷键提示的多为界面入口
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
      // Read only visible content from the actual platform page. Search-result cards
      // are evidence; links harvested elsewhere are never promoted into records.
      const harvestObservations = async () => {
        if (!observationPlatforms.length) return;
        try {
          const res: any = await page.evaluateJavaScript(`(() => {
            const host = location.hostname.toLowerCase();
            const platform = host.endsWith('xiaohongshu.com') ? '小红书' : host.endsWith('douyin.com') ? '抖音' : host.endsWith('zhihu.com') ? '知乎' : '';
            if (!platform) return [];
            const out = [];
            for (const a of document.querySelectorAll('a[href]')) {
              if (!a.getClientRects().length || a.closest('nav,header,footer,aside')) continue;
              const h = a.href;
              if (platform === '小红书' && !/\\/(explore|discovery\\/item)\\//.test(h)) continue;
              if (platform === '抖音' && !/\\/(video|note)\\//.test(h)) continue;
              if (platform === '知乎' && !/\\/(question\\/\\d+\\/answer|p)\\//.test(h)) continue;
              const card = a.closest('article, section, [class*="card" i], [class*="item" i]') || a;
              const titleNode = card.querySelector('[class*="title" i], h1, h2, h3');
              const title = (titleNode?.innerText || a.innerText || '').replace(/\\s+/g, ' ').trim();
              const author = (card.querySelector('[class*="author" i], [class*="user" i]')?.innerText || '').replace(/\\s+/g, ' ').trim();
              const text = (card.innerText || '').replace(/\\s+/g, ' ');
              const time = (text.match(/(?:\\d+\\s*(?:天|小时|分钟|周|个月|年)前|昨天|今天|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2})/) || [])[0] || '';
              if (title) out.push({ platform, title, author, time, url: h });
              if (out.length >= 50) break;
            }
            if (platform !== '知乎') {
              for (const node of document.querySelectorAll('article h3,section h3,[class*="card" i] [class*="title" i],[class*="item" i] [class*="title" i],[data-e2e*="title"]')) {
                if (!node.getClientRects().length || node.closest('nav,header,footer,aside')) continue;
                const card = node.closest('article,section,li,[class*="card" i],[class*="item" i]');
                const title = (node.innerText || '').trim();
                if (!card || !title || out.some(x => x.title === title)) continue;
                const author = (card.querySelector('[class*="author" i],[data-e2e*="author"]')?.innerText || '').trim();
                const time = ((card.innerText || '').match(/(?:\\d+\\s*(?:天|小时|分钟|周|个月)前|昨天|今天)/) || [''])[0];
                if (author || time) out.push({ platform, title, author, time, url: '' });
                if (out.length >= 50) break;
              }
            }
            return out;
          })()`);
          saveObservations(normalizeObservations(res?.result?.value ?? res?.value ?? res, observationPlatforms));
        } catch { /* page may be navigating */ }
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
        // 模型名同理：只是占位符，真正用哪个模型永远由服务端决定（见下方 delete body.model），
        // 插件自身不含任何模型名，服务端升级模型无需发新版插件。
        modelConfig: { MIDSCENE_MODEL_NAME: 'qiyuan-plugin', MIDSCENE_MODEL_FAMILY: message.modelFamily, MIDSCENE_MODEL_API_KEY: 'not-a-secret', MIDSCENE_MODEL_BASE_URL: `${SITE}/api/browser-plugin/tasks/${message.taskId}/model`, MIDSCENE_MODEL_STREAM_MODE: 'non-stream', MIDSCENE_MODEL_PROTOCOL: 'openai-responses' },
        createOpenAIClient: async (client: any) => new Proxy(client, { get(target, key, receiver) {
          if (key === 'responses') return { create: (body: any, options: any = {}) => {
            if (body.stream) throw new Error('Streaming unsupported');
            delete body.model; // 模型由服务端决定，插件不发送模型名
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
                void harvestObservations();
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
      for (const notice of navigationNotices) {
        steps.push({ kind: '导航', text: notice, status: 'done', ts: Date.now() });
      }
      if (navigationNotices.length) pushTip(navigationNotices[navigationNotices.length - 1]);
      let outcome: unknown;
      // 模型只看截图看不到 href，「带链接」类需求会逼它诚实认输。提前声明：
      // 链接由系统自动提取，它只需浏览阅读，不用记录网址。
      const actPrompt = `${prompt}\n\n（如果完成任务必须先由用户提供缺失信息或作出选择，使用 AskUser 动作提出明确问题，等待答复；不要猜测或继续执行，也不要在同一轮安排其他动作。不要询问密码、验证码或支付凭据。）\n\n（提示：你只需浏览和阅读页面内容；如果任务要求附带原文链接，页面上的真实链接会在任务结束时由系统自动提取，不需要你逐个记录或抄写网址。注意：任务已打开与指令匹配的起始页；后续需要浏览网页时请直接用「浏览」动作打开合适的网站（如百度/必应搜索、任务或对话上下文里提到的站点），主动搜索任务主题；当前页空白不是放弃的理由，禁止因为页面空白就结束任务。站点直达要求：如果任务（或对话上下文）指定了具体网站/平台（如百度、抖音、小红书、B站、知乎、微博、淘宝、X、Reddit 等），必须用「浏览」直接打开该网站官网，并用它的站内搜索功能搜索任务关键词；禁止只用 Google 搜索或 site: 语法代替站内搜索——用户要的是该平台站内 browse 到的热门内容（点赞/热度信息只有站内才看得到）。明确指定百度时只能在百度完成，禁止改用 Google 或其他搜索引擎。后续浏览动作遇到网络错误时，未限定网站就尝试百度/必应备用入口；限定网站就尝试该站备用入口，不要在第一次访问失败后直接结束。任务点名多个网站时逐站完成，不要遗漏。效率要求：搜索结果每页约 10 条，浏览 5–8 页通常就足够；标题和摘要级别的候选即可计入结果，不需要逐个打开帖子核实正文，也不要因为"摘要不够详细""可能是转述"这类理由排除候选——判断是否与此前结果重复只看标题或链接是否相同。候选够数不代表完成；先整理可配对的记录交给服务端验收。连续两页没有新结果时换查询词或切换缺失的平台。）`;
      // 汇总提示：把执行中采集到的真实链接列表交给模型，只允许用这些链接。
      const buildSummaryPrompt = (limitNote: string) => {
        const links = linkCorpusText();
        // 汇总 aiAsk 只能看到最后一页截图，模型物理上不可能凭截图列出几十条
        // 结果——真正的收集成果都在各步「规划」的观察笔记里，必须喂回去。
        const notes = (() => {
          const lines = steps.filter(s => s.text).map((s, i) => `${i + 1}. [${s.kind}] ${s.text}`);
          const text = lines.join('\n');
          return text.length > 9000 ? text.slice(-9000) : text;
        })();
        const evidence = observationPlatforms.length ? `\n已在实际平台页面看到的结构化记录（仅供筛选，未经观察的链接候选不是记录）：${JSON.stringify(observations).slice(0, 20000)}\n优先保留同一卡片 DOM 中的作品网址。仅当本次用户允许该平台不附链接时，该行才可以不带链接；不要为免链接的平台点开分享页。` : '';
        const linkBlock = links
          ? `\n\n以下是执行过程中从页面 DOM 提取的真实链接列表（锚文本 → 网址）。表格每一行的「链接」列必须写成可点击的 markdown 链接（格式：[查看原文](网址)），网址必须只取自下面列表，按锚文本与条目标题的相似度配对，禁止编造或猜测任何不在列表中的链接；列表里找不到合适链接的条目，该行链接列留空并注明"链接缺失"：\n${links}`
          : '\n\n注意：本次未能从页面提取到任何真实链接。如果任务要求附带链接，如实说明无法获取链接，绝对不要编造网址，也不要声称链接会由系统附上。';
        const notesBlock = notes ? `\n\n以下是执行过程中每一步的观察笔记（各步骤看到的结果条目都记录在内）。结果表格的条目必须主要来自这些笔记，绝对不要只凭最后一页看到的内容概述，也不要只给笼统总结：\n${notes}` : '';
        return `用户要求在网页上完成：「${prompt}」。${limitNote}请先根据用户当前要求逐条筛选下方 DOM 链接候选，排除导航、广告和不相关内容，不能将所有链接视为热点；再基于筛选结果、观察笔记和当前页面内容，用中文输出用户想要的结果本身。硬性格式要求：只要任务要求返回若干条结果（如前 N 条/列表/汇总），输出必须是一个 markdown 表格，表头固定为 | 序号 | 标题 | 来源 | 链接 |，一行一条结果，逐条列出、条数尽量满足任务要求，表格不受任何字数限制；表格之外可以补一段 800 字以内的总体说明。示例行：| 1 | Introducing Claude Opus 5 | Anthropic 官网 | [查看原文](https://example.com/post) |。如果笔记里确实没有收集到任何条目，就直接说"暂无有效结果"，不要编造。${notesBlock}${linkBlock}${evidence}`;
      };
      // 确定性兜底：采集到的链接直接作为数据放进结果，不依赖模型自觉。
      const flattenLinks = () => {
        const out: Array<{ t: string; h: string; page: string }> = [];
        for (const p of linkCorpus) {
          for (const l of p.links) {
            out.push({ t: l.t, h: l.h, page: p.title || p.page });
            if (out.length >= 400) return out;
          }
        }
        return out;
      };
      // 模型有时会抛开固定表头自由发挥、丢掉「链接」列。汇总文本生成后做
      // 确定性注入：语料里的锚文本若在汇总中仍以纯文本出现（不是已有
      // markdown 链接的可见文字、该网址也没出现过），就替换成 [标题](网址)。
      const injectLinks = (text: string) => {
        if (!text) return text;
        const entries = flattenLinks()
          .filter(l => l.t && l.t.length >= 6 && !text.includes(`](${l.h})`))
          .sort((a, b) => b.t.length - a.t.length);
        let out = text;
        for (const { t, h } of entries) {
          if (out.includes(`](${h})`)) continue;
          // 模型可能截断或微调长标题，逐级缩短前缀找匹配
          for (const len of [60, 40, 25, 12]) {
            const needle = t.slice(0, len);
            const idx = out.indexOf(needle);
            // 前面是 `[` 说明它已经是某个 markdown 链接的可见文字，不动
            if (idx >= 0 && out[idx - 1] !== '[') {
              out = out.slice(0, idx) + `[${needle}](${h})` + out.slice(idx + needle.length);
              break;
            }
          }
        }
        return out;
      };
      const taskPrompt = observationPlatforms.length ? `${actPrompt}\n\n从同一结果卡片读取作品原文链接。用户明确免链的平台拿不到网址也记录，不要逐条打开分享面板；其他平台按本次指令核对原文。只记录页面实际看到且与任务相关的条目，不要把计划或链接池当作已读结果。` : actPrompt;
      const deadline = AbortSignal.any([abort.signal, AbortSignal.timeout(30 * 60_000)]);
      try {
        // Hard cap: if the agent loop stalls (dead page, wedged navigation),
        // abort so /result is still posted while this context is alive. The
        // backend watchdog (15 min silence) is the fallback if WE die instead.
        const actSignal = deadline;
        outcome = await sdk.executeAction('aiAct', { type: 'aiAct', prompt: taskPrompt }, { requestId: message.taskId, abortSignal: actSignal });
        if (clarificationFailed) throw new Error('无法取得用户答复，已安全停止任务');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (clarificationFailed) {
          outcome = { error: '无法取得用户答复，已安全停止任务。' };
        } else if (abort.signal.aborted) {
          // 用户点了停止：跳过半路汇总，直接终态，别再用 aborted 信号空转。
          outcome = { result: '任务已被用户停止。', partial: true };
        } else {
        // 任何 aiAct 失败（超步数、动作失败、模型放弃等）都不直接把英文报错
        // 糊给用户：先采集一次当前页链接，再基于已完成的工作汇总部分结果。
        pushTip(/planning cycle limit|replanningCycleLimit/i.test(errorMessage) ? '已达步数上限，正在汇总已完成部分…' : '任务中途受挫，正在汇总已完成部分…');
        outcome = { error: errorMessage, partial: true };
        }
      }
      // aiAct 只描述"做了什么动作"；用户要的是页面上的实际内容。
      // 任务成功后追加一次 aiAsk，基于当前页面总结与指令相关的内容。
      if (!abort.signal.aborted && !clarificationFailed && !deadline.aborted) {
        pushTip('正在汇总结果…');
        await harvestLinks(); // 汇总前再采集一次，确保最后一页的链接也在语料库里
        await harvestObservations();
        pushTip(seenHrefs.size ? `已采集到 ${seenHrefs.size} 条页面真实链接，正在汇总…` : '未能从页面提取到链接，正在汇总…');
        try {
          const asked: unknown = await sdk.executeAction('aiAsk', { type: 'aiAsk', prompt: buildSummaryPrompt('') }, { requestId: `${message.taskId}-ask`, abortSignal: deadline });
          const answer = injectLinks(typeof asked === 'string' ? asked : (asked && typeof asked === 'object' ? String((asked as Record<string, unknown>).result ?? (asked as Record<string, unknown>).thought ?? '') : ''));
          if (answer.trim()) {
            outcome = outcome && typeof outcome === 'object' && !Array.isArray(outcome)
              ? { ...(outcome as Record<string, unknown>), error: null, result: answer }
              : { result: answer };
          }
        } catch { /* 摘要失败不阻断，保留原 outcome */ }
      }
      // The server is the sole authority on whether a collection task is complete.
      // Its inactive response leaves unrelated browser tasks on their normal path.
      if (!abort.signal.aborted && !clarificationFailed && !deadline.aborted) {
        type Checkpoint = { active: boolean; ok: boolean; summary: string; result: string; missing_platforms?: string[] };
        const answerText = () => typeof outcome === 'string' ? outcome : String((outcome as Record<string, unknown> | null)?.result ?? '');
        try {
          let check = await request('checkpoint', { links: flattenLinks(), observations, answer: answerText() }, deadline) as Checkpoint;
          let round = 0;
          while (check.active && !check.ok && !deadline.aborted && round < 4) {
            const previous = check.result;
            const missing = check.missing_platforms?.join('、') || check.summary || '尚未满足的要求';
            pushTip(`验收未通过，正在补采：${missing}`);
            try {
              await sdk.executeAction('aiAct', { type: 'aiAct', prompt: `${actPrompt}\n\n这是补采，不要重做已有记录。服务端指出缺口：${missing}。已有结果：\n${previous}\n请针对缺口浏览并记录相关候选。` }, { requestId: `${message.taskId}-retry-${round}`, abortSignal: deadline });
            } catch { if (deadline.aborted) break; }
            await harvestLinks();
            if (deadline.aborted) break;
            try {
              const asked: unknown = await sdk.executeAction('aiAsk', { type: 'aiAsk', prompt: `${buildSummaryPrompt('这是补采后的合并汇总。')}\n\n此前已采集并验收过的记录，必须保留并去重：\n${previous}\n只把符合用户当前要求的候选纳入表格，不得把全部 DOM 链接当作结果。` }, { requestId: `${message.taskId}-merge-${round}`, abortSignal: deadline });
              const text = typeof asked === 'string' ? asked : String((asked as Record<string, unknown> | null)?.result ?? (asked as Record<string, unknown> | null)?.thought ?? '');
              if (text.trim()) outcome = { result: injectLinks(text), partial: true };
            } catch { if (deadline.aborted) break; }
            const merged = [previous, answerText()].filter(Boolean).join('\n\n');
            check = await request('checkpoint', { links: flattenLinks(), observations, answer: merged }, deadline) as Checkpoint;
            if (!check.ok && check.result) {
              check = await request('checkpoint', { links: flattenLinks(), observations, answer: check.result }, deadline) as Checkpoint;
            }
            round++;
          }
          if (check.active) outcome = { result: check.result || answerText() || check.summary, partial: !check.ok };
        } catch {
          if (!abort.signal.aborted) outcome = { result: answerText() || '未能完成验收，请稍后重试。', partial: true };
        }
      } else if (deadline.aborted && !abort.signal.aborted && !clarificationFailed) {
        const current = outcome && typeof outcome === 'object' ? outcome as Record<string, unknown> : {};
        outcome = { result: String(current.result || '已达到时间上限，未能完成采集。'), partial: true };
      }
      // Best-effort terminal artifact: replay video. Rendered locally and kept
      // in the extension's IndexedDB — never uploaded, so the server spends
      // zero storage/bandwidth on videos. The chat page links to the local
      // replay player page instead.
      let videoAvailable = false;
      let videoError: string | undefined;
      const agent = reservation.agent;
      if (agent && !abort.signal.aborted) {
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
      const fullAnswer = typeof outcome === 'string' ? outcome : (outcome as { result?: unknown } | null)?.result;
      if (typeof fullAnswer === 'string' && !fullAnswer.startsWith('data:')) finalOutcome.result = fullAnswer;
      if (navigationNotices.length && typeof finalOutcome.result === 'string' && finalOutcome.result.trim()) {
        finalOutcome.result += `\n\n${navigationNotices.join('\n')}`;
      }
      const byteLen = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).byteLength;
      if (observations.length) finalOutcome.observations = observations.slice(0, 200);
      if (byteLen(finalOutcome) > 200 * 1024) {
        const { result, error, partial } = finalOutcome;
        const text = String(result ?? '');
        finalOutcome = { result: text, error, partial, videoAvailable, steps: finalSteps, totalSteps: steps.length,
          links: harvestedLinks.filter(l => text.includes(l.h)) };
      }
      if (byteLen(finalOutcome) > 200 * 1024) {
        finalOutcome = { partial: true, result: '结果超出对话容量，未能交付完整表格。', videoAvailable };
      }
      // 面板终态：和对话页同一口径（取消/失败/完成 + 结果摘要）。
      // 注意必须判值非空而非键存在——aiAct 的 outcome 固定带 error:null。
      const outcomeError = (finalOutcome as Record<string, unknown>).error;
      panelState = clarificationFailed ? 'failed' : abort.signal.aborted ? 'cancelled' : (outcomeError != null && outcomeError !== '' ? 'failed' : 'done');
      panelResultText = String((finalOutcome as Record<string, unknown>).result ?? outcomeError ?? '').slice(0, 2000);
      postProgress(true); // flush the complete timeline before the terminal post
      await observationQueue;
      await request('result', { outcome: finalOutcome, cancelled: abort.signal.aborted && !clarificationFailed });
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
