import { afterEach, describe, expect, it, rs } from '@rstest/core';
import { clarificationAction } from '../src/extension/popup/clarification';

afterEach(() => {
  rs.restoreAllMocks();
});

describe('AskUser planner action', () => {
  it('submits a structured question and returns the answer as planning feedback', async () => {
    const abort = new AbortController();
    const failure = rs.fn();
    let posted: any;
    const fetchMock = rs
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        if (init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          return new Response('{}', { status: 200 });
        }
        return new Response(JSON.stringify({ ...posted, answer: '第二个' }), {
          status: 200,
        });
      });
    const action = clarificationAction({
      url: 'https://example.test/task/1',
      capability: 'secret',
      signal: abort.signal,
      onFailure: failure,
    });
    const context: any = { signal: abort.signal, task: {} };
    await action.call({ question: '选哪个？' }, context);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(posted.questionId).toBeTruthy();
    expect(posted.question).toBe('选哪个？');
    expect(context.task.planningFeedback).toContain('第二个');
    expect(failure).not.toHaveBeenCalled();
  });

  it('fails closed on mismatched responses without replaying a question', async () => {
    const abort = new AbortController();
    const failure = rs.fn();
    const fetchMock = rs
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async (_url, init) =>
          new Response(
            JSON.stringify(
              init?.method === 'POST'
                ? {}
                : { questionId: 'wrong', question: 'Q', answer: 'A' },
            ),
            { status: 200 },
          ),
      );
    const action = clarificationAction({
      url: 'https://example.test/task/1',
      capability: 'secret',
      signal: abort.signal,
      onFailure: failure,
    });
    await expect(
      action.call({ question: 'Q' }, { task: {} } as any),
    ).rejects.toThrow('Invalid clarification response');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it('stops waiting promptly when cancelled', async () => {
    const abort = new AbortController();
    const failure = rs.fn();
    let posted: any;
    rs.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return new Response('{}');
      }
      queueMicrotask(() => abort.abort());
      return new Response(JSON.stringify({ ...posted, answer: null }));
    });
    const action = clarificationAction({
      url: 'https://example.test/task/1',
      capability: 'secret',
      signal: abort.signal,
      onFailure: failure,
    });
    await expect(
      action.call({ question: 'Q' }, { task: {} } as any),
    ).rejects.toBeDefined();
    expect(failure).toHaveBeenCalledTimes(1);
  });
});
