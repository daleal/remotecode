import type { OpenCodeClient } from '@opencode/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateAndApplySessionTitle } from '../session-title';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateAndApplySessionTitle', () => {
  it('uses the first nonempty generated line', async () => {
    const client = {
      generate: { text: vi.fn(async () => ({ text: '\n  Investigate API failures  \nIgnored' })) },
      session: { rename: vi.fn(async () => {}) },
    } as unknown as OpenCodeClient;

    await generateAndApplySessionTitle({
      adapterName: 'slack',
      client,
      model: { id: 'small', providerID: 'provider' },
      prompt: 'User transcript',
      sessionID: 'session-1',
    });

    expect(client.generate.text).toHaveBeenCalledWith({
      model: { id: 'small', providerID: 'provider' },
      prompt: expect.stringMatching(/You are a title generator[\s\S]*User transcript$/),
    });
    expect(client.session.rename).toHaveBeenCalledWith({
      sessionID: 'session-1',
      title: '[slack] Investigate API failures',
    });
  });

  it('logs generation failures without rejecting', async () => {
    const failure = new Error('generation unavailable');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = {
      generate: { text: vi.fn(async () => Promise.reject(failure)) },
      session: { rename: vi.fn() },
    } as unknown as OpenCodeClient;

    await expect(
      generateAndApplySessionTitle({
        adapterName: 'slack',
        client,
        model: { id: 'small', providerID: 'provider' },
        prompt: 'User transcript',
        sessionID: 'session-1',
      }),
    ).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledWith('Could not generate a session title', failure);
    expect(client.session.rename).not.toHaveBeenCalled();
  });
});
