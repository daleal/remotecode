import type { OpenCodeClient } from '@opencode/client';
import type { StreamChunk } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSessionTurn, TurnAbortedError } from '../session-turn';

const metadata = {
  lastMessageID: 'thread-message-1',
  source: 'slack',
  threadID: 'thread-1',
};

describe('runSessionTurn', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('discovers new descendants across pages and unblocks the parent by rejecting their permissions', async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    let finish = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let completed = false;
    let childrenCreated = false;
    let failDiscovery = true;
    const rejected = new Set<string>();
    const client = {
      message: {
        list: vi.fn(async () => ({
          cursor: {},
          data: completed
            ? [{ id: 'answer', type: 'assistant', content: [{ type: 'text', text: 'Done' }] }]
            : [],
        })),
      },
      permission: {
        list: vi.fn(async ({ sessionID }: { sessionID: string }) =>
          sessionID !== 'parent' && !rejected.has(sessionID)
            ? [{ id: `permission-${sessionID}` }]
            : [],
        ),
        reply: vi.fn(async ({ sessionID }: { sessionID: string }) => {
          rejected.add(sessionID);
          if (rejected.size === 3) {
            completed = true;
            finish();
          }
        }),
      },
      session: {
        list: vi.fn(
          async ({
            parentID,
            cursor,
            order,
          }: {
            parentID: string;
            cursor?: string;
            order?: string;
          }) => {
            if (!childrenCreated) return { data: [], cursor: {} };
            if (parentID === 'parent') {
              if (failDiscovery) {
                failDiscovery = false;
                throw new Error('Transient discovery failure');
              }
              if (cursor) {
                expect(order).toBeUndefined();
                return { data: [{ id: 'background-child' }], cursor: {} };
              }
              return { data: [{ id: 'foreground-child' }], cursor: { next: 'page-2' } };
            }
            return {
              data: parentID === 'foreground-child' ? [{ id: 'grandchild' }] : [],
              cursor: {},
            };
          },
        ),
        prompt: vi.fn(async () => {}),
        wait: vi.fn(() => waiting),
      },
    } as unknown as OpenCodeClient;

    const result = runSessionTurn({
      adapterName: 'slack',
      client,
      metadata,
      prompt: 'Work',
      sessionID: 'parent',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.session.wait).toHaveBeenCalled();
    childrenCreated = true;
    await vi.advanceTimersByTimeAsync(3000);
    await expect(result).resolves.toBe('Done');

    for (const sessionID of ['foreground-child', 'background-child', 'grandchild']) {
      expect(client.permission.reply).toHaveBeenCalledWith({
        sessionID,
        requestID: `permission-${sessionID}`,
        decision: 'reject',
        message: expect.stringContaining("user can't see the request on slack"),
      });
    }
    expect(errorLog).toHaveBeenCalledWith(
      'Could not discover OpenCode subagents for parent',
      expect.any(Error),
    );
    const calls = vi.mocked(client.permission.list).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.permission.list).toHaveBeenCalledTimes(calls);
  });

  it('prompts the session, rejects permissions, and returns the final new response', async () => {
    const messages: unknown[] = [
      {
        content: [{ text: 'Old response', type: 'text' }],
        id: 'assistant-old',
        type: 'assistant',
      },
    ];
    const client = {
      message: {
        list: vi.fn(async () => ({ cursor: {}, data: [...messages].reverse() })),
      },
      permission: {
        list: vi.fn(async () => [{ id: 'permission-1' }]),
        reply: vi.fn(async () => {}),
      },
      session: {
        list: vi.fn(async () => ({ data: [], cursor: {} })),
        prompt: vi.fn(async () => {
          messages.push(
            { id: 'user-new', type: 'user' },
            {
              content: [
                { text: ' First paragraph ', type: 'text' },
                { text: '', type: 'text' },
                { text: 'Second paragraph', type: 'text' },
              ],
              id: 'assistant-new',
              type: 'assistant',
            },
          );
        }),
        wait: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;

    await expect(
      runSessionTurn({
        adapterName: 'slack',
        client,
        metadata,
        prompt: 'Prompt text',
        sessionID: 'session-1',
      }),
    ).resolves.toBe('First paragraph\n\nSecond paragraph');
    expect(client.session.prompt).toHaveBeenCalledWith({
      metadata,
      sessionID: 'session-1',
      text: 'Prompt text',
    });
    expect(client.permission.reply).toHaveBeenCalledWith({
      message: expect.stringContaining("user can't see the request on slack"),
      decision: 'reject',
      requestID: 'permission-1',
      sessionID: 'session-1',
    });
  });

  it('reports the last assistant error when no text is returned', async () => {
    let prompted = false;
    const client = {
      message: {
        list: vi.fn(async () => ({
          cursor: {},
          data: prompted
            ? [
                {
                  content: [],
                  error: { message: 'Model failed' },
                  id: 'assistant-error',
                  type: 'assistant',
                },
              ]
            : [],
        })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn() },
      session: {
        list: vi.fn(async () => ({ data: [], cursor: {} })),
        prompt: vi.fn(async () => {
          prompted = true;
        }),
        wait: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;

    await expect(
      runSessionTurn({
        adapterName: 'slack',
        client,
        metadata,
        prompt: 'Prompt text',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('Model failed');
  });

  it('streams text deltas and tool status updates from OpenCode events', async () => {
    const chunks: StreamChunk[] = [];
    const statuses: string[] = [];
    let releaseWait = () => {};
    const waitPromise = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const events: unknown[] = [
      {
        data: {
          assistantMessageID: 'assistant-old',
          delta: 'ignored',
          ordinal: 0,
          sessionID: 'session-1',
        },
        type: 'session.text.delta',
      },
      {
        data: {
          assistantMessageID: 'other-msg',
          delta: 'other session',
          ordinal: 0,
          sessionID: 'session-2',
        },
        type: 'session.text.delta',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          delta: 'Checking ',
          ordinal: 0,
          sessionID: 'session-1',
        },
        type: 'session.text.delta',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          delta: 'repo.',
          ordinal: 0,
          sessionID: 'session-1',
        },
        type: 'session.text.delta',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          id: 'tool-1',
          name: 'read',
          sessionID: 'session-1',
        },
        type: 'session.tool.input.started',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          executed: true,
          id: 'tool-1',
          input: { path: '/repo/src/agent.ts' },
          sessionID: 'session-1',
        },
        type: 'session.tool.called',
      },
      {
        data: {
          assistantMessageID: 'assistant-2',
          delta: 'All fixed.',
          ordinal: 0,
          sessionID: 'session-1',
        },
        type: 'session.text.delta',
      },
    ];

    let prompted = false;
    const client = {
      event: {
        subscribe: vi.fn(async function* () {
          for (const event of events) yield event;
          releaseWait();
        }),
      },
      message: {
        list: vi.fn(async () => ({
          cursor: {},
          data: prompted
            ? [
                {
                  content: [{ text: 'All fixed.', type: 'text' }],
                  id: 'assistant-2',
                  type: 'assistant',
                },
                {
                  content: [{ text: 'Checking repo.', type: 'text' }],
                  id: 'assistant-1',
                  type: 'assistant',
                },
                {
                  content: [{ text: 'Old', type: 'text' }],
                  id: 'assistant-old',
                  type: 'assistant',
                },
              ]
            : [
                {
                  content: [{ text: 'Old', type: 'text' }],
                  id: 'assistant-old',
                  type: 'assistant',
                },
              ],
        })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn() },
      session: {
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async () => {
          prompted = true;
        }),
        wait: vi.fn(() => waitPromise),
      },
    } as unknown as OpenCodeClient;

    const result = await runSessionTurn({
      adapterName: 'slack',
      client,
      metadata,
      onChunk: (chunk) => chunks.push(chunk),
      onStatus: (status) => statuses.push(status),
      prompt: 'Fix it',
      sessionID: 'session-1',
    });

    expect(result).toBe('All fixed.');
    expect(statuses).toEqual(['Reading file...', 'Reading src/agent.ts...']);
    expect(chunks).toEqual([
      { text: 'Checking ', type: 'markdown_text' },
      { text: 'repo.', type: 'markdown_text' },
      { text: '\n\n', type: 'markdown_text' },
      { text: 'All fixed.', type: 'markdown_text' },
    ]);
  });

  it('interrupts OpenCode and throws TurnAbortedError when aborted', async () => {
    const controller = new AbortController();
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const client = {
      message: { list: vi.fn(async () => ({ cursor: {}, data: [] })) },
      permission: { list: vi.fn(async () => []), reply: vi.fn() },
      session: {
        interrupt,
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async () => {}),
        wait: vi.fn(
          (_input: unknown, requestOptions?: { signal?: AbortSignal }) =>
            new Promise<void>((_resolve, reject) => {
              requestOptions?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              });
            }),
        ),
      },
    } as unknown as OpenCodeClient;

    const running = runSessionTurn({
      adapterName: 'slack',
      client,
      metadata,
      prompt: 'Long task',
      sessionID: 'session-abort',
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(running).rejects.toBeInstanceOf(TurnAbortedError);
    expect(interrupt).toHaveBeenCalledWith({ sessionID: 'session-abort' });
  });
});
