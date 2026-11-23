import { afterEach, describe, expect, it, rs } from '@rstest/core';
import {
  navigateWithFailover,
  selectStartUrls,
} from '../src/extension/popup/qiyuan-navigation';

afterEach(() => rs.unstubAllGlobals());

function mockChrome(
  options: {
    fail?: (attempt: number) => string | undefined;
    loading?: (attempt: number) => boolean;
  } = {},
) {
  let errorListener:
    | ((details: { tabId: number; frameId: number; error: string }) => void)
    | undefined;
  const visited: string[] = [];
  const addListener = rs.fn((listener: typeof errorListener) => {
    errorListener = listener;
  });
  const removeListener = rs.fn((listener: typeof errorListener) => {
    if (errorListener === listener) errorListener = undefined;
  });
  const update = rs.fn(async (_tabId: number, { url }: { url: string }) => {
    visited.push(url);
    const error = options.fail?.(visited.length);
    if (error)
      queueMicrotask(() => errorListener?.({ tabId: 7, frameId: 0, error }));
    return { id: 7, status: 'loading', url };
  });
  const get = rs.fn(async () => ({
    id: 7,
    status: options.loading?.(visited.length) ? 'loading' : 'complete',
    url: visited[visited.length - 1],
  }));
  rs.stubGlobal('chrome', {
    tabs: { update, get },
    webRequest: { onErrorOccurred: { addListener, removeListener } },
  });
  return { visited, addListener, removeListener, update, get };
}

describe('initial-site selection', () => {
  it('honors an explicit Baidu search and never includes Google', () => {
    const urls = selectStartUrls('帮我在百度查下最新热点新闻');
    expect(urls[0]).toBe('https://www.baidu.com/');
    expect(
      urls.every((url) => new URL(url).hostname.endsWith('baidu.com')),
    ).toBe(true);
    expect(urls.some((url) => url.includes('google'))).toBe(false);
  });

  it('uses mainland-safe defaults without Google', () => {
    expect(selectStartUrls('查一下最新热点新闻')).toEqual([
      'https://www.baidu.com/',
      'https://www.bing.com/',
    ]);
  });

  it('retains explicit Google with ordered failover', () => {
    expect(selectStartUrls('用 Google 搜索今日新闻')).toEqual([
      'https://www.google.com/',
      'https://www.bing.com/',
      'https://www.baidu.com/',
    ]);
  });

  it('preserves existing direct-platform routing', () => {
    expect(selectStartUrls('在哔哩哔哩查找热门视频')).toEqual([
      'https://www.bilibili.com/',
    ]);
  });
});

describe('initial-navigation failover', () => {
  it('switches on a main-frame network error and cleans up listeners', async () => {
    const chrome = mockChrome({
      fail: (attempt) =>
        attempt === 1 ? 'net::ERR_CONNECTION_TIMED_OUT' : undefined,
    });
    const onFallback = rs.fn();
    const tab = await navigateWithFailover(
      7,
      ['https://www.google.com/', 'https://www.bing.com/'],
      new AbortController().signal,
      {
        timeoutMs: 30,
        pollMs: 1,
        settleMs: 1,
        onFallback,
      },
    );
    expect(tab.url).toBe('https://www.bing.com/');
    expect(chrome.visited).toEqual([
      'https://www.google.com/',
      'https://www.bing.com/',
    ]);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0].from).toBe('https://www.google.com/');
    expect(onFallback.mock.calls[0][0].to).toBe('https://www.bing.com/');
    expect(chrome.addListener).toHaveBeenCalledTimes(2);
    expect(chrome.removeListener).toHaveBeenCalledTimes(2);
  });

  it('treats a loading timeout as retryable and remains bounded', async () => {
    const chrome = mockChrome({ loading: (attempt) => attempt === 1 });
    const onFallback = rs.fn();
    await navigateWithFailover(
      7,
      ['https://www.baidu.com/', 'https://www.bing.com/'],
      new AbortController().signal,
      {
        timeoutMs: 8,
        pollMs: 2,
        settleMs: 1,
        onFallback,
      },
    );
    expect(chrome.visited).toHaveLength(2);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(chrome.removeListener).toHaveBeenCalledTimes(2);
  });

  it('fails clearly only after every candidate has failed', async () => {
    const chrome = mockChrome({ fail: () => 'net::ERR_NAME_NOT_RESOLVED' });
    await expect(
      navigateWithFailover(
        7,
        ['https://www.google.com/', 'https://www.bing.com/'],
        new AbortController().signal,
        {
          timeoutMs: 20,
          pollMs: 1,
          settleMs: 1,
        },
      ),
    ).rejects.toThrow('已尝试全部备用入口');
    expect(chrome.visited).toHaveLength(2);
    expect(chrome.removeListener).toHaveBeenCalledTimes(2);
  });

  it('does not mistake a redirected navigation abort for a network failure', async () => {
    const chrome = mockChrome({
      fail: (attempt) => (attempt === 1 ? 'net::ERR_ABORTED' : undefined),
    });
    const onFallback = rs.fn();
    await navigateWithFailover(
      7,
      ['https://www.baidu.com/', 'https://www.bing.com/'],
      new AbortController().signal,
      {
        timeoutMs: 20,
        pollMs: 1,
        settleMs: 1,
        onFallback,
      },
    );
    expect(chrome.visited).toEqual(['https://www.baidu.com/']);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('honors cancellation without trying another destination', async () => {
    const chrome = mockChrome();
    const controller = new AbortController();
    controller.abort();
    await expect(
      navigateWithFailover(
        7,
        ['https://www.google.com/', 'https://www.bing.com/'],
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(chrome.visited).toHaveLength(0);
  });
});
