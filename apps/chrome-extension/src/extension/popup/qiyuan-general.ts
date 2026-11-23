// Executed in Chrome's isolated world. Targets belong to one observation only.
export function applyGeneral(
  origin: string,
  kind: string,
  target: string,
  value: string,
) {
  if (location.origin !== origin) {
    return {
      status: kind === 'observe' ? 'ok' : 'blocked', rows: [],
      detail: 'navigation_changed',
      page: { url: location.origin, elements: [], links: [], text: `页面已跳转。如需读取当前页面，请使用 ${location.origin} 作为 origin 再次 observe。` },
    };
  }
  const state = globalThis as any;
  const sensitive = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type=password],input[autocomplete=one-time-code],input[autocomplete^="cc-"]')).some(el => el.getClientRects().length > 0 && !el.closest('[hidden],[aria-hidden=true]'));
  const binding = () => JSON.stringify([location.href, innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY, document.body?.innerHTML]);
  if (kind === 'visual_prepare') {
    if (!document.body) return { status: 'blocked', rows: [], detail: '页面尚未加载，未截图' };
    if (sensitive()) return { status: 'blocked', rows: [], detail: '当前页面不满足截图条件，未截图' };
    const id = crypto.randomUUID();
    state.qkVisual = { id, binding: binding(), at: Date.now() };
    return { id, width: innerWidth, height: innerHeight, url: location.origin + location.pathname };
  }
  if (kind === 'visual_verify' || kind === 'visual_click') {
    const saved = state.qkVisual;
    const reason = sensitive() ? '页面含敏感输入' : !saved ? '截图记录不存在' : saved.id !== target ? '截图编号不匹配' : Date.now() - saved.at > 30000 ? '截图超过30秒' : saved.binding !== binding() ? '页面与截图绑定不一致' : '';
    if (reason) {
      state.qkVisual = undefined;
      if (kind === 'visual_click') return { status: 'blocked', rows: [], detail: `${reason}，未操作` };
      throw Error('截图已陈旧或页面敏感，未操作');
    }
    if (kind === 'visual_verify') return { status: 'ok', rows: [] };
    state.qkVisual = undefined;
    const p = JSON.parse(value);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) throw Error('无效视觉坐标');
    const el = document.elementFromPoint(p.x, p.y) as HTMLElement | null;
    if (!el || el.closest('input,textarea,[contenteditable],a,form') || /提交|发布|删除|确认|购买|支付|转账|授权|登录|submit|publish|delete|confirm|purchase|pay|authorize|sign.?in/i.test(el.innerText || el.getAttribute('aria-label') || '')) throw Error('视觉兜底不操作输入、链接或高风险控件');
    return { status: 'ok', rows: [], point: { x: p.x, y: p.y } };
  }
  if (kind === 'scroll') {
    window.scrollBy(0, innerHeight);
    return { status: 'ok', rows: [] };
  }
  const box = globalThis as unknown as { qkTargets?: Map<string, HTMLElement> };
  if (kind === 'click' || kind === 'fill' || kind === 'move') {
    const el = box.qkTargets?.get(target);
    box.qkTargets = undefined;
    if (!el || !el.isConnected || !el.getClientRects().length)
      throw Error('页面已变化，未操作');
    if (kind === 'move') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect(),
        x = r.left + r.width / 2,
        y = r.top + r.height / 2;
      if (!el.contains(document.elementFromPoint(x, y)))
        throw Error('目标被遮挡，未移动鼠标');
      return { status: 'ok', rows: [], point: { x, y } };
    }
    if (kind === 'fill' && el.isContentEditable) {
      if (el.closest('[contenteditable=false]') || el.innerText.trim())
        throw Error('仅允许向空白富文本区域插入正文，不覆盖已有内容');
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('insertText', false, value);
      const body = el.innerText.trim();
      if (body !== value.trim())
        throw Error('编辑器未能读回预期正文，未确认写入');
      return {
        status: 'ok',
        rows: [],
        evidence: {
          kind: 'editor_readback',
          body,
          length: Array.from(body).length,
        },
      };
    }
    if (
      kind === 'click' &&
      el instanceof HTMLAnchorElement &&
      el.target === '_blank'
    ) {
      if (el.origin !== origin) throw Error('链接已变化');
      setTimeout(() => location.assign(el.href), 0);
    } else if (kind === 'click' && !(el instanceof HTMLAnchorElement)) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !el.contains(hit)) throw Error('目标被遮挡，未点击');
      return { status: 'ok', rows: [], point: { x, y } };
    } else if (kind === 'click') el.click();
    else if (
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement && ['text', 'search'].includes(el.type))
    ) {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else throw Error('不支持此输入框');
    return { status: 'ok', rows: [] };
  }
  if (
    Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[type=password],input[autocomplete=one-time-code]',
      ),
    ).some((input) => input.getClientRects().length > 0)
  )
    return { status: 'blocked', rows: [], detail: '请手动完成登录，不采集登录页面' };
  if (!document.body)
    return { status: 'error', rows: [], detail: '页面正文尚未加载，请稍后重试' };
  const targets = new Map<string, HTMLElement>();
  box.qkTargets = targets;
  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href]'),
  )
    .filter(
      (a) =>
        a.getClientRects().length &&
        !a.closest('nav,aside,footer,[hidden],[aria-hidden=true]') &&
        a.protocol === 'https:' &&
        !a.username &&
        !a.password &&
        a.href.length <= 1500,
    )
    .map((a) => ({
      label: (a.innerText || a.getAttribute('aria-label') || '')
        .trim()
        .slice(0, 200),
      href: a.href,
    }))
    .filter((a) => a.label.length >= 3)
    .slice(0, 80);
  const elements = [];
  // When a planner reports a missing control, search the current DOM before
  // applying the normal list budget. Never create a target from coordinates.
  const needle = value.trim().toLowerCase();
  if (needle && sensitive()) return { status: 'blocked', rows: [], detail: '页面含敏感输入，未操作' };
  const relevant = (el: HTMLElement) => {
    if (!needle) return true;
    const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim().toLowerCase();
    return label === needle || (label.length >= 2 && [`“${label}”`, `「${label}」`, `"${label}"`].some(quoted => needle.includes(quoted)));
  };
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>(
      'button,a[href],textarea,input[type=text],input[type=search],[contenteditable=true],[contenteditable=plaintext-only],[role=button],[aria-haspopup],[role=menuitem],[tabindex="0"]',
    ),
  )) {
    if (
      !el.getClientRects().length ||
      el.closest('[hidden],[aria-hidden=true]')
    )
      continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const label = (
      el.getAttribute('aria-label') ||
      el.innerText ||
      el.textContent ||
      el.getAttribute('placeholder') ||
      (el.isContentEditable ? '可编辑正文' : '')
    )
      .trim()
      .slice(0, 160);
    if (!label || /密码|验证码|支付|银行卡|password|otp/i.test(label) || !relevant(el)) continue;
    if (el instanceof HTMLAnchorElement && el.origin !== origin) continue;
    const id = crypto.randomUUID();
    targets.set(id, el);
    elements.push({
      id,
      label,
      kind: el.tagName,
      href:
        el instanceof HTMLAnchorElement && el.protocol === 'https:'
          ? el.href
          : undefined,
    });
    if (elements.length >= 240) break;
  }
  const standardCount = elements.length;
  if (standardCount < 240) {
    const known = new Set(targets.values());
    const appended = new Set(known);
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(el => {
      if (known.has(el) || !el.getClientRects().length || el.closest('[hidden],[aria-hidden=true],button,a,[role=button],[role=menuitem]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    });
    const append = (el: HTMLElement, textLeaf: boolean) => {
      const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();
      if (!label || label.length > 120 || /密码|验证码|支付|银行卡|password|otp/i.test(label)) return;
      if (!relevant(el)) return;
      if (textLeaf && (el.children.length || label.length < 2 || label.length > 60)) return;
      const id = crypto.randomUUID();
      targets.set(id, el);
      appended.add(el);
      elements.push({ id, label: label.slice(0, 160), kind: el.tagName });
    };
    for (const el of candidates) {
      if (getComputedStyle(el).cursor === 'pointer') append(el, false);
      if (elements.length >= 240) break;
    }
    for (const el of candidates) {
      if (!appended.has(el)) append(el, true);
      if (elements.length >= 240) break;
    }
  }
  return {
    status: 'ok',
    rows: [],
    page: {
      url: location.origin + location.pathname,
      text: (document.body.innerText || document.body.textContent || '').slice(0, 6000),
      elements,
      links,
    },
  };
}
