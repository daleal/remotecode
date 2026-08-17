import type { OpenCodeClient } from '@opencode-ai/client';
import { describe, expect, it, vi } from 'vitest';
import { runSessionTurn } from '../session-turn';

const metadata = {
  lastMessageID: 'thread-message-1',
  source: 'slack',
  threadID: 'thread-1',
};

describe('runSessionTurn', () => {
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
      reply: 'reject',
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
