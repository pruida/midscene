// Runs inside the target tab, not the extension window.
export const douyinCards = String.raw`
if (platform === '抖音') {
  const out = [];
  const visible = el => el && el.getClientRects().length && !el.closest('[hidden],[aria-hidden="true"],aside,nav');
  const text = el => (el?.innerText || el?.textContent || '').trim();
  const work = href => {
    try { const u = new URL(href, location.href);
      if (u.protocol !== 'https:' || !['www.douyin.com','douyin.com'].includes(u.host)) return '';
      if (/^\/(video|note)\/\d+\/?$/.test(u.pathname)) return u.href;
      if (/^\/(?:jingxuan\/)?search\//.test(u.pathname) && /^\d+$/.test(u.searchParams.get('modal_id') || '')) return u.href;
    } catch {} return '';
  };
  const titleSel = '[data-e2e="video-desc"],[data-e2e="search-card-desc"],[data-e2e="video-title"],h1,h2,h3,[class*="title" i]';
  const emit = (card,url) => {
    const title = text(Array.from(card.querySelectorAll(titleSel)).find(visible));
    if (title.length < 6 || /^(合集\s*[·：:]|作者声明)/.test(title)) return;
    out.push({platform,title,author:text(card.querySelector('[data-e2e*="author-name"], [class*="author-name"]')),time:text(card.querySelector('time,[data-e2e*="publish-time"],[class*="publish-time"]')),url});
  };
  const current = work(location.href);
  if (current) {
    const layers = Array.from(document.querySelectorAll('[role="dialog"],[data-e2e="feed-active-video"],[data-e2e="video-detail"]')).filter(visible);
    const layer = layers.find(el => layers.every(other => other.contains(el)));
    if (layer) emit(layer,current);
  } else if (/^\/(?:jingxuan\/)?search\//.test(location.pathname)) {
    for (const a of document.querySelectorAll('#search-result-container li a[href]')) {
      const url = work(a.href);
      if (!url || !visible(a)) continue;
      const lines = (a.innerText || '').split(/\n+/).map(x=>x.trim()).filter(Boolean);
      const by = lines.findIndex(x=>x.startsWith('@'));
      const title = (by < 0 ? lines : lines.slice(0,by)).filter(x=>!/^([\d:.万亿wW+]+|合集)$/.test(x)).join(' ');
      if (title.length < 6 || title.startsWith('作者声明') || out.some(x=>x.url===url)) continue;
      out.push({platform,title,author:by<0?'':lines[by].slice(1),time:lines.find(x=>/^(昨天|今天|前天|\d+\s*(分钟|小时|天|周|个月)前)$/.test(x)) || '',url});
    }
    if (out.length) return {url:location.href,items:out};
    const sel = '[data-e2e="search-card"],[data-e2e="search-result-card"],li:has([data-e2e="video-desc"]),li:has(a[href*="/video/"]),article';
    for (const card of document.querySelectorAll(sel)) {
      if (!visible(card) || card.querySelector(sel)) continue;
      const urls = new Set(Array.from(card.querySelectorAll('a[href]'), a => work(a.href)).filter(Boolean));
      emit(card, urls.size === 1 ? [...urls][0] : '');
      if (out.length >= 50) break;
    }
  }
  return {url:location.href,items:out};
}
`;
