import type { OpenCodeClient } from '@opencode/client';
import {
  Chat,
  StreamingPlan,
  type Adapter,
  type Message,
  type StateAdapter,
  type StreamChunk,
  type Thread,
} from 'chat';
import type { OpenCodeConfig } from './opencode';
import { generateAndApplySessionTitle } from './session-title';
import { runSessionTurn, TurnAbortedError } from './session-turn';
import { shouldRespond } from './should-respond';
import { buildThreadPrompt, messagesSince, threadImageFiles } from './thread-prompt';
import { getOrCreateThreadSession, type ThreadState } from './thread-session';
import { parseResponseParts, SpecStreamFilter, supportsUI } from './ui';
import { createThreadWorkspace } from './workspace';

type CreateAgentOptions = {
  adapters: Record<string, Adapter>;
  allowedUsers: string[];
  config: OpenCodeConfig;
  openCode: OpenCodeClient;
  state: StateAdapter;
  uiAdapters?: readonly string[];
  userTimezone?: (userId: string) => Promise<string | undefined>;
  userName: string;
  workspaceForThread?: typeof createThreadWorkspace;
};

type ProcessMentionOptions = {
  client: OpenCodeClient;
  config: OpenCodeConfig;
  directory: string;
  getLastMessageID?: () => string | undefined;
  onChunk?: (chunk: StreamChunk) => void;
  onSessionReady?: (sessionID: string, lastMessageID: string) => void;
  onStatus?: (status: string) => void;
  shouldContinueWaiting?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
  thread: Thread<ThreadState>;
  triggeringMessage: Message;
  uiAdapters?: readonly string[];
  userTimezone?: (userId: string) => Promise<string | undefined>;
};

type ReactionOptions = {
  emoji: string;
  messageID: string;
  thread: Thread<ThreadState>;
};

type ActiveTurn = {
  closing: boolean;
  finished: Promise<void>;
  lastMessageID?: string;
  onSteer?: (message: Message) => void;
  rejectSession: (error: unknown) => void;
  resolveFinished: () => void;
  resolveSession: (sessionID: string) => void;
  sessionReady: Promise<string>;
  sessionSettled: boolean;
  steerChain: Promise<void>;
  steerEpoch: number;
  steeredMessageIDs: string[];
};

const createActiveTurn = (): ActiveTurn => {
  let resolveFinished = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  let resolveSession = (_sessionID: string) => {};
  let rejectSession = (_error: unknown) => {};
  const sessionReady = new Promise<string>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });
  // Prevent unhandled rejections if the turn fails before any steer awaits sessionReady.
  void sessionReady.catch(() => {});

  return {
    closing: false,
    finished,
    rejectSession,
    resolveFinished,
    resolveSession,
    sessionReady,
    sessionSettled: false,
    steerChain: Promise.resolve(),
    steerEpoch: 0,
    steeredMessageIDs: [],
  };
};

class AsyncChunkQueue implements AsyncIterable<StreamChunk> {
  private closed = false;
  private readonly queue: StreamChunk[] = [];
  private waiting: ((result: IteratorResult<StreamChunk>) => void) | undefined;

