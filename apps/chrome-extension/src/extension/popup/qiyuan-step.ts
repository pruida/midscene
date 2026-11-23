import { timeline } from './qiyuan-timeline';

// Keep evidence to the public origin: never transmit a tab's path, query or title.
export function safeChildOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port ||
        !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(u.hostname) ||
        /\.(local|localhost|internal)$/.test(u.hostname)) return null;
    return u.origin;
  } catch { return null; }
}

export async function resolveChildTab(
  ids: number[], parent: number, get: (id: number) => Promise<chrome.tabs.Tab>,
  wait: () => Promise<void>, attempts = 12,
) {
  if (ids.length !== 1) return { outcome: 'ambiguous' as const, count: ids.length };
  for (let i = 0; i < attempts; i++) {
    let child: chrome.tabs.Tab;
    try { child = await get(ids[0]); } catch { return { outcome: 'blocked' as const }; }
    if (child.id !== ids[0] || child.openerTabId !== parent) return { outcome: 'blocked' as const };
    const raw = child.pendingUrl || child.url || '';
    if (!raw || raw === 'about:blank') {
      if (i + 1 < attempts) await wait();
      continue;
    }
    const origin = safeChildOrigin(raw);
    return origin ? { outcome: 'switched' as const, id: ids[0], origin } : { outcome: 'blocked' as const };
  }
  return { outcome: 'pending' as const };
}
export function startInputProbe() {
  const state = globalThis as any;
  state.qkInputProbe?.();
  const events: string[] = [];
  const listener = (event: Event) => events.push(`${event.type}:${event.isTrusted ? 'trusted' : 'untrusted'}`);
  const types = ['pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  types.forEach(type => window.addEventListener(type, listener, true));
  state.qkInputProbe = () => {
    types.forEach(type => window.removeEventListener(type, listener, true));
    delete state.qkInputProbe;
    return events;
  };
}
export function finishInputProbe() {
  return (globalThis as any).qkInputProbe?.() || [];
}
export function receiptFor(seq: number, action: string, result: any) {
  if (
    result &&
    ['ok', 'error', 'blocked'].includes(result.status) &&
    Array.isArray(result.rows) &&
    (action !== 'observe' ||
      result.status !== 'ok' ||
      (result.page &&
        typeof result.page.url === 'string' &&
        Array.isArray(result.page.elements)))
  )
    return { ...result, seq };
  return {
    seq,
    status: 'error',
    rows: [],
    detail: '浏览器未返回有效结果',
    uncertain: ['click', 'fill'].includes(action),
  };
}

// A navigation can destroy the injected execution context before Chrome returns
// its result. Only retry the read-only observation, never a side-effecting action.
export async function observeWithRetry(
  run: () => Promise<any>,
  wait: () => Promise<void>,
  attempts = 3,
) {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      last = receiptFor(0, 'observe', await run());
      if (last.status === 'ok' || last.detail !== '浏览器未返回有效结果')
        return last;
    } catch (e) {
      last = { status: 'error', rows: [], detail: String(e).slice(0, 200) };
    }
    if (i + 1 < attempts) await wait();
  }
  return last;
}
import { applyGeneral } from './qiyuan-general';
const paths: Record<string, [string, RegExp]> = {
  百度: ['www.baidu.com', /^\/s$/],
  Google: ['www.google.com', /^\/search$/],
  Reddit: ['www.reddit.com', /^\/search\/?$/],
  小红书: ['www.xiaohongshu.com', /^\/search_result$/],
  抖音: ['www.douyin.com', /^\/search\/.+/],
  知乎: ['www.zhihu.com', /^\/search$/],
};
function allowed(platform: string, raw: string) {
  const u = new URL(raw),
    p = paths[platform];
  return (
    !!p &&
    u.origin === 'https://' + p[0] &&
    !u.username &&
    !u.password &&
    p[1].test(u.pathname)
  );
}
// This function is serialized by Chrome. Do not close over extension state.
function readPage(platform: string, expected: string, scroll: boolean) {
  const page = new URL(location.href);
  const safe = new URL(page.origin + page.pathname);
  for (const k of ['q', 'keyword', 'type', 'wd'])
    for (const v of page.searchParams.getAll(k)) safe.searchParams.append(k, v);
  const pageUrl = safe.href;
  if (page.origin !== new URL(expected).origin)
    return { status: 'ok', rows: [], pageUrl: page.origin };
  if (['百度', 'Google', 'Reddit'].includes(platform)) {
    const selector =
      platform === '百度'
        ? '#content_left h3 a[href]'
        : platform === 'Google'
          ? '#search a[href]:has(h3)'
          : 'main a[href*="/comments/"],shreddit-post a[slot="title"]';
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(selector),
    ).filter((a) => a.getClientRects().length);
    if (scroll) {
      links.at(-1)?.scrollIntoView({ block: 'end' });
      window.scrollBy(0, innerHeight);
      return { status: 'ok', rows: [], pageUrl };
    }
    const rows = links.flatMap((a) => {
      const u = new URL(a.href);
      const title = (a.querySelector('h3')?.textContent || a.innerText).trim();
      return title && u.protocol === 'https:' && !u.username && !u.password
        ? [
            {
              platform,
              title: title.slice(0, 300),
              url: u.href,
              author: '',
              time: '',
            },
          ]
        : [];
    });
    return { status: 'ok', rows: rows.slice(0, 100), pageUrl };
  }
  const selectors: Record<string, string> = {
    小红书: 'section.note-item',
    抖音: '#search-result-container li',
    知乎: '.SearchResult-Card .ContentItem-title,.List-item .ContentItem-title',
  };
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>(selectors[platform]),
  ).filter(
    (c) =>
      c.getClientRects().length &&
      !c.closest('aside,nav,[class*="recommend" i]'),
  );
  if (scroll) {
    cards.at(-1)?.scrollIntoView({ block: 'end' });
    window.scrollBy(0, innerHeight);
    return { status: 'ok', rows: [], pageUrl };
  }
  const rows = [];
  for (const c of cards) {
    for (const a of Array.from(
      c.querySelectorAll<HTMLAnchorElement>('a[href]'),
    )) {
      const u = new URL(a.href);
      const valid =
        platform === '小红书'
          ? u.hostname === 'www.xiaohongshu.com' &&
            /^\/(search_result|explore|discovery\/item)\/[a-f0-9]{24}\/?$/i.test(
              u.pathname,
            )
          : platform === '抖音'
            ? u.hostname === 'www.douyin.com' &&
              /^\/(video|note)\/\d+\/?$/.test(u.pathname)
            : (u.hostname === 'zhuanlan.zhihu.com' &&
                /^\/p\/\d+\/?$/.test(u.pathname)) ||
              (u.hostname === 'www.zhihu.com' &&
                /^\/question\/\d+\/answer\/\d+\/?$/.test(u.pathname));
      if (!valid || u.protocol !== 'https:') continue;
      const lines = a.innerText.split(/\n+/).map((x) => x.trim());
      const title =
        platform === '小红书'
          ? c.querySelector<HTMLElement>('.title')?.innerText
          : platform === '抖音'
            ? lines
                .slice(
                  0,
                  lines.findIndex((x) => x.startsWith('@')) < 0
                    ? lines.length
                    : lines.findIndex((x) => x.startsWith('@')),
                )
                .filter((x) => !/^([\d:.万亿wW+]+|合集)$/.test(x))
                .join(' ')
            : a.innerText;
      if (title?.trim()) {
        rows.push({
          platform,
          title: title.trim().slice(0, 300),
          url: u.href,
          author: '',
          time: '',
        });
        break;
      }
    }
    if (rows.length >= 100) break;
  }
  return { status: 'ok', rows, pageUrl };
}
export function installQiyuanBridge() {
  let active: { id: string; cap: string; abort: AbortController } | undefined;
  const listen = (
    m: any,
    s: chrome.runtime.MessageSender,
    reply: (r: any) => void,
  ) => {
    if (s.id !== chrome.runtime.id || s.tab || m?.channel !== 'qiyuan-verified')
      return false;
    if (m.type === 'cancel') {
      if (active?.id === m.taskId && active?.cap === m.capability)
        active?.abort.abort();
      reply({ ok: true });
      return false;
    }
    if (
      m.type !== 'run' ||
      active ||
      !/^使用浏览器插件/.test(m.text || '') ||
      !/^[-\w]{1,128}$/.test(m.taskId) ||
      !/^[-\w.~]{16,4096}$/.test(m.capability)
    ) {
      reply({ ok: false, error: '无效请求或已有任务运行' });
      return false;
    }
    const run = {
      id: m.taskId,
      cap: m.capability,
      abort: new AbortController(),
    };
    active = run;
    reply({ ok: true, started: true, taskId: m.taskId });
    const post = async (path: string, data: unknown, signal?: AbortSignal) => {
      const res = await fetch(
        'https://ai.qykaiwu.cn/api/browser-plugin/tasks/' + run.id + '/' + path,
        {
          method: 'POST',
          credentials: 'omit',
          redirect: 'error',
          headers: {
            Authorization: 'Bearer ' + run.cap,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(105000)])
            : AbortSignal.timeout(10000),
        },
      );
      const value = await res.json();
      if (!res.ok) throw new Error(value.error || '执行机通信失败');
      return value;
    };
    void (async () => {
      const trace = timeline(run.id);
      let tab: number | undefined,
        expected = '',
        seq = 0,
        receipt: any = null;
      let verifiedBody = '';
      let visualFrameShared = false;
      const children = new Set<number>();
      let clickParent: number | undefined;
      const child = (t: chrome.tabs.Tab) => {
        if (clickParent !== undefined && t.openerTabId === clickParent && t.id !== undefined)
          children.add(t.id);
      };
      chrome.tabs.onCreated.addListener(child);
      try {
        tab = (await chrome.tabs.create({ url: 'about:blank', active: true }))
          .id;
        if (!tab || tab === m.targetTabId)
          throw new Error('无法建立独立任务页');
        for (;;) {
          run.abort.signal.throwIfAborted();
          const a = await post('step', { receipt }, run.abort.signal);
          if (!Number.isSafeInteger(a.seq) || a.seq !== ++seq)
            throw new Error('执行机序号无效');
          trace.log(a, '开始');
          // A child may appear while the planner is thinking. Never dispatch an
          // action planned against the parent after observing such a transition.
          if (children.size) {
            const candidates = Array.from(children);
            visualFrameShared = false;
            const result = await resolveChildTab(candidates, tab!, id => chrome.tabs.get(id), async () => {
              run.abort.signal.throwIfAborted();
              await new Promise(r => setTimeout(r, 250));
            });
            // A second child may have appeared during the wait: never guess.
            if (children.size !== candidates.length) {
              receipt = { seq, status: 'error', rows: [], detail: '检测到多个任务子标签页，未执行过期动作', evidence: { kind: 'tab_transition', outcome: 'ambiguous', count: children.size } };
              continue;
            }
            if (result.outcome === 'switched') {
              tab = result.id;
              children.clear();
              clickParent = undefined;
              receipt = { seq, status: 'error', rows: [], detail: '任务已切换标签页，原计划未执行，请重新观察', evidence: { kind: 'tab_transition', outcome: 'switched', origin: result.origin } };
            } else {
              // Keep unresolved children as a barrier; never resume parent actions.
              receipt = { seq, status: 'error', rows: [], detail: '任务子标签页未安全就绪，未执行过期动作', evidence: { kind: 'tab_transition', outcome: result.outcome } };
            }
            continue;
          }
          if (a.action === 'finish') {
            trace.log(a, a.partial ? '部分完成' : '完成');
            break;
          }
          try {
            if (a.mode === 'general') {
              const u = new URL(a.origin);
              if (
                u.protocol !== 'https:' ||
                u.origin !== a.origin ||
                u.port ||
                !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(u.hostname) ||
                /\.(local|localhost|internal)$/.test(u.hostname)
              )
                throw Error('目标不是公开 HTTPS 站点');
              if (a.action === 'batch_read') {
                const rows: any[] = [],
                  reports: any[] = [],
                  seen = new Set<string>();
                let bytes = 0;
                for (const raw of (a.batch_urls || []).slice(0, 12)) {
                  const site = new URL(raw);
                  if (
                    site.protocol !== 'https:' ||
                    site.username ||
                    site.password ||
                    site.port ||
                    !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(site.hostname) ||
                    /\.(local|localhost|internal)$/.test(site.hostname)
                  )
                    throw Error('无效批量目的地');
                  let count = 0,
                    stale = 0;
                  try {
                    await chrome.tabs.update(tab, { url: site.href });
                    for (let screen = 0; screen < 16 && stale < 3; screen++) {
                      await new Promise((r) => setTimeout(r, 1500));
                      run.abort.signal.throwIfAborted();
                      const [r] = await chrome.scripting.executeScript({
                        target: { tabId: tab },
                        func: (origin: string) => {
                          if (
                            location.origin !== origin ||
                            document.querySelector(
                              'input[type=password],input[autocomplete=one-time-code]',
                            )
                          )
                            return [];
                          const out = [];
                          for (const a of Array.from(
                            document.querySelectorAll<HTMLAnchorElement>(
                              'a[href]',
                            ),
                          )) {
                            if (
                              !a.getClientRects().length ||
                              a.closest('nav,header,aside,footer,[hidden]') ||
                              a.protocol !== 'https:' ||
                              a.username ||
                              a.password ||
                              a.href.length > 1200
                            )
                              continue;
                            const c = a.closest(
                              'article,li,section.note-item,[data-testid="cellInnerDiv"],.cards-content,.SearchResult-Card',
                            );
                            const title = (
                              a.innerText ||
                              c?.querySelector(
                                'h3,h2,.title,[data-testid="tweetText"]',
                              )?.textContent ||
                              a.getAttribute('aria-label') ||
                              ''
                            )
                              .trim()
                              .slice(0, 200);
                            if (title.length < 4) continue;
                            out.push({
                              url: a.href,
                              title,
                              time:
                                c
                                  ?.querySelector('time')
                                  ?.getAttribute('datetime') || '',
                              snippet: (c?.textContent || '')
                                .trim()
                                .slice(0, 250),
                            });
                            if (out.length >= 150) break;
                          }
                          window.scrollBy(0, innerHeight * 1.7);
                          return out;
                        },
                        args: [site.origin],
                      });
                      let added = 0;
                      for (const item of r.result || []) {
                        if (seen.has(item.url)) continue;
                        const row = { ...item, source: raw };
                        const cost =
                          new TextEncoder().encode(JSON.stringify(row)).length +
                          2;
                        if (bytes + cost > 215000 || rows.length >= 500) break;
                        rows.push(row);
                        seen.add(item.url);
                        bytes += cost;
                        count++;
                        added++;
                      }
                      stale = added ? 0 : stale + 1;
                      trace.log(
                        a,
                        site.hostname + ' 已取 ' + count + ' 个候选',
                      );
                      if (
                        count >=
                          Math.ceil((a.target * 2) / a.batch_urls.length) +
                            12 ||
                        bytes >= 214000 ||
                        rows.length >= 500
                      )
                        break;
                    }
                  } catch (e) {
                    run.abort.signal.throwIfAborted();
                  }
                  reports.push({ site: raw, count });
                }
                receipt = { seq, status: 'ok', rows, reports };
                continue;
              }
              if (a.action === 'navigate') {
                if (new URL(a.url).origin !== a.origin)
                  throw Error('目标超出授权范围');
                await chrome.tabs.update(tab, { url: a.url });
                await new Promise((r) => setTimeout(r, 1500));
                receipt = { seq, status: 'ok', rows: [], batchReady: true };
              } else if (a.action === 'save_local') {
                if (!verifiedBody) throw Error('没有已读回的正文，未生成文件');
                const file = '浏览器任务-' + run.id + '.txt';
                const blob = new Blob([verifiedBody], {
                  type: 'text/plain;charset=utf-8',
                });
                const object = URL.createObjectURL(blob);
                try {
                  const id = await chrome.downloads.download({
                    url: object,
                    filename: file,
                    conflictAction: 'uniquify',
                    saveAs: false,
                  });
                  let completed = false;
                  for (let i = 0; i < 120; i++) {
                    const [item] = await chrome.downloads.search({ id });
                    if (
                      item?.state === 'complete' &&
                      item.exists &&
                      item.fileSize === blob.size
                    ) {
                      receipt = {
                        seq,
                        status: 'ok',
                        rows: [],
                        evidence: {
                          kind: 'download_complete',
                          filename: item.filename.split(/[\\/]/).pop(),
                          bytes: item.fileSize,
                        },
                      };
                      completed = true;
                      break;
                    }
                    if (item?.state === 'interrupted') break;
                    await new Promise((r) => setTimeout(r, 250));
                  }
                  if (!completed) throw Error('本机下载未确认完成');
                } finally {
                  URL.revokeObjectURL(object);
                }
                continue;
              } else if (a.action === 'visual_observe') {
                receipt = null;
                const inject = async (kind: string, id = '') => {
                  const [r] = await chrome.scripting.executeScript({ target: { tabId: tab! }, func: applyGeneral, args: [a.origin, kind, id, ''] });
                  return r?.result as any;
                };
                // Re-query by the requested label before spending a turn on an image.
                // Return IDs only; the planner still chooses the next action.
                if (a.missing_control) {
                  const [found] = await chrome.scripting.executeScript({ target: { tabId: tab! }, func: applyGeneral, args: [a.origin, 'observe', '', a.missing_control] });
                  if (found?.result?.status === 'blocked' || found?.result?.page?.elements?.length) {
                    visualFrameShared = false;
                    receipt = receiptFor(seq, a.action, found.result);
                    if (receipt.status === 'ok') receipt.detail = `按名称重新读取到 ${receipt.page.elements.length} 个结构化候选，未截图`;
                    continue;
                  }
                }
                let shared = false;
                for (let attempt = 0; attempt < 4 && !shared; attempt++) {
                  visualFrameShared = false;
                  const before = await inject('visual_prepare');
                  if (before?.status === 'blocked') { receipt = receiptFor(seq, a.action, before); break; }
                  if (!before || typeof before.id !== 'string' || !before.id || typeof before.url !== 'string' || new URL(before.url).origin !== a.origin || ![before.width, before.height].every(n => Number.isInteger(n) && n > 0 && n <= 2000)) throw Error('截图准备未得到有效页面回执，未截图');
                  const debuggee = { tabId: tab! };
                  let image: any;
                  await chrome.debugger.attach(debuggee, '1.3');
                  try {
                    image = await chrome.debugger.sendCommand(debuggee, 'Page.captureScreenshot', { format: 'jpeg', quality: 60, captureBeyondViewport: false });
                  } finally { await chrome.debugger.detach(debuggee).catch(() => {}); }
                  const verified = await inject('visual_verify', before.id);
                  if (verified?.status === 'blocked') { receipt = receiptFor(seq, a.action, verified); break; }
                  if (verified?.status !== 'ok') {
                    if (attempt < 3) await new Promise(r => setTimeout(r, 200));
                    continue;
                  }
                  if (!image?.data || image.data.length > 1400000 || before.width > 2000 || before.height > 2000) throw Error('截图超过视觉兜底大小上限');
                  visualFrameShared = true;
                  shared = true;
                  receipt = { seq, status: 'ok', rows: [], page: { url: before.url, elements: [], links: [], text: '', visual: { ...before, data: image.data, consent: true } } };
                }
                if (!shared && !receipt) throw Error('截图后的页面校验未通过，未共享截图');
                continue;
              } else if (a.action === 'visual_click') {
                if (!visualFrameShared) throw Error('当前任务没有经过校验的截图');
                visualFrameShared = false;
                clickParent = tab;
                const [r] = await chrome.scripting.executeScript({ target: { tabId: tab! }, func: applyGeneral, args: [a.origin, 'visual_click', a.visual_id, JSON.stringify({ x: a.x, y: a.y })] });
                if (r?.result?.status !== 'ok' || r.result.point?.x !== a.x || r.result.point?.y !== a.y) {
                  receipt = receiptFor(seq, 'click', r?.result);
                  continue;
                }
                if (new URL((await chrome.tabs.get(tab!)).url || '').origin !== a.origin) throw Error('页面已变化，未点击');
                if (children.size) throw Error('任务子标签页已出现，未执行过期动作');
                await chrome.scripting.executeScript({ target: { tabId: tab! }, func: startInputProbe });
                const debuggee = { tabId: tab! };
                await chrome.debugger.attach(debuggee, '1.3');
                try {
                  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, buttons: 0, pointerType: 'mouse' });
                  await new Promise(r => setTimeout(r, 150));
                  if (children.size) throw Error('任务子标签页已出现，未执行过期动作');
                  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
                  await new Promise(r => setTimeout(r, 100));
                  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
                } finally { await chrome.debugger.detach(debuggee).catch(() => {}); }
                let events: string[] = [];
                let probeError = '';
                try {
                  const [probe] = await chrome.scripting.executeScript({ target: { tabId: tab! }, func: finishInputProbe });
                  events = Array.isArray(probe?.result) ? probe.result.slice(0, 20) : [];
                } catch (e) {
                  // A click may navigate and destroy the probe context. The CDP dispatch
                  // already succeeded; the following observe must verify the result.
                  probeError = String(e).slice(0, 120);
                }
                receipt = { seq, status: 'ok', rows: [], evidence: { kind: 'trusted_input', events, probe_error: probeError } };
                continue;
              } else if (
                ['click', 'fill', 'move', 'observe', 'scroll'].includes(
                  a.action,
                )
              ) {
                if (a.action === 'observe') {
                  // Menus and dialogs often mount after the click dispatch returns.
                  // Let the current page settle before deciding JSON cannot express it.
                  await new Promise((r) => setTimeout(r, 800));
                  const result = await observeWithRetry(
                    async () => {
                      const [r] = await chrome.scripting.executeScript({
                        target: { tabId: tab! },
                        func: applyGeneral,
                        args: [
                          a.origin,
                          a.action,
                          a.target || '',
                          a.text || '',
                        ],
                      });
                      return r?.result;
                    },
                    () => new Promise((r) => setTimeout(r, 500)),
                  );
                  receipt = { ...result, seq };
                  continue;
                }
                if (a.action === 'click') {
                  clickParent = tab;
                }
                const [res] = await chrome.scripting.executeScript({
                  target: { tabId: tab },
                  func: applyGeneral,
                  args: [a.origin, a.action, a.target || '', a.text || ''],
                });
                if (a.action === 'move') {
                  const point = res.result?.point;
                  if (!point) throw Error('目标坐标不可用');
                  const debuggee = { tabId: tab };
                  await chrome.debugger.attach(debuggee, '1.3');
                  try {
                    if (
                      new URL((await chrome.tabs.get(tab)).url || '').origin !==
                      a.origin
                    )
                      throw Error('页面已变化');
                    await chrome.debugger.sendCommand(
                      debuggee,
                      'Input.dispatchMouseEvent',
                      {
                        type: 'mouseMoved',
                        x: point.x,
                        y: point.y,
                        buttons: 0,
                      },
                    );
                  } finally {
                    await chrome.debugger.detach(debuggee).catch(() => {});
                  }
                  receipt = { seq, status: 'ok', rows: [] };
                } else if (a.action === 'click' && res?.result?.point) {
                  const point = res.result.point;
                  a.point = point;
                  await chrome.scripting.executeScript({ target: { tabId: tab! }, func: startInputProbe });
                  const debuggee = { tabId: tab! };
                  await chrome.debugger.attach(debuggee, '1.3');
                  try {
                    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0, pointerType: 'mouse' });
                    await new Promise(r => setTimeout(r, 150));
                    if (children.size) throw Error('任务子标签页已出现，未执行过期动作');
                    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
                    await new Promise(r => setTimeout(r, 100));
                    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
                  } finally { await chrome.debugger.detach(debuggee).catch(() => {}); }
                  let events: string[] = [];
                  try {
                    const [probe] = await chrome.scripting.executeScript({ target: { tabId: tab! }, func: finishInputProbe });
                    events = Array.isArray(probe?.result) ? probe.result.slice(0, 20) : [];
                  } catch { /* The following observe verifies clicks that navigate. */ }
                  receipt = { seq, status: 'ok', rows: [], evidence: { kind: 'trusted_input', events } };
                } else receipt = receiptFor(seq, a.action, res?.result);
                if (
                  a.action === 'fill' &&
                  res?.result?.evidence?.kind === 'editor_readback'
                )
                  verifiedBody = res.result.evidence.body;
              } else throw Error('通用动作无效');
              continue;
            }
            if (a.action === 'navigate') {
              if (!allowed(a.platform, a.url))
                throw new Error('目标超出支持范围');
              expected = a.url;
              await chrome.tabs.update(tab, { url: expected });
            } else if (
              ['collect', 'scroll'].includes(a.action) &&
              allowed(a.platform, expected)
            ) {
              const out = await chrome.scripting.executeScript({
                target: { tabId: tab },
                func: readPage,
                args: [a.platform, expected, a.action === 'scroll'],
              });
              receipt = receiptFor(seq, a.action, out[0]?.result);
              if (a.action === 'collect') continue;
            } else throw new Error('不支持的执行机动作');
            await new Promise((r) => setTimeout(r, 1800));
            if (a.action === 'navigate')
              receipt = { seq, status: 'ok', rows: [] };
          } catch (e) {
            receipt = {
              seq,
              status: 'error',
              rows: [],
              detail: String(e).slice(0, 200),
              uncertain:
                a.mode === 'general' && ['click', 'fill', 'visual_click'].includes(a.action),
            };
          } finally {
            trace.log(
              a,
              receipt?.uncertain
                ? '结果待核实'
                : receipt?.status === 'ok'
                  ? '已执行'
                  : '未完成',
              receipt,
            );
            if (tab) await trace.frame(tab, a);
          }
        }
      } catch (e) {
        trace.log(
          { action: 'finish' },
          run.abort.signal.aborted ? '已取消' : '失败',
        );
        await post('result', {
          cancelled: run.abort.signal.aborted,
          outcome: { error: String(e).slice(0, 300) },
        }).catch(() => {});
      } finally {
        chrome.tabs.onCreated.removeListener(child);
        await trace.end();
        active = undefined;
        if (tab && !verifiedBody) await chrome.tabs.remove(tab).catch(() => {});
      }
    })();
    return false;
  };
  chrome.runtime.onMessage.addListener(listen);
  return () => chrome.runtime.onMessage.removeListener(listen);
}
