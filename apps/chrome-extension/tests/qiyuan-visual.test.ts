// @rstest-environment jsdom
// Synthetic DOM only. No account pages or real screenshots.
import { describe, expect, it } from '@rstest/core';
import { applyGeneral } from '../src/extension/popup/qiyuan-general';

describe('visual observation binding', () => {
  it('clicks a custom div with no standard button', () => {
    document.body.innerHTML = '<div id="custom">展开菜单</div>';
    const el = document.getElementById('custom')!;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => el });
    let clicked = false;
    el.addEventListener('click', () => { clicked = true; });
    const view = applyGeneral(location.origin, 'visual_prepare', '', '') as any;
    const ready = applyGeneral(location.origin, 'visual_click', view.id, JSON.stringify({ x: 10, y: 10 })) as any;
    expect(ready).toMatchObject({ status: 'ok', point: { x: 10, y: 10 } });
    expect(clicked).toBe(false); // Trusted CDP input is dispatched by qiyuan-step.
    expect(applyGeneral(location.origin, 'visual_click', view.id, '{"x":10,"y":10}')).toMatchObject({ status: 'blocked' });
  });
  it('blocks changed DOM and sensitive screens before capture', () => {
    document.body.innerHTML = '<div>菜单</div>';
    const view = applyGeneral(location.origin, 'visual_prepare', '', '') as any;
    document.body.innerHTML = '<div>另一个页面</div>';
    expect(() => applyGeneral(location.origin, 'visual_verify', view.id, '')).toThrow();
    document.body.innerHTML = '<input type="password">';
    const password = document.querySelector('input')!;
    Object.defineProperty(password, 'getClientRects', { configurable: true, value: () => [{}] });
    expect(applyGeneral(location.origin, 'visual_prepare', '', '')).toMatchObject({status: 'blocked'});
  });
  it('reports a stale visual click instead of an empty browser result', () => {
    document.body.innerHTML = '<div>菜单</div>';
    const view = applyGeneral(location.origin, 'visual_prepare', '', '') as any;
    document.body.innerHTML = '<div>动态状态已变化</div>';
    expect(applyGeneral(location.origin, 'visual_click', view.id, '{"x":10,"y":10}')).toMatchObject({
      status: 'blocked', detail: '页面与截图绑定不一致，未操作'
    });
  });
  it('exposes pointer-only controls as JSON and prepares trusted coordinates', () => {
    document.body.innerHTML = '<div id="new" style="cursor:pointer">新建</div>';
    const el = document.getElementById('new')!;
    Object.defineProperty(el, 'getClientRects', { configurable: true, value: () => [{}] });
    Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 }) });
    const page = applyGeneral(location.origin, 'observe', '', '') as any;
    const target = page.page.elements.find((item: any) => item.label === '新建');
    expect(target).toBeTruthy();
    Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 10, top: 20, width: 100, height: 40 }) });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => el });
    let clicked = false;
    el.addEventListener('click', () => { clicked = true; });
    expect(applyGeneral(location.origin, 'click', target.id, '')).toMatchObject({
      status: 'ok', point: { x: 60, y: 40 }
    });
    expect(clicked).toBe(false);
  });
  it('still exposes pointer-only controls after 80 standard controls', () => {
    document.body.innerHTML = `${Array.from({ length: 80 }, (_, i) => `<button>标准控件${i}</button>`).join('')}<div id="new" style="cursor:pointer">新建</div>`;
    for (const el of Array.from(document.body.querySelectorAll('button, #new'))) {
      Object.defineProperty(el, 'getClientRects', { configurable: true, value: () => [{}] });
      Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 }) });
    }
    const page = applyGeneral(location.origin, 'observe', '', '') as any;
    expect(page.page.elements).toHaveLength(81);
    expect(page.page.elements.at(-1)).toMatchObject({ label: '新建' });
  });
  it('still exposes semantic menu controls after 80 standard controls', () => {
    document.body.innerHTML = `${Array.from({ length: 80 }, (_, i) => `<button>标准控件${i}</button>`).join('')}<div role="menuitem">新建空白文档</div>`;
    for (const el of Array.from(document.body.querySelectorAll('button, [role=menuitem]'))) {
      Object.defineProperty(el, 'getClientRects', { configurable: true, value: () => [{}] });
      Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 }) });
    }
    const page = applyGeneral(location.origin, 'observe', '', '') as any;
    expect(page.page.elements.at(-1)).toMatchObject({ label: '新建空白文档' });
  });
  it('recovers a named target beyond the observation budget without clicking', () => {
    document.body.innerHTML = '<button>普通项</button>'.repeat(245) + '<button>展开目录</button>';
    for (const el of document.querySelectorAll('button')) {
      Object.defineProperty(el, 'getClientRects', { value: () => [{}] });
      Object.defineProperty(el, 'getBoundingClientRect', { value: () => ({ left: 5, top: 5, right: 55, bottom: 25, width: 50, height: 20 }) });
    }
    const rows = (query: string) => (applyGeneral(location.origin, 'observe', '', query) as any).page.elements;
    expect(rows('').some((e: any) => e.label === '展开目录')).toBe(false);
    expect(rows('菜单中的“展开目录”控件')).toEqual([expect.objectContaining({ label: '展开目录', id: expect.any(String) })]);
    expect(rows('不存在的控件')).toHaveLength(0);
  });
  it('exposes short text controls without pointer styling', () => {
    document.body.innerHTML = '<div><span id="blank">新建空白文档</span></div>';
    const el = document.getElementById('blank')!;
    Object.defineProperty(el, 'getClientRects', { configurable: true, value: () => [{}] });
    Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 }) });
    const page = applyGeneral(location.origin, 'observe', '', '') as any;
    expect(page.page.elements).toContainEqual(expect.objectContaining({ label: '新建空白文档' }));
  });
  it('prioritizes visible pointer controls over earlier text leaves', () => {
    document.body.innerHTML = `${Array.from({ length: 200 }, (_, i) => `<span>普通文本${i}</span>`).join('')}<div id="action" style="cursor:pointer">操作目标</div>`;
    for (const el of Array.from(document.body.querySelectorAll('span, #action'))) {
      Object.defineProperty(el, 'getClientRects', { configurable: true, value: () => [{}] });
      Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 }) });
    }
    const page = applyGeneral(location.origin, 'observe', '', '') as any;
    expect(page.page.elements[0]).toMatchObject({ label: '操作目标' });
  });
  it('allows ordinary editor iframes, auth paths and explanatory text', () => {
    history.replaceState(null, '', '/account/auth/editor');
    document.body.innerHTML = '<div>验证码使用说明</div><iframe title="普通文档编辑器"></iframe>';
    expect(applyGeneral(location.origin, 'visual_prepare', '', '')).toHaveProperty('id');
  });
  it('ignores hidden sensitive fields but blocks visible OTP fields', () => {
    document.body.innerHTML = '<input type="password" hidden>';
    expect(applyGeneral(location.origin, 'visual_prepare', '', '')).toHaveProperty('id');
    document.body.innerHTML = '<input autocomplete="one-time-code">';
    const otp = document.querySelector('input')!;
    Object.defineProperty(otp, 'getClientRects', { configurable: true, value: () => [{}] });
    expect(applyGeneral(location.origin, 'visual_prepare', '', '')).toMatchObject({status: 'blocked'});
  });
});