  push(chunk: StreamChunk) {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: false, value: chunk });
      return;
    }
    this.queue.push(chunk);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
    return {
      next: () => {
        const next = this.queue.shift();
        if (next) return Promise.resolve({ done: false, value: next });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export const createAgent = (options: CreateAgentOptions) => {
  const bot = new Chat<typeof options.adapters, ThreadState>({
    adapters: options.adapters,
    concurrency: {
      strategy: 'concurrent',
    },
    state: options.state,
    userName: options.userName,
  });

  const activeTurns = new Map<string, ActiveTurn>();

  const handleMessage = async (thread: Thread<ThreadState>, message: Message) => {
    if (!options.allowedUsers.includes(message.author.userId)) return;
    if (!(thread.isDM || message.isMention || (await shouldRespond(thread, message)))) return;

    for (;;) {
      const existing = activeTurns.get(thread.id);
      if (!existing) break;
      if (existing.closing) {
        await existing.finished;
        continue;
      }
      const steered = await steerActiveTurn({
        client: options.openCode,
        message,
        thread,
        turn: existing,
        uiAdapters: options.uiAdapters,
        userTimezone: options.userTimezone,
      });
      if (steered) return;
      await existing.finished;
    }

    const turn = createActiveTurn();
    activeTurns.set(thread.id, turn);

    await thread.subscribe();

    const hasSession = Boolean((await thread.state)?.sessionID);
    await setTypingStatus(thread, hasSession ? 'Thinking...' : 'Setting up workspace...');

    const chunkQueue = new AsyncChunkQueue();
    let streamPromise: Promise<unknown> | undefined;
    let streamError: unknown;

    const specFilter = new SpecStreamFilter({
      enabled: supportsUI(thread.adapter.name, options.uiAdapters),
      onSpecStart: () => {
        if (!streamPromise) void setTypingStatus(thread, 'Rendering card...');
      },
    });

    const pushToStream = (chunk: StreamChunk) => {
      if (!streamPromise) {
        streamPromise = Promise.resolve(thread.post(new StreamingPlan(chunkQueue))).catch(
          (error) => {
            streamError = error;
          },
        );
      }
      chunkQueue.push(chunk);
    };

    const emitChunk = (chunk: StreamChunk) => {
      if (chunk.type === 'markdown_text') {
        for (const filtered of specFilter.push(chunk.text)) {
          pushToStream(filtered);
        }
        return;
      }
      pushToStream(chunk);
    };

    turn.onSteer = () => {
      if (!streamPromise) void setTypingStatus(thread, 'Updating approach...');
    };

    let outcomeEmoji: 'octagonal_sign' | 'x' | undefined;
    let posted = false;
    try {
      const workspaceForThread = options.workspaceForThread ?? createThreadWorkspace;
      const directory = await workspaceForThread({
        adapter: thread.adapter.name,
        client: options.openCode,
        repositoryRoot: options.config.reposRoot,
        threadID: thread.id,
        workspaceRoot: options.config.workspaceRoot,
      });

      let observedSteerEpoch = turn.steerEpoch;
      const shouldContinueWaiting = async () => {
        await turn.steerChain;
        if (turn.steerEpoch !== observedSteerEpoch) {
          observedSteerEpoch = turn.steerEpoch;
          return true;
        }
        turn.closing = true;
        return false;
      };

      const response = await processMention({
        client: options.openCode,
        config: options.config,
        directory,
        getLastMessageID: () => turn.lastMessageID,
        onChunk: emitChunk,
        onSessionReady: (sessionID, lastMessageID) => {
          turn.lastMessageID = lastMessageID;
          if (!turn.sessionSettled) {
            turn.sessionSettled = true;
            turn.resolveSession(sessionID);
          }
        },
        onStatus: (status) => {
          if (!streamPromise) void setTypingStatus(thread, status);
        },
        shouldContinueWaiting,
        signal: thread.signal,
        thread,
        triggeringMessage: message,
        uiAdapters: options.uiAdapters,
        userTimezone: options.userTimezone,
      });

      const { cards, chunks } = specFilter.finish();
      for (const chunk of chunks) pushToStream(chunk);
      chunkQueue.close();

      if (streamPromise) {
        await streamPromise;
        if (streamError) throw streamError;
        for (const card of cards) {
          await thread.post(card);
        }
      } else if (cards.length > 0) {
        for (const card of cards) {
          await thread.post(card);
        }
      } else {
        await postResponse(thread, response, options.uiAdapters);
      }
      posted = true;
    } catch (error) {
      chunkQueue.close();
      if (streamPromise) await streamPromise;
      if (!turn.sessionSettled) {
        turn.sessionSettled = true;
        turn.rejectSession(error);
      }
      if (error instanceof TurnAbortedError || thread.signal.aborted) {
        outcomeEmoji = 'octagonal_sign';
      } else {
        console.error(error);
        outcomeEmoji = 'x';
      }
    } finally {
      turn.closing = true;
      await turn.steerChain.catch(() => {});
      if (activeTurns.get(thread.id) === turn) {
        activeTurns.delete(thread.id);
      }
      turn.resolveFinished();
      if (!posted) await endTypingStatus(thread);
    }

    if (outcomeEmoji) {
      const targetMessageID = turn.steeredMessageIDs.at(-1) ?? message.id;
      await addReaction({ emoji: outcomeEmoji, messageID: targetMessageID, thread });
    }
  };

  bot.onNewMention(handleMessage);
  bot.onSubscribedMessage(handleMessage);

  return bot;
};

type SteerActiveTurnOptions = {
  client: OpenCodeClient;
  message: Message;
  thread: Thread<ThreadState>;
  turn: ActiveTurn;
  uiAdapters?: readonly string[];
  userTimezone?: (userId: string) => Promise<string | undefined>;
};

const steerActiveTurn = ({
  client,
  message,
  thread,
  turn,
  uiAdapters,
  userTimezone,
}: SteerActiveTurnOptions): Promise<boolean> => {
  if (turn.closing) return Promise.resolve(false);

  const run = async (): Promise<boolean> => {
    let sessionID: string;
    try {
      sessionID = await turn.sessionReady;
    } catch {
      return false;
    }
    if (turn.closing) return false;

    try {
      const messages = await messagesSince(thread, turn.lastMessageID);
      if (!messages.some((item) => item.id === message.id)) {
        messages.push(message);
      }
      const contextMessages = messages.filter((item) => !item.author.isMe);
      const lastMessageID = contextMessages.at(-1)?.id ?? message.id;
      const prompt = await buildThreadPrompt({
        adapterName: thread.adapter.name,
        firstTurn: false,
        messages: contextMessages,
        uiAdapters,
        userTimezone,
      });

      await client.session.prompt({
        delivery: 'steer',
        files: await threadImageFiles(contextMessages),
        metadata: { lastMessageID, source: thread.adapter.name, threadID: thread.id },
        sessionID,
        text: prompt,
      });

      turn.lastMessageID = lastMessageID;
      turn.steerEpoch += 1;
      turn.steeredMessageIDs.push(message.id);
      await thread.setState({ lastMessageID, sessionID });
      turn.onSteer?.(message);
      return true;
    } catch (error) {
      console.error('Could not steer active OpenCode session', error);
      await addReaction({ emoji: 'x', messageID: message.id, thread });
      return true;
    }
  };

  const result = turn.steerChain.then(run, run);
  turn.steerChain = result.then(
    () => {},
    () => {},
  );
  return result;
};

const postResponse = async (
  thread: Thread<ThreadState>,
  response: string,
  uiAdapters?: readonly string[],
) => {
  if (!supportsUI(thread.adapter.name, uiAdapters)) {
    await thread.post({ markdown: response });
    return;
  }

  for (const part of parseResponseParts(response)) {
    if (part.type === 'card') {
      await thread.post(part.card);
    } else {
      await thread.post({ markdown: part.markdown });
    }
  }
};

type SlackAssistantAdapter = Adapter & {
  endTyping?: (threadId: string, status?: 'active') => Promise<void>;
  setAssistantTitle?: (channelId: string, threadTs: string, title: string) => Promise<void>;
  webClient?: {
    assistant?: {
      threads?: {
        setStatus?: (args: {
          channel_id: string;
          status: string;
          thread_ts: string;
        }) => Promise<unknown>;
        setTitle?: (args: {
          channel_id: string;
          thread_ts: string;
          title: string;
        }) => Promise<unknown>;
      };
    };
  };
};

const decodedThreadParts = (thread: Thread<ThreadState>) => {
  const decoded = thread.adapter.decodeThreadId(thread.id) as {
    channel?: string;
    thread?: string;
    threadTs?: string;
  };
  const threadTs = decoded?.threadTs ?? decoded?.thread;
  return decoded?.channel && threadTs ? { channel: decoded.channel, threadTs } : undefined;
};

const MAX_TYPING_STATUS_LENGTH = 50;

const clampTypingStatus = (status: string) => {
  const singleLine = status.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= MAX_TYPING_STATUS_LENGTH) return singleLine;
  if (singleLine.endsWith('...')) {
    return `${singleLine.slice(0, MAX_TYPING_STATUS_LENGTH - 3).trimEnd()}...`;
  }
  return `${singleLine.slice(0, MAX_TYPING_STATUS_LENGTH - 1).trimEnd()}…`;
};

const setTypingStatus = async (thread: Thread<ThreadState>, status: string) => {
  try {
    await thread.startTyping(clampTypingStatus(status));
  } catch (error) {
    console.error('Could not update typing status', error);
  }
};

const endTypingStatus = async (thread: Thread<ThreadState>) => {
  const adapter = thread.adapter as SlackAssistantAdapter;
  const setStatus = adapter.webClient?.assistant?.threads?.setStatus;
  if (typeof setStatus === 'function') {
    const parts = decodedThreadParts(thread);
    if (!parts) return;
    try {
      await setStatus({ channel_id: parts.channel, status: '', thread_ts: parts.threadTs });
    } catch (error) {
      console.error('Could not clear typing status', error);
    }
    return;
  }

  if (typeof adapter.endTyping !== 'function') return;
  try {
    await adapter.endTyping(thread.id, 'active');
  } catch (error) {
    console.error('Could not clear typing status', error);
  }
};

const setAdapterThreadTitle = async (thread: Thread<ThreadState>, title: string) => {
  const adapter = thread.adapter as SlackAssistantAdapter;
  const parts = decodedThreadParts(thread);
  if (!parts) return;

  const setTitle = adapter.webClient?.assistant?.threads?.setTitle;
  if (typeof setTitle === 'function') {
    try {
      await setTitle({ channel_id: parts.channel, thread_ts: parts.threadTs, title });
    } catch (error) {
      console.warn('Could not set Slack thread title', error);
    }
    return;
  }

  if (typeof adapter.setAssistantTitle !== 'function') return;
  try {
    await adapter.setAssistantTitle(parts.channel, parts.threadTs, title);
  } catch (error) {
    console.warn('Could not set adapter thread title', error);
  }
};

const addReaction = async ({ emoji, messageID, thread }: ReactionOptions) => {
  try {
    await thread.adapter.addReaction(thread.id, messageID, emoji);
  } catch (error) {
    console.error(`Could not add ${emoji} reaction`, error);
  }
};

export const processMention = async ({
  client,
  config,
  directory,
  getLastMessageID,
  onChunk,
  onSessionReady,
  onStatus,
  shouldContinueWaiting,
  signal,
  thread,
  triggeringMessage,
  uiAdapters,
  userTimezone,
}: ProcessMentionOptions) => {
  const state = await thread.state;
  const session = await getOrCreateThreadSession({
    adapterName: thread.adapter.name,
    client,
    config,
    directory,
    state,
    threadID: thread.id,
  });

  await thread.setState({ sessionID: session.sessionID });
  if (session.created) {
    await sendSessionInstructions({
      sessionID: session.sessionID,
      thread,
      userID: triggeringMessage.author.userId,
    });
  }
  if (session.created || !state?.sessionID) {
    await setTypingStatus(thread, 'Thinking...');
  }

  const messages = await messagesSince(thread, session.lastMessageID);
  if (!messages.some((item) => item.id === triggeringMessage.id)) {
    messages.push(triggeringMessage);
  }

  const contextMessages = messages.filter((item) => !item.author.isMe);
  const lastMessageID = contextMessages.at(-1)?.id;
  if (!lastMessageID) throw new Error('No new messages found in the thread');

  const prompt = await buildThreadPrompt({
    adapterName: thread.adapter.name,
    firstTurn: session.created,
    messages: contextMessages,
    uiAdapters,
    userTimezone,
  });

  onSessionReady?.(session.sessionID, lastMessageID);

  const response = await runSessionTurn({
    adapterName: thread.adapter.name,
    client,
    files: await threadImageFiles(contextMessages),
    metadata: { lastMessageID, source: thread.adapter.name, threadID: thread.id },
    onChunk,
    onStatus,
    prompt,
    sessionID: session.sessionID,
    shouldContinueWaiting,
    signal,
  });
  const finalLastMessageID = getLastMessageID?.() ?? lastMessageID;
  await thread.setState({ lastMessageID: finalLastMessageID, sessionID: session.sessionID });

  if (session.created) {
    const title = await generateAndApplySessionTitle({
      adapterName: thread.adapter.name,
      client,
      model: config.smallModel,
      prompt,
      sessionID: session.sessionID,
    });
    if (title) {
      await setAdapterThreadTitle(thread, title);
    }
  }

  return response;
};

const sendSessionInstructions = async ({
  sessionID,
  thread,
  userID,
}: {
  sessionID: string;
  thread: Thread<ThreadState>;
  userID: string;
}) => {
  try {
    await thread.postEphemeral(
      userID,
      `To inspect this session locally, run:\n\n\`\`\`\nopencode --session '${sessionID}'\n\`\`\``,
      { fallbackToDM: false },
    );
  } catch (error) {
    console.error('Could not post session instructions', error);
  }
};
