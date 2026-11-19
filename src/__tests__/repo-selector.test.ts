import type { OpenCodeClient } from '@opencode/client';
import type { Message } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSelectedRepositories, selectRepositories } from '../repo-selector';
import { TurnAbortedError } from '../session-turn';

const message = (id: string, text: string, isMe = false) =>
  ({
    author: {
      fullName: isMe ? 'remotecode' : 'Ada Lovelace',
      isBot: isMe,
      isMe,
      userId: isMe ? 'bot-1' : 'user-1',
      userName: isMe ? 'remotecode' : 'ada',
    },
    id,
    metadata: { dateSent: new Date('2026-08-17T12:00:00.000Z') },
    text,
  }) as Message;

const config = {
  agent: 'build',
  smallModel: { id: 'small-model', providerID: 'provider' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseSelectedRepositories', () => {
  it('parses raw JSON arrays and filters to unprovisioned candidates in order', () => {
    expect(parseSelectedRepositories('["web", "unknown", "api", "web"]', ['api', 'web'])).toEqual([
      'api',
      'web',
    ]);
  });

  it('parses fenced JSON, wrapped arrays, and object fallbacks', () => {
    expect(parseSelectedRepositories('```json\n["web"]\n```', ['api', 'web'])).toEqual(['web']);
    expect(parseSelectedRepositories('Needed repos: ["api"]', ['api', 'web'])).toEqual(['api']);
    expect(parseSelectedRepositories('{"repositories":["web"]}', ['api', 'web'])).toEqual(['web']);
  });

  it('returns an empty list and warns on unparseable output', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSelectedRepositories('I think maybe api', ['api', 'web'])).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('selectRepositories', () => {
  it('skips creating an ephemeral session when every repository is already provisioned', async () => {
    const client = {
      session: { create: vi.fn() },
    } as unknown as OpenCodeClient;

    await expect(
      selectRepositories({
        availableRepos: ['api', 'web'],
        client,
        config,
        messages: [message('m1', 'check api')],
        provisionedRepos: ['api', 'web'],
        repositoryRoot: '/srv/repos',
        threadID: 'slack:C1:T1',
      }),
    ).resolves.toEqual([]);
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it('runs a read-only ephemeral session with the small model and removes it afterwards', async () => {
    const prompts: string[] = [];
    const client = {
      message: {
        list: vi.fn(async () => ({
          cursor: {},
          data: [
            {
              content: [{ text: '["dashboard"]', type: 'text' }],
              id: 'assistant-1',
              type: 'assistant',
            },
          ],
        })),
      },
      session: {
        create: vi.fn(async () => ({ id: 'ephemeral-1' })),
        interrupt: vi.fn(async () => ({ interrupted: true })),
        prompt: vi.fn(async (input: { text: string }) => {
          prompts.push(input.text);
        }),
        remove: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;

    const selected = await selectRepositories({
      availableRepos: ['api', 'dashboard', 'sdk'],
      client,
      config,
      messages: [message('m2', 'yes, check that too')],
      priorMessages: [message('m1', 'I would need to check dashboard next.', true)],
      provisionedRepos: ['api'],
      repositoryRoot: '/srv/repos',
      threadID: 'slack:C1:T1',
    });

    expect(selected).toEqual(['dashboard']);
    expect(client.session.create).toHaveBeenCalledWith({
      agent: 'build',
      location: { directory: '/srv/repos' },
      model: config.smallModel,
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'read', resource: '*.env', effect: 'deny' },
        { action: 'read', resource: '*.env.*', effect: 'deny' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
      ],
      title: 'Select repositories (slack:C1:T1)',
    });
    expect(prompts[0]).toContain(
      '<available_repositories>\napi\ndashboard\nsdk\n</available_repositories>',
    );
    expect(prompts[0]).toContain('<provisioned_repositories>\napi\n</provisioned_repositories>');
    expect(prompts[0]).toContain(
      '<unprovisioned_repositories>\ndashboard\nsdk\n</unprovisioned_repositories>',
    );
    expect(prompts[0]).toContain('<recent_thread_context>');
    expect(prompts[0]).toContain('I would need to check dashboard next.');
    expect(prompts[0]).toContain('yes, check that too');
    expect(client.session.remove).toHaveBeenCalledWith({ sessionID: 'ephemeral-1' });
  });

  it('removes the ephemeral session and falls back to [] when selection fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = {
      session: {
        create: vi.fn(async () => ({ id: 'ephemeral-err' })),
        prompt: vi.fn(async () => {
          throw new Error('small model unavailable');
        }),
        remove: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;

    await expect(
      selectRepositories({
        availableRepos: ['api', 'dashboard'],
        client,
        config,
        messages: [message('m1', 'check dashboard')],
        provisionedRepos: [],
        repositoryRoot: '/srv/repos',
        threadID: 'slack:C1:T1',
      }),
    ).resolves.toEqual([]);

    expect(client.session.remove).toHaveBeenCalledWith({ sessionID: 'ephemeral-err' });
    expect(errorLog).toHaveBeenCalledWith(
      'Could not select repositories for slack:C1:T1',
      expect.objectContaining({ message: 'small model unavailable' }),
    );
  });

  it('interrupts, cleans up, and throws TurnAbortedError when aborted', async () => {
    const controller = new AbortController();
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const remove = vi.fn(async () => {});
    const client = {
      session: {
        create: vi.fn(async () => ({ id: 'ephemeral-abort' })),
        interrupt,
        prompt: vi.fn(async () => {}),
        remove,
        wait: vi.fn(
          (_input: unknown, options?: { signal?: AbortSignal }) =>
            new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              });
            }),
        ),
      },
    } as unknown as OpenCodeClient;

    const promise = selectRepositories({
      availableRepos: ['api'],
      client,
      config,
      messages: [message('m1', 'check api')],
      provisionedRepos: [],
      repositoryRoot: '/srv/repos',
      signal: controller.signal,
      threadID: 'slack:C1:T1',
    });

    await vi.waitFor(() => {
      expect(client.session.wait).toHaveBeenCalled();
    });
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(TurnAbortedError);
    expect(interrupt).toHaveBeenCalledWith({ sessionID: 'ephemeral-abort' });
    expect(remove).toHaveBeenCalledWith({ sessionID: 'ephemeral-abort' });
  });
});
