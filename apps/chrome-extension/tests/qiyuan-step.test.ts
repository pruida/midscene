// @rstest-environment jsdom
import { describe, expect, it } from '@rstest/core';
import {
  observeWithRetry,
  receiptFor,
  startInputProbe,
  finishInputProbe,
  resolveChildTab,
  safeChildOrigin,
} from '../src/extension/popup/qiyuan-step';

describe('task child tabs', () => {
  it('waits for a blank child and returns only sanitized origin evidence', async () => {
    let calls = 0;
    const result = await resolveChildTab([2], 1, async () => ({
      id: 2, openerTabId: 1, url: ++calls < 3 ? 'about:blank' : 'https://example.com/private?token=secret#x',
    }) as chrome.tabs.Tab, async () => {});
    expect(result).toEqual({ outcome: 'switched', id: 2, origin: 'https://example.com' });
    expect(calls).toBe(3);
  });
  it('keeps pending, unrelated, unsafe and ambiguous children blocked', async () => {
    const blank = async () => ({ id: 2, openerTabId: 1, url: 'about:blank' }) as chrome.tabs.Tab;
    expect(await resolveChildTab([2], 1, blank, async () => {}, 2)).toEqual({ outcome: 'pending' });
    expect(await resolveChildTab([2, 3], 1, blank, async () => {})).toEqual({ outcome: 'ambiguous', count: 2 });
    expect(await resolveChildTab([2], 9, blank, async () => {})).toEqual({ outcome: 'blocked' });
    expect(safeChildOrigin('https://user:pass@example.com/private')).toBeNull();
    expect(safeChildOrigin('https://router.internal/')).toBeNull();
    expect(safeChildOrigin('http://example.com/')).toBeNull();
  });
});

describe('general browser receipts', () => {
  it('rejects missing click and malformed observe results', () => {
    expect(receiptFor(2, 'click', undefined)).toMatchObject({
      status: 'error',
      uncertain: true,
    });
    expect(receiptFor(3, 'observe', { status: 'ok', rows: [] })).toMatchObject({
      status: 'error',
    });
  });
  it('retries a destroyed context and missing result, then returns the observed page', async () => {
    let calls = 0,
      waits = 0;
    const result = await observeWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('context destroyed');
        if (calls === 2) return undefined;
        return {
          status: 'ok',
          rows: [],
          page: { url: 'https://example.com/new', elements: [] },
        };
      },
      async () => {
        waits++;
      },
    );
    expect(result.status).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toBe(2);
  });
  it('does not turn repeated invalid observations into success', async () => {
    const result = await observeWithRetry(
      async () => undefined,
      async () => {},
    );
    expect(result.status).toBe('error');
  });
  it('records delivered input event types and removes the probe', () => {
    startInputProbe();
    window.dispatchEvent(new MouseEvent('mousedown'));
    window.dispatchEvent(new MouseEvent('click'));
    expect(finishInputProbe()).toEqual(['mousedown:untrusted', 'click:untrusted']);
    expect(finishInputProbe()).toEqual([]);
  });
});
