import type { OpenCodeClient, SessionInboxItem, SessionMessageInfo } from '@opencode/client';
import type { StreamChunk } from 'chat';

export type OpenCodeEvent =
  ReturnType<OpenCodeClient['event']['subscribe']> extends AsyncIterable<infer Event>
    ? Event
    : never;

export type SessionEventStream = (signal: AbortSignal) => AsyncIterable<OpenCodeEvent>;

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
  onAssistantMessage?: (assistantMessageID: string) => void;
  onChunk?: (chunk: StreamChunk) => void;
  onMessageEnd?: () => void;
  onStatus?: (status: string) => void;
  prompt: string;
  sessionID: string;
  shouldContinueWaiting?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
  subscribeEvents?: SessionEventStream;
};

export type ObserveSessionTurnOptions = {
  adapterName: string;
  client: OpenCodeClient;
  interruptOnAbort?: boolean;
  onAssistantMessage?: (assistantMessageID: string) => void;
  onChunk?: (chunk: StreamChunk) => void;
  onMessageEnd?: () => void;
  onStatus?: (status: string) => void;
  previousAssistantIDs?: ReadonlySet<string>;
  sessionID: string;
  shouldContinueWaiting?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
  subscribeEvents?: SessionEventStream;
};

export const runSessionTurn = async ({
  adapterName,
  client,
  files,
  metadata,
  onAssistantMessage,
  onChunk,
  onMessageEnd,
  onStatus,
  prompt,
  sessionID,
  shouldContinueWaiting,
  signal,
  subscribeEvents,
}: RunSessionTurnOptions): Promise<string> => {
  if (signal?.aborted) throw new TurnAbortedError();

  const previousAssistantIDs = await assistantMessageIDs(client, sessionID);
  const result = await executeSessionTurn({
    adapterName,
    allowEmpty: false,
    client,
    interruptOnAbort: true,
    onAssistantMessage,
    onChunk,
    onMessageEnd,
    onStatus,
    previousAssistantIDs,
    promptRequest: {
      metadata,
      sessionID,
      text: prompt,
      ...(files?.length ? { files } : {}),
    },
    sessionID,
    shouldContinueWaiting,
    signal,
    subscribeEvents,
  });
  return result ?? '';
};

export const observeSessionTurn = async ({
  adapterName,
  client,
  interruptOnAbort = false,
  onAssistantMessage,
  onChunk,
  onMessageEnd,
  onStatus,
  previousAssistantIDs,
  sessionID,
  shouldContinueWaiting,
  signal,
  subscribeEvents,
}: ObserveSessionTurnOptions): Promise<string | undefined> => {
  if (signal?.aborted) throw new TurnAbortedError();

  const resolvedPrevious = previousAssistantIDs
    ? new Set(previousAssistantIDs)
    : await assistantMessageIDs(client, sessionID);

  return executeSessionTurn({
    adapterName,
    allowEmpty: true,
    client,
    interruptOnAbort,
    onAssistantMessage,
    onChunk,
    onMessageEnd,
    onStatus,
    previousAssistantIDs: resolvedPrevious,
    sessionID,
    shouldContinueWaiting,
    signal,
    subscribeEvents,
  });
};

type ExecuteSessionTurnOptions = {
  adapterName: string;
  allowEmpty: boolean;
  client: OpenCodeClient;
  interruptOnAbort: boolean;
  onAssistantMessage?: (assistantMessageID: string) => void;
  onChunk?: (chunk: StreamChunk) => void;
  onMessageEnd?: () => void;
  onStatus?: (status: string) => void;
  previousAssistantIDs: Set<string>;
  promptRequest?: Parameters<OpenCodeClient['session']['prompt']>[0];
  sessionID: string;
  shouldContinueWaiting?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
  subscribeEvents?: SessionEventStream;
};

