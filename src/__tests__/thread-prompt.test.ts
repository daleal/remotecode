import type { Message, Thread } from 'chat';
import { describe, expect, it, vi } from 'vitest';
import { buildThreadPrompt, messagesSince } from '../thread-prompt';
import type { ThreadState } from '../thread-session';

const message = (id: string, text: string, isBot = false) =>
  ({
    author: {
      fullName: isBot ? 'Build Bot' : 'Ada Lovelace',
      isBot,
      isMe: false,
      userId: isBot ? 'bot-1' : 'user-1',
      userName: isBot ? 'build' : 'ada',
    },
    id,
    metadata: { dateSent: new Date('2026-08-17T12:00:00.000Z') },
    text,
  }) as Message;

const threadWithMessages = (messages: Message[]) =>
  ({
    allMessages: {
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
    },
  }) as unknown as Thread<ThreadState>;

describe('messagesSince', () => {
  it('returns only messages after the checkpoint', async () => {
    const messages = [message('one', 'first'), message('two', 'second'), message('three', 'third')];

    await expect(messagesSince(threadWithMessages(messages), 'one')).resolves.toEqual(
      messages.slice(1),
    );
  });

  it('returns the full history when the checkpoint is inaccessible', async () => {
    const messages = [message('one', 'first'), message('two', 'second')];

    await expect(messagesSince(threadWithMessages(messages), 'missing')).resolves.toEqual(messages);
  });
});

describe('buildThreadPrompt', () => {
  it('formats attributed messages and first-turn instructions', async () => {
    const userTimezone = vi.fn(async (userId: string) =>
      userId === 'user-1' ? 'Europe/London' : undefined,
    );

    const prompt = await buildThreadPrompt({
      adapterName: 'slack',
      firstTurn: true,
      messages: [message('one', 'Please investigate'), message('two', 'Build failed', true)],
      userTimezone,
    });

    expect(prompt).toContain('You are working from a slack thread.');
    expect(prompt).toContain(
      '[Message from Ada Lovelace (@ada) at 2026-08-17T12:00:00.000Z (timezone: Europe/London)]\nPlease investigate',
    );
    expect(prompt).toContain(
      '[Message from Build Bot (@build, bot) at 2026-08-17T12:00:00.000Z]\nBuild failed',
    );
    expect(userTimezone).toHaveBeenCalledTimes(2);
  });

  it('omits first-turn instructions on later turns', async () => {
    const prompt = await buildThreadPrompt({
      adapterName: 'slack',
      firstTurn: false,
      messages: [message('one', 'Continue')],
    });

    expect(prompt).toBe('[Message from Ada Lovelace (@ada) at 2026-08-17T12:00:00.000Z]\nContinue');
  });
});
