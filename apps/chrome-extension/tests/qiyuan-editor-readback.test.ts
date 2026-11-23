// @rstest-environment jsdom
import { describe, expect, it } from '@rstest/core';
import { applyGeneral } from '../src/extension/popup/qiyuan-general';

describe('trusted editor readback', () => {
  function editor(label: string, blockId = '') {
    document.body.innerHTML = `<div contenteditable="true" aria-label="${label}"${blockId ? ` data-block-id="${blockId}"` : ''}></div>`;
    const el = document.querySelector('div')!;
    let text = '';
    Object.defineProperties(el, {
      isContentEditable: { value: true },
      innerText: { get: () => text, set: (v) => { text = v; } },
      getClientRects: { value: () => [{}] },
    });
    (globalThis as any).qkTargets = new Map([['target', el]]);
    let writes = 0;
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => { writes++; return true; } });
    return { el, setText: (v: string) => { text = v; }, writes: () => writes };
  }

  it('prepares body only for an identified body role and never writes in page script', () => {
    for (const [label, role, qualifies] of [['正文', 'body', true], ['标题', 'title', false], ['正文', 'other', false], ['标题 正文', 'body', false], ['编辑区域', 'body', false]]) {
      const fixture = editor(label as string);
      const result = applyGeneral(location.origin, 'fill', 'target', 'hello', role as string) as any;
      if (role === 'body' && !qualifies) expect(result).toMatchObject({ status: 'blocked' });
      else expect(result).toMatchObject({ status: 'ok', editor_insert_pending: true });
      expect(fixture.writes()).toBe(0);
      if (qualifies) {
        fixture.setText('hello');
        expect(applyGeneral(location.origin, 'editor_readback', '', '')).toMatchObject({
          status: 'ok', evidence: { kind: 'editor_readback', field_role: 'body', body: 'hello' },
        });
      }
    }
  });

  it('reads delayed body without a second write and rejects stale targets', () => {
    const e = editor('正文');
    expect(applyGeneral(location.origin, 'fill', 'target', 'hello', 'body')).toMatchObject({ editor_insert_pending: true });
    e.setText('hello');
    expect(applyGeneral(location.origin, 'editor_readback', '', '')).toMatchObject({ status: 'ok', evidence: { field_role: 'body', body: 'hello' } });
    expect(e.writes()).toBe(0);
    expect(applyGeneral(location.origin, 'editor_readback', '', '')).toMatchObject({ status: 'error' });
    const stale = editor('正文');
    applyGeneral(location.origin, 'fill', 'target', 'hello', 'body');
    stale.setText('hello');
    stale.el.remove();
    expect(applyGeneral(location.origin, 'editor_readback', '', '')).toMatchObject({ status: 'error', uncertain: true });
  });

  it('follows Feishu replacing a paragraph with the same unique block id', () => {
    const original = editor('正文', 'block-1');
    expect(applyGeneral(location.origin, 'fill', 'target', 'hello', 'body')).toMatchObject({ editor_insert_pending: true });
    const replacement = document.createElement('div');
    replacement.setAttribute('data-block-id', 'block-1');
    replacement.setAttribute('aria-label', '正文');
    Object.defineProperties(replacement, {
      isContentEditable: { value: true },
      innerText: { value: 'hello' },
      getClientRects: { value: () => [{}] },
    });
    original.el.replaceWith(replacement);
    expect(applyGeneral(location.origin, 'editor_readback', '', '')).toMatchObject({ status: 'ok', evidence: { body: 'hello' } });
    expect(original.writes()).toBe(0);
  });

  it('defers Gmail recipient input events until trusted insertion and reads the value', () => {
    document.body.innerHTML = '<input type="text" aria-label="发送至收件人">';
    const el = document.querySelector('input')!;
    Object.defineProperty(el, 'getClientRects', { value: () => [{}] });
    let events = 0;
    el.addEventListener('input', () => events++);
    (globalThis as any).qkTargets = new Map([['target', el]]);
    expect(applyGeneral(location.origin, 'fill', 'target', 'pengruida@foxmail.com', 'other')).toMatchObject({ editor_insert_pending: true });
    expect(el.value).toBe('');
    expect(events).toBe(0);
    el.value = 'pengruida@foxmail.com';
    expect(applyGeneral(location.origin, 'editor_readback', '', '')).toMatchObject({
      status: 'ok', evidence: { kind: 'field_readback', field_role: 'other', body: 'pengruida@foxmail.com' },
    });
  });

  it('accepts only Gmail’s single terminal layout newline, not other added whitespace', () => {
    const gmail = editor('邮件正文');
    applyGeneral(location.origin, 'fill', 'target', 'hello', 'body');
    gmail.setText('hello\n');
    expect(applyGeneral(location.origin, 'editor_readback', '', '')).toMatchObject({
      status: 'ok', evidence: { field_role: 'body', body: 'hello' },
    });
    const trailingSpace = editor('邮件正文');
    applyGeneral(location.origin, 'fill', 'target', 'hello', 'body');
    trailingSpace.setText('hello ');
    expect(applyGeneral(location.origin, 'editor_readback', '', '')).toMatchObject({ status: 'error', uncertain: true });
  });

  it('does not accept trimmed or partial text as exact readback', () => {
    const e = editor('正文');
    applyGeneral(location.origin, 'fill', 'target', 'hello', 'body');
    e.setText('hello ');
    expect(applyGeneral(location.origin, 'editor_readback', '', '')).toMatchObject({ status: 'error', uncertain: true });
  });
});
