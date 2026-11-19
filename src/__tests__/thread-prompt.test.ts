import { createSlackAdapter } from '@chat-adapter/slack';
import type { Message, Thread } from 'chat';
import { describe, expect, it, vi } from 'vitest';
import {
  buildThreadPrompt,
  collectThreadMessages,
  messagesSince,
  threadImageFiles,
} from '../thread-prompt';
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

describe('collectThreadMessages', () => {
  it('returns new messages since checkpoint alongside bounded prior context', async () => {
    const messages = [
      message('one', 'first'),
      message('two', 'second'),
      message('three', 'third'),
      message('four', 'fourth'),
    ];

    await expect(collectThreadMessages(threadWithMessages(messages), 'three', 2)).resolves.toEqual({
      messages: [messages[3]],
      priorMessages: [messages[1], messages[2]],
    });
  });
});

describe('buildThreadPrompt', () => {
  it('preserves a forwarded Slack message link from its attachment', async () => {
    const slack = createSlackAdapter({ botToken: 'test-token', signingSecret: 'test-secret' });
    const url = 'https://example.slack.com/archives/C123/p1786968000000000';
    const forwarded = slack.parseMessage({
      type: 'message',
      channel: 'D123',
      ts: '1786968000.000001',
      user: 'U123',
      text: 'Please investigate this thread',
      attachments: [{ from_url: url, text: 'Original message', is_msg_unfurl: true }],
    });

    const prompt = await buildThreadPrompt({
      adapterName: 'slack',
      firstTurn: false,
      messages: [forwarded],
    });

    expect(prompt).toContain(`Please investigate this thread\n${url}`);
  });

  it('includes links without commentary and avoids duplicate URLs', async () => {
    const url = 'https://example.slack.com/archives/C123/p1786968000000000';
    const forwarded = message('one', '');
    forwarded.links = [{ url }, { url }];
    const options = { adapterName: 'slack', firstTurn: false, messages: [forwarded] };

    expect((await buildThreadPrompt(options)).split(url)).toHaveLength(2);

    forwarded.text = `Investigate ${url}`;
    expect((await buildThreadPrompt(options)).split(url)).toHaveLength(2);
  });

  it('formats attributed messages and first-turn instructions with adapter prefix', async () => {
    const userTimezone = vi.fn(async (userId: string) =>
      userId === 'user-1' ? 'Europe/London' : undefined,
    );

    const prompt = await buildThreadPrompt({
      adapterName: 'slack',
      firstTurn: true,
      messages: [message('one', 'Please investigate'), message('two', 'Build failed', true)],
      userTimezone,
    });

    expect(prompt.startsWith('<slack>\nYou are working from a slack thread.')).toBe(true);
    expect(prompt).toContain('starts with one of these prefixes: <slack>.');
    expect(prompt).toContain('```spec');
    expect(prompt).toContain(
      '[Message from Ada Lovelace (@ada) at 2026-08-17T12:00:00.000Z (timezone: Europe/London)]\nPlease investigate',
    );
    expect(prompt).toContain(
      '[Message from Build Bot (@build, bot) at 2026-08-17T12:00:00.000Z]\nBuild failed',
    );
    expect(userTimezone).toHaveBeenCalledTimes(2);
  });

  it('omits UI instructions on first turn for adapters without UI support', async () => {
    const prompt = await buildThreadPrompt({
      adapterName: 'email',
      firstTurn: true,
      messages: [message('one', 'Please investigate')],
    });

    expect(prompt.startsWith('<email>\nYou are working from a email thread.')).toBe(true);
    expect(prompt).not.toContain('```spec');
  });

  it('references attached images in the transcript', async () => {
    const withImage = message('one', 'What is wrong here?');
    withImage.attachments = [{ type: 'image', mimeType: 'image/png', name: 'error.png' }];

    const prompt = await buildThreadPrompt({
      adapterName: 'slack',
      firstTurn: false,
      messages: [withImage],
    });

    expect(prompt).toContain('What is wrong here?\n[Image attached: error.png]');
  });

  it('keeps the adapter prefix and omits first-turn instructions on later turns', async () => {
    const prompt = await buildThreadPrompt({
      adapterName: 'slack',
      firstTurn: false,
      messages: [message('one', 'Continue')],
    });

    expect(prompt).toBe(
      '<slack>\n[Message from Ada Lovelace (@ada) at 2026-08-17T12:00:00.000Z]\nContinue',
    );
  });

  it('includes provisioned and available repository summary on first turn and updates on later turns', async () => {
    const firstTurn = await buildThreadPrompt({
      adapterName: 'slack',
      firstTurn: true,
      messages: [message('one', 'Check api')],
      workspace: {
        availableRepos: ['api', 'dashboard', 'sdk'],
        newlyProvisionedRepos: ['api'],
        provisionedRepos: ['api'],
      },
    });
    expect(firstTurn).toContain(
      'Workspace repositories provisioned: api. Other available repositories not checked out: dashboard, sdk.',
    );

    const laterNoNew = await buildThreadPrompt({
      adapterName: 'slack',
      firstTurn: false,
      messages: [message('two', 'More details')],
      workspace: {
        availableRepos: ['api', 'dashboard', 'sdk'],
        newlyProvisionedRepos: [],
        provisionedRepos: ['api'],
      },
    });
    expect(laterNoNew).not.toContain('provisioned');

    const laterWithNew = await buildThreadPrompt({
      adapterName: 'slack',
      firstTurn: false,
      messages: [message('three', 'Check dashboard')],
      workspace: {
        availableRepos: ['api', 'dashboard', 'sdk'],
        newlyProvisionedRepos: ['dashboard'],
        provisionedRepos: ['api', 'dashboard'],
      },
    });
    expect(laterWithNew).toContain(
      'Newly provisioned workspace repositories: dashboard. Workspace repositories currently checked out: api, dashboard.',
    );
  });
});

describe('threadImageFiles', () => {
  it('downloads images as data URIs and skips other attachments and failures', async () => {
    const withFiles = message('one', 'See attached');
    withFiles.attachments = [
      {
        type: 'image',
        mimeType: 'image/png',
        name: 'error.png',
        fetchData: async () => Buffer.from('png-bytes'),
      },
      { type: 'file', mimeType: 'application/pdf', fetchData: async () => Buffer.from('pdf') },
      {
        type: 'image',
        mimeType: 'image/jpeg',
        fetchData: async () => {
          throw new Error('missing files:read');
        },
      },
    ];
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(threadImageFiles([withFiles])).resolves.toEqual([
      {
        uri: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
        name: 'error.png',
      },
    ]);
  });
});
