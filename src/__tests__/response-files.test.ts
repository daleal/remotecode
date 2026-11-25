import type { OpenCodeClient } from '@opencode/client';
import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteFileReader,
  extractLocalFileEmbeds,
  loadFileUploads,
  LocalFileStreamFilter,
} from '../response-files';

const streamText = (text: string, chunkSize: number, enabled = true) => {
  const filter = new LocalFileStreamFilter({ enabled });
  const chunks = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(...filter.push(text.slice(index, index + chunkSize)));
  }
  const done = filter.finish();
  const markdown = [...chunks, ...done.chunks]
    .filter((chunk) => chunk.type === 'markdown_text')
    .map((chunk) => chunk.text)
    .join('');
  return { files: done.files, markdown };
};

describe('extractLocalFileEmbeds and LocalFileStreamFilter', () => {
  it.each([1, 3, 7, 100])(
    'extracts standalone local image and file embeds across chunk size %i',
    (chunkSize) => {
      const response = [
        'Aquí está el screenshot y el reporte:',
        '',
        '![Flighty landing](/tmp/opencode/flighty-landing.png)',
        '',
        '![Q4 Report](/tmp/opencode/report.pdf)',
        '',
        'Avísame si necesitas más.',
      ].join('\n');

      const streamed = streamText(response, chunkSize);
      expect(streamed.markdown).toBe(
        'Aquí está el screenshot y el reporte:\n\nAvísame si necesitas más.',
      );
      expect(streamed.files).toEqual([
        {
          alt: 'Flighty landing',
          filename: 'flighty-landing.png',
          path: '/tmp/opencode/flighty-landing.png',
        },
        {
          alt: 'Q4 Report',
          filename: 'report.pdf',
          path: '/tmp/opencode/report.pdf',
        },
      ]);

      expect(extractLocalFileEmbeds(response)).toEqual({
        files: streamed.files,
        markdown: streamed.markdown,
      });
    },
  );

  it('emits no text when the message contains only standalone file embeds', () => {
    const response = '![Flighty landing](/tmp/opencode/flighty-landing.png)';
    const streamed = streamText(response, 4);

    expect(streamed.markdown).toBe('');
    expect(streamed.files).toEqual([
      {
        alt: 'Flighty landing',
        filename: 'flighty-landing.png',
        path: '/tmp/opencode/flighty-landing.png',
      },
    ]);
    expect(extractLocalFileEmbeds(response)).toEqual({
      files: streamed.files,
      markdown: '',
    });
  });

  it('supports spaces via angle brackets, percent-encoding, file:// URIs, balanced parens, and titles', () => {
    const response = [
      '![With spaces](</tmp/my reports/q4 summary.pdf> "Q4")',
      '![Encoded](/tmp/my%20reports/export%202026.csv)',
      '![File URI](file:///tmp/opencode/diagram%201.svg)',
      '![Parens](/tmp/opencode/screenshot(1).png)',
    ].join('\n');

    const { files, markdown } = extractLocalFileEmbeds(response);
    expect(markdown).toBe('');
    expect(files).toEqual([
      {
        alt: 'With spaces',
        filename: 'q4 summary.pdf',
        path: '/tmp/my reports/q4 summary.pdf',
      },
      {
        alt: 'Encoded',
        filename: 'export 2026.csv',
        path: '/tmp/my reports/export 2026.csv',
        rawPath: '/tmp/my%20reports/export%202026.csv',
      },
      {
        alt: 'File URI',
        filename: 'diagram 1.svg',
        path: '/tmp/opencode/diagram 1.svg',
        rawPath: '/tmp/opencode/diagram%201.svg',
      },
      {
        alt: 'Parens',
        filename: 'screenshot(1).png',
        path: '/tmp/opencode/screenshot(1).png',
      },
    ]);
  });

  it('replaces inline embeds with readable filename references so prose never loses context', () => {
    const inlinePair = streamText(
      'Compara ![la primera](/tmp/first.png) y ![la segunda](/tmp/second.png).',
      3,
    );
    expect(inlinePair.markdown).toBe(
      'Compara la primera (`first.png`) y la segunda (`second.png`).',
    );
    expect(inlinePair.files).toHaveLength(2);

    const inlineStart = streamText(
      '![first.png](/tmp/first.png) y ![](/tmp/second.png) listas.',
      3,
    );
    expect(inlineStart.markdown).toBe('`first.png` y `second.png` listas.');
    expect(inlineStart.files).toHaveLength(2);

    const doubleBang = streamText('Done!![shot](/tmp/a.png)', 2);
    expect(doubleBang.markdown).toBe('Done!shot (`a.png`)');
    expect(doubleBang.files).toHaveLength(1);
  });

  it('ignores remote URLs, relative paths, directories, normal file links, escapes, and code spans/blocks', () => {
    const response = [
      'Remote: ![logo](https://example.com/logo.png) and ![cdn](//cdn.example.com/a.png)',
      'Relative: ![rel](./local.png) and ![bare](local.png) and ![dir](/tmp/opencode/)',
      'Link: [agent.ts:10](/home/user/remotecode/src/agent.ts:10)',
      'Escaped: \\![not an embed](/tmp/opencode/escaped.png)',
      'Inline code: `![code](/tmp/opencode/inline.png)` and ``![code2](/tmp/opencode/inline2.png)``',
      '',
      '```md',
      '![fenced](/tmp/opencode/fenced.png)',
      '```',
      '',
      '~~~',
      '![tilde](/tmp/opencode/tilde.png)',
      '~~~',
    ].join('\n');

    const streamed = streamText(response, 5);
    expect(streamed.files).toEqual([]);
    expect(streamed.markdown).toBe(response);
    expect(extractLocalFileEmbeds(response)).toEqual({ files: [], markdown: response });
  });

  it('passes through everything untouched when disabled', () => {
    const response = '![shot](/tmp/opencode/a.png)';
    const streamed = streamText(response, 5, false);
    expect(streamed.files).toEqual([]);
    expect(streamed.markdown).toBe(response);
  });
});

