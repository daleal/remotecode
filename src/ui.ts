import {
  CardSpecError,
  schema,
  standardComponentDefinitions,
  toCard,
  type ToCardOptions,
} from '@json-render/chat';
import {
  createSpecStreamCompiler,
  defineCatalog,
  parseSpecStreamLine,
  type Spec,
} from '@json-render/core';
import type { CardChild, CardElement, StreamChunk } from 'chat';

export type ResponsePart =
  | { type: 'card'; card: CardElement }
  | { type: 'markdown'; markdown: string };

const { Button: _button, ...readOnlyComponents } = standardComponentDefinitions;

export const uiComponents = {
  ...readOnlyComponents,
  Actions: {
    ...readOnlyComponents.Actions,
    description: 'Row of LinkButton elements.',
  },
};

export const uiCatalog = defineCatalog(schema, {
  components: uiComponents,
});

export const UI_SUPPORTED_ADAPTERS = ['slack'] as const;

export const adapterPrefix = (adapterName: string) => `<${adapterName}>`;

export const supportsUI = (
  adapterName: string,
  supportedAdapters: readonly string[] = UI_SUPPORTED_ADAPTERS,
) => supportedAdapters.includes(adapterName);

export const uiInstructions = (supportedAdapters: readonly string[] = UI_SUPPORTED_ADAPTERS) => {
  if (supportedAdapters.length === 0) return '';
  const prefixes = supportedAdapters.map(adapterPrefix).join(', ');
  return uiCatalog.prompt({
    mode: 'inline',
    system: `You can optionally render rich UI cards using json-render specs when structured UI helps, ONLY when the latest user message starts with one of these prefixes: ${prefixes}. If the latest user message does not start with one of those prefixes, the client cannot render json-render specs—never emit \`\`\`spec blocks or json-render JSONL patches, and respond in plain markdown only.`,
    customRules: [
      `Only emit a \`\`\`spec block or json-render JSONL when the latest user message starts with one of these prefixes: ${prefixes}. If the latest user message has no matching prefix (for example, raw messages sent directly in OpenCode or from an unsupported client), never emit \`\`\`spec blocks or json-render patches—respond in plain markdown only.`,
      'Use plain markdown by default. Even for supported prefixes, only emit a ```spec block when structured UI (tables, charts, KPI fields, cards, or link buttons) improves clarity over plain text.',
      'Never emit Button elements; interactive actions are not supported. Only use LinkButton inside Actions for external URLs.',
      'Respect Slack limits: at most 1 Table and 2 Chart elements per card, chart titles under 50 characters, and chart labels under 20 characters.',
      'Avoid duplicating the full card content in prose outside the ```spec block.',
    ],
  });
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

const fenceMarker = (line: string) => {
  const match = line.trim().match(/^(`{3,}|~{3,})(.*)$/);
  if (!match) return undefined;
  return { info: (match[2] ?? '').trim(), marker: match[1] ?? '' };
};

const isSpecInfo = (info: string) => info === 'spec' || info.startsWith('spec ');

const compileSpecBlock = (lines: string[]): Spec | undefined => {
  const compiler = createSpecStreamCompiler<Spec>();
  let applied = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const { newPatches } = compiler.push(`${trimmed}\n`);
    applied += newPatches.length;
  }

  if (applied > 0) return compiler.getResult();

  const joined = lines.join('\n').trim();
  if (!joined.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(joined);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'root' in parsed &&
      'elements' in parsed &&
      typeof parsed.root === 'string' &&
      parsed.elements &&
      typeof parsed.elements === 'object'
    ) {
      return parsed as Spec;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const ensureUniqueLinkActionIDs = (card: CardElement): CardElement => {
  const seen = new Set<string>();
  let duplicateCounter = 0;

  const uniqueID = (base: string) => {
    if (!seen.has(base)) {
      seen.add(base);
      return undefined;
    }
    let candidate: string;
    do {
      duplicateCounter += 1;
      candidate = `${base.slice(0, 240)}-${duplicateCounter}`;
    } while (seen.has(candidate));
    seen.add(candidate);
    return candidate;
  };

  const visit = (children: CardChild[]): CardChild[] =>
    children.map((child) => {
      if (child.type === 'section') {
        return { ...child, children: visit(child.children) };
      }
      if (child.type === 'actions') {
        return {
          ...child,
          children: child.children.map((item) => {
            if (item.type !== 'link-button') return item;
            const base = item.id ?? `link-${item.url.slice(0, 200)}`;
            const id = uniqueID(base);
            return id ? { ...item, id } : item;
          }),
        };
      }
      return child;
    });

  return { ...card, children: visit(card.children) };
};

const tryBuildCard = (lines: string[], options?: ToCardOptions): CardElement | undefined => {
  const spec = compileSpecBlock(lines);
  if (!spec) return undefined;

  try {
    return ensureUniqueLinkActionIDs(toCard(spec, { components: uiComponents, ...options }));
  } catch (error) {
    if (error instanceof CardSpecError) {
      console.warn('Invalid json-render card spec; falling back to markdown', error.issues);
      return undefined;
    }
    throw error;
  }
};

const tryStandaloneSpecCard = (
  response: string,
  options?: ToCardOptions,
): CardElement | undefined => {
  const lines = response
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;

  let hasSpecPath = false;
  for (const line of lines) {
    const patch = parseSpecStreamLine(line);
    if (!patch) return undefined;
    if (
      patch.path === '/root' ||
      patch.path.startsWith('/elements/') ||
      patch.path.startsWith('/state/')
    ) {
      hasSpecPath = true;
    }
  }
  if (!hasSpecPath) return undefined;

  return tryBuildCard(lines, options);
};

export const parseResponseParts = (response: string, options?: ToCardOptions): ResponsePart[] => {
  const lines = response.split(/\r?\n/);
  const parts: ResponsePart[] = [];
  let markdownLines: string[] = [];
  let specLines: string[] = [];
  let rawSpecLines: string[] = [];
  let activeFence: string | undefined;
  let inSpecFence = false;
  let foundCard = false;

  const flushMarkdown = () => {
    const markdown = markdownLines.join('\n').trim();
    markdownLines = [];
    if (markdown) parts.push({ markdown, type: 'markdown' });
  };

  for (const line of lines) {
    if (inSpecFence && activeFence) {
      rawSpecLines.push(line);
      if (isFenceToggle(line, activeFence)) {
        const card = tryBuildCard(specLines, options);
        if (card) {
          flushMarkdown();
          parts.push({ card, type: 'card' });
          foundCard = true;
        } else {
          markdownLines.push(...rawSpecLines);
        }
        inSpecFence = false;
        activeFence = undefined;
        specLines = [];
        rawSpecLines = [];
      } else {
        specLines.push(line);
      }
      continue;
    }

    if (activeFence) {
      markdownLines.push(line);
      if (isFenceToggle(line, activeFence)) activeFence = undefined;
      continue;
    }

    const fence = fenceMarker(line);
    if (fence) {
      if (isSpecInfo(fence.info)) {
        inSpecFence = true;
        activeFence = fence.marker;
        specLines = [];
        rawSpecLines = [line];
      } else {
        activeFence = fence.marker;
        markdownLines.push(line);
      }
      continue;
    }

    markdownLines.push(line);
  }

  if (inSpecFence) {
    const card = tryBuildCard(specLines, options);
    if (card) {
      flushMarkdown();
      parts.push({ card, type: 'card' });
      foundCard = true;
    } else {
      markdownLines.push(...rawSpecLines);
    }
  }

  if (!foundCard) {
    const standaloneCard = tryStandaloneSpecCard(response, options);
    if (standaloneCard) return [{ card: standaloneCard, type: 'card' }];
    return [{ markdown: response, type: 'markdown' }];
  }

  flushMarkdown();
  return parts;
};

const couldBeFenceStart = (trimmed: string) =>
  trimmed === '`' ||
  trimmed === '``' ||
  trimmed.startsWith('```') ||
  trimmed === '~' ||
  trimmed === '~~' ||
  trimmed.startsWith('~~~');

export class SpecStreamFilter {
  private activeFence: string | undefined;
  private readonly cards: CardElement[] = [];
  private readonly enabled: boolean;
  private hasEmittedProse = false;
  private inSpecFence = false;
  private leadingWhitespace = '';
  private lineBuffer = '';
  private midLine = false;
  private readonly onSpecStart?: () => void;
  private readonly options?: ToCardOptions;
  private rawSpecLines: string[] = [];
  private specLines: string[] = [];
  private standaloneLines: string[] = [];

  constructor({
    enabled,
    onSpecStart,
    options,
  }: {
    enabled: boolean;
    onSpecStart?: () => void;
    options?: ToCardOptions;
  }) {
    this.enabled = enabled;
    this.onSpecStart = onSpecStart;
    this.options = options;
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
        this.emitText(`${piece}\n`, chunks);
        this.midLine = false;
      } else {
        const line = this.lineBuffer + piece;
        this.lineBuffer = '';
        this.processLine(line, true, chunks);
      }
      cursor = newlineIndex + 1;
    }
    return chunks;
  }

  finish(): { cards: CardElement[]; chunks: StreamChunk[] } {
    if (!this.enabled) return { cards: [], chunks: [] };

    const chunks: StreamChunk[] = [];
    if (this.lineBuffer) {
      const line = this.lineBuffer;
      this.lineBuffer = '';
      this.processLine(line, false, chunks);
    }
    if (this.inSpecFence) {
      this.finalizeSpecFence(chunks, false);
    }
    if (this.standaloneLines.length > 0) {
      const raw = this.standaloneLines.join('\n');
      this.standaloneLines = [];
      const card = tryStandaloneSpecCard(raw, this.options);
      if (card) {
        this.cards.push(card);
      } else {
        this.emitText(raw, chunks);
      }
    }
    return { cards: [...this.cards], chunks };
  }

  private pushPartial(piece: string, chunks: StreamChunk[]) {
    if (!piece) return;
    if (this.midLine) {
      this.emitText(piece, chunks);
      return;
    }
    this.lineBuffer += piece;
    if (this.inSpecFence || this.standaloneLines.length > 0) return;
    if (this.couldBeFenceOrStandalone(this.lineBuffer)) return;

    const text = this.lineBuffer;
    this.lineBuffer = '';
    this.midLine = true;
    this.emitText(text, chunks);
  }

  private couldBeFenceOrStandalone(text: string) {
    const trimmed = text.trimStart();
    if (!trimmed) return true;
    if (this.activeFence) {
      const char = this.activeFence[0];
      return Boolean(char && trimmed.startsWith(char));
    }
    if (couldBeFenceStart(trimmed)) return true;
    if (!this.hasEmittedProse && trimmed.startsWith('{')) return true;
    return false;
  }

  private processLine(line: string, hasNewline: boolean, chunks: StreamChunk[]) {
    const suffix = hasNewline ? '\n' : '';
    if (this.inSpecFence && this.activeFence) {
      this.rawSpecLines.push(line);
      if (isFenceToggle(line, this.activeFence)) {
        this.finalizeSpecFence(chunks, hasNewline);
      } else {
        this.specLines.push(line);
      }
      return;
    }

    if (this.activeFence) {
      this.emitText(`${line}${suffix}`, chunks);
      if (isFenceToggle(line, this.activeFence)) this.activeFence = undefined;
      return;
    }

    if (this.standaloneLines.length > 0 || (!this.hasEmittedProse && line.trim().startsWith('{'))) {
      const trimmed = line.trim();
      if (!trimmed && this.standaloneLines.length > 0) {
        this.standaloneLines.push(line);
        return;
      }
      if (trimmed && parseSpecStreamLine(trimmed)) {
        this.standaloneLines.push(line);
        return;
      }
      if (this.standaloneLines.length > 0) {
        this.emitText(`${this.standaloneLines.join('\n')}\n`, chunks);
        this.standaloneLines = [];
      }
    }

    const fence = fenceMarker(line);
    if (fence) {
      if (isSpecInfo(fence.info)) {
        this.inSpecFence = true;
        this.activeFence = fence.marker;
        this.specLines = [];
        this.rawSpecLines = [line];
        this.onSpecStart?.();
      } else {
        this.activeFence = fence.marker;
        this.emitText(`${line}${suffix}`, chunks);
      }
      return;
    }

    this.emitText(`${line}${suffix}`, chunks);
  }

  private finalizeSpecFence(chunks: StreamChunk[], trailingNewline: boolean) {
    const card = tryBuildCard(this.specLines, this.options);
    if (card) {
      this.cards.push(card);
    } else {
      this.emitText(`${this.rawSpecLines.join('\n')}${trailingNewline ? '\n' : ''}`, chunks);
    }
    this.inSpecFence = false;
    this.activeFence = undefined;
    this.specLines = [];
    this.rawSpecLines = [];
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
      chunks.push({ text: combined, type: 'markdown_text' });
      return;
    }
    chunks.push({ text, type: 'markdown_text' });
  }
}
