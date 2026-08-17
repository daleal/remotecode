import { describe, expect, it } from 'vitest';
import { modelSchema } from '../config/model';

describe('modelSchema', () => {
  it('validates and transforms the provider/model value', () => {
    expect(modelSchema.parse('openrouter/anthropic/claude-sonnet')).toEqual({
      id: 'anthropic/claude-sonnet',
      providerID: 'openrouter',
    });
  });

  it('rejects values without a provider', () => {
    expect(() => modelSchema.parse('claude-sonnet')).toThrow('provider/model');
  });
});
