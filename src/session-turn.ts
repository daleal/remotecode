import type { OpenCodeClient, SessionMessageInfo } from '@opencode/client';
import type { StreamChunk } from 'chat';

export class TurnAbortedError extends Error {
  constructor() {
    super('Turn aborted');
    this.name = 'TurnAbortedError';
  }
}

export type RunSessionTurnOptions = {
  adapterName: string;
  client: OpenCodeClient;
  files?: { uri: string; name?: string }[];
  metadata: {
    availableRepos?: string[];
    lastMessageID: string;
    provisionedRepos?: string[];
    source: string;
    threadID: string;
  };
  onChunk?: (chunk: StreamChunk) => void;
  onMessageEnd?: () => void;
  onStatus?: (status: string) => void;
  prompt: string;
  sessionID: string;
  shouldContinueWaiting?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
};

export const runSessionTurn = async ({
  adapterName,
  client,
  files,
  metadata,
  onChunk,
  onMessageEnd,
  onStatus,
  prompt,
  sessionID,
  shouldContinueWaiting,
  signal,
}: RunSessionTurnOptions) => {
  if (signal?.aborted) throw new TurnAbortedError();

  const previousAssistantIDs = await assistantMessageIDs(client, sessionID);
  let stopRequestMonitor = () => {};
  const requestMonitorStopped = new Promise<void>((resolve) => {
    stopRequestMonitor = resolve;
  });
  const requestMonitor = rejectBlockingRequests(
    client,
    adapterName,
    sessionID,
    requestMonitorStopped,
  );

  const eventAbort = new AbortController();
  let interrupted = false;
  const onAbort = () => {
    eventAbort.abort();
    if (interrupted) return;
    interrupted = true;
    void interruptSession(client, sessionID);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const streamedAssistantIDs = new Set<string>();
  let emittedAnyChunk = false;
  const emitChunk = onChunk
    ? (chunk: StreamChunk) => {
        emittedAnyChunk = true;
        onChunk(chunk);
      }
    : undefined;
  const canStreamEvents = Boolean(emitChunk && typeof client.event?.subscribe === 'function');
  const streamController = { flush: () => {} };
  const eventMonitor =
    canStreamEvents && emitChunk
      ? streamSessionEvents({
          client,
          controller: streamController,
          onChunk: emitChunk,
          onMessageEnd,
          onStatus,
          previousAssistantIDs,
          sessionID,
          signal: eventAbort.signal,
          streamedAssistantIDs,
        })
      : Promise.resolve();

  let newMessages: SessionMessageInfo[];
  try {
    await client.session.prompt({
      metadata,
      sessionID,
      text: prompt,
      ...(files?.length ? { files } : {}),
    });

    const handledSubagents = new Set<string>();
    do {
      await waitForSession(client, sessionID, signal);
      if (signal?.aborted) throw new TurnAbortedError();

      newMessages = await newSessionMessages(client, sessionID, previousAssistantIDs);
      let subagents = backgroundSubagentIDs(newMessages);
      while (subagents.some((id) => !handledSubagents.has(id))) {
        const current = subagents.filter((id) => !handledSubagents.has(id));
        streamController.flush();
        onStatus?.('Waiting for subagent...');
        let completed = completedSubagentIDs(newMessages);
        while (current.some((id) => !completed.has(id))) {
          if (signal?.aborted) throw new TurnAbortedError();
          await sleep(1000, signal);
          if (signal?.aborted) throw new TurnAbortedError();
          newMessages = await newSessionMessages(client, sessionID, previousAssistantIDs);
          completed = completedSubagentIDs(newMessages);
        }
        for (const id of current) handledSubagents.add(id);
        await waitForSession(client, sessionID, signal);
        if (signal?.aborted) throw new TurnAbortedError();
        newMessages = await newSessionMessages(client, sessionID, previousAssistantIDs);
        subagents = backgroundSubagentIDs(newMessages);
      }
    } while (!signal?.aborted && (await shouldContinueWaiting?.()));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    eventAbort.abort();
    stopRequestMonitor();
    await Promise.all([requestMonitor, eventMonitor]);
  }

  if (signal?.aborted) throw new TurnAbortedError();

  const result = newMessages.filter((item) => item.type === 'assistant');
  const finalMessage = result.at(-1);
  const replies = (finalMessage?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean);

  if (replies.length === 0) {
    const failure = result.findLast((item) => item.error);
    throw new Error(failure?.error?.message ?? 'OpenCode returned no text');
  }

  const finalText = replies.join('\n\n');
  if (emittedAnyChunk && emitChunk && finalMessage && !streamedAssistantIDs.has(finalMessage.id)) {
    if (onMessageEnd) {
      streamController.flush();
    } else if (streamedAssistantIDs.size > 0) {
      emitChunk({ text: '\n\n', type: 'markdown_text' });
    }
    emitChunk({ text: finalText, type: 'markdown_text' });
  }

  return finalText;
};

const interruptSession = async (client: OpenCodeClient, sessionID: string) => {
  try {
    await client.session.interrupt?.({ sessionID });
  } catch (error) {
    console.warn(`Could not interrupt OpenCode session ${sessionID}`, error);
  }
};

type StreamSessionEventsOptions = {
  client: OpenCodeClient;
  controller: { flush: () => void };
  onChunk: (chunk: StreamChunk) => void;
  onMessageEnd?: () => void;
  onStatus?: (status: string) => void;
  previousAssistantIDs: Set<string>;
  sessionID: string;
  signal: AbortSignal;
  streamedAssistantIDs: Set<string>;
};

const streamSessionEvents = async ({
  client,
  controller,
  onChunk,
  onMessageEnd,
  onStatus,
  previousAssistantIDs,
  sessionID,
  signal,
  streamedAssistantIDs,
}: StreamSessionEventsOptions) => {
  const toolNames = new Map<string, string>();
  const streamedTextByPart = new Map<string, string>();
  let activeAssistantID: string | undefined;
  let activeTextKey: string | undefined;
  let emittedAnyText = false;
  let lastTextEndedWithNewlines = false;

  const finishCurrentMessage = () => {
    if (!onMessageEnd || !activeAssistantID) return;
    activeAssistantID = undefined;
    activeTextKey = undefined;
    emittedAnyText = false;
    lastTextEndedWithNewlines = false;
    onMessageEnd();
  };
  controller.flush = finishCurrentMessage;

  const emitDelta = (assistantMessageID: string, ordinal: number, delta: string) => {
    if (!delta) return;
    if (onMessageEnd && activeAssistantID && activeAssistantID !== assistantMessageID) {
      finishCurrentMessage();
    }
    const key = `${assistantMessageID}:${ordinal}`;
    if (activeTextKey !== key) {
      if (emittedAnyText && !lastTextEndedWithNewlines) {
        onChunk({ text: '\n\n', type: 'markdown_text' });
      }
      activeTextKey = key;
    }
    activeAssistantID = assistantMessageID;
    streamedAssistantIDs.add(assistantMessageID);
    streamedTextByPart.set(key, (streamedTextByPart.get(key) ?? '') + delta);
    emittedAnyText = true;
    lastTextEndedWithNewlines = delta.endsWith('\n\n');
    onChunk({ text: delta, type: 'markdown_text' });
  };

  while (!signal.aborted) {
    try {
      for await (const event of client.event.subscribe({ signal })) {
        if (signal.aborted) return;
        if (!('data' in event) || !event.data || !('sessionID' in event.data)) continue;
        if (event.data.sessionID !== sessionID) continue;

        if (event.type === 'session.text.delta') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          emitDelta(event.data.assistantMessageID, event.data.ordinal, event.data.delta);
        } else if (event.type === 'session.text.ended') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          const key = `${event.data.assistantMessageID}:${event.data.ordinal}`;
          const already = streamedTextByPart.get(key) ?? '';
          if (event.data.text.startsWith(already) && event.data.text.length > already.length) {
            emitDelta(
              event.data.assistantMessageID,
              event.data.ordinal,
              event.data.text.slice(already.length),
            );
          }
        } else if (event.type === 'session.step.started') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          if (activeAssistantID && activeAssistantID !== event.data.assistantMessageID) {
            finishCurrentMessage();
            onStatus?.('Thinking...');
          }
        } else if (event.type === 'session.step.ended') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          if (event.data.finish === 'tool-calls') {
            finishCurrentMessage();
          }
        } else if (event.type === 'session.reasoning.started') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          if (activeAssistantID === event.data.assistantMessageID) continue;
          finishCurrentMessage();
          onStatus?.('Thinking...');
        } else if (event.type === 'session.tool.input.started') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          finishCurrentMessage();
          toolNames.set(event.data.id, event.data.name);
          onStatus?.(`${formatToolTitle(event.data.name)}...`);
        } else if (event.type === 'session.tool.called') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          finishCurrentMessage();
          const name = toolNames.get(event.data.id) ?? 'tool';
          onStatus?.(`${describeToolCall(name, event.data.input)}...`);
        }
      }
      return;
    } catch (error) {
      if (signal.aborted) return;
      console.warn(`OpenCode event stream failed for ${sessionID}; reconnecting`, error);
      await sleep(1000, signal);
    }
  }
};

