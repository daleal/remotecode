import type { OpenCodeClient } from '@opencode/client';
import type { StreamChunk } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectAutonomousTurn,
  observeSessionTurn,
  runSessionTurn,
  TurnAbortedError,
} from '../session-turn';

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

  it('keeps all emitted tool status messages within Slack 50-character limit', async () => {
    const statuses: string[] = [];
    let releaseWait = () => {};
    const waitPromise = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const events: unknown[] = [
      {
        data: {
          assistantMessageID: 'assistant-1',
          id: 'tool-1',
          name: 'bash',
          sessionID: 'session-1',
        },
        type: 'session.tool.input.started',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          executed: true,
          id: 'tool-1',
          input: {
            description:
              'A very long shell command description that exceeds fifty characters easily',
          },
          sessionID: 'session-1',
        },
        type: 'session.tool.called',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          id: 'tool-2',
          name: 'grep',
          sessionID: 'session-1',
        },
        type: 'session.tool.input.started',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          executed: true,
          id: 'tool-2',
          input: {
            pattern: 'someVeryLongRegexPatternNameThatWillDefinitelyExceedFiftyCharacters',
          },
          sessionID: 'session-1',
        },
        type: 'session.tool.called',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          id: 'tool-3',
          name: 'very_long_custom_mcp_server_tool_name_that_exceeds_slack_limit',
          sessionID: 'session-1',
        },
        type: 'session.tool.input.started',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          executed: true,
          id: 'tool-3',
          input: {},
          sessionID: 'session-1',
        },
        type: 'session.tool.called',
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
            ? [{ content: [{ text: 'Done', type: 'text' }], id: 'assistant-1', type: 'assistant' }]
            : [],
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

    await runSessionTurn({
      adapterName: 'slack',
      client,
      metadata,
      onChunk: () => {},
      onStatus: (status) => statuses.push(status),
      prompt: 'Check',
      sessionID: 'session-1',
    });

    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(status.length).toBeLessThanOrEqual(50);
    }
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

  it('splits messages via onMessageEnd across tools and steps while ignoring same-step trailing reasoning', async () => {
    const messagesEmitted: string[][] = [[]];
    const statuses: string[] = [];
    let releaseWait = () => {};
    const waitPromise = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const events: unknown[] = [
      {
        data: {
          assistantMessageID: 'assistant-1',
          delta: 'Anotado, ya lo cambio.',
          ordinal: 0,
          sessionID: 'session-1',
        },
        type: 'session.text.delta',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          ordinal: 0,
          sessionID: 'session-1',
          text: 'Anotado, ya lo cambio.',
        },
        type: 'session.text.ended',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          ordinal: 1,
          sessionID: 'session-1',
        },
        type: 'session.reasoning.started',
      },
      {
        data: {
          assistantMessageID: 'assistant-2',
          sessionID: 'session-1',
        },
        type: 'session.step.started',
      },
      {
        data: {
          assistantMessageID: 'assistant-2',
          id: 'tool-1',
          name: 'shell',
          sessionID: 'session-1',
        },
        type: 'session.tool.input.started',
      },
      {
        data: {
          assistantMessageID: 'assistant-2',
          executed: true,
          id: 'tool-1',
          input: { command: 'git push' },
          sessionID: 'session-1',
        },
        type: 'session.tool.called',
      },
      {
        data: {
          assistantMessageID: 'assistant-3',
          delta: 'Quedó listo.',
          ordinal: 0,
          sessionID: 'session-1',
        },
        type: 'session.text.delta',
      },
      {
        data: {
          assistantMessageID: 'assistant-3',
          ordinal: 1,
          sessionID: 'session-1',
        },
        type: 'session.reasoning.started',
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
                  content: [{ text: 'Quedó listo.', type: 'text' }],
                  id: 'assistant-3',
                  type: 'assistant',
                },
                {
                  content: [{ text: 'Anotado, ya lo cambio.', type: 'text' }],
                  id: 'assistant-1',
                  type: 'assistant',
                },
              ]
            : [],
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
      onChunk: (chunk) => {
        if (chunk.type === 'markdown_text') {
          messagesEmitted.at(-1)?.push(chunk.text);
        }
      },
      onMessageEnd: () => {
        messagesEmitted.push([]);
      },
      onStatus: (status) => statuses.push(status),
      prompt: 'Update PR',
      sessionID: 'session-1',
    });

    expect(result).toBe('Quedó listo.');
    expect(messagesEmitted).toEqual([['Anotado, ya lo cambio.'], ['Quedó listo.']]);
    expect(statuses).toEqual(['Thinking...', 'Running command...', 'Running git push...']);
  });

  it('waits for chained background and timed-out shell commands, flushing intermediate messages and updating status', async () => {
    vi.useFakeTimers();
    const pendingEvents: unknown[] = [];
    let notifyEvent: (() => void) | undefined;
    let eventsDone = false;
    const pushEvent = (event: unknown) => {
      pendingEvents.push(event);
      notifyEvent?.();
      notifyEvent = undefined;
    };

    const messages: unknown[] = [];
    let waitCount = 0;
    let releaseWait: (() => void) | undefined;
    const messagesEmitted: string[][] = [[]];
    const statuses: string[] = [];

    const client = {
      event: {
        subscribe: vi.fn(async function* () {
          while (!eventsDone || pendingEvents.length > 0) {
            if (pendingEvents.length === 0) {
              await new Promise<void>((resolve) => {
                notifyEvent = resolve;
              });
              continue;
            }
            yield pendingEvents.shift();
          }
        }),
      },
      message: {
        list: vi.fn(async () => ({ cursor: {}, data: [...messages].reverse() })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async () => {
          messages.push({ id: 'user-1', type: 'user' });
        }),
        wait: vi.fn(async () => {
          waitCount += 1;
          await new Promise<void>((resolve) => {
            releaseWait = resolve;
          });
        }),
      },
    } as unknown as OpenCodeClient;

    const turn = runSessionTurn({
      adapterName: 'slack',
      client,
      metadata,
      onChunk: (chunk) => {
        if (chunk.type === 'markdown_text') {
          messagesEmitted.at(-1)?.push(chunk.text);
        }
      },
      onMessageEnd: () => {
        messagesEmitted.push([]);
      },
      onStatus: (status) => statuses.push(status),
      prompt: 'Open PR and babysit it',
      sessionID: 'session-bg-shell',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(waitCount).toBe(1);

    // Round 1: agent starts an explicit background shell and posts a draft PR update.
    messages.push(
      {
        content: [
          {
            id: 'call-sh-1',
            name: 'shell',
            state: {
              input: { background: true, command: 'python3 watch.py' },
              metadata: { pid: 101, shellID: 'sh-1', status: 'running' },
              status: 'completed',
            },
            type: 'tool',
          },
        ],
        id: 'assistant-1a',
        type: 'assistant',
      },
      {
        content: [{ text: 'PR abierta en draft.', type: 'text' }],
        id: 'assistant-1b',
        type: 'assistant',
      },
      { id: 'idle-1', type: 'idle' },
    );
    pushEvent({
      data: {
        assistantMessageID: 'assistant-1b',
        delta: 'PR abierta en draft.',
        ordinal: 0,
        sessionID: 'session-bg-shell',
      },
      type: 'session.text.delta',
    });
    releaseWait?.();
    await vi.advanceTimersByTimeAsync(0);

    // Trailing reasoning on the already-flushed message must not clobber waiting status.
    pushEvent({
      data: {
        assistantMessageID: 'assistant-1b',
        ordinal: 1,
        sessionID: 'session-bg-shell',
      },
      type: 'session.reasoning.started',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(messagesEmitted).toEqual([['PR abierta en draft.'], []]);
    expect(statuses).toEqual(['Waiting for background command...']);

    // Round 2: sh-1 finishes; agent runs a foreground shell that times out into background (no input.background).
    messages.push({
      id: 'syn-sh-1',
      metadata: { exit: 0, jobID: 'sh-1', shellID: 'sh-1', source: 'shell', state: 'completed' },
      text: '<shell id="sh-1" state="completed">',
      type: 'synthetic',
    });
    pushEvent({
      data: {
        assistantMessageID: 'assistant-2a',
        sessionID: 'session-bg-shell',
      },
      type: 'session.step.started',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(waitCount).toBe(2);
    expect(statuses.at(-1)).toBe('Thinking...');

    messages.push(
      {
        content: [
          {
            id: 'call-sh-2',
            name: 'shell',
            state: {
              input: { command: 'python3 watch.py --round 2' },
              metadata: { pid: 102, shellID: 'sh-2', status: 'running' },
              status: 'completed',
            },
            type: 'tool',
          },
        ],
        id: 'assistant-2a',
        type: 'assistant',
      },
      {
        content: [{ text: 'Update de babysit.', type: 'text' }],
        id: 'assistant-2b',
        type: 'assistant',
      },
      { id: 'idle-2', type: 'idle' },
    );
    pushEvent({
      data: {
        assistantMessageID: 'assistant-2b',
        delta: 'Update de babysit.',
        ordinal: 0,
        sessionID: 'session-bg-shell',
      },
      type: 'session.text.delta',
    });
    releaseWait?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(messagesEmitted).toEqual([['PR abierta en draft.'], ['Update de babysit.'], []]);
    expect(statuses.at(-1)).toBe('Waiting for background command...');

    // Round 3: sh-2 finishes; agent posts final ready-for-review message.
    messages.push({
      id: 'syn-sh-2',
      metadata: { exit: 0, jobID: 'sh-2', shellID: 'sh-2', source: 'shell', state: 'completed' },
      text: '<shell id="sh-2" state="completed">',
      type: 'synthetic',
    });
    pushEvent({
      data: {
        assistantMessageID: 'assistant-3',
        sessionID: 'session-bg-shell',
      },
      type: 'session.step.started',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(waitCount).toBe(3);

    messages.push(
      {
        content: [{ text: 'Lista para review humano.', type: 'text' }],
        id: 'assistant-3',
        type: 'assistant',
      },
      { id: 'idle-3', type: 'idle' },
    );
    pushEvent({
      data: {
        assistantMessageID: 'assistant-3',
        delta: 'Lista para review humano.',
        ordinal: 0,
        sessionID: 'session-bg-shell',
      },
      type: 'session.text.delta',
    });
    eventsDone = true;
    notifyEvent?.();
    releaseWait?.();

    const result = await turn;
    expect(result).toBe('Lista para review humano.');
    expect(messagesEmitted).toEqual([
      ['PR abierta en draft.'],
      ['Update de babysit.'],
      ['Lista para review humano.'],
    ]);
    expect(statuses).toEqual([
      'Waiting for background command...',
      'Thinking...',
      'Waiting for background command...',
      'Thinking...',
    ]);
    for (const status of statuses) {
      expect(status.length).toBeLessThanOrEqual(50);
    }
  });

  it('tracks V2 background subagents by running metadata, updates between partial completions, and handles follow-ups', async () => {
    vi.useFakeTimers();
    const messages: unknown[] = [];
    let waitCount = 0;
    let releaseWait: (() => void) | undefined;
    const statuses: string[] = [];

    const client = {
      message: {
        list: vi.fn(async () => ({ cursor: {}, data: [...messages].reverse() })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async () => {
          messages.push({ id: 'user-1', type: 'user' });
        }),
        wait: vi.fn(async () => {
          waitCount += 1;
          await new Promise<void>((resolve) => {
            releaseWait = resolve;
          });
        }),
      },
    } as unknown as OpenCodeClient;

    const turn = runSessionTurn({
      adapterName: 'slack',
      client,
      metadata,
      onStatus: (status) => statuses.push(status),
      prompt: 'Analyze repos',
      sessionID: 'session-subagents',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(waitCount).toBe(1);

    // Launch two V2 subagents (no input.background, metadata.status === 'running') + one completed legacy subagent.
    messages.push(
      {
        content: [
          {
            id: 'call-legacy-fg',
            name: 'subagent',
            state: {
              input: { agent: 'explore', prompt: 'sync' },
              metadata: { sessionID: 'child-fg', status: 'completed' },
              status: 'completed',
            },
            type: 'tool',
          },
          {
            id: 'call-sub-1',
            name: 'subagent',
            state: {
              input: { agent: 'explore', prompt: 'repo a' },
              metadata: { sessionID: 'child-1', status: 'running' },
              status: 'completed',
            },
            type: 'tool',
          },
          {
            id: 'call-sub-2',
            name: 'subagent',
            state: {
              input: { agent: 'explore', prompt: 'repo b' },
              metadata: { sessionID: 'child-2', status: 'running' },
              status: 'completed',
            },
            type: 'tool',
          },
        ],
        id: 'assistant-1',
        type: 'assistant',
      },
      { id: 'idle-1', type: 'idle' },
    );
    releaseWait?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['Waiting for subagents...']);

    // child-1 finishes first; assistant acknowledges while child-2 is still pending.
    messages.push({
      id: 'syn-1',
      metadata: { childID: 'child-1', source: 'subagent', state: 'completed' },
      text: '<subagent sessionID="child-1" state="completed">',
      type: 'synthetic',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(waitCount).toBe(2);

    messages.push(
      {
        content: [{ text: 'First done, waiting on second.', type: 'text' }],
        id: 'assistant-2',
        type: 'assistant',
      },
      { id: 'idle-2', type: 'idle' },
    );
    releaseWait?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['Waiting for subagents...', 'Waiting for subagent...']);

    // child-2 finishes; assistant sends a follow-up to child-1 (re-using sessionID).
    messages.push({
      id: 'syn-2',
      metadata: { childID: 'child-2', source: 'subagent', state: 'completed' },
      text: '<subagent sessionID="child-2" state="completed">',
      type: 'synthetic',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(waitCount).toBe(3);

    messages.push(
      {
        content: [
          {
            id: 'call-sub-1-followup',
            name: 'subagent',
            state: {
              input: { agent: 'explore', prompt: 'follow up', sessionID: 'child-1' },
              metadata: { sessionID: 'child-1', status: 'running' },
              status: 'completed',
            },
            type: 'tool',
          },
        ],
        id: 'assistant-3',
        type: 'assistant',
      },
      { id: 'idle-3', type: 'idle' },
    );
    releaseWait?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual([
      'Waiting for subagents...',
      'Waiting for subagent...',
      'Waiting for subagent...',
    ]);

    // Follow-up to child-1 completes; assistant writes final answer.
    messages.push({
      id: 'syn-1-followup',
      metadata: { childID: 'child-1', source: 'subagent', state: 'completed' },
      text: '<subagent sessionID="child-1" state="completed">',
      type: 'synthetic',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(waitCount).toBe(4);

    messages.push(
      {
        content: [{ text: 'All subagents complete.', type: 'text' }],
        id: 'assistant-4',
        type: 'assistant',
      },
      { id: 'idle-4', type: 'idle' },
    );
    releaseWait?.();

    await expect(turn).resolves.toBe('All subagents complete.');
  });

  it('reconnects when a live OpenCode event stream closes cleanly after server.connected', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks: StreamChunk[] = [];
    let attempt = 0;
    let releaseWait = () => {};
    const waitPromise = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });

    const client = {
      event: {
        subscribe: vi.fn(async function* ({ signal }: { signal?: AbortSignal } = {}) {
          attempt += 1;
          yield { data: {}, type: 'server.connected' };
          if (attempt === 1) {
            yield {
              data: {
                assistantMessageID: 'assistant-1',
                delta: 'Part 1. ',
                ordinal: 0,
                sessionID: 'session-eof',
              },
              type: 'session.text.delta',
            };
            // Clean EOF (e.g. server SIGTERM graceful shutdown)
            return;
          }
          yield {
            data: {
              assistantMessageID: 'assistant-2',
              delta: 'Part 2 after restart.',
              ordinal: 0,
              sessionID: 'session-eof',
            },
            type: 'session.text.delta',
          };
          releaseWait();
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }),
      },
      message: {
        list: vi.fn(async () => ({
          cursor: {},
          data:
            attempt >= 2
              ? [
                  {
                    content: [{ text: 'Part 2 after restart.', type: 'text' }],
                    id: 'assistant-2',
                    type: 'assistant',
                  },
                ]
              : [],
        })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async () => {}),
        wait: vi.fn(() => waitPromise),
      },
    } as unknown as OpenCodeClient;

    const turn = runSessionTurn({
      adapterName: 'slack',
      client,
      metadata,
      onChunk: (chunk) => chunks.push(chunk),
      prompt: 'Run long task',
      sessionID: 'session-eof',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(turn).resolves.toBe('Part 2 after restart.');
    expect(attempt).toBe(2);
    expect(chunks).toEqual([
      { text: 'Part 1. ', type: 'markdown_text' },
      { text: '\n\n', type: 'markdown_text' },
      { text: 'Part 2 after restart.', type: 'markdown_text' },
    ]);
    expect(warn).toHaveBeenCalledWith('OpenCode event stream closed for session-eof; reconnecting');
  });
});

describe('inspectAutonomousTurn', () => {
  const clientWithMessages = (messages: unknown[]) =>
    ({
      message: {
        list: vi.fn(async () => ({ cursor: {}, data: [...messages].reverse() })),
      },
    }) as unknown as OpenCodeClient;

  it('detects stacked automation prompts and restart notices and finds the prior assistant boundary', async () => {
    const client = clientWithMessages([
      {
        content: [{ text: 'De una, dejé 4 timers.', type: 'text' }],
        id: 'asst-1',
        type: 'assistant',
      },
      { id: 'idle-1', type: 'idle' },
      {
        id: 'msg_aut_1',
        metadata: { automation: { id: 'aut_1', name: '1/4', run: 1 } },
        text: 'Timer 1/4',
        type: 'user',
      },
      { id: 'syn-restart', metadata: { notice: 'restart' }, text: 'restarted', type: 'synthetic' },
      {
        id: 'msg_aut_2',
        metadata: { automation: { id: 'aut_2', name: '2/4', run: 1 } },
        text: 'Timer 2/4',
        type: 'user',
      },
      {
        content: [{ text: 'Chuta, el server se reinició...', type: 'text' }],
        id: 'asst-2',
        type: 'assistant',
      },
    ]);

    const result = await inspectAutonomousTurn(client, 'ses-1');
    expect(result).toEqual({
      autonomous: true,
      previousAssistantIDs: new Set(['asst-1']),
    });
    await expect(inspectAutonomousTurn(client, 'ses-1', 'asst-2')).resolves.toEqual({
      autonomous: false,
    });
  });

  it('ignores manual local CLI prompts even after a server restart, while resuming Slack prompts', async () => {
    const manualClient = clientWithMessages([
      { content: [{ text: 'Prev', type: 'text' }], id: 'asst-1', type: 'assistant' },
      { id: 'user-cli', text: 'git status', type: 'user' },
      { id: 'syn-restart', metadata: { notice: 'restart' }, text: 'restarted', type: 'synthetic' },
      { content: [{ text: 'On main', type: 'text' }], id: 'asst-2', type: 'assistant' },
    ]);
    await expect(inspectAutonomousTurn(manualClient, 'ses-cli')).resolves.toEqual({
      autonomous: false,
    });

    const slackRestartClient = clientWithMessages([
      { content: [{ text: 'Prev', type: 'text' }], id: 'asst-1', type: 'assistant' },
      {
        id: 'user-slack',
        metadata: { threadID: 'slack:C1:1.0' },
        text: 'fix bug',
        type: 'user',
      },
      { id: 'syn-restart', metadata: { notice: 'restart' }, text: 'restarted', type: 'synthetic' },
      { content: [{ text: 'Fixed', type: 'text' }], id: 'asst-2', type: 'assistant' },
    ]);
    await expect(inspectAutonomousTurn(slackRestartClient, 'ses-slack')).resolves.toEqual({
      autonomous: true,
      previousAssistantIDs: new Set(['asst-1']),
    });
  });

  it('distinguishes background job/subagent synthetics from interactive user shell commands', async () => {
    const interactiveShellClient = clientWithMessages([
      { content: [{ text: 'Prev', type: 'text' }], id: 'asst-1', type: 'assistant' },
      {
        id: 'syn-user-shell',
        metadata: { exit: 0, shellID: 'sh-local', source: 'shell', state: 'completed' },
        text: 'The following shell command was executed by the user:',
        type: 'synthetic',
      },
    ]);
    await expect(inspectAutonomousTurn(interactiveShellClient, 'ses-1')).resolves.toEqual({
      autonomous: false,
    });

    const backgroundShellClient = clientWithMessages([
      { content: [{ text: 'Prev', type: 'text' }], id: 'asst-1', type: 'assistant' },
      {
        id: 'syn-bg-shell',
        metadata: {
          exit: 0,
          jobID: 'sh-bg',
          shellID: 'sh-bg',
          source: 'shell',
          state: 'completed',
        },
        text: '<background-result kind="shell" id="sh-bg">',
        type: 'synthetic',
      },
    ]);
    await expect(inspectAutonomousTurn(backgroundShellClient, 'ses-1')).resolves.toEqual({
      autonomous: true,
      previousAssistantIDs: new Set(['asst-1']),
    });
  });
});

describe('observeSessionTurn', () => {
  it('observes without prompting and detaches cleanly without interrupting OpenCode when aborted', async () => {
    const controller = new AbortController();
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const prompt = vi.fn(async () => {});
    const client = {
      message: { list: vi.fn(async () => ({ cursor: {}, data: [] })) },
      permission: { list: vi.fn(async () => []), reply: vi.fn() },
      session: {
        interrupt,
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt,
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

    const observing = observeSessionTurn({
      adapterName: 'slack',
      client,
      previousAssistantIDs: new Set(['asst-prev']),
      sessionID: 'session-auto',
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(observing).rejects.toBeInstanceOf(TurnAbortedError);
    expect(prompt).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });
});
