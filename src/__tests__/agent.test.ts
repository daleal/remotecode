import { createMemoryState } from '@chat-adapter/state-memory';
import type { OpenCodeClient } from '@opencode-ai/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../agent';
import { MockAdapter } from '../mock-adapter';

const bots: Array<ReturnType<typeof createAgent>> = [];

afterEach(async () => {
  await Promise.all(bots.splice(0).map((bot) => bot.shutdown()));
  vi.restoreAllMocks();
});

describe('Slack agent', () => {
  it('imports full context once and only new messages on later mentions', async () => {
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
      generate: { text: vi.fn(async () => ({ text: 'Handle Slack requests' })) },
      message: { list: listMessages },
      permission: {
        list: vi.fn(async () => [
          { action: 'external_directory', id: 'permission-1', resources: ['/original'] },
        ]),
        reply: vi.fn(async () => {}),
      },
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
        rename: vi.fn(async () => {}),
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
      workspaceForThread: async ({ repositoryRoot }) => repositoryRoot,
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('one', 'background context', false);
    await adapter.receive('one', 'automated context', false, true);
    await adapter.receive('one', 'first request');
    await adapter.receive('one', 'new context', false);
    await adapter.receive('one', 'second request');

    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.text).toContain('background context');
    expect(prompts[0]?.text).toContain('automated context');
    expect(prompts[0]?.text).toContain('first request');
    expect(prompts[0]?.text).toContain('Message from Local User (@local) at');
    expect(prompts[0]?.text).toContain('Message from Local User (@local, bot) at');
    expect(prompts[0]?.text).toContain('Z (timezone: Europe/Madrid)');
    expect(prompts[1]?.text).not.toContain('background context');
    expect(prompts[1]?.text).not.toContain('first request');
    expect(prompts[1]?.text).toContain('new context');
    expect(prompts[1]?.text).toContain('second request');
    expect(prompts[0]?.text).toContain('Your filesystem boundary is the thread workspace at /tmp');
    expect(prompts[1]?.text).toContain('Never inspect or access parent directories');
    expect(adapter.reactions.map((reaction) => reaction.emoji)).toEqual([
      'gear',
      'eyes',
      'white_check_mark',
      'eyes',
      'white_check_mark',
    ]);
    expect(adapter.removedReactions.map((reaction) => reaction.emoji)).toEqual([
      'gear',
      'eyes',
      'eyes',
    ]);
    expect(adapter.outputs).toEqual(['response 1', 'response 2']);
    expect(postMessage.mock.calls.map(([, message]) => message)).toEqual([
      { markdown: 'response 1' },
      { markdown: 'response 2' },
    ]);
    expect(adapter.ephemeralOutputs).toEqual([
      {
        text: "To inspect this session locally, run:\n\n```\nopencode --session 'session-1'\n```",
        userId: 'local-user',
      },
    ]);
    expect(listMessages.mock.calls.some(([input]) => input.cursor === 'next-page')).toBe(true);
    expect(client.generate.text).toHaveBeenCalledWith({
      location: { directory: '/tmp' },
      model: { id: 'small-model', providerID: 'provider' },
      prompt: expect.stringContaining('You are a title generator.'),
    });
    expect(client.session.rename).toHaveBeenCalledWith({
      sessionID: 'session-1',
      title: '[mock] Handle Slack requests',
    });
    expect(client.permission.reply).toHaveBeenCalledWith({
      message:
        "This request was automatically rejected, because the user can't see the request on mock to approve it. User won't be able to approve permissions in this thread.",
      reply: 'reject',
      requestID: 'permission-1',
      sessionID: 'session-1',
    });
  });

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
      workspaceForThread: async ({ repositoryRoot }) => repositoryRoot,
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('one', 'fail');

    expect(adapter.outputs).toEqual([]);
    expect(adapter.reactions.map((reaction) => reaction.emoji)).toEqual(['gear', 'eyes', 'x']);
    expect(adapter.removedReactions.map((reaction) => reaction.emoji)).toEqual(['gear', 'eyes']);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ message: 'private failure' }));
  });

  it('reconnects while waiting for a background subagent and posts the final response', async () => {
    vi.useFakeTimers();
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages: unknown[] = [];
    let waits = 0;
    const client = {
      generate: { text: vi.fn(async () => ({ text: 'Background task' })) },
      message: {
        list: vi.fn(async () => ({ data: [...messages].reverse(), cursor: {} })),
      },
      permission: { list: vi.fn(async () => []), reply: vi.fn(async () => {}) },
      session: {
        create: vi.fn(async () => ({ id: 'session-1' })),
        list: vi.fn(async () => ({ data: [], cursor: {} })),
        prompt: vi.fn(async (input) => {
          messages.push({ id: 'user-1', metadata: input.metadata, type: 'user' });
        }),
        rename: vi.fn(async () => {}),
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
      workspaceForThread: async ({ repositoryRoot }) => repositoryRoot,
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
      workspaceForThread: async () => {
        throw new Error('workspace failure');
      },
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('one', 'fail');

    expect(adapter.reactions.map((reaction) => reaction.emoji)).toEqual(['gear', 'x']);
    expect(adapter.removedReactions.map((reaction) => reaction.emoji)).toEqual(['gear']);
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
      workspaceForThread: async ({ repositoryRoot }) => repositoryRoot,
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('one', 'ignored');

    expect(client.session.create).not.toHaveBeenCalled();
    expect(adapter.outputs).toEqual([]);
    expect(adapter.reactions).toEqual([]);
  });
});
