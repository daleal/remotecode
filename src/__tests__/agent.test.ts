import { createMemoryState } from '@chat-adapter/state-memory';
import type { OpenCodeClient } from '@opencode/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../agent';
import { MockAdapter } from '../mock-adapter';
import { shouldRespond } from '../should-respond';

vi.mock('../should-respond', () => ({ shouldRespond: vi.fn() }));

const bots: Array<ReturnType<typeof createAgent>> = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(bots.splice(0).map((bot) => bot.shutdown()));
  vi.restoreAllMocks();
  vi.mocked(shouldRespond).mockReset();
});

const staticWorkspace = {
  initWorkspace: async ({ repositoryRoot }: { repositoryRoot: string }) => ({
    availableRepos: [] as string[],
    directory: repositoryRoot,
    provisionedRepos: [] as string[],
    repositoryRoot,
  }),
};

describe('Slack agent', () => {
  it.each([true, false])(
    'routes follow-ups with shouldRespond=%s and imports only new context',
    async (smart) => {
      vi.mocked(shouldRespond).mockResolvedValue(smart);
      const prompts: Array<{ metadata?: Record<string, unknown>; text: string }> = [];
      const messages: Array<
        | { id: string; metadata?: Record<string, unknown>; type: 'user' }
        | { content: Array<{ text: string; type: 'text' }>; id: string; type: 'assistant' }
      > = [];
      const listMessages = vi.fn(async (input: { cursor?: string; order?: string }) => {
        if (input.cursor) {
          if (input.order) throw new Error('Cursor cannot be combined with order');
          return { data: [], cursor: {} };
        }
        return { data: [...messages].reverse(), cursor: { next: 'next-page' } };
      });
      const client = {
        experimental: {
          generate: { text: vi.fn(async () => ({ text: 'Handle Slack requests' })) },
        },
        message: { list: listMessages },
        permission: {
          list: vi.fn(async () => [
            { action: 'external_directory', id: 'permission-1', resources: ['/original'] },
          ]),
          reply: vi.fn(async () => {}),
        },
        question: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
        session: {
          create: vi.fn(async () => ({ id: 'session-1' })),
          list: vi.fn(async () => ({ data: [], cursor: {} })),
          prompt: vi.fn(async (input) => {
            prompts.push(input);
            messages.push(
              { id: `user-${prompts.length}`, metadata: input.metadata, type: 'user' },
              {
                content: [{ text: `intermediate ${prompts.length}`, type: 'text' }],
                id: `assistant-intermediate-${prompts.length}`,
                type: 'assistant',
              },
              {
                content: [{ text: `response ${prompts.length}`, type: 'text' }],
                id: `assistant-${prompts.length}`,
                type: 'assistant',
              },
            );
          }),
          update: vi.fn(async () => {}),
          wait: vi.fn(async () => {}),
        },
      } as unknown as OpenCodeClient;
      const adapter = new MockAdapter('remotecode');
      const postMessage = vi.spyOn(adapter, 'postMessage');
      const bot = createAgent({
        adapters: { mock: adapter },
        allowedUsers: ['local-user'],
        config: {
          agent: 'build',
          model: { id: 'model', providerID: 'provider', variant: 'high' },
          reposRoot: '/tmp',
          smallModel: { id: 'small-model', providerID: 'provider' },
          workspaceRoot: '/tmp/workspaces',
        },
        openCode: client,
        state: createMemoryState(),
        userTimezone: async () => 'Europe/Madrid',
        userName: 'remotecode',
        ...staticWorkspace,
      });
      bots.push(bot);
      await bot.initialize();

      await adapter.receive('one', 'background context', false);
      await adapter.receive('one', 'automated context', false, true);
      expect(prompts).toHaveLength(0);
      await adapter.receive('one', 'first request');
      await adapter.receive('one', 'new context', false);
      expect(shouldRespond).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ text: 'new context' }),
        { assistantRunning: false },
      );
      expect(prompts).toHaveLength(smart ? 2 : 1);
      await adapter.receive('one', 'second request');
      await adapter.receive('other', 'unrelated channel thread', false);

      expect(prompts).toHaveLength(smart ? 3 : 2);
      expect(prompts[0]?.text.startsWith('<mock>\n')).toBe(true);
      expect(prompts[0]?.text).toContain('background context');
      expect(prompts[0]?.text).toContain('automated context');
      expect(prompts[0]?.text).toContain('first request');
      expect(prompts[0]?.text).toContain('Message from Local User (@local) at');
      expect(prompts[0]?.text).toContain('Message from Local User (@local, bot) at');
      expect(prompts[0]?.text).toContain('Z (timezone: Europe/Madrid)');
      expect(prompts[1]?.text.startsWith('<mock>\n')).toBe(true);
      expect(prompts[1]?.text).not.toContain('background context');
      expect(prompts[1]?.text).not.toContain('first request');
      expect(prompts[1]?.text).toContain('new context');
      expect(prompts[smart ? 2 : 1]?.text).toContain('second request');
      if (smart) expect(prompts[2]?.text).not.toContain('new context');
      expect(adapter.reactions).toEqual([]);
      expect(adapter.removedReactions).toEqual([]);
      expect(adapter.outputs).toEqual([
        'response 1',
        'response 2',
        ...(smart ? ['response 3'] : []),
      ]);
      expect(postMessage.mock.calls.map(([, message]) => message)).toEqual([
        { markdown: 'response 1' },
        { markdown: 'response 2' },
        ...(smart ? [{ markdown: 'response 3' }] : []),
      ]);
      expect(adapter.ephemeralOutputs).toEqual([
        {
          text: "To inspect this session locally, run:\n\n```\nopencode --session 'session-1'\n```",
          userId: 'local-user',
        },
      ]);
      expect(listMessages.mock.calls.some(([input]) => input.cursor === 'next-page')).toBe(true);
      expect(client.experimental.generate.text).toHaveBeenCalledWith({
        model: { id: 'small-model', providerID: 'provider' },
        prompt: expect.stringContaining('You are a title generator.'),
      });
      expect(client.session.update).toHaveBeenCalledWith({
        sessionID: 'session-1',
        title: '[mock] Handle Slack requests',
      });
      expect(client.permission.reply).toHaveBeenCalledWith({
        message:
          "This request was automatically rejected, because the user can't see the request on mock to approve it. User won't be able to approve permissions in this thread.",
        decision: 'reject',
        requestID: 'permission-1',
        sessionID: 'session-1',
      });
    },
  );

  it('replaces the processing reaction with an error without posting details', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = {
      message: { list: vi.fn(async () => ({ data: [], cursor: {} })) },
      session: {
        create: vi.fn(async () => {
          throw new Error('private failure');
        }),
        list: vi.fn(async () => ({ data: [], cursor: {} })),
      },
    } as unknown as OpenCodeClient;
    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      openCode: client,
      state: createMemoryState(),
      userName: 'remotecode',
      ...staticWorkspace,
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('one', 'fail');

    expect(adapter.outputs).toEqual([]);
    expect(adapter.reactions.map((reaction) => reaction.emoji)).toEqual(['x']);
    expect(adapter.removedReactions).toEqual([]);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ message: 'private failure' }));
  });

  it('reconnects while waiting for a background subagent and posts the final response', async () => {
    vi.useFakeTimers();
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages: unknown[] = [];
    let waits = 0;
    const client = {
      experimental: { generate: { text: vi.fn(async () => ({ text: 'Background task' })) } },
      message: {
        list: vi.fn(async () => ({ data: [...messages].reverse(), cursor: {} })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      question: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        create: vi.fn(async () => ({ id: 'session-1' })),
        list: vi.fn(async () => ({ data: [], cursor: {} })),
        prompt: vi.fn(async (input) => {
          messages.push({ id: 'user-1', metadata: input.metadata, type: 'user' });
        }),
        update: vi.fn(async () => {}),
        wait: vi.fn(async () => {
          waits += 1;
          if (waits === 1) {
            messages.push({
              content: [
                {
                  id: 'tool-1',
                  name: 'subagent',
                  state: {
                    input: { background: true },
                    metadata: { sessionID: 'child-1' },
                    status: 'completed',
                  },
                  time: { created: 1 },
                  type: 'tool',
                },
                { text: 'Interim response', type: 'text' },
              ],
              id: 'assistant-interim',
              type: 'assistant',
            });
            throw new TypeError('connection lost');
          } else {
            messages.push({
              content: [{ text: 'Expected final response', type: 'text' }],
              id: 'assistant-final',
              type: 'assistant',
            });
          }
        }),
      },
    } as unknown as OpenCodeClient;
    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      openCode: client,
      state: createMemoryState(),
      userName: 'remotecode',
      ...staticWorkspace,
    });
    bots.push(bot);
    await bot.initialize();

    const response = adapter.receive('one', 'delegate this');
    await vi.advanceTimersByTimeAsync(1000);
    messages.push({
      id: 'subagent-result',
      metadata: { childID: 'child-1', source: 'subagent', state: 'completed' },
      text: 'Child result',
      type: 'synthetic',
    });
    await vi.advanceTimersByTimeAsync(1000);
    await response;

    expect(client.session.wait).toHaveBeenCalledTimes(3);
    expect(adapter.outputs).toEqual(['Expected final response']);
    expect(adapter.reactions.map((reaction) => reaction.emoji)).not.toContain('x');
    expect(warningLog).toHaveBeenCalledWith(
      'OpenCode wait connection failed for session-1; reconnecting',
      expect.objectContaining({ message: 'connection lost' }),
    );
    vi.useRealTimers();
  });

  it('replaces the setup reaction with an error when workspace provisioning fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      openCode: {} as OpenCodeClient,
      state: createMemoryState(),
      userName: 'remotecode',
      initWorkspace: async () => {
        throw new Error('workspace failure');
      },
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('one', 'fail');

    expect(adapter.reactions.map((reaction) => reaction.emoji)).toEqual(['x']);
    expect(adapter.removedReactions).toEqual([]);
  });

  it('ignores mentions from users outside the allowlist', async () => {
    const client = {
      session: { create: vi.fn(), list: vi.fn() },
    } as unknown as OpenCodeClient;
    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: [],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      openCode: client,
      state: createMemoryState(),
      userName: 'remotecode',
      ...staticWorkspace,
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('one', 'ignored');
    await bot.getState().subscribe('mock:local:one');
    await adapter.receive('one', 'ignored follow-up', false);

    expect(client.session.create).not.toHaveBeenCalled();
    expect(adapter.outputs).toEqual([]);
    expect(adapter.reactions).toEqual([]);
  });

  it('posts generative UI cards when OpenCode emits a ```spec block for a UI-enabled adapter', async () => {
    const prompts: string[] = [];
    const messages: Array<
      | { id: string; metadata?: Record<string, unknown>; type: 'user' }
      | { content: Array<{ text: string; type: 'text' }>; id: string; type: 'assistant' }
    > = [];
    const cardResponse = [
      'Here is the release summary:',
      '',
      '```spec',
      '{"op":"add","path":"/root","value":"card"}',
      '{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Release v1.2"},"children":["kpis","actions"]}}',
      '{"op":"add","path":"/elements/kpis","value":{"type":"Fields","props":{},"children":["status"]}}',
      '{"op":"add","path":"/elements/status","value":{"type":"Field","props":{"label":"Status","value":"Ready"},"children":[]}}',
      '{"op":"add","path":"/elements/actions","value":{"type":"Actions","props":{},"children":["pr"]}}',
      '{"op":"add","path":"/elements/pr","value":{"type":"LinkButton","props":{"label":"View PR","url":"https://github.com/org/repo/pull/42"},"children":[]}}',
      '```',
    ].join('\n');
    const client = {
      experimental: { generate: { text: vi.fn(async () => ({ text: 'Release v1.2' })) } },
      message: {
        list: vi.fn(async () => ({ cursor: {}, data: [...messages].reverse() })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      question: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        create: vi.fn(async () => ({ id: 'session-ui' })),
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async (input) => {
          prompts.push(input.text);
          messages.push(
            { id: 'user-1', metadata: input.metadata, type: 'user' },
            {
              content: [{ text: cardResponse, type: 'text' }],
              id: 'assistant-1',
              type: 'assistant',
            },
          );
        }),
        update: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;
    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      openCode: client,
      state: createMemoryState(),
      uiAdapters: ['mock'],
      userName: 'remotecode',
      ...staticWorkspace,
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('deploy', 'summarize release v1.2');
    expect(prompts[0]?.startsWith('<mock>\n')).toBe(true);
    expect(prompts[0]).toContain('starts with one of these prefixes: <mock>.');
    expect(adapter.cards).toHaveLength(1);
    expect(adapter.cards[0]?.title).toBe('Release v1.2');
    expect(adapter.outputs[0]).toBe('Here is the release summary:');
    expect(adapter.outputs[1]).toContain('Status: Ready');
    expect(adapter.outputs[1]).toContain('[Link: View PR (https://github.com/org/repo/pull/42)]');
  });

  it('posts plain markdown without parsing cards for adapters without UI support', async () => {
    const prompts: string[] = [];
    const messages: Array<
      | { id: string; metadata?: Record<string, unknown>; type: 'user' }
      | { content: Array<{ text: string; type: 'text' }>; id: string; type: 'assistant' }
    > = [];
    const cardResponse = [
      '```spec',
      '{"op":"add","path":"/root","value":"card"}',
      '{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Release v1.2"},"children":[]}}',
      '```',
    ].join('\n');
    const client = {
      experimental: { generate: { text: vi.fn(async () => ({ text: 'Release v1.2' })) } },
      message: {
        list: vi.fn(async () => ({ cursor: {}, data: [...messages].reverse() })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      question: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        create: vi.fn(async () => ({ id: 'session-no-ui' })),
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async (input) => {
          prompts.push(input.text);
          messages.push(
            { id: 'user-1', metadata: input.metadata, type: 'user' },
            {
              content: [{ text: cardResponse, type: 'text' }],
              id: 'assistant-1',
              type: 'assistant',
            },
          );
        }),
        update: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;
    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      openCode: client,
      state: createMemoryState(),
      userName: 'remotecode',
      ...staticWorkspace,
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('deploy', 'summarize release v1.2');
    expect(prompts[0]?.startsWith('<mock>\n')).toBe(true);
    expect(prompts[0]).not.toContain('```spec');
    expect(adapter.cards).toHaveLength(0);
    expect(adapter.outputs).toEqual([cardResponse]);
  });

  it('streams tool progress and prose live, then posts rendered cards and sets assistant title', async () => {
    let releaseWait = () => {};
    const waitPromise = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const specBlock = [
      '```spec',
      '{"op":"add","path":"/root","value":"card"}',
      '{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Checks"},"children":["body"]}}',
      '{"op":"add","path":"/elements/body","value":{"type":"Text","props":{"content":"All green"},"children":[]}}',
      '```',
    ].join('\n');
    const fullText = `Done checking.\n\n${specBlock}`;
    const events: unknown[] = [
      {
        data: {
          assistantMessageID: 'assistant-1',
          id: 'tool-1',
          name: 'bash',
          sessionID: 'session-stream',
        },
        type: 'session.tool.input.started',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          executed: true,
          id: 'tool-1',
          input: { command: 'bun run test', description: 'Run test suite' },
          sessionID: 'session-stream',
        },
        type: 'session.tool.called',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          executed: true,
          id: 'tool-1',
          sessionID: 'session-stream',
        },
        type: 'session.tool.success',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          delta: 'Done checking.\n\n',
          ordinal: 0,
          sessionID: 'session-stream',
        },
        type: 'session.text.delta',
      },
      {
        data: {
          assistantMessageID: 'assistant-1',
          delta: specBlock,
          ordinal: 0,
          sessionID: 'session-stream',
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
      experimental: { generate: { text: vi.fn(async () => ({ text: 'Test suite run' })) } },
      message: {
        list: vi.fn(async () => ({
          cursor: {},
          data: prompted
            ? [
                {
                  content: [{ text: fullText, type: 'text' }],
                  id: 'assistant-1',
                  type: 'assistant',
                },
              ]
            : [],
        })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        create: vi.fn(async () => ({ id: 'session-stream' })),
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async () => {
          prompted = true;
        }),
        update: vi.fn(async () => {}),
        wait: vi.fn(() => waitPromise),
      },
    } as unknown as OpenCodeClient;
    const adapter = new MockAdapter('remotecode');
    const lifecycle: string[] = [];
    const origPostEphemeral = adapter.postEphemeral.bind(adapter);
    vi.spyOn(adapter, 'postEphemeral').mockImplementation(async (...args) => {
      lifecycle.push('ephemeral');
      return origPostEphemeral(...args);
    });
    const origStartTyping = adapter.startTyping.bind(adapter);
    vi.spyOn(adapter, 'startTyping').mockImplementation(async (threadId, status) => {
      lifecycle.push(`typing:${status ?? ''}`);
      return origStartTyping(threadId, status);
    });
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      openCode: client,
      state: createMemoryState(),
      uiAdapters: ['mock'],
      userName: 'remotecode',
      ...staticWorkspace,
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('stream', 'run tests');

    expect(lifecycle.slice(0, 2)).toEqual(['ephemeral', 'typing:Thinking...']);
    expect(adapter.typingStatuses).toContain('Run test suite...');
    expect(
      adapter.streamChunks.filter(
        (chunk) => typeof chunk !== 'string' && chunk.type !== 'markdown_text',
      ),
    ).toEqual([]);
    expect(adapter.cards).toHaveLength(1);
    expect(adapter.cards[0]?.title).toBe('Checks');
    expect(adapter.outputs[0]).toBe('Done checking.');
    expect(adapter.assistantTitles).toEqual(['Test suite run']);
    expect(adapter.reactions).toEqual([]);
  });

  it('steers an active turn when a follow-up message arrives mid-turn', async () => {
    const promptCalls: Array<{ delivery?: string; text: string }> = [];
    let releaseFirstWait = () => {};
    let waitCount = 0;
    let firstPromptSent = () => {};
    const firstPromptReady = new Promise<void>((resolve) => {
      firstPromptSent = resolve;
    });
    const messages: unknown[] = [];

    const client = {
      experimental: { generate: { text: vi.fn(async () => ({ text: 'Auth refactor' })) } },
      message: {
        list: vi.fn(async () => ({ cursor: {}, data: [...messages].reverse() })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        create: vi.fn(async () => ({ id: 'session-steer' })),
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(
          async (input: {
            delivery?: string;
            metadata?: Record<string, unknown>;
            text: string;
          }) => {
            promptCalls.push({ delivery: input.delivery, text: input.text });
            messages.push({
              id: `user-${promptCalls.length}`,
              metadata: input.metadata,
              type: 'user',
            });
            if (promptCalls.length === 1) {
              firstPromptSent();
            } else {
              messages.push({
                content: [{ text: 'Switched to cookies!', type: 'text' }],
                id: 'assistant-steered',
                type: 'assistant',
              });
              releaseFirstWait();
            }
          },
        ),
        update: vi.fn(async () => {}),
        wait: vi.fn(async () => {
          waitCount += 1;
          if (waitCount === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstWait = resolve;
            });
          }
        }),
      },
    } as unknown as OpenCodeClient;
    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      openCode: client,
      state: createMemoryState(),
      userName: 'remotecode',
      ...staticWorkspace,
    });
    bots.push(bot);
    await bot.initialize();

    const firstTurn = adapter.receive('steer', 'refactor auth to JWT');
    await firstPromptReady;
    vi.mocked(shouldRespond).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await adapter.receive('steer', 'fyi bob, taking a look too', false);
    await adapter.receive('steer', 'actually use cookies instead', false);
    await firstTurn;

    expect(shouldRespond).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ text: 'fyi bob, taking a look too' }),
      { assistantRunning: true },
    );
    expect(shouldRespond).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ text: 'actually use cookies instead' }),
      { assistantRunning: true },
    );
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[0]?.delivery).toBeUndefined();
    expect(promptCalls[0]?.text).toContain('refactor auth to JWT');
    expect(promptCalls[1]?.delivery).toBe('steer');
    expect(promptCalls[1]?.text).toContain('actually use cookies instead');
    expect(promptCalls[1]?.text.startsWith('<mock>\n')).toBe(true);
    expect(adapter.outputs).toEqual(['Switched to cookies!']);
    expect(adapter.typingStatuses).toContain('Updating approach...');
    expect(adapter.reactions).toEqual([]);
  });

  it('interrupts OpenCode and reacts only on the latest steered message when cancelled', async () => {
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    let promptCount = 0;
    let firstPromptSent = () => {};
    const firstPromptReady = new Promise<void>((resolve) => {
      firstPromptSent = resolve;
    });
    const client = {
      experimental: { generate: { text: vi.fn(async () => ({ text: 'Stopped' })) } },
      message: { list: vi.fn(async () => ({ cursor: {}, data: [] })) },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        create: vi.fn(async () => ({ id: 'session-stop' })),
        interrupt,
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async () => {
          promptCount += 1;
          if (promptCount === 1) firstPromptSent();
        }),
        update: vi.fn(async () => {}),
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
    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      openCode: client,
      state: createMemoryState(),
      userName: 'remotecode',
      ...staticWorkspace,
    });
    bots.push(bot);
    await bot.initialize();

    const running = adapter.receive('stop', 'do a long task');
    await firstPromptReady;
    await adapter.receive('stop', 'change direction');
    await bot.abortTurn(adapter.encodeThreadId({ channel: 'local', thread: 'stop' }));
    await running;

    expect(interrupt).toHaveBeenCalledWith({ sessionID: 'session-stop' });
    expect(adapter.reactions).toEqual([{ emoji: 'octagonal_sign', messageId: 'mock-3' }]);
    expect(adapter.endTypingCount).toBeGreaterThanOrEqual(1);
    expect(adapter.outputs).toEqual([]);
  });

  it('lazily selects and provisions needed repositories per message and tracks them in session state', async () => {
    const prompts: Array<{ metadata?: Record<string, unknown>; text: string }> = [];
    const messages: unknown[] = [];
    const initWorkspace = vi.fn(async () => ({
      availableRepos: ['api', 'dashboard'],
      directory: '/tmp/workspaces/sessions/lazy',
      provisionedRepos: [] as string[],
      repositoryRoot: '/tmp/repos',
    }));
    const provisionRepos = vi.fn(async ({ repos }: { repos: readonly string[] }) => [...repos]);
    const selectRepos = vi.fn(
      async ({
        messages: turnMessages,
        provisionedRepos,
      }: {
        messages: Array<{ text: string }>;
        provisionedRepos: readonly string[];
      }) => {
        const latest = turnMessages.at(-1)?.text ?? '';
        if (latest.includes('api')) return ['api'];
        if (latest.includes('dashboard') && !provisionedRepos.includes('dashboard')) {
          return ['dashboard'];
        }
        return [];
      },
    );
    const client = {
      experimental: { generate: { text: vi.fn(async () => ({ text: 'Lazy workspace' })) } },
      message: {
        list: vi.fn(async () => ({ cursor: {}, data: [...messages].reverse() })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        create: vi.fn(async () => ({ id: 'session-lazy' })),
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async (input: { metadata?: Record<string, unknown>; text: string }) => {
          prompts.push(input);
          messages.push(
            { id: `user-${prompts.length}`, metadata: input.metadata, type: 'user' },
            {
              content: [{ text: `reply ${prompts.length}`, type: 'text' }],
              id: `assistant-${prompts.length}`,
              type: 'assistant',
            },
          );
        }),
        update: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;
    const state = createMemoryState();
    const adapter = new MockAdapter('remotecode');
    const lifecycle: string[] = [];
    const origPostEphemeral = adapter.postEphemeral.bind(adapter);
    vi.spyOn(adapter, 'postEphemeral').mockImplementation(async (...args) => {
      lifecycle.push('ephemeral');
      return origPostEphemeral(...args);
    });
    const origStartTyping = adapter.startTyping.bind(adapter);
    vi.spyOn(adapter, 'startTyping').mockImplementation(async (threadId, status) => {
      lifecycle.push(`typing:${status ?? ''}`);
      return origStartTyping(threadId, status);
    });
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp/repos',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      initWorkspace,
      openCode: client,
      provisionRepos,
      selectRepos,
      state,
      userName: 'remotecode',
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('lazy', 'check api webhook');
    await adapter.receive('lazy', 'now check dashboard too');
    await adapter.receive('lazy', 'summarize both');

    expect(lifecycle).toEqual([
      'ephemeral',
      'typing:Thinking...',
      'typing:Preparing repositories...',
      'typing:Thinking...',
      'typing:Thinking...',
      'typing:Preparing repositories...',
      'typing:Thinking...',
      'typing:Thinking...',
    ]);

    expect(initWorkspace).toHaveBeenCalledTimes(1);
    expect(selectRepos).toHaveBeenCalledTimes(2);
    expect(selectRepos.mock.calls[0]?.[0]).toMatchObject({
      availableRepos: ['api', 'dashboard'],
      provisionedRepos: [],
      repositoryRoot: '/tmp/repos',
    });
    expect(selectRepos.mock.calls[1]?.[0]).toMatchObject({
      availableRepos: ['api', 'dashboard'],
      provisionedRepos: ['api'],
      repositoryRoot: '/tmp/repos',
    });
    expect(provisionRepos).toHaveBeenCalledTimes(2);
    expect(provisionRepos.mock.calls[0]?.[0]?.repos).toEqual(['api']);
    expect(provisionRepos.mock.calls[1]?.[0]?.repos).toEqual(['dashboard']);

    expect(prompts[0]?.metadata).toMatchObject({
      availableRepos: ['api', 'dashboard'],
      provisionedRepos: ['api'],
    });
    expect(prompts[0]?.text).toContain(
      'Workspace repositories provisioned: api. Other available repositories not checked out: dashboard.',
    );
    expect(prompts[1]?.metadata).toMatchObject({
      availableRepos: ['api', 'dashboard'],
      provisionedRepos: ['api', 'dashboard'],
    });
    expect(prompts[1]?.text).toContain('Newly provisioned workspace repositories: dashboard.');
    expect(prompts[2]?.metadata).toMatchObject({
      availableRepos: ['api', 'dashboard'],
      provisionedRepos: ['api', 'dashboard'],
    });
    expect(prompts[2]?.text).not.toContain('Newly provisioned workspace repositories:');

    const savedState = await state.get(
      `thread-state:${adapter.encodeThreadId({ channel: 'local', thread: 'lazy' })}`,
    );
    expect(savedState).toMatchObject({
      availableRepos: ['api', 'dashboard'],
      directory: '/tmp/workspaces/sessions/lazy',
      provisionedRepos: ['api', 'dashboard'],
      repositoryRoot: '/tmp/repos',
      sessionID: 'session-lazy',
    });
  });

  it('selects and provisions additional repositories during a mid-turn steer without losing them', async () => {
    const promptCalls: Array<{
      delivery?: string;
      metadata?: Record<string, unknown>;
      text: string;
    }> = [];
    let releaseFirstWait = () => {};
    let waitCount = 0;
    let firstPromptSent = () => {};
    const firstPromptReady = new Promise<void>((resolve) => {
      firstPromptSent = resolve;
    });
    const messages: unknown[] = [];

    const provisionRepos = vi.fn(async ({ repos }: { repos: readonly string[] }) => [...repos]);
    const selectRepos = vi.fn(
      async ({ messages: turnMessages }: { messages: Array<{ text: string }> }) => {
        const latest = turnMessages.at(-1)?.text ?? '';
        if (latest.includes('api')) return ['api'];
        if (latest.includes('dashboard')) return ['dashboard'];
        return [];
      },
    );

    const client = {
      experimental: { generate: { text: vi.fn(async () => ({ text: 'Steer repos' })) } },
      message: {
        list: vi.fn(async () => ({ cursor: {}, data: [...messages].reverse() })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        create: vi.fn(async () => ({ id: 'session-steer-repos' })),
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(
          async (input: {
            delivery?: string;
            metadata?: Record<string, unknown>;
            text: string;
          }) => {
            promptCalls.push(input);
            messages.push({
              id: `user-${promptCalls.length}`,
              metadata: input.metadata,
              type: 'user',
            });
            if (promptCalls.length === 1) {
              firstPromptSent();
            } else {
              messages.push({
                content: [{ text: 'Checked api and dashboard!', type: 'text' }],
                id: 'assistant-steered',
                type: 'assistant',
              });
              releaseFirstWait();
            }
          },
        ),
        update: vi.fn(async () => {}),
        wait: vi.fn(async () => {
          waitCount += 1;
          if (waitCount === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstWait = resolve;
            });
          }
        }),
      },
    } as unknown as OpenCodeClient;
    const state = createMemoryState();
    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp/repos',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      initWorkspace: async () => ({
        availableRepos: ['api', 'dashboard'],
        directory: '/tmp/workspaces/sessions/steer',
        provisionedRepos: [],
        repositoryRoot: '/tmp/repos',
      }),
      openCode: client,
      provisionRepos,
      selectRepos,
      state,
      userName: 'remotecode',
    });
    bots.push(bot);
    await bot.initialize();

    const firstTurn = adapter.receive('steer-repos', 'check api');
    await firstPromptReady;
    await adapter.receive('steer-repos', 'also check dashboard');
    await firstTurn;

    expect(provisionRepos.mock.calls.map(([input]) => input.repos)).toEqual([
      ['api'],
      ['dashboard'],
    ]);
    expect(promptCalls[1]?.delivery).toBe('steer');
    expect(promptCalls[1]?.text).toContain('Newly provisioned workspace repositories: dashboard.');
    expect(promptCalls[1]?.metadata).toMatchObject({
      availableRepos: ['api', 'dashboard'],
      provisionedRepos: ['api', 'dashboard'],
    });

    const savedState = await state.get(
      `thread-state:${adapter.encodeThreadId({ channel: 'local', thread: 'steer-repos' })}`,
    );
    expect(savedState).toMatchObject({
      availableRepos: ['api', 'dashboard'],
      provisionedRepos: ['api', 'dashboard'],
    });
  });

  it('posts intermediate text as separate messages, keeps typing status alive across steers, and refreshes on long tools', async () => {
    vi.useFakeTimers();
    const pendingEvents: unknown[] = [];
    let notifyEvent: (() => void) | undefined;
    let eventsDone = false;
    const pushEvent = (event: unknown) => {
      pendingEvents.push(event);
      notifyEvent?.();
      notifyEvent = undefined;
    };
    let waitCount = 0;
    let releaseWait = () => {};
    let promptCount = 0;
    let firstPromptSent = () => {};
    const firstPromptReady = new Promise<void>((resolve) => {
      firstPromptSent = resolve;
    });

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
      experimental: { generate: { text: vi.fn(async () => ({ text: 'Multi-message' })) } },
      message: {
        list: vi.fn(async () => ({
          cursor: {},
          data:
            promptCount > 0
              ? [
                  {
                    content: [{ text: 'Subido y monitoreando.', type: 'text' }],
                    id: 'assistant-3',
                    type: 'assistant',
                  },
                  {
                    content: [{ text: 'Anotado, saco DEFAULT_EFFORT.', type: 'text' }],
                    id: 'assistant-1',
                    type: 'assistant',
                  },
                ]
              : [],
        })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        create: vi.fn(async () => ({ id: 'session-multi' })),
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async () => {
          promptCount += 1;
          if (promptCount === 1) firstPromptSent();
        }),
        update: vi.fn(async () => {}),
        wait: vi.fn(async () => {
          waitCount += 1;
          if (waitCount === 1) {
            await new Promise<void>((resolve) => {
              releaseWait = resolve;
            });
          }
        }),
      },
    } as unknown as OpenCodeClient;

    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      openCode: client,
      state: createMemoryState(),
      userName: 'remotecode',
      ...staticWorkspace,
    });
    bots.push(bot);
    await bot.initialize();

    const turnPromise = adapter.receive('multi', 'saca default effort');
    await firstPromptReady;

    // Step 1 emits short acknowledgment, then step 2 starts a long git push.
    pushEvent({
      data: {
        assistantMessageID: 'assistant-1',
        delta: 'Anotado, saco DEFAULT_EFFORT.',
        ordinal: 0,
        sessionID: 'session-multi',
      },
      type: 'session.text.delta',
    });
    pushEvent({
      data: {
        assistantMessageID: 'assistant-2',
        sessionID: 'session-multi',
      },
      type: 'session.step.started',
    });
    pushEvent({
      data: {
        assistantMessageID: 'assistant-2',
        id: 'tool-push',
        name: 'shell',
        sessionID: 'session-multi',
      },
      type: 'session.tool.input.started',
    });
    pushEvent({
      data: {
        assistantMessageID: 'assistant-2',
        executed: true,
        id: 'tool-push',
        input: { command: 'git push' },
        sessionID: 'session-multi',
      },
      type: 'session.tool.called',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(adapter.outputs).toEqual(['Anotado, saco DEFAULT_EFFORT.']);
    expect(adapter.streamSessionStatuses).toEqual([undefined]);
    expect(adapter.typingStatuses.at(-1)).toBe('Running git push...');

    await adapter.receive('multi', 'deberia quedar mas chica');
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.typingStatuses.at(-1)).toBe('Updating approach...');

    const beforeSecondSteer = adapter.typingStatuses.length;
    await adapter.receive('multi', 'y actualiza la descripcion');
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.typingStatuses.length).toBeGreaterThan(beforeSecondSteer);
    expect(adapter.typingStatuses.at(-1)).toBe('Updating approach...');

    const beforeKeepalive = adapter.typingStatuses.length;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(adapter.typingStatuses.length).toBe(beforeKeepalive + 1);
    expect(adapter.typingStatuses.at(-1)).toBe('Updating approach...');

    pushEvent({
      data: {
        assistantMessageID: 'assistant-3',
        delta: 'Subido y monitoreando.',
        ordinal: 0,
        sessionID: 'session-multi',
      },
      type: 'session.text.delta',
    });
    eventsDone = true;
    notifyEvent?.();
    releaseWait();
    await turnPromise;

    expect(adapter.outputs).toEqual(['Anotado, saco DEFAULT_EFFORT.', 'Subido y monitoreando.']);
    expect(adapter.streamSessionStatuses).toEqual([undefined, undefined]);
    expect(adapter.endTypingCount).toBe(0);

    const finalStatusCount = adapter.typingStatuses.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(adapter.typingStatuses.length).toBe(finalStatusCount);
  });

  it('keeps working status alive and posts follow-up messages across background shell waits', async () => {
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
    let firstWaitReady = () => {};
    const firstWaitStarted = new Promise<void>((resolve) => {
      firstWaitReady = resolve;
    });

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
      experimental: { generate: { text: vi.fn(async () => ({ text: 'PR babysit' })) } },
      message: {
        list: vi.fn(async () => ({ cursor: {}, data: [...messages].reverse() })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        create: vi.fn(async () => ({ id: 'session-babysit' })),
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
        prompt: vi.fn(async (input: { metadata?: Record<string, unknown> }) => {
          messages.push({ id: 'user-1', metadata: input.metadata, type: 'user' });
        }),
        update: vi.fn(async () => {}),
        wait: vi.fn(async () => {
          waitCount += 1;
          if (waitCount === 1) firstWaitReady();
          await new Promise<void>((resolve) => {
            releaseWait = resolve;
          });
        }),
      },
    } as unknown as OpenCodeClient;

    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      allowedUsers: ['local-user'],
      config: {
        agent: 'build',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
        reposRoot: '/tmp',
        smallModel: { id: 'small-model', providerID: 'provider' },
        workspaceRoot: '/tmp/workspaces',
      },
      openCode: client,
      state: createMemoryState(),
      userName: 'remotecode',
      ...staticWorkspace,
    });
    bots.push(bot);
    await bot.initialize();

    const turnPromise = adapter.receive('babysit', 'tira una PR y babysitteala');
    await firstWaitStarted;

    // Agent opens draft PR, starts background watcher shell, and session goes idle.
    messages.push(
      {
        content: [
          {
            id: 'call-watch-1',
            name: 'shell',
            state: {
              input: { background: true, command: 'python3 watch.py' },
              metadata: { pid: 2902881, shellID: 'sh-watch-1', status: 'running' },
              status: 'completed',
            },
            type: 'tool',
          },
        ],
        id: 'assistant-1a',
        type: 'assistant',
      },
      {
        content: [
          { text: 'PR abierta en draft: https://github.com/org/repo/pull/1', type: 'text' },
        ],
        id: 'assistant-1b',
        type: 'assistant',
      },
      { id: 'idle-1', type: 'idle' },
    );
    pushEvent({
      data: {
        assistantMessageID: 'assistant-1b',
        delta: 'PR abierta en draft: https://github.com/org/repo/pull/1',
        ordinal: 0,
        sessionID: 'session-babysit',
      },
      type: 'session.text.delta',
    });
    releaseWait?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(adapter.outputs).toEqual(['PR abierta en draft: https://github.com/org/repo/pull/1']);
    expect(adapter.typingStatuses.at(-1)).toBe('Waiting for background command...');

    // Keepalive refreshes the waiting status while the background shell runs.
    const beforeKeepalive = adapter.typingStatuses.length;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(adapter.typingStatuses.length).toBeGreaterThan(beforeKeepalive);
    expect(adapter.typingStatuses.at(-1)).toBe('Waiting for background command...');

    // Background shell completes; agent resumes and posts final ready message.
    messages.push({
      id: 'syn-watch-1',
      metadata: {
        exit: 0,
        jobID: 'sh-watch-1',
        shellID: 'sh-watch-1',
        source: 'shell',
        state: 'completed',
      },
      text: '<shell id="sh-watch-1" state="completed">',
      type: 'synthetic',
    });
    pushEvent({
      data: {
        assistantMessageID: 'assistant-2',
        sessionID: 'session-babysit',
      },
      type: 'session.step.started',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(waitCount).toBe(2);
    expect(adapter.typingStatuses.at(-1)).toBe('Thinking...');

    messages.push(
      {
        content: [{ text: 'Lista para review humano.', type: 'text' }],
        id: 'assistant-2',
        type: 'assistant',
      },
      { id: 'idle-2', type: 'idle' },
    );
    pushEvent({
      data: {
        assistantMessageID: 'assistant-2',
        delta: 'Lista para review humano.',
        ordinal: 0,
        sessionID: 'session-babysit',
      },
      type: 'session.text.delta',
    });
    eventsDone = true;
    notifyEvent?.();
    releaseWait?.();
    await turnPromise;

    expect(adapter.outputs).toEqual([
      'PR abierta en draft: https://github.com/org/repo/pull/1',
      'Lista para review humano.',
    ]);
    expect(adapter.endTypingCount).toBe(0);
    expect(adapter.reactions).toEqual([]);
  });
});
