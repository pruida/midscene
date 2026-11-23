// Kept as page-side JavaScript: the extension evaluates this in the target tab.
export const searchScope = String.raw`
let root = document;
const xhs = /(^|\.)xiaohongshu\.com$/i.test(location.hostname);
const excluded = 'nav,header,footer,aside,[class*="recommend" i],[data-testid*="recommend" i],[aria-label*="推荐"], [hidden],[aria-hidden="true"]';
if (xhs) {
  const current = new URL(location.href);
  const term = (current.searchParams.get('keyword') || current.searchParams.get('q') || '').trim();
  const input = document.querySelector('#search-input, input[type="search"], input[placeholder*="搜索"]');
  if (!/^\/search_result\/?$/.test(current.pathname) || !term || (input && input.value.trim() !== term)) return null;
  root = Array.from(document.querySelectorAll('#search-result, .search-result-container, .search-result, [data-testid="search-results"]')).find(el => el.getClientRects().length && !el.closest(excluded));
  if (!root || root.matches('[aria-busy="true"]') || Array.from(root.querySelectorAll('[aria-busy="true"], [role="progressbar"], .loading, .skeleton')).some(el => el.getClientRects().length)) return null;
}
const candidates = selector => Array.from(root.querySelectorAll(selector)).filter(el => !xhs || (!el.closest(excluded) && el.getClientRects().length));
`;
