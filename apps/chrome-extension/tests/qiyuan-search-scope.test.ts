// @rstest-environment jsdom
import { expect, it } from '@rstest/core';
import { searchScope } from '../src/extension/popup/qiyuan-search-scope';
function scan(path: string, body: string) {
  document.body.innerHTML = body;
  for (const node of document.body.querySelectorAll('*'))
    Object.defineProperty(node, 'getClientRects', { value: () => [1] });
  return new Function(
    'document',
    'location',
    searchScope + `return candidates('a').map(a=>a.textContent);`,
  )(document, new URL(path, 'https://www.xiaohongshu.com'));
}
const cards =
  '<input id="search-input" value="AI"><section class="search-result-container"><a>AI笔记</a><aside><a>足球推荐</a></aside></section><a>装修推荐</a>';
it('does not harvest the homepage even after typing a keyword', () =>
  expect(scan('/explore', cards)).toBeNull());
it('skips loading, mismatched queries and unidentified result containers', () => {
  expect(
    scan(
      '/search_result?keyword=AI',
      cards.replace('<section', '<section aria-busy="true"'),
    ),
  ).toBeNull();
  expect(scan('/search_result?keyword=足球', cards)).toBeNull();
  expect(scan('/search_result?keyword=AI', '<a>旧卡片</a>')).toBeNull();
});
it('reads only links inside the search result, excluding embedded recommendations', () =>
  expect(scan('/search_result?keyword=AI', cards)).toEqual(['AI笔记']));
