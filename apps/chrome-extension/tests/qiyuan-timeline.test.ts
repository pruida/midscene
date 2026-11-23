import { describe, expect, it } from '@rstest/core';
import { describeAction } from '../src/extension/popup/qiyuan-timeline';

describe('browser task timeline details', () => {
  it('shows visual coordinates and target instead of a generic task label', () => {
    expect(describeAction({ action: 'visual_click', x: 441, y: 104, control: { label: '视觉点击' } }))
      .toBe('鼠标点击（441, 104）“视觉点击”');
    expect(describeAction({ action: 'visual_observe', missing_control: '新建' }))
      .toBe('截图定位“新建”');
  });
  it('identifies structured actions and the pending result being read', () => {
    expect(describeAction({ action: 'click', control: { label: '云文档' } })).toBe('点击“云文档”');
    expect(describeAction({ action: 'observe', pending: { label: '视觉点击' } })).toBe('读取操作结果“视觉点击”');
    expect(describeAction({ action: 'navigate', url: 'https://www.feishu.cn/?private=1' })).toBe('打开页面 www.feishu.cn');
  });
});
