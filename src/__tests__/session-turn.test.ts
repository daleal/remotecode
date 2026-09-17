import type { OpenCodeClient } from '@opencode/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSessionTurn } from '../session-turn';

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
});