const truncate = (value: string, maxLength: number) => {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
};

const shortPath = (value: string) => {
  const parts = value.split('/').filter(Boolean);
  return parts.length <= 2 ? value : parts.slice(-2).join('/');
};

const TOOL_TITLES: Record<string, string> = {
  bash: 'Running command',
  edit: 'Editing file',
  execute: 'Running script',
  glob: 'Finding files',
  grep: 'Searching code',
  read: 'Reading file',
  shell: 'Running command',
  subagent: 'Running subagent',
  webfetch: 'Fetching page',
  websearch: 'Searching the web',
  write: 'Writing file',
};

const formatToolTitle = (name: string) => truncate(TOOL_TITLES[name] ?? `Running ${name}`, 47);

const describeToolCall = (name: string, input: Record<string, unknown>) => {
  const str = (key: string) => (typeof input[key] === 'string' ? input[key] : undefined);
  if (name === 'bash' || name === 'shell') {
    const description = str('description');
    const command = str('command');
    return description
      ? truncate(description, 47)
      : command
        ? `Running ${truncate(command, 39)}`
        : 'Running command';
  }
  if (name === 'read') {
    const path = str('path') ?? str('filePath');
    return path ? `Reading ${truncate(shortPath(path), 39)}` : 'Reading file';
  }
  if (name === 'edit') {
    const path = str('path') ?? str('filePath');
    return path ? `Editing ${truncate(shortPath(path), 39)}` : 'Editing file';
  }
  if (name === 'write') {
    const path = str('path') ?? str('filePath');
    return path ? `Writing ${truncate(shortPath(path), 39)}` : 'Writing file';
  }
  if (name === 'grep') {
    const pattern = str('pattern');
    return pattern ? `Searching "${truncate(pattern, 35)}"` : 'Searching code';
  }
  if (name === 'glob') {
    const pattern = str('pattern');
    return pattern ? `Finding ${truncate(pattern, 39)}` : 'Finding files';
  }
  if (name === 'subagent') {
    const description = str('description');
    return description ? truncate(description, 47) : 'Running subagent';
  }
  if (name === 'websearch') {
    const query = str('query');
    return query ? `Searching "${truncate(query, 35)}"` : 'Searching the web';
  }
  if (name === 'webfetch') {
    const url = str('url');
    return url ? `Fetching ${truncate(url, 38)}` : 'Fetching page';
  }
  return formatToolTitle(name);
};

