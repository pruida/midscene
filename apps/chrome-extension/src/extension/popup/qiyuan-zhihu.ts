export const zhihuCards = String.raw`
if (platform === '知乎') {
  const items = [];
  if (/安全验证.*知乎/.test(document.title) || /^\s*\{.{0,800}"code"\s*:\s*40362/s.test((document.body?.textContent || '').slice(0,1000))) return {url:location.href,items,blocked:true};
  const work = href => { if (!href) return ''; try { const u = new URL(href,location.href); return u.protocol === 'https:' && ((u.host==='zhuanlan.zhihu.com' && /^\/p\/\d+\/?$/.test(u.pathname)) || (u.host==='www.zhihu.com' && /^\/question\/\d+\/answer\/\d+\/?$/.test(u.pathname))) ? u.href : ''; } catch {return '';} };
  const text = el => (el?.textContent || '').trim();
  const emit = (root,title,url) => {
    if (!title || !url) return;
    const author = root.querySelector('.AuthorInfo-name a,.AuthorInfo-name,[itemprop="author"] [itemprop="name"],meta[name="author"]');
    const published = root.querySelector('[itemprop="datePublished"],meta[property="article:published_time"]');
    const stamp = root.querySelector('.ContentItem-time, .Post-Time, .Post-Header .time');
    const raw = published?.getAttribute('content') || published?.getAttribute('datetime') || text(published) || ((text(stamp)+' '+(stamp?.querySelector('[data-tooltip]')?.getAttribute('data-tooltip')||'')).match(/发布于\s*([^，；\s]+(?:前)?)/)||[])[1] || '';
    const time = (raw.match(/^(\d{4}-\d{2}-\d{2}|昨天|今天|\d+\s*(?:天|小时|分钟)前)/)||[])[1] || '';
    items.push({platform,title,url,author:author?.getAttribute('content') || text(author),time});
  };
  if (location.pathname==='/search') {
    for(const a of document.querySelectorAll('.SearchResult-Card .ContentItem-title a[href],.List-item .ContentItem-title a[href]')) {
      if(!a.getClientRects().length || a.closest('aside,nav')) continue;
      emit(a.closest('.ContentItem,.SearchResult-Card,.List-item'),text(a),work(a.href));
      if(items.length>=50) break;
    }
  } else if(work(location.href)) {
    if(location.hostname==='zhuanlan.zhihu.com') {
      const root=document.querySelector('article.Post-Main,article.Post-MainPage,.Post-Main,article');
      if(root) emit(root,text(root.querySelector('h1')),location.href);
    } else {
      const id=location.pathname.match(/\/answer\/(\d+)/)?.[1];
      for(const root of document.querySelectorAll('.AnswerItem')) {
        const self=root.querySelector('meta[itemprop="url"],link[itemprop="url"]');
        const url=work(self?.getAttribute('content') || self?.getAttribute('href') || '');
        if(root.getAttribute('data-id')===id || (url && new URL(url).pathname===location.pathname)) {emit(root,text(document.querySelector('h1.QuestionHeader-title')),location.href); break;}
      }
    }
  }
  return {url:location.href,items};
}`;
