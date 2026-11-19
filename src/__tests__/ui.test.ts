import { cardToBlockKit } from '@chat-adapter/slack';
import { describe, expect, it, vi } from 'vitest';
import { adapterPrefix, parseResponseParts, supportsUI, uiInstructions } from '../ui';

const VALID_SPEC_JSONL = [
  '{"op":"add","path":"/root","value":"card"}',
  '{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Deploy Status","subtitle":"Production"},"children":["kpis","table","chart","actions"]}}',
  '{"op":"add","path":"/elements/kpis","value":{"type":"Fields","props":{},"children":["kpi-1"]}}',
  '{"op":"add","path":"/elements/kpi-1","value":{"type":"Field","props":{"label":"Uptime","value":"99.98%"},"children":[]}}',
  '{"op":"add","path":"/elements/table","value":{"type":"Table","props":{"headers":["Service","Latency"],"rows":[["api","42ms"],["web","18ms"]],"align":["left","right"]},"children":[]}}',
  '{"op":"add","path":"/elements/chart","value":{"type":"Chart","props":{"title":"Deploys","chart":{"type":"bar","categories":["Mon","Tue"],"series":[{"name":"Prod","values":[4,7]}]}},"children":[]}}',
  '{"op":"add","path":"/elements/actions","value":{"type":"Actions","props":{},"children":["link-1"]}}',
  '{"op":"add","path":"/elements/link-1","value":{"type":"LinkButton","props":{"label":"Dashboard","url":"https://example.com/deploys"},"children":[]}}',
].join('\n');

describe('uiInstructions', () => {
  it('describes the read-only json-render chat catalog gated on supported client prefixes', () => {
    const prompt = uiInstructions();

    expect(prompt).toContain(
      'ONLY when the latest user message starts with one of these prefixes: <slack>.',
    );
    expect(prompt).toContain('```spec');
    expect(prompt).toContain('Table');
    expect(prompt).toContain('Chart');
    expect(prompt).toContain('LinkButton');
    expect(prompt).toContain('Never emit Button elements');
    expect(prompt).not.toContain('- Button:');
  });

  it('lists multiple supported prefixes and returns empty string when none are enabled', () => {
    expect(uiInstructions(['slack', 'discord'])).toContain(
      'starts with one of these prefixes: <slack>, <discord>.',
    );
    expect(uiInstructions([])).toBe('');
  });
});

describe('adapterPrefix and supportsUI', () => {
  it('formats adapter prefixes and checks supported adapters', () => {
    expect(adapterPrefix('slack')).toBe('<slack>');
    expect(supportsUI('slack')).toBe(true);
    expect(supportsUI('email')).toBe(false);
    expect(supportsUI('mock', ['mock'])).toBe(true);
  });
});

describe('parseResponseParts', () => {
  it('preserves plain markdown including blank lines and non-spec JSON fences', () => {
    const markdown = [
      'Here is an RFC 6902 patch example:',
      '',
      '```json',
      '{"op":"add","path":"/root","value":"main"}',
      '```',
      '',
      'Done.',
    ].join('\n');

    expect(parseResponseParts(markdown)).toEqual([{ markdown, type: 'markdown' }]);
  });

  it('parses inline prose and a ```spec fence into markdown and a Slack-compatible card', () => {
    const response = `Here is the latest deploy overview:\n\n\`\`\`spec\n${VALID_SPEC_JSONL}\n\`\`\``;
    const parts = parseResponseParts(response);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      markdown: 'Here is the latest deploy overview:',
      type: 'markdown',
    });
    expect(parts[1]?.type).toBe('card');
    if (parts[1]?.type === 'card') {
      expect(parts[1].card.title).toBe('Deploy Status');
      expect(parts[1].card.children).toHaveLength(4);
      const blocks = cardToBlockKit(parts[1].card);
      expect(blocks.length).toBeGreaterThan(0);
    }
  });

  it('parses a standalone unfenced JSONL spec into a card', () => {
    const parts = parseResponseParts(VALID_SPEC_JSONL);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe('card');
  });

  it('parses a complete JSON spec object inside a ```spec fence', () => {
    const response = [
      '```spec',
      JSON.stringify({
        elements: {
          card: { children: ['text'], props: { title: 'Summary' }, type: 'Card' },
          text: { children: [], props: { content: 'All checks passed.' }, type: 'Text' },
        },
        root: 'card',
      }),
      '```',
    ].join('\n');

    const parts = parseResponseParts(response);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe('card');
    if (parts[0]?.type === 'card') {
      expect(parts[0].card.title).toBe('Summary');
    }
  });

  it('rejects interactive Button components and falls back to markdown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const withButton = [
      '```spec',
      '{"op":"add","path":"/root","value":"card"}',
      '{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Deploy"},"children":["actions"]}}',
      '{"op":"add","path":"/elements/actions","value":{"type":"Actions","props":{},"children":["btn"]}}',
      '{"op":"add","path":"/elements/btn","value":{"type":"Button","props":{"id":"deploy","label":"Deploy"},"children":[]}}',
      '```',
    ].join('\n');

    expect(parseResponseParts(withButton)).toEqual([{ markdown: withButton, type: 'markdown' }]);
    expect(warn).toHaveBeenCalledWith(
      'Invalid json-render card spec; falling back to markdown',
      expect.arrayContaining([expect.stringContaining('unknown component "Button"')]),
    );
    warn.mockRestore();
  });

  it('falls back to markdown and warns when a spec fails validation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invalid = [
      'Intro',
      '',
      '```spec',
      '{"op":"add","path":"/root","value":"card"}',
      '{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Bad Table"},"children":["t"]}}',
      '{"op":"add","path":"/elements/t","value":{"type":"Table","props":{"headers":["A","B"],"rows":[["only-one"]]},"children":[]}}',
      '```',
    ].join('\n');

    expect(parseResponseParts(invalid)).toEqual([{ markdown: invalid, type: 'markdown' }]);
    expect(warn).toHaveBeenCalledWith(
      'Invalid json-render card spec; falling back to markdown',
      expect.arrayContaining([expect.stringContaining('expected 2')]),
    );
    warn.mockRestore();
  });
});
