import { posix } from 'node:path';
import type { OpenCodeClient } from '@opencode/client';
import type { FileUpload, StreamChunk } from 'chat';

export type LocalFileEmbed = {
  alt: string;
  filename: string;
  path: string;
  rawPath?: string;
};

export type ReadRemoteFile = (filePath: string) => Promise<Uint8Array>;

export const createRemoteFileReader = (client: OpenCodeClient): ReadRemoteFile | undefined => {
  if (typeof client.file?.read !== 'function') return undefined;
  return (filePath) =>
    client.file.read({
      location: { directory: posix.dirname(filePath) },
      path: posix.basename(filePath),
    });
};

export const loadFileUploads = async (
  embeds: readonly LocalFileEmbed[],
  readFile: ReadRemoteFile,
): Promise<FileUpload[]> => {
  const seen = new Set<string>();
  const unique: LocalFileEmbed[] = [];
  for (const embed of embeds) {
    if (seen.has(embed.path)) continue;
    seen.add(embed.path);
    unique.push(embed);
  }

  const results = await Promise.all(
    unique.map(async (embed): Promise<FileUpload | undefined> => {
      const bytes = await readEmbedBytes(embed, readFile);
      if (!bytes) return undefined;
      if (bytes.byteLength === 0) {
        console.warn(`Skipping empty OpenCode file ${embed.path}`);
        return undefined;
      }
      return {
        data: Buffer.from(bytes),
        filename: embed.filename,
      };
    }),
  );

  return results.filter((item): item is FileUpload => item !== undefined);
};

const readEmbedBytes = async (
  embed: LocalFileEmbed,
  readFile: ReadRemoteFile,
): Promise<Uint8Array | undefined> => {
  try {
    return await readFile(embed.path);
  } catch (error) {
    if (embed.rawPath && embed.rawPath !== embed.path) {
      try {
        return await readFile(embed.rawPath);
      } catch {
        // Fall through and log the primary path failure below.
      }
    }
    console.warn(`Could not read OpenCode file ${embed.path}`, error);
    return undefined;
  }
};

type EmbedPrefixMatch =
  | { kind: 'incomplete' }
  | { kind: 'invalid' }
  | { embed: LocalFileEmbed; kind: 'local'; length: number };

const couldBeLocalPathPrefix = (destination: string) => {
  if (!destination) return true;
  if (destination.startsWith('//')) return false;
  if (destination.startsWith('/')) return true;
  if (destination.startsWith('file:///')) return true;
  return 'file:///'.startsWith(destination);
};

const resolveLocalFilePath = (
  destination: string,
  angleBracketed: boolean,
): { filename: string; path: string; rawPath?: string } | undefined => {
  let raw: string;
  let tryDecode = false;

  if (destination.startsWith('file:///')) {
    raw = destination.slice('file://'.length);
    tryDecode = true;
  } else if (destination.startsWith('/') && !destination.startsWith('//')) {
    raw = destination;
    tryDecode = !angleBracketed;
  } else {
    return undefined;
  }

  let resolved = raw;
  let rawPath: string | undefined;
  if (tryDecode && raw.includes('%')) {
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded !== raw) {
        resolved = decoded;
        rawPath = raw;
      }
    } catch {
      resolved = raw;
    }
  }

  if (!resolved.startsWith('/') || resolved.endsWith('/')) return undefined;
  if (/[\0\r\n]/.test(resolved)) return undefined;

  const filename = posix.basename(resolved);
  if (!filename || filename === '.' || filename === '..') return undefined;

  return {
    filename,
    path: resolved,
    ...(rawPath ? { rawPath } : {}),
  };
};

const unescapeMarkdown = (value: string) => value.replace(/\\([\\[\]()<>])/g, '$1');

const isHorizontalSpace = (ch: string | undefined) => ch === ' ' || ch === '\t';