describe('createRemoteFileReader and loadFileUploads', () => {
  it('returns undefined when client.file.read is unavailable', () => {
    expect(createRemoteFileReader({} as OpenCodeClient)).toBeUndefined();
  });

  it('reads unique files via OpenCode file.read, falls back to rawPath, and skips empty or missing files', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = vi.fn(
      async (input: { location?: { directory?: string }; path: string }): Promise<Uint8Array> => {
        const full = `${input.location?.directory}/${input.path}`;
        if (full === '/tmp/opencode/shot.png') return new Uint8Array([1, 2, 3]);
        if (full === '/tmp/opencode/literal%20name.csv') return new Uint8Array([4, 5]);
        if (full === '/tmp/opencode/empty.txt') return new Uint8Array([]);
        throw new Error('ENOENT');
      },
    );
    const reader = createRemoteFileReader({ file: { read } } as unknown as OpenCodeClient);
    expect(reader).toBeDefined();

    const uploads = await loadFileUploads(
      [
        { alt: 'one', filename: 'shot.png', path: '/tmp/opencode/shot.png' },
        { alt: 'dup', filename: 'shot.png', path: '/tmp/opencode/shot.png' },
        {
          alt: 'encoded',
          filename: 'literal name.csv',
          path: '/tmp/opencode/literal name.csv',
          rawPath: '/tmp/opencode/literal%20name.csv',
        },
        { alt: 'empty', filename: 'empty.txt', path: '/tmp/opencode/empty.txt' },
        { alt: 'missing', filename: 'missing.pdf', path: '/tmp/opencode/missing.pdf' },
      ],
      reader!,
    );

    expect(uploads).toEqual([
      { data: Buffer.from([1, 2, 3]), filename: 'shot.png' },
      { data: Buffer.from([4, 5]), filename: 'literal name.csv' },
    ]);
    expect(read).toHaveBeenCalledWith({
      location: { directory: '/tmp/opencode' },
      path: 'shot.png',
    });
    expect(read).toHaveBeenCalledWith({
      location: { directory: '/tmp/opencode' },
      path: 'literal%20name.csv',
    });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
