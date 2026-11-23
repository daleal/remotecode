import type { OpenCodeClient } from '@opencode/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateAndApplySessionTitle } from '../session-title';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateAndApplySessionTitle', () => {
  it('uses the first nonempty generated line', async () => {
    const client = {
      experimental: {
        generate: {
          text: vi.fn(async () => ({ text: '\n  Investigate API failures  \nIgnored' })),
        },
      },
      session: { update: vi.fn(async () => {}) },
    } as unknown as OpenCodeClient;

    await generateAndApplySessionTitle({
      adapterName: 'slack',
      client,
      model: { id: 'small', providerID: 'provider' },
      prompt: 'User transcript',
      sessionID: 'session-1',
    });

    expect(client.experimental.generate.text).toHaveBeenCalledWith({
      model: { id: 'small', providerID: 'provider' },
      prompt: expect.stringMatching(/You are a title generator[\s\S]*User transcript$/),
    });
    expect(client.session.update).toHaveBeenCalledWith({
      sessionID: 'session-1',
      title: '[slack] Investigate API failures',
    });
  });

  it('retries when the model or provider catalog has not finished loading yet', async () => {
    const modelNotFound = Object.assign(new Error('Model not found: openai/gpt-6-luna'), {
      _tag: 'ModelNotFoundError',
      name: 'ModelNotFoundError',
    });
    const providerNotFound = Object.assign(new Error('Provider not found: openai'), {
      _tag: 'ProviderNotFoundError',
      name: 'ProviderNotFoundError',
    });
    const generateText = vi
      .fn()
      .mockRejectedValueOnce(modelNotFound)
      .mockRejectedValueOnce(providerNotFound)
      .mockResolvedValueOnce({ text: 'Recovered title' });
    const client = {
      experimental: { generate: { text: generateText } },
      session: { update: vi.fn(async () => {}) },
    } as unknown as OpenCodeClient;

    await expect(
      generateAndApplySessionTitle({
        adapterName: 'slack',
        client,
        model: { id: 'gpt-6-luna', providerID: 'openai' },
        prompt: 'User transcript',
        retryDelaysMs: [0, 0],
        sessionID: 'session-1',
      }),
    ).resolves.toBe('Recovered title');

    expect(generateText).toHaveBeenCalledTimes(3);
    expect(client.session.update).toHaveBeenCalledWith({
      sessionID: 'session-1',
      title: '[slack] Recovered title',
    });
  });

  it('logs after exhausting retries for retryable model errors', async () => {
    const modelNotFound = Object.assign(new Error('Model not found: openai/gpt-6-luna'), {
      _tag: 'ModelNotFoundError',
      name: 'ModelNotFoundError',
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const generateText = vi.fn().mockRejectedValue(modelNotFound);
    const client = {
      experimental: { generate: { text: generateText } },
      session: { update: vi.fn() },
    } as unknown as OpenCodeClient;

    await expect(
      generateAndApplySessionTitle({
        adapterName: 'slack',
        client,
        model: { id: 'gpt-6-luna', providerID: 'openai' },
        prompt: 'User transcript',
        retryDelaysMs: [0, 0],
        sessionID: 'session-1',
      }),
    ).resolves.toBeUndefined();

    expect(generateText).toHaveBeenCalledTimes(3);
    expect(errorLog).toHaveBeenCalledWith('Could not generate a session title', modelNotFound);
    expect(client.session.update).not.toHaveBeenCalled();
  });

  it('logs non-retryable generation failures immediately without rejecting', async () => {
    const failure = new Error('generation unavailable');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const generateText = vi.fn(async () => Promise.reject(failure));
    const client = {
      experimental: { generate: { text: generateText } },
      session: { update: vi.fn() },
    } as unknown as OpenCodeClient;

    await expect(
      generateAndApplySessionTitle({
        adapterName: 'slack',
        client,
        model: { id: 'small', providerID: 'provider' },
        prompt: 'User transcript',
        retryDelaysMs: [0, 0],
        sessionID: 'session-1',
      }),
    ).resolves.toBeUndefined();
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith('Could not generate a session title', failure);
    expect(client.session.update).not.toHaveBeenCalled();
  });
});