const assistantMessageIDs = async (client: OpenCodeClient, sessionID: string) => {
  let cursor: string | undefined;

  do {
    const page = await client.message.list({
      sessionID,
      limit: 100,
      ...(cursor ? { cursor } : { order: 'desc' }),
    });
    const assistant = page.data.find((item) => item.type === 'assistant');
    if (assistant) return new Set([assistant.id]);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);

  return new Set<string>();
};

const newSessionMessages = async (
  client: OpenCodeClient,
  sessionID: string,
  previousIDs: Set<string>,
) => {
  const messages: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  let reachedPrevious = false;

  do {
    const page = await client.message.list({
      sessionID,
      limit: 100,
      ...(cursor ? { cursor } : { order: 'desc' }),
    });

    for (const item of page.data) {
      if (item.type === 'assistant' && previousIDs.has(item.id)) {
        reachedPrevious = true;
        break;
      }
      messages.push(item);
    }
    cursor = page.cursor.next ?? undefined;
  } while (!reachedPrevious && cursor);

  return messages.reverse();
};

const completedSubagentIDs = (messages: SessionMessageInfo[]) =>
  new Set(
    messages
      .filter((item) => item.type === 'synthetic' && item.metadata?.source === 'subagent')
      .map((item) => item.metadata?.childID)
      .filter((id): id is string => typeof id === 'string'),
  );