const executeSessionTurn = async ({
  adapterName,
  allowEmpty,
  client,
  interruptOnAbort,
  onAssistantMessage,
  onChunk,
  onMessageEnd,
  onStatus,
  previousAssistantIDs,
  promptRequest,
  sessionID,
  shouldContinueWaiting,
  signal,
  subscribeEvents,
}: ExecuteSessionTurnOptions): Promise<string | undefined> => {
  if (signal?.aborted) throw new TurnAbortedError();

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
    if (!interruptOnAbort || interrupted) return;
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
  const eventSource =
    subscribeEvents ??
    (typeof client.event?.subscribe === 'function'
      ? (eventSignal: AbortSignal) => client.event.subscribe({ signal: eventSignal })
      : undefined);
  const canStreamEvents = Boolean(emitChunk && eventSource);
  const streamController: StreamController = {
    flush: () => {},
    setWaiting: () => {},
  };
  const eventMonitor =
    canStreamEvents && emitChunk && eventSource
      ? streamSessionEvents({
          controller: streamController,
          onAssistantMessage,
          onChunk: emitChunk,
          onMessageEnd,
          onStatus,
          previousAssistantIDs,
          sessionID,
          signal: eventAbort.signal,
          streamedAssistantIDs,
          subscribeEvents: eventSource,
        })
      : Promise.resolve();

  let newMessages: SessionMessageInfo[];
  try {
    if (promptRequest) {
      await client.session.prompt(promptRequest);
    }

    for (;;) {
      streamController.setWaiting(false);
      await waitForSession(client, sessionID, signal);
      if (signal?.aborted) throw new TurnAbortedError();

      newMessages = await newSessionMessages(client, sessionID, previousAssistantIDs);
      const pending = pendingBackgroundTasks(newMessages);
      if (pending.length > 0) {
        const knownAssistantIDs = new Set(
          newMessages.filter((item) => item.type === 'assistant').map((item) => item.id),
        );
        streamController.flush();
        streamController.setWaiting(true, knownAssistantIDs);
        onStatus?.(backgroundWaitStatus(pending));
        await waitForSessionResume({
          client,
          lastMessageCount: newMessages.length,
          lastMessageID: newMessages.at(-1)?.id,
          pendingKeys: new Set(pending.map((task) => task.key)),
          previousAssistantIDs,
          sessionID,
          signal,
        });
        continue;
      }

      if (signal?.aborted) throw new TurnAbortedError();
      if (!(await shouldContinueWaiting?.())) break;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    eventAbort.abort();
    stopRequestMonitor();
    await Promise.all([requestMonitor, eventMonitor]);
  }

  if (signal?.aborted) throw new TurnAbortedError();

  const result = newMessages.filter((item) => item.type === 'assistant');
  const finalMessage = result.at(-1);
  if (finalMessage) {
    onAssistantMessage?.(finalMessage.id);
  }
  const replies = (finalMessage?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean);

  if (replies.length === 0) {
    const failure = result.findLast((item) => item.error);
    if (failure?.error) {
      throw new Error(failure.error.message ?? 'OpenCode returned no text');
    }
    if (allowEmpty) {
      return emittedAnyChunk ? '' : undefined;
    }
    throw new Error('OpenCode returned no text');
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

export const isAutonomousInboxItem = (item: SessionInboxItem): boolean => {
  if (item.type === 'user') {
    return Boolean(item.payload.metadata?.automation);
  }
  if (item.type === 'synthetic') {
    return isAutonomousSyntheticMetadata(item.payload.metadata);
  }
  return false;
};

export const isAutonomousSyntheticMetadata = (metadata?: Record<string, unknown>): boolean => {
  if (!metadata) return false;
  if (metadata.source === 'subagent') return true;
  if (typeof metadata.jobID === 'string') return true;
  if (metadata.notice === 'restart') return true;
  return false;
};

export type AutonomousTurnInspection =
  | { autonomous: false }
  | { autonomous: true; previousAssistantIDs: Set<string> };

export const inspectAutonomousTurn = async (
  client: OpenCodeClient,
  sessionID: string,
  lastDeliveredAssistantID?: string,
): Promise<AutonomousTurnInspection> => {
  let cursor: string | undefined;
  let sawAutonomous = false;
  let sawRestart = false;

  do {
    const page = await client.message.list({
      sessionID,
      limit: 100,
      ...(cursor ? { cursor } : { order: 'desc' }),
    });

    for (const item of page.data) {
      if (item.type === 'assistant') {
        if (lastDeliveredAssistantID && item.id === lastDeliveredAssistantID) {
          if (sawAutonomous) {
            return { autonomous: true, previousAssistantIDs: new Set([lastDeliveredAssistantID]) };
          }
          return { autonomous: false };
        }
        if (sawAutonomous) {
          return {
            autonomous: true,
            previousAssistantIDs: new Set([lastDeliveredAssistantID ?? item.id]),
          };
        }
        continue;
      }

      if (item.type === 'user') {
        if (item.metadata?.automation) {
          sawAutonomous = true;
          continue;
        }
        if (sawRestart && typeof item.metadata?.threadID === 'string') {
          sawAutonomous = true;
          continue;
        }
        if (!sawAutonomous) {
          return { autonomous: false };
        }
        continue;
      }

      if (item.type === 'synthetic') {
        if (item.metadata?.notice === 'restart') {
          sawRestart = true;
          continue;
        }
        if (isAutonomousSyntheticMetadata(item.metadata)) {
          sawAutonomous = true;
          continue;
        }
      }
    }

    cursor = page.cursor.next ?? undefined;
  } while (cursor);

  if (sawAutonomous) {
    return {
      autonomous: true,
      previousAssistantIDs: lastDeliveredAssistantID
        ? new Set([lastDeliveredAssistantID])
        : new Set<string>(),
    };
  }
  return { autonomous: false };
};

const interruptSession = async (client: OpenCodeClient, sessionID: string) => {
  try {
    await client.session.interrupt?.({ sessionID });
  } catch (error) {
    console.warn(`Could not interrupt OpenCode session ${sessionID}`, error);
  }
};

type StreamController = {
  flush: () => void;
  setWaiting: (waiting: boolean, knownAssistantIDs?: Set<string>) => void;
};

type StreamSessionEventsOptions = {
  controller: StreamController;
  onAssistantMessage?: (assistantMessageID: string) => void;
  onChunk: (chunk: StreamChunk) => void;
  onMessageEnd?: () => void;
  onStatus?: (status: string) => void;
  previousAssistantIDs: Set<string>;
  sessionID: string;
  signal: AbortSignal;
  streamedAssistantIDs: Set<string>;
  subscribeEvents: SessionEventStream;
};

const streamSessionEvents = async ({
  controller,
  onAssistantMessage,
  onChunk,
  onMessageEnd,
  onStatus,
  previousAssistantIDs,
  sessionID,
  signal,
  streamedAssistantIDs,
  subscribeEvents,
}: StreamSessionEventsOptions) => {
  const toolNames = new Map<string, string>();
  const streamedTextByPart = new Map<string, string>();
  let activeAssistantID: string | undefined;
  let activeTextKey: string | undefined;
  let emittedAnyText = false;
  let lastTextEndedWithNewlines = false;
  let waitingForBackground = false;
  let waitedAssistantIDs = new Set<string>();

  const finishCurrentMessage = () => {
    if (!onMessageEnd || !activeAssistantID) return;
    activeAssistantID = undefined;
    activeTextKey = undefined;
    emittedAnyText = false;
    lastTextEndedWithNewlines = false;
    onMessageEnd();
  };
  controller.flush = finishCurrentMessage;
  controller.setWaiting = (waiting, knownAssistantIDs) => {
    waitingForBackground = waiting;
    waitedAssistantIDs = waiting && knownAssistantIDs ? new Set(knownAssistantIDs) : new Set();
  };

  const isNewAssistantEvent = (assistantMessageID: string) =>
    !waitedAssistantIDs.has(assistantMessageID);

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
    onAssistantMessage?.(assistantMessageID);
    streamedTextByPart.set(key, (streamedTextByPart.get(key) ?? '') + delta);
    emittedAnyText = true;
    lastTextEndedWithNewlines = delta.endsWith('\n\n');
    onChunk({ text: delta, type: 'markdown_text' });
  };

  while (!signal.aborted) {
    let sawServerConnected = false;
    try {
      for await (const event of subscribeEvents(signal)) {
        if (signal.aborted) return;
        if (event.type === 'server.connected') {
          sawServerConnected = true;
          continue;
        }
        if (!('data' in event) || !event.data || !('sessionID' in event.data)) continue;
        if (event.data.sessionID !== sessionID) continue;

        if (event.type === 'session.text.delta') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          if (waitingForBackground && isNewAssistantEvent(event.data.assistantMessageID)) {
            waitingForBackground = false;
          }
          emitDelta(event.data.assistantMessageID, event.data.ordinal, event.data.delta);
        } else if (event.type === 'session.text.ended') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          const key = `${event.data.assistantMessageID}:${event.data.ordinal}`;
          const already = streamedTextByPart.get(key) ?? '';
          if (event.data.text.startsWith(already) && event.data.text.length > already.length) {
            if (waitingForBackground && isNewAssistantEvent(event.data.assistantMessageID)) {
              waitingForBackground = false;
            }
            emitDelta(
              event.data.assistantMessageID,
              event.data.ordinal,
              event.data.text.slice(already.length),
            );
          }
        } else if (event.type === 'session.step.started') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          const resuming =
            waitingForBackground && isNewAssistantEvent(event.data.assistantMessageID);
          if (
            resuming ||
            (activeAssistantID && activeAssistantID !== event.data.assistantMessageID)
          ) {
            waitingForBackground = false;
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
          if (waitingForBackground && !isNewAssistantEvent(event.data.assistantMessageID)) continue;
          waitingForBackground = false;
          finishCurrentMessage();
          onStatus?.('Thinking...');
        } else if (event.type === 'session.tool.input.started') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          if (waitingForBackground && !isNewAssistantEvent(event.data.assistantMessageID)) continue;
          waitingForBackground = false;
          finishCurrentMessage();
          toolNames.set(event.data.id, event.data.name);
          onStatus?.(`${formatToolTitle(event.data.name)}...`);
        } else if (event.type === 'session.tool.called') {
          if (previousAssistantIDs.has(event.data.assistantMessageID)) continue;
          if (waitingForBackground && !isNewAssistantEvent(event.data.assistantMessageID)) continue;
          waitingForBackground = false;
          finishCurrentMessage();
          const name = toolNames.get(event.data.id) ?? 'tool';
          onStatus?.(`${describeToolCall(name, event.data.input)}...`);
        } else if (event.type === 'session.idle') {
          if (waitingForBackground) {
            finishCurrentMessage();
          }
        }
      }
      if (!sawServerConnected || signal.aborted) return;
      console.warn(`OpenCode event stream closed for ${sessionID}; reconnecting`);
      await sleep(1000, signal);
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

type BackgroundTaskKind = 'job' | 'shell' | 'subagent';

type BackgroundTask = {
  id: string;
  key: string;
  kind: BackgroundTaskKind;
};

const pendingBackgroundTasks = (messages: SessionMessageInfo[]) => {
  const pending = new Map<string, BackgroundTask>();

  for (const message of messages) {
    if (message.type === 'assistant') {
      for (const part of message.content) {
        if (part.type !== 'tool' || part.state.status !== 'completed') continue;

        if (part.name === 'subagent') {
          const childID = part.state.metadata?.sessionID;
          const isBackground =
            part.state.metadata?.status === 'running' || part.state.input.background === true;
          if (isBackground && typeof childID === 'string') {
            const key = `subagent:${childID}`;
            pending.set(key, { id: childID, key, kind: 'subagent' });
          }
          continue;
        }

        if (part.name === 'shell' || part.name === 'bash') {
          const shellID = part.state.metadata?.shellID;
          const isBackground =
            part.state.metadata?.status === 'running' || part.state.input.background === true;
          if (isBackground && typeof shellID === 'string') {
            const key = `shell:${shellID}`;
            pending.set(key, { id: shellID, key, kind: 'shell' });
          }
          continue;
        }

        const jobID = part.state.metadata?.jobID;
        if (part.state.metadata?.status === 'running' && typeof jobID === 'string') {
          const key = `job:${jobID}`;
          pending.set(key, { id: jobID, key, kind: 'job' });
        }
      }
      continue;
    }

    if (message.type !== 'synthetic') continue;

    const source = message.metadata?.source;
    if (source === 'subagent') {
      const childID = message.metadata?.childID;
      if (typeof childID === 'string') {
        pending.delete(`subagent:${childID}`);
      }
    } else if (source === 'shell') {
      const shellID =
        typeof message.metadata?.shellID === 'string'
          ? message.metadata.shellID
          : typeof message.metadata?.jobID === 'string'
            ? message.metadata.jobID
            : undefined;
      if (shellID) {
        pending.delete(`shell:${shellID}`);
      }
    }
    const jobID = message.metadata?.jobID;
    if (typeof jobID === 'string') {
      pending.delete(`job:${jobID}`);
    }
  }

  return [...pending.values()];
};

const backgroundWaitStatus = (pending: readonly BackgroundTask[]) => {
  const kinds = new Set(pending.map((task) => task.kind));
  if (kinds.size === 1) {
    if (kinds.has('subagent')) {
      return pending.length === 1 ? 'Waiting for subagent...' : 'Waiting for subagents...';
    }
    if (kinds.has('shell')) {
      return pending.length === 1
        ? 'Waiting for background command...'
        : 'Waiting for background commands...';
    }
  }
  return pending.length === 1
    ? 'Waiting for background task...'
    : 'Waiting for background tasks...';
};

type WaitForSessionResumeOptions = {
  client: OpenCodeClient;
  lastMessageCount: number;
  lastMessageID?: string;
  pendingKeys: Set<string>;
  previousAssistantIDs: Set<string>;
  sessionID: string;
  signal?: AbortSignal;
};

const waitForSessionResume = async ({
  client,
  lastMessageCount,
  lastMessageID,
  pendingKeys,
  previousAssistantIDs,
  sessionID,
  signal,
}: WaitForSessionResumeOptions) => {
  for (;;) {
    if (signal?.aborted) throw new TurnAbortedError();
    await sleep(1000, signal);
    if (signal?.aborted) throw new TurnAbortedError();
    try {
      const latest = await newSessionMessages(client, sessionID, previousAssistantIDs);
      const latestPending = new Set(pendingBackgroundTasks(latest).map((task) => task.key));
      if (
        latest.length !== lastMessageCount ||
        latest.at(-1)?.id !== lastMessageID ||
        [...pendingKeys].some((key) => !latestPending.has(key))
      ) {
        return;
      }
    } catch (error) {
      if (signal?.aborted) throw new TurnAbortedError();
      if (!(error instanceof Error)) throw error;
      console.warn(`OpenCode background check failed for ${sessionID}; retrying`, error);
    }
  }
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
