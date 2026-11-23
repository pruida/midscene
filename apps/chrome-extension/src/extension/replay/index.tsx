/// <reference types="chrome" />
// Local replay player: videos are rendered and stored by the extension itself
// (IndexedDB), never uploaded to the server. Opened as replay.html?task=<id>.
import { getReplayVideo } from '../replay-store';

const root = document.getElementById('root') ?? document.body;

function showMessage(text: string) {
  root.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText =
    'font-family:system-ui,sans-serif;color:#444;max-width:520px;margin:80px auto;padding:0 16px;line-height:1.7;text-align:center;';
  box.textContent = text;
  root.appendChild(box);
}

async function main() {
  const taskId = new URLSearchParams(location.search).get('task') || '';
  if (!/^[\w-]{1,128}$/.test(taskId)) {
    showMessage('无效的回放链接。');
    return;
  }
  try {
    const blob = await getReplayVideo(taskId);
    if (!blob || blob.size === 0) {
      showMessage(
        '该任务的过程视频不存在或已被清理。视频只保存在本机浏览器中，最多保留最近几个任务，且清理浏览器数据后不可恢复。',
      );
      return;
    }
    const url = URL.createObjectURL(blob);
    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'max-width:960px;margin:24px auto;padding:0 16px;font-family:system-ui,sans-serif;';
    const title = document.createElement('div');
    title.style.cssText = 'color:#666;font-size:13px;margin-bottom:8px;';
    title.textContent = '过程回放（视频保存在本机浏览器，未上传服务器）';
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.src = url;
    video.style.cssText = 'width:100%;border-radius:8px;background:#000;';
    wrap.appendChild(title);
    wrap.appendChild(video);
    root.appendChild(wrap);
  } catch (error) {
    showMessage(
      `读取回放失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

void main();
