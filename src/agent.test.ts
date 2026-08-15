import { createMemoryState } from '@chat-adapter/state-memory';
import type { OpenCodeClient } from '@opencode-ai/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from './agent';
import { MockAdapter } from './mock-adapter';

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
      message: { list: listMessages },
      session: {
        create: vi.fn(async () => ({ id: 'session-1' })),
        list: vi.fn(async () => ({ data: [], cursor: {} })),
        prompt: vi.fn(async (input) => {
          prompts.push(input);
          messages.push(
            { id: `user-${prompts.length}`, metadata: input.metadata, type: 'user' },
            {
              content: [{ text: `response ${prompts.length}`, type: 'text' }],
              id: `assistant-${prompts.length}`,
              type: 'assistant',
            },
          );
        }),
        wait: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;
    const adapter = new MockAdapter('remotecode');
    const bot = createAgent({
      adapters: { mock: adapter },
      config: {
        agent: 'build',
        directory: '/tmp',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
      },
      openCode: client,
      state: createMemoryState(),
      userTimezone: async () => 'Europe/Madrid',
      userName: 'remotecode',
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
    expect(prompts[0]?.text).toContain('Slack message from Local User (@local) at');
    expect(prompts[0]?.text).toContain('Slack message from Local User (@local, bot) at');
    expect(prompts[0]?.text).toContain('Z (user timezone: Europe/Madrid)');
    expect(prompts[1]?.text).not.toContain('background context');
    expect(prompts[1]?.text).not.toContain('first request');
    expect(prompts[1]?.text).toContain('new context');
    expect(prompts[1]?.text).toContain('second request');
    expect(adapter.reactions.map((reaction) => reaction.emoji)).toEqual([
      'eyes',
      'white_check_mark',
      'eyes',
      'white_check_mark',
    ]);
    expect(adapter.removedReactions.map((reaction) => reaction.emoji)).toEqual(['eyes', 'eyes']);
    expect(adapter.outputs).toEqual(['response 1', 'response 2']);
    expect(listMessages.mock.calls.some(([input]) => input.cursor === 'next-page')).toBe(true);
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
      config: {
        agent: 'build',
        directory: '/tmp',
        model: { id: 'model', providerID: 'provider', variant: 'high' },
      },
      openCode: client,
      state: createMemoryState(),
      userName: 'remotecode',
    });
    bots.push(bot);
    await bot.initialize();

    await adapter.receive('one', 'fail');

    expect(adapter.outputs).toEqual([]);
    expect(adapter.reactions.map((reaction) => reaction.emoji)).toEqual(['eyes', 'x']);
    expect(adapter.removedReactions.map((reaction) => reaction.emoji)).toEqual(['eyes']);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ message: 'private failure' }));
  });
});
