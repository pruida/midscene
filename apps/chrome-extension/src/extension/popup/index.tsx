/// <reference types="chrome" />
import { useEffect } from 'react';
import { installQiyuanBridge } from './qiyuan';
import './index.less';

// The side panel is only a host for the qiyuan bridge: tasks arrive from the
// chat page (ai.qykaiwu.cn), run on an auto-created tab, and report back to
// the conversation. There is intentionally nothing to click or configure here.
export function PlaygroundPopup() {
  useEffect(() => installQiyuanBridge(), []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: 24,
        textAlign: 'center',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>
        欢迎使用启源开物浏览器助手
      </div>
      <div style={{ fontSize: 13, color: '#888', lineHeight: 1.8 }}>
        请在 ai.qykaiwu.cn 对话中
        <br />
        发送「使用浏览器插件」开头的指令
        <br />
        助手会自动新建标签页执行并回传结果
      </div>
    </div>
  );
}
