import type { OpenCodeClient } from '@opencode/client';
import { describe, expect, it, vi } from 'vitest';
import { getOrCreateThreadSession } from '../thread-session';

const config = {
  agent: 'build',
  model: { id: 'model', providerID: 'provider', variant: 'high' },
};

describe('getOrCreateThreadSession', () => {
  it('uses the session stored in thread state', async () => {
    const client = {
      session: { create: vi.fn(), list: vi.fn() },
    } as unknown as OpenCodeClient;

    await expect(
      getOrCreateThreadSession({
        adapterName: 'slack',
        client,
        config,
        directory: '/workspace',
        state: {
          availableRepos: ['api', 'web'],
          lastMessageID: 'message-1',
          provisionedRepos: ['api'],
          sessionID: 'session-1',
        },
        threadID: 'thread-1',
      }),
    ).resolves.toEqual({
      availableRepos: ['api', 'web'],
      created: false,
      lastMessageID: 'message-1',
      provisionedRepos: ['api'],
      sessionID: 'session-1',
    });
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it('recovers a matching session and repository metadata from prompt metadata', async () => {
    const listMessages = vi.fn(async (input: { cursor?: string; order?: string }) => {
      if (!input.cursor) return { cursor: { next: 'next' }, data: [] };
      return {
        cursor: {},
        data: [
          {
            id: 'user-1',
            metadata: {
              availableRepos: ['api', 'web'],
              lastMessageID: 'message-2',
              provisionedRepos: ['api'],
              threadID: 'thread-1',
            },
            type: 'user',
          },
        ],
      };
    });
    const client = {
      message: { list: listMessages },
      session: {
        create: vi.fn(),
        list: vi.fn(async () => ({
          cursor: {},
          data: [
            {
              id: 'session-1',
              location: { directory: '/workspace' },
              title: '[slack] Existing title',
            },
          ],
        })),
      },
    } as unknown as OpenCodeClient;

    await expect(
      getOrCreateThreadSession({
        adapterName: 'slack',
        client,
        config,
        directory: '/workspace',
        threadID: 'thread-1',
      }),
    ).resolves.toEqual({
      availableRepos: ['api', 'web'],
      created: false,
      lastMessageID: 'message-2',
      provisionedRepos: ['api'],
      sessionID: 'session-1',
    });
    expect(listMessages).toHaveBeenNthCalledWith(1, {
      limit: 100,
      order: 'desc',
      sessionID: 'session-1',
    });
    expect(listMessages).toHaveBeenNthCalledWith(2, {
      cursor: 'next',
      limit: 100,
      sessionID: 'session-1',
    });
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it('creates a session with repository metadata when none can be recovered', async () => {
    const client = {
      session: {
        create: vi.fn(async () => ({ id: 'session-new' })),
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
      },
    } as unknown as OpenCodeClient;

    await expect(
      getOrCreateThreadSession({
        adapterName: 'slack',
        availableRepos: ['api', 'web'],
        client,
        config,
        directory: '/workspace',
        provisionedRepos: [],
        threadID: 'thread-1',
      }),
    ).resolves.toEqual({
      availableRepos: ['api', 'web'],
      created: true,
      lastMessageID: undefined,
      provisionedRepos: [],
      sessionID: 'session-new',
    });
    expect(client.session.create).toHaveBeenCalledWith({
      agent: 'build',
      location: { directory: '/workspace' },
      metadata: {
        availableRepos: ['api', 'web'],
        provisionedRepos: [],
        threadID: 'thread-1',
      },
      model: config.model,
      permissions: [{ action: 'question', resource: '*', effect: 'deny' }],
      title: 'thread-1',
    });
  });
});
