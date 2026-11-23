import { saveReplayVideo } from '../replay-store';
const labels: Record<string, string> = {
  navigate: '打开页面',
  observe: '读取页面',
  collect: '提取记录',
  scroll: '滚动页面',
  move: '移动鼠标',
  click: '点击',
  fill: '填写',
  visual_observe: '截图定位',
  visual_click: '鼠标点击',
  finish: '结束',
};
function short(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 40) : '';
}
export function describeAction(a: any) {
  const label = short(a?.control?.label || a?.missing_control);
  if (['visual_click', 'move', 'click'].includes(a?.action)) {
    const point = a.point || a;
    if (Number.isFinite(point?.x) && Number.isFinite(point?.y))
      return `${labels[a.action]}（${Math.round(point.x)}, ${Math.round(point.y)}）${label ? `“${label}”` : ''}`;
  }
  if (label && ['click', 'fill', 'visual_observe'].includes(a?.action))
    return `${labels[a.action]}“${label}”`;
  if (a?.action === 'observe' && a.pending)
    return `读取操作结果${short(a.pending.label) ? `“${short(a.pending.label)}”` : ''}`;
  if (a?.action === 'navigate') {
    try { return `打开页面 ${new URL(a.url).hostname}`; } catch { /* Use the generic label. */ }
  }
  return labels[a?.action] || `执行任务 ${short(a?.action) || '未知动作'}`;
}
export function timeline(task: string) {
  document.getElementById('qk-live-steps')?.remove();
  const panel = document.createElement('section');
  panel.id = 'qk-live-steps';
  panel.style.cssText =
    'position:fixed;inset:0;background:white;color:#202124;padding:16px;overflow:auto;z-index:99999';
  document.body.append(panel);
  const heading = document.createElement('h3'),
    info = document.createElement('p'),
    list = document.createElement('ol');
  heading.textContent = '任务执行步骤';
  info.textContent = '回放仅保存在本机；登录页、输入页面不录制。';
  panel.append(heading, info, list);
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  const chunks: Blob[] = [];
  let size = 0;
  let last = '正在接单';
  function draw(image?: ImageBitmap) {
    if (!ctx) return;
    ctx.fillStyle = '#18212c';
    ctx.fillRect(0, 0, 800, 480);
    if (image) ctx.drawImage(image, 0, 0, 800, 445);
    ctx.fillStyle = '#fff';
    ctx.font = '18px sans-serif';
    ctx.fillText(last, 12, 469, 776);
  }
  try {
    draw();
    stream = canvas.captureStream(2);
    recorder = new MediaRecorder(stream, { videoBitsPerSecond: 350000 });
    recorder.ondataavailable = (e) => {
      chunks.push(e.data);
      size += e.data.size;
      if (size > 14e6 && recorder?.state === 'recording') recorder.stop();
    };
    recorder.start(1000);
  } catch {
    info.textContent = '本机不支持录像；步骤仍会显示。';
  }
  const tick = setInterval(() => {
    if (ctx) {
      ctx.fillRect(0, 0, 1, 1);
    }
  }, 500);
  return {
    log(a: any, status: string, receipt?: any) {
      const input = receipt?.evidence?.kind === 'trusted_input'
        ? `；页面事件：${receipt.evidence.events?.join('→') || '未收到'}${receipt.evidence.probe_error ? `；事件读取失败：${String(receipt.evidence.probe_error).slice(0, 120)}` : ''}`
        : '';
      const detail = receipt?.detail ? `：${String(receipt.detail).slice(0, 120)}` : '';
      last = `${new Date().toLocaleTimeString()} · ${describeAction(a)} · ${status}${input}${detail}`;
      const li = document.createElement('li');
      li.textContent = last;
      list.append(li);
      li.scrollIntoView({ block: 'nearest' });
      draw();
    },
    async frame(tab: number, a: any) {
      if (
        !recorder ||
        recorder.state !== 'recording' ||
        a.mode === 'general' ||
        !['collect', 'scroll'].includes(a.action)
      )
        return;
      const t = { tabId: tab };
      let attached = false;
      try {
        await chrome.debugger.attach(t, '1.3');
        attached = true;
        const inspect = (await chrome.debugger.sendCommand(
          t,
          'Runtime.evaluate',
          {
            expression: `({url:location.href,sensitive:!!document.querySelector('input[type=password],input[autocomplete=one-time-code],iframe,textarea:focus,input:focus')})`,
            returnByValue: true,
          },
        )) as any;
        const page = inspect?.result?.value;
        if (
          !page ||
          page.sensitive ||
          !/^https:\/\/(www\.)?(douyin\.com\/search\/|zhihu\.com\/search\?|xiaohongshu\.com\/search_result\?|google\.com\/search\?|baidu\.com\/s\?|reddit\.com\/search\/)/.test(
            page.url,
          )
        )
          return;
        const r = (await chrome.debugger.sendCommand(
          t,
          'Page.captureScreenshot',
          { format: 'jpeg', quality: 45 },
        )) as any;
        const check = await chrome.tabs.get(tab);
        if (check.url !== page.url) return;
        const im = await createImageBitmap(
          await (await fetch('data:image/jpeg;base64,' + r.data)).blob(),
        );
        draw(im);
        im.close();
      } catch {
        /* Step captions remain available when screenshot capture is unavailable. */
      } finally {
        if (attached) await chrome.debugger.detach(t).catch(() => {});
      }
    },
    async end() {
      clearInterval(tick);
      try {
        if (recorder?.state === 'recording')
          await new Promise<void>((resolve) => {
            recorder!.onstop = () => resolve();
            recorder!.stop();
          });
        if (chunks.some((b) => b.size)) {
          await saveReplayVideo(
            task,
            new Blob(chunks, { type: recorder?.mimeType || 'video/webm' }),
          );
          const btn = document.createElement('button');
          btn.textContent = '回看本次任务（本机）';
          btn.onclick = () =>
            void chrome.tabs.create({
              url:
                chrome.runtime.getURL('replay.html') +
                '?task=' +
                encodeURIComponent(task),
            });
          panel.append(btn);
        }
      } catch {
        info.textContent = '回放未能保存。';
      } finally {
        stream?.getTracks().forEach((t) => t.stop());
      }
    },
  };
}
