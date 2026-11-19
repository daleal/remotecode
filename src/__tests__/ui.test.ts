import { cardToBlockKit } from '@chat-adapter/slack';
import { describe, expect, it, vi } from 'vitest';
import {
  adapterPrefix,
  parseResponseParts,
  SpecStreamFilter,
  supportsUI,
  uiInstructions,
} from '../ui';

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

  it('assigns unique Slack action_ids when multiple LinkButtons share the same URL', () => {
    const duplicateLinks = [
      '```spec',
      '{"op":"add","path":"/root","value":"card"}',
      '{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Links"},"children":["actions"]}}',
      '{"op":"add","path":"/elements/actions","value":{"type":"Actions","props":{},"children":["l1","l2"]}}',
      '{"op":"add","path":"/elements/l1","value":{"type":"LinkButton","props":{"label":"First","url":"https://fintoc.com"},"children":[]}}',
      '{"op":"add","path":"/elements/l2","value":{"type":"LinkButton","props":{"label":"Second","url":"https://fintoc.com"},"children":[]}}',
      '```',
    ].join('\n');

    const parts = parseResponseParts(duplicateLinks);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe('card');
    if (parts[0]?.type === 'card') {
      const blocks = cardToBlockKit(parts[0].card);
      const actionsBlock = blocks.find((block) => block.type === 'actions') as
        | { elements: Array<{ action_id: string }> }
        | undefined;
      const actionIDs = actionsBlock?.elements.map((element) => element.action_id);
      expect(actionIDs).toEqual(['link-https://fintoc.com', 'link-https://fintoc.com-1']);
    }
  });
});

describe('SpecStreamFilter', () => {
  it('streams prose immediately, hides ```spec fences without task updates, and extracts cards', () => {
    const onSpecStart = vi.fn();
    const filter = new SpecStreamFilter({ enabled: true, onSpecStart });
    const text = `Here is the overview:\n\n\`\`\`spec\n${VALID_SPEC_JSONL}\n\`\`\`\n\nAll good.`;
    const streamed = [];
    for (let index = 0; index < text.length; index += 7) {
      streamed.push(...filter.push(text.slice(index, index + 7)));
    }
    const done = filter.finish();
    const allChunks = [...streamed, ...done.chunks];
    const markdown = allChunks
      .filter((chunk) => chunk.type === 'markdown_text')
      .map((chunk) => chunk.text)
      .join('');
    const tasks = allChunks.filter((chunk) => chunk.type === 'task_update');

    expect(markdown).toBe('Here is the overview:\n\n\nAll good.');
    expect(markdown).not.toContain('"op":"add"');
    expect(tasks).toEqual([]);
    expect(onSpecStart).toHaveBeenCalledTimes(1);
    expect(done.cards).toHaveLength(1);
    expect(done.cards[0]?.title).toBe('Deploy Status');
  });

  it('extracts standalone unfenced JSONL specs without emitting markdown', () => {
    const filter = new SpecStreamFilter({ enabled: true });
    const chunks = filter.push(VALID_SPEC_JSONL);
    const done = filter.finish();

    expect(chunks).toEqual([]);
    expect(done.chunks).toEqual([]);
    expect(done.cards).toHaveLength(1);
    expect(done.cards[0]?.title).toBe('Deploy Status');
  });

  it('falls back to markdown when a streamed ```spec block is invalid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const filter = new SpecStreamFilter({ enabled: true });
    const invalid = [
      '```spec',
      '{"op":"add","path":"/root","value":"card"}',
      '{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Bad"},"children":["t"]}}',
      '{"op":"add","path":"/elements/t","value":{"type":"Table","props":{"headers":["A","B"],"rows":[["only-one"]]},"children":[]}}',
      '```',
    ].join('\n');
    const chunks = [...filter.push(invalid), ...filter.finish().chunks];
    const markdown = chunks
      .filter((chunk) => chunk.type === 'markdown_text')
      .map((chunk) => chunk.text)
      .join('');

    expect(markdown).toBe(invalid);
    expect(chunks.filter((chunk) => chunk.type === 'task_update')).toEqual([]);
    warn.mockRestore();
  });

  it('passes through non-spec code blocks and skips parsing when disabled', () => {
    const enabled = new SpecStreamFilter({ enabled: true });
    const snippet = '```ts\nconst x = 1;\n```';
    const enabledText = [...enabled.push(snippet), ...enabled.finish().chunks]
      .filter((chunk) => chunk.type === 'markdown_text')
      .map((chunk) => chunk.text)
      .join('');
    expect(enabledText).toBe(snippet);

    const disabled = new SpecStreamFilter({ enabled: false });
    const rawSpec = `\`\`\`spec\n${VALID_SPEC_JSONL}\n\`\`\``;
    expect(disabled.push(rawSpec)).toEqual([{ text: rawSpec, type: 'markdown_text' }]);
    expect(disabled.finish()).toEqual({ cards: [], chunks: [] });
  });
});
