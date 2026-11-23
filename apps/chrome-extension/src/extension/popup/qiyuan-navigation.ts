export interface NavigationFallback {
  from: string;
  to: string;
  reason: string;
}

interface FailoverOptions {
  timeoutMs?: number;
  pollMs?: number;
  settleMs?: number;
  onFallback?: (fallback: NavigationFallback) => void;
}

const SITE_STARTS: Array<[RegExp, string[]]> = [
  // An explicitly named platform remains authoritative. In particular, a
  // Baidu request must never be silently converted into a Google search.
  [/百度|baidu/i, ['https://www.baidu.com/', 'https://m.baidu.com/']],
  [
    /谷歌|google/i,
    [
      'https://www.google.com/',
      'https://www.bing.com/',
      'https://www.baidu.com/',
    ],
  ],
  [/必应|bing/i, ['https://www.bing.com/', 'https://www.baidu.com/']],
  [/抖音|douyin/i, ['https://www.douyin.com/']],
  [/小红书|xiaohongshu|redbook/i, ['https://www.xiaohongshu.com/']],
  [/哔哩哔哩|bilibili|b站/i, ['https://www.bilibili.com/']],
  [/知乎/i, ['https://www.zhihu.com/']],
  [/微博/i, ['https://weibo.com/']],
  [/淘宝|天猫/i, ['https://www.taobao.com/']],
  [/京东/i, ['https://www.jd.com/']],
  [/reddit/i, ['https://www.reddit.com/']],
  [/x\.com|twitter|推特/i, ['https://x.com/']],
  [/youtube|油管/i, ['https://www.youtube.com/']],
  [/github/i, ['https://github.com/']],
];

export function selectStartUrls(userIntent: string): string[] {
  const match = SITE_STARTS.find(([pattern]) => pattern.test(userIntent));
  // Mainland-safe default. Google remains available only when the user names it,
  // with disclosed fallback if that network path is unavailable.
  return [
    ...(match?.[1] ?? ['https://www.baidu.com/', 'https://www.bing.com/']),
  ];
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Navigate one controlled tab through a bounded list of initial-page candidates. */
export async function navigateWithFailover(
  tabId: number,
  urls: string[],
  signal: AbortSignal,
  options: FailoverOptions = {},
): Promise<chrome.tabs.Tab> {
  if (!urls.length) throw new Error('缺少任务起始页');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 200;
  // A Chrome network-error event can race with tabs.status === 'complete'.
  const settleMs = options.settleMs ?? 100;

  for (let index = 0; index < urls.length; index += 1) {
    signal.throwIfAborted();
    const url = urls[index];
    let networkError = '';
    const onError = (details: {
      tabId: number;
      frameId: number;
      error: string;
    }) => {
      if (
        details.tabId === tabId &&
        details.frameId === 0 &&
        details.error !== 'net::ERR_ABORTED'
      ) {
        networkError = details.error;
      }
    };
    chrome.webRequest.onErrorOccurred.addListener(onError, {
      urls: ['http://*/*', 'https://*/*'],
      tabId,
      types: ['main_frame'],
    });
    try {
      await chrome.tabs.update(tabId, { url, active: true });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        signal.throwIfAborted();
        if (networkError) throw new Error(networkError);
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          await delay(settleMs);
          signal.throwIfAborted();
          if (networkError) throw new Error(networkError);
          return tab;
        }
        await delay(pollMs);
      }
      throw new Error('TIMEOUT');
    } catch (error) {
      signal.throwIfAborted();
      const next = urls[index + 1];
      if (!next) break;
      options.onFallback?.({
        from: url,
        to: next,
        reason:
          networkError ||
          (error instanceof Error ? error.message : String(error)),
      });
    } finally {
      chrome.webRequest.onErrorOccurred.removeListener(onError);
    }
  }
  throw new Error('起始页无法访问，已尝试全部备用入口。请检查网络后重试。');
}