const classifyLocalEmbedPrefix = (text: string): EmbedPrefixMatch => {
  if (text[0] !== '!') return { kind: 'invalid' };
  if (text.length === 1) return { kind: 'incomplete' };
  if (text[1] !== '[') return { kind: 'invalid' };

  let index = 2;
  let bracketDepth = 0;
  let closeBracket = -1;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '\n' || ch === '\r') return { kind: 'invalid' };
    if (ch === '\\') {
      if (index + 1 >= text.length) return { kind: 'incomplete' };
      index += 2;
      continue;
    }
    if (ch === '[') {
      bracketDepth += 1;
      index += 1;
      continue;
    }
    if (ch === ']') {
      if (bracketDepth === 0) {
        closeBracket = index;
        break;
      }
      bracketDepth -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }

  if (closeBracket === -1) return { kind: 'incomplete' };

  const alt = unescapeMarkdown(text.slice(2, closeBracket));
  index = closeBracket + 1;
  if (index >= text.length) return { kind: 'incomplete' };
  if (text[index] !== '(') return { kind: 'invalid' };
  index += 1;

  while (index < text.length && isHorizontalSpace(text[index])) {
    index += 1;
  }
  if (index >= text.length) return { kind: 'incomplete' };

  let destination = '';
  let angleBracketed = false;

  if (text[index] === '<') {
    angleBracketed = true;
    index += 1;
    const start = index;
    let closed = false;
    while (index < text.length) {
      const ch = text[index];
      if (ch === '\n' || ch === '\r' || ch === '<') return { kind: 'invalid' };
      if (ch === '\\') {
        if (index + 1 >= text.length) return { kind: 'incomplete' };
        index += 2;
        continue;
      }
      if (ch === '>') {
        closed = true;
        break;
      }
      index += 1;
    }
    destination = unescapeMarkdown(text.slice(start, index));
    if (!couldBeLocalPathPrefix(destination)) return { kind: 'invalid' };
    if (!closed) return { kind: 'incomplete' };
    index += 1;
  } else {
    const start = index;
    let parenDepth = 0;
    while (index < text.length) {
      const ch = text[index];
      if (ch === '\n' || ch === '\r') return { kind: 'invalid' };
      if (isHorizontalSpace(ch)) break;
      if (ch === '\\') {
        if (index + 1 >= text.length) return { kind: 'incomplete' };
        index += 2;
        continue;
      }
      if (ch === '(') {
        parenDepth += 1;
        index += 1;
        continue;
      }
      if (ch === ')') {
        if (parenDepth === 0) break;
        parenDepth -= 1;
        index += 1;
        continue;
      }
      index += 1;
    }
    destination = unescapeMarkdown(text.slice(start, index));
    if (destination && !couldBeLocalPathPrefix(destination)) return { kind: 'invalid' };
    if (index >= text.length) return { kind: 'incomplete' };
    if (!destination) return { kind: 'invalid' };
  }

  let sawSpace = false;
  while (index < text.length && isHorizontalSpace(text[index])) {
    sawSpace = true;
    index += 1;
  }
  if (index >= text.length) return { kind: 'incomplete' };

  if (text[index] !== ')') {
    if (!sawSpace) return { kind: 'invalid' };
    const opener = text[index];
    const closer = opener === '"' ? '"' : opener === "'" ? "'" : opener === '(' ? ')' : undefined;
    if (!closer) return { kind: 'invalid' };
    index += 1;
    let closedTitle = false;
    while (index < text.length) {
      const ch = text[index];
      if (ch === '\n' || ch === '\r') return { kind: 'invalid' };
      if (ch === '\\') {
        if (index + 1 >= text.length) return { kind: 'incomplete' };
        index += 2;
        continue;
      }
      if (ch === closer) {
        closedTitle = true;
        index += 1;
        break;
      }
      index += 1;
    }
    if (!closedTitle) return { kind: 'incomplete' };
    while (index < text.length && isHorizontalSpace(text[index])) {
      index += 1;
    }
    if (index >= text.length) return { kind: 'incomplete' };
    if (text[index] !== ')') return { kind: 'invalid' };
  }

  const resolved = resolveLocalFilePath(destination, angleBracketed);
  if (!resolved) return { kind: 'invalid' };

  return {
    embed: { alt, ...resolved },
    kind: 'local',
    length: index + 1,
  };
};

