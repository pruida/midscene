// @rstest-environment jsdom
import { expect, it } from '@rstest/core';
import { zhihuCards } from '../src/extension/popup/qiyuan-zhihu';
function scan(url: string, html: string) {
  document.body.innerHTML = html;
  for (const a of document.querySelectorAll('a'))
    Object.defineProperty(a, 'getClientRects', { value: () => [1] });
  return new Function('document', 'location', 'platform', zhihuCards)(
    document,
    new URL(url),
    '知乎',
  ).items;
}
it('does not use a date in the title or edit time as publication time', () => {
  const [x] = scan(
    'https://www.zhihu.com/search?q=AI',
    '<div class="SearchResult-Card"><div class="ContentItem-title"><a href="https://zhuanlan.zhihu.com/p/123">AI日报 2026-11-21</a></div><div class="ContentItem-time">编辑于 2026-11-22</div></div>',
  );
  expect(x.time).toBe('');
});
it('reads the publication metadata and named author of an article', () => {
  const [x] = scan(
    'https://zhuanlan.zhihu.com/p/123',
    '<article><h1>AI日报</h1><div class="AuthorInfo-name"><a>甲</a></div><meta itemprop="datePublished" content="2026-11-20T10:00:00+08:00"></article>',
  );
  expect([x.author, x.time]).toEqual(['甲', '2026-11-20']);
});
it('picks only the answer named by the current URL', () => {
  const [x] = scan(
    'https://www.zhihu.com/question/1/answer/2',
    '<h1 class="QuestionHeader-title">AI研究进展</h1><div class="AnswerItem" data-id="3"><span class="AuthorInfo-name">乙</span></div><div class="AnswerItem" data-id="2"><span class="AuthorInfo-name">甲</span><div class="ContentItem-time">发布于 2026-11-21</div></div>',
  );
  expect([x.author, x.time]).toEqual(['甲', '2026-11-21']);
});
