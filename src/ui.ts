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
import type { CardElement } from 'chat';

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

export const uiInstructions = (adapterName: string) =>
  uiCatalog.prompt({
    mode: 'inline',
    system: `You can optionally render rich ${adapterName} cards using json-render specs when structured UI helps.`,
    customRules: [
      'Use plain markdown by default. Only emit a ```spec block when structured UI (tables, charts, KPI fields, cards, or link buttons) improves clarity over plain text.',
      'Never emit Button elements; interactive actions are not supported. Only use LinkButton inside Actions for external URLs.',
      'Respect Slack limits: at most 1 Table and 2 Chart elements per card, chart titles under 50 characters, and chart labels under 20 characters.',
      'Avoid duplicating the full card content in prose outside the ```spec block.',
    ],
  });

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

const tryBuildCard = (lines: string[], options?: ToCardOptions): CardElement | undefined => {
  const spec = compileSpecBlock(lines);
  if (!spec) return undefined;

  try {
    return toCard(spec, { components: uiComponents, ...options });
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