const fenceMarker = (line: string) => {
  const match = line.trim().match(/^(`{3,}|~{3,})/);
  return match?.[1];
};

const isFenceToggle = (line: string, activeFence: string) => {
  const trimmed = line.trim();
  const char = activeFence[0];
  if (!char) return false;
  return (
    trimmed.length >= activeFence.length &&
    trimmed.startsWith(activeFence) &&
    [...trimmed].every((character) => character === char)
  );
};

const couldBeFenceStart = (trimmed: string) =>
  trimmed === '`' ||
  trimmed === '``' ||
  trimmed.startsWith('```') ||
  trimmed === '~' ||
  trimmed === '~~' ||
  trimmed.startsWith('~~~');

const parseStandaloneEmbedLine = (line: string): LocalFileEmbed[] | undefined => {
  let index = 0;
  const embeds: LocalFileEmbed[] = [];

  while (index < line.length) {
    while (index < line.length && isHorizontalSpace(line[index])) {
      index += 1;
    }
    if (index >= line.length) break;
    if (line[index] !== '!') return undefined;
    const match = classifyLocalEmbedPrefix(line.slice(index));
    if (match.kind !== 'local') return undefined;
    embeds.push(match.embed);
    index += match.length;
  }

  return embeds.length > 0 ? embeds : undefined;
};

const formatInlineFileReference = (embed: LocalFileEmbed) => {
  const alt = embed.alt.trim();
  if (!alt || alt === embed.filename) return `\`${embed.filename}\``;
  return `${alt} (\`${embed.filename}\`)`;
};

export class LocalFileStreamFilter {
  private activeFence: string | undefined;
  private readonly enabled: boolean;
  private readonly files: LocalFileEmbed[] = [];
  private hasEmittedProse = false;
  private inlineCodeTicks = 0;
  private justDroppedStandaloneLine = false;
  private leadingWhitespace = '';
  private lineBuffer = '';
  private midLine = false;
  private pendingBackticks = '';
  private pendingEmbed = '';
  private pendingEscape = false;

  constructor({ enabled }: { enabled: boolean }) {
    this.enabled = enabled;
  }

  push(delta: string): StreamChunk[] {
    if (!delta) return [];
    if (!this.enabled) return [{ text: delta, type: 'markdown_text' }];

    const chunks: StreamChunk[] = [];
    let cursor = 0;
    while (cursor < delta.length) {
      const newlineIndex = delta.indexOf('\n', cursor);
      if (newlineIndex === -1) {
        this.pushPartial(delta.slice(cursor), chunks);
        break;
      }
      const piece = delta.slice(cursor, newlineIndex);
      if (this.midLine) {
        this.pushInline(piece, chunks);
        this.flushInlineState(chunks);
        this.emitText('\n', chunks);
        this.resetLineState();
      } else {
        const line = this.lineBuffer + piece;
        this.lineBuffer = '';
        this.processCompleteLine(line, true, chunks);
      }
      cursor = newlineIndex + 1;
    }
    return chunks;
  }

  finish(): { chunks: StreamChunk[]; files: LocalFileEmbed[] } {
    if (!this.enabled) return { chunks: [], files: [] };

    const chunks: StreamChunk[] = [];
    if (this.midLine) {
      this.flushInlineState(chunks);
      this.resetLineState();
    } else if (this.lineBuffer) {
      const line = this.lineBuffer;
      this.lineBuffer = '';
      this.processCompleteLine(line, false, chunks);
    }
    return { chunks, files: [...this.files] };
  }

  private resetLineState() {
    this.midLine = false;
    this.inlineCodeTicks = 0;
    this.pendingBackticks = '';
    this.pendingEmbed = '';
    this.pendingEscape = false;
  }

  private pushPartial(piece: string, chunks: StreamChunk[]) {
    if (!piece) return;
    if (this.midLine) {
      this.pushInline(piece, chunks);
      return;
    }

    this.lineBuffer += piece;
    if (this.couldBeFenceOrStandalone(this.lineBuffer)) return;

    const buffered = this.lineBuffer;
    this.lineBuffer = '';
    this.justDroppedStandaloneLine = false;
    this.midLine = true;
    this.pushInline(buffered, chunks);
  }

  private couldBeFenceOrStandalone(text: string): boolean {
    const trimmed = text.trimStart();
    if (!trimmed) return true;
    if (this.activeFence) {
      const char = this.activeFence[0];
      return Boolean(char && trimmed.startsWith(char));
    }
    if (couldBeFenceStart(trimmed)) return true;

    let index = 0;
    while (index < trimmed.length) {
      while (index < trimmed.length && isHorizontalSpace(trimmed[index])) {
        index += 1;
      }
      if (index >= trimmed.length) return true;
      if (trimmed[index] !== '!') return false;
      const match = classifyLocalEmbedPrefix(trimmed.slice(index));
      if (match.kind === 'incomplete') return true;
      if (match.kind === 'invalid') return false;
      index += match.length;
    }
    return true;
  }

  private processCompleteLine(line: string, hasNewline: boolean, chunks: StreamChunk[]) {
    const suffix = hasNewline ? '\n' : '';
    if (this.activeFence) {
      this.justDroppedStandaloneLine = false;
      this.emitText(`${line}${suffix}`, chunks);
      if (isFenceToggle(line, this.activeFence)) this.activeFence = undefined;
      return;
    }

    const fence = fenceMarker(line);
    if (fence) {
      this.justDroppedStandaloneLine = false;
      this.activeFence = fence;
      this.emitText(`${line}${suffix}`, chunks);
      return;
    }

    if (this.justDroppedStandaloneLine && !line.trim()) {
      this.justDroppedStandaloneLine = false;
      return;
    }

    const standalone = parseStandaloneEmbedLine(line);
    if (standalone) {
      this.files.push(...standalone);
      this.justDroppedStandaloneLine = true;
      return;
    }

    this.justDroppedStandaloneLine = false;
    this.midLine = true;
    this.pushInline(line, chunks);
    this.flushInlineState(chunks);
    if (suffix) this.emitText(suffix, chunks);
    this.resetLineState();
  }

  private pushInline(text: string, chunks: StreamChunk[]) {
    if (this.activeFence) {
      this.emitText(text, chunks);
      return;
    }

    let index = 0;
    while (index < text.length) {
      const ch = text[index] as string;

      if (this.pendingBackticks) {
        if (ch === '`') {
          this.pendingBackticks += ch;
          index += 1;
          continue;
        }
        this.commitPendingBackticks(chunks);
      }

      if (this.pendingEmbed) {
        this.pendingEmbed += ch;
        const match = classifyLocalEmbedPrefix(this.pendingEmbed);
        if (match.kind === 'incomplete') {
          index += 1;
          continue;
        }
        if (match.kind === 'local') {
          this.files.push(match.embed);
          this.pendingEmbed = '';
          this.emitText(formatInlineFileReference(match.embed), chunks);
          index += 1;
          continue;
        }
        const failed = this.pendingEmbed;
        this.pendingEmbed = '';
        // Re-scan everything after the leading '!' in case another embed/code span starts inside it.
        this.emitText(failed[0] as string, chunks);
        this.pushInline(failed.slice(1), chunks);
        index += 1;
        continue;
      }

      if (this.inlineCodeTicks > 0) {
        if (ch === '`') {
          this.pendingBackticks = '`';
        } else {
          this.emitText(ch, chunks);
        }
        index += 1;
        continue;
      }

      if (this.pendingEscape) {
        this.pendingEscape = false;
        this.emitText(ch, chunks);
        index += 1;
        continue;
      }

      if (ch === '\\') {
        this.pendingEscape = true;
        this.emitText(ch, chunks);
        index += 1;
        continue;
      }

      if (ch === '`') {
        this.pendingBackticks = '`';
        index += 1;
        continue;
      }

      if (ch === '!') {
        this.pendingEmbed = '!';
        index += 1;
        continue;
      }

      this.emitText(ch, chunks);
      index += 1;
    }
  }

  private commitPendingBackticks(chunks: StreamChunk[]) {
    const ticks = this.pendingBackticks;
    this.pendingBackticks = '';
    if (!ticks) return;
    if (this.inlineCodeTicks === 0) {
      this.inlineCodeTicks = ticks.length;
    } else if (ticks.length === this.inlineCodeTicks) {
      this.inlineCodeTicks = 0;
    }
    this.emitText(ticks, chunks);
  }

  private flushInlineState(chunks: StreamChunk[]) {
    if (this.pendingBackticks) {
      this.commitPendingBackticks(chunks);
    }
    if (this.pendingEmbed) {
      const leftover = this.pendingEmbed;
      this.pendingEmbed = '';
      this.emitText(leftover, chunks);
    }
    this.pendingEscape = false;
  }

  private emitText(text: string, chunks: StreamChunk[]) {
    if (!text) return;
    if (!this.hasEmittedProse) {
      if (!text.trim()) {
        this.leadingWhitespace += text;
        return;
      }
      this.hasEmittedProse = true;
      const combined = this.leadingWhitespace ? `${this.leadingWhitespace}${text}` : text;
      this.leadingWhitespace = '';
      this.appendChunk(combined, chunks);
      return;
    }
    this.appendChunk(text, chunks);
  }

  private appendChunk(text: string, chunks: StreamChunk[]) {
    const previous = chunks.at(-1);
    if (previous?.type === 'markdown_text') {
      previous.text += text;
      return;
    }
    chunks.push({ text, type: 'markdown_text' });
  }
}

export const extractLocalFileEmbeds = (
  markdown: string,
): { files: LocalFileEmbed[]; markdown: string } => {
  const filter = new LocalFileStreamFilter({ enabled: true });
  const pushed = filter.push(markdown);
  const done = filter.finish();
  if (done.files.length === 0) {
    return { files: [], markdown };
  }
  const text = [...pushed, ...done.chunks]
    .filter((chunk) => chunk.type === 'markdown_text')
    .map((chunk) => chunk.text)
    .join('')
    .trim();
  return { files: done.files, markdown: text };
};