const backgroundSubagentIDs = (messages: SessionMessageInfo[]) => {
  const ids: string[] = [];

  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'tool' || part.name !== 'subagent' || part.state.status !== 'completed')
        continue;
      if (part.state.input.background !== true) continue;
      const childID = part.state.metadata?.sessionID;
      if (typeof childID === 'string') ids.push(childID);
    }
  }

  return ids;
};

const waitForSession = async (client: OpenCodeClient, sessionID: string, signal?: AbortSignal) => {
  for (;;) {
    if (signal?.aborted) throw new TurnAbortedError();
    try {
      await (signal
        ? client.session.wait({ sessionID }, { signal })
        : client.session.wait({ sessionID }));
      return;
    } catch (error) {
      if (signal?.aborted) throw new TurnAbortedError();
      if (!(error instanceof Error)) throw error;
      console.warn(`OpenCode wait connection failed for ${sessionID}; reconnecting`, error);
      await sleep(1000, signal);
    }
  }
};

const rejectBlockingRequests = async (
  client: OpenCodeClient,
  adapterName: string,
  sessionID: string,
  stopped: Promise<void>,
) => {
  let running = true;
  void stopped.then(() => {
    running = false;
  });
  const sessionIDs = new Set([sessionID]);

  while (running) {
    for (const id of sessionIDs) {
      if (!running) break;
      await rejectPermissionRequests(client, adapterName, id);
      const childIDs = await discoverSubagents(client, id, () => running);
      for (const childID of childIDs) sessionIDs.add(childID);
    }
    await Promise.race([sleep(1000), stopped]);
  }
};

const discoverSubagents = async (
  client: OpenCodeClient,
  parentID: string,
  isRunning: () => boolean,
) => {
  const childIDs: string[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await client.session.list({
        parentID,
        limit: 100,
        ...(cursor ? { cursor } : { order: 'desc' }),
      });
      childIDs.push(...page.data.map((child) => child.id));
      cursor = page.cursor.next ?? undefined;
    } while (isRunning() && cursor);
  } catch (error) {
    console.error(`Could not discover OpenCode subagents for ${parentID}`, error);
  }
  return childIDs;
};

const rejectPermissionRequests = async (
  client: OpenCodeClient,
  adapterName: string,
  sessionID: string,
) => {
  try {
    const requests = await client.permission.list({ sessionID });
    for (const request of requests) {
      await client.permission.reply({
        message: `This request was automatically rejected, because the user can't see the request on ${adapterName} to approve it. User won't be able to approve permissions in this thread.`,
        decision: 'reject',
        requestID: request.id,
        sessionID,
      });
    }
  } catch (error) {
    console.error(`Could not check OpenCode permissions for ${sessionID}`, error);
  }
};

const sleep = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
