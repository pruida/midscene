import { describe, expect, it } from '@rstest/core';
import {
  collectionPlatforms,
  createMissingLinkGuard,
  normalizeObservations,
  observationBatches,
} from '../src/extension/popup/qiyuan-observations';

describe('qiyuan observations', () => {
  it('limits collection to current relevant platform tasks', () => {
    expect(
      collectionPlatforms('浏览小红书、抖音和知乎的AI知识库热门文章'),
    ).toEqual(['小红书', '抖音', '知乎']);
    expect(collectionPlatforms('打开设置【对话上下文：浏览小红书】')).toEqual(
      [],
    );
  });
  it('keeps observed example without requiring a URL and rejects other platforms', () => {
    expect(
      normalizeObservations(
        [
          {
            platform: '小红书',
            title: 'AI一键替换元素，轻松复刻热门视频',
            author: 'AI知识库',
            time: '1天前，662赞',
            url: '',
          },
          { platform: '知乎', title: '不属于本次平台的记录' },
        ],
        ['小红书'],
      ),
    ).toEqual([
      {
        platform: '小红书',
        title: 'AI一键替换元素，轻松复刻热门视频',
        author: 'AI知识库',
        time: '1天前，662赞',
        url: '',
      },
    ]);
  });
  it('blocks only after distinct linkless Douyin screens and resets on link or navigation', () => {
    const guard = createMissingLinkGuard();
    const card = (title: string, url = '') => [
      { platform: '抖音', title, author: '', time: '', url },
    ];
    const page = 'https://www.douyin.com/search/test';
    expect(guard(page, card('结果屏一'))).toBe(false);
    expect(guard(page, card('结果屏一'))).toBe(false);
    expect(guard(page, card('结果屏二'))).toBe(false);
    expect(guard(page, card('结果屏三'))).toBe(true);
    expect(guard(page, card('作品', 'https://www.douyin.com/video/123'))).toBe(
      false,
    );
    expect(guard(page, card('结果屏一'))).toBe(false);
    expect(guard('https://www.douyin.com/search/other', card('结果屏二'))).toBe(
      false,
    );
  });
  it('splits UTF-8 records within progress budget', () => {
    const records = Array.from({ length: 100 }, (_, i) => ({
      platform: '小红书',
      title: `测试文章${i}${'长标题'.repeat(30)}`,
      author: '',
      time: '',
      url: '',
    }));
    const batches = observationBatches(records);
    expect(batches.flat()).toEqual(records);
    expect(
      batches.every(
        (batch) =>
          new TextEncoder().encode(
            JSON.stringify({ tip: '正在保存已读记录', observations: batch }),
          ).length < 8192,
      ),
    ).toBe(true);
  });
});
