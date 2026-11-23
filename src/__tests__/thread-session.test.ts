import type { OpenCodeClient } from '@opencode/client';
import { describe, expect, it, vi } from 'vitest';
import { getOrCreateThreadSession, resolveSessionThreadID } from '../thread-session';

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

  it('always includes threadID in session metadata even when repository lists are omitted', async () => {
    const client = {
      session: {
        create: vi.fn(async () => ({ id: 'session-minimal' })),
        list: vi.fn(async () => ({ cursor: {}, data: [] })),
      },
    } as unknown as OpenCodeClient;

    await getOrCreateThreadSession({
      adapterName: 'slack',
      client,
      config,
      directory: '/workspace',
      threadID: 'slack:C123:1.0',
    });

    expect(client.session.create).toHaveBeenCalledWith({
      agent: 'build',
      location: { directory: '/workspace' },
      metadata: { threadID: 'slack:C123:1.0' },
      model: config.model,
      permissions: [{ action: 'question', resource: '*', effect: 'deny' }],
      title: 'slack:C123:1.0',
    });
  });
});

describe('resolveSessionThreadID', () => {
  it('resolves threadID from session metadata and ignores subagents or unknown adapters', async () => {
    const client = {
      message: { list: vi.fn() },
      session: {
        get: vi.fn(async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === 'ses-main') {
            return { id: sessionID, metadata: { threadID: 'slack:C1:123.456' } };
          }
          if (sessionID === 'ses-child') {
            return {
              id: sessionID,
              metadata: { threadID: 'slack:C1:123.456' },
              parentID: 'ses-main',
            };
          }
          return { id: sessionID, metadata: { threadID: 'discord:C1:1' } };
        }),
      },
    } as unknown as OpenCodeClient;
    const adapters = new Set(['slack']);

    await expect(resolveSessionThreadID(client, 'ses-main', adapters)).resolves.toBe(
      'slack:C1:123.456',
    );
    await expect(resolveSessionThreadID(client, 'ses-child', adapters)).resolves.toBeNull();
    await expect(resolveSessionThreadID(client, 'ses-other', adapters)).resolves.toBeNull();
  });

  it('falls back to imported user prompt metadata for legacy titled sessions and returns undefined on errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = {
      message: {
        list: vi.fn(async () => ({
          cursor: {},
          data: [{ id: 'u1', metadata: { threadID: 'slack:C2:999.1' }, type: 'user' }],
        })),
      },
      session: {
        get: vi.fn(async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === 'ses-legacy') {
            return { id: sessionID, title: '[slack] Legacy thread' };
          }
          throw new Error('temporary network error');
        }),
      },
    } as unknown as OpenCodeClient;
    const adapters = new Set(['slack']);

    await expect(resolveSessionThreadID(client, 'ses-legacy', adapters)).resolves.toBe(
      'slack:C2:999.1',
    );
    await expect(resolveSessionThreadID(client, 'ses-error', adapters)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
