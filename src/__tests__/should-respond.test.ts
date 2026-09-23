import { experimental_evaluate as evaluate } from 'ai';
import type { Message, Thread } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldRespond } from '../should-respond';
import type { ThreadState } from '../thread-session';

vi.mock('ai', () => ({ experimental_evaluate: vi.fn() }));
vi.mock('../config/env', () => ({
  env: { OPENROUTER_API_KEY: 'test-key', SLACK_BOT_NAME: 'remotecode' },
}));

const message = (id: string, text: string, isMe = false) =>
  ({
    id,
    text,
    author: {
      userName: isMe ? 'remotecode' : 'ada',
      userId: isMe ? 'bot' : 'user',
      isMe,
      isBot: isMe,
    },
  }) as Message;

const thread = (recentMessages: Message[]) =>
  ({
    id: 'mock:local:one',
    recentMessages,
    refresh: vi.fn(async () => {}),
  }) as unknown as Thread<ThreadState>;

const mockProbabilities = ({
  requiresResponse = 0.9,
  directedAtBot = 0.9,
  continuesBotTask = 0.1,
  directedAtOthers = 0.1,
} = {}) =>
  vi.mocked(evaluate).mockResolvedValue({
    answers: {
      requiresResponse: { type: 'boolean', probability: requiresResponse },
      directedAtBot: { type: 'boolean', probability: directedAtBot },
      continuesBotTask: { type: 'boolean', probability: continuesBotTask },
      directedAtOthers: { type: 'boolean', probability: directedAtOthers },
    },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    warnings: [],
    rounding: undefined,
    providerMetadata: undefined,
    response: { timestamp: new Date(), modelId: 'test' },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(evaluate).mockReset();
});

describe('shouldRespond', () => {
  it.each([
    [0.69, false],
    [0.7, true],
    [0.99, true],
  ] as const)('responds at the probability threshold: %s → %s', async (probability, expected) => {
    const latest = message('latest', 'Please fix it');
    mockProbabilities({ requiresResponse: probability });
    await expect(shouldRespond(thread([]), latest)).resolves.toBe(expected);
  });

  it.each([
    { name: 'remark directed at the bot', requiresResponse: 0.1, expected: false },
    { name: 'unaddressed question unrelated to its task', directedAtBot: 0.1, expected: false },
    {
      name: 'implicit task continuation',
      directedAtBot: 0.1,
      continuesBotTask: 0.7,
      expected: true,
    },
    {
      name: 'uncertain task continuation',
      directedAtBot: 0.69,
      continuesBotTask: 0.69,
      expected: false,
    },
    { name: 'direct request at the threshold', directedAtBot: 0.7, expected: true },
    {
      name: 'task discussion exclusively addressed to a human',
      continuesBotTask: 0.9,
      directedAtOthers: 0.7,
      expected: false,
    },
    { name: 'no confident other-recipient veto', directedAtOthers: 0.69, expected: true },
  ])('$name', async ({ name, expected, ...probabilities }) => {
    mockProbabilities(probabilities);
    await expect(shouldRespond(thread([]), message('latest', name))).resolves.toBe(expected);
  });

  it('includes bounded history with assistant replies and excludes queued future messages', async () => {
    mockProbabilities();
    const latest = message('latest', 'Yes, proceed');
    const assistant = message('assistant', 'Should I fix the tests?', true);
    const history = Array.from({ length: 25 }, (_value, index) =>
      message(String(index), 'x'.repeat(5000)),
    );
    const conversation = thread([...history, assistant, latest, message('future', 'Not yet')]);

    await shouldRespond(conversation, latest);

    expect(conversation.refresh).toHaveBeenCalledOnce();
    const state = vi.mocked(evaluate).mock.calls[0]?.[0].state as {
      history: Array<{ isAssistant: boolean; text: string }>;
      message: { text: string };
    };
    expect(state.history).toHaveLength(20);
    expect(state.history[0]?.text).toHaveLength(5000);
    expect(state.history.at(-1)).toMatchObject({ isAssistant: true, text: assistant.text });
    expect(state.message.text).toBe(latest.text);
    expect(JSON.stringify(state)).not.toContain('Not yet');
  });

  it('evaluates the triggering message even when Slack history has not caught up', async () => {
    mockProbabilities();
    await shouldRespond(thread([message('before', 'Prior context')]), message('new', 'Fix it'));
    expect(vi.mocked(evaluate).mock.calls[0]?.[0].state).toMatchObject({
      history: [{ text: 'Prior context' }],
      message: { text: 'Fix it' },
    });
  });

  it('logs and skips the reply when evaluation fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(evaluate).mockRejectedValue(new Error('Unavailable'));
    await expect(shouldRespond(thread([]), message('new', 'Fix it'))).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('mock:local:one'), expect.any(Error));
  });
});
