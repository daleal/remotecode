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
import { selectRepositories } from './repo-selector';
import { generateAndApplySessionTitle } from './session-title';
import { runSessionTurn, TurnAbortedError } from './session-turn';
import { shouldRespond } from './should-respond';
import { buildThreadPrompt, collectThreadMessages, threadImageFiles } from './thread-prompt';
import { getOrCreateThreadSession, type ThreadState } from './thread-session';
import { parseResponseParts, SpecStreamFilter, supportsUI } from './ui';
import { initThreadWorkspace, provisionWorkspaceRepos, type ThreadWorkspace } from './workspace';

type CreateAgentOptions = {
  adapters: Record<string, Adapter>;
  allowedUsers: string[];
  config: OpenCodeConfig;
  initWorkspace?: typeof initThreadWorkspace;
  openCode: OpenCodeClient;
  provisionRepos?: typeof provisionWorkspaceRepos;
  selectRepos?: typeof selectRepositories;
  state: StateAdapter;
  uiAdapters?: readonly string[];
  userTimezone?: (userId: string) => Promise<string | undefined>;
  userName: string;
};

type ProcessMentionOptions = {
  client: OpenCodeClient;
  config: OpenCodeConfig;
  getLastMessageID?: () => string | undefined;
  initialStatus?: string;
  onChunk?: (chunk: StreamChunk) => void;
  onSessionReady?: (sessionID: string, lastMessageID: string) => void;
  onStatus?: (status: string) => void;
  provisionRepos?: typeof provisionWorkspaceRepos;
  selectRepos?: typeof selectRepositories;
  shouldContinueWaiting?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
  thread: Thread<ThreadState>;
  triggeringMessage: Message;
  uiAdapters?: readonly string[];
  userTimezone?: (userId: string) => Promise<string | undefined>;
  workspace: ThreadWorkspace;
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
  onStatus?: (status: string) => void;
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
  const initWorkspace = options.initWorkspace ?? initThreadWorkspace;
  const provisionRepos = options.provisionRepos ?? provisionWorkspaceRepos;
  const selectRepos = options.selectRepos ?? selectRepositories;

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
        config: options.config,
        message,
        provisionRepos,
        selectRepos,
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

    const existingState = await thread.state;
    const initialStatus = existingState?.sessionID ? 'Thinking...' : undefined;
    if (initialStatus) {
      await setTypingStatus(thread, initialStatus);
    }

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

    turn.onStatus = (status) => {
      if (!streamPromise) void setTypingStatus(thread, status);
    };
    turn.onSteer = () => {
      turn.onStatus?.('Updating approach...');
    };

    let outcomeEmoji: 'octagonal_sign' | 'x' | undefined;
    let posted = false;
    try {
      const workspace =
        existingState?.directory &&
        existingState.repositoryRoot &&
        existingState.availableRepos &&
        existingState.provisionedRepos
          ? {
              availableRepos: existingState.availableRepos,
              directory: existingState.directory,
              provisionedRepos: existingState.provisionedRepos,
              repositoryRoot: existingState.repositoryRoot,
            }
          : await initWorkspace({
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
        getLastMessageID: () => turn.lastMessageID,
        initialStatus,
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
        provisionRepos,
        selectRepos,
        shouldContinueWaiting,
        signal: thread.signal,
        thread,
        triggeringMessage: message,
        uiAdapters: options.uiAdapters,
        userTimezone: options.userTimezone,
        workspace,
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

type EnsureReposForMessagesOptions = {
  availableRepos: readonly string[];
  client: OpenCodeClient;
  config: OpenCodeConfig;
  contextMessages: Message[];
  onProvisioningStart?: (repos: string[]) => Promise<void> | void;
  priorMessages: Message[];
  provisionRepos: typeof provisionWorkspaceRepos;
  provisionedRepos: readonly string[];
  repositoryRoot: string;
  selectRepos: typeof selectRepositories;
  signal?: AbortSignal;
  thread: Thread<ThreadState>;
  userTimezone?: (userId: string) => Promise<string | undefined>;
};

const ensureReposForMessages = async ({
  availableRepos,
  client,
  config,
  contextMessages,
  onProvisioningStart,
  priorMessages,
  provisionRepos,
  provisionedRepos,
  repositoryRoot,
  selectRepos,
  signal,
  thread,
  userTimezone,
}: EnsureReposForMessagesOptions) => {
  const unprovisionedRepos = availableRepos.filter((repo) => !provisionedRepos.includes(repo));
  if (unprovisionedRepos.length === 0) {
    return {
      newlyProvisionedRepos: [] as string[],
      provisionedRepos: [...provisionedRepos],
    };
  }

  const selectedRepos = await selectRepos({
    availableRepos,
    client,
    config,
    messages: contextMessages,
    priorMessages,
    provisionedRepos,
    repositoryRoot,
    signal,
    threadID: thread.id,
    userTimezone,
  });

  const toProvision = selectedRepos.filter((repo) => unprovisionedRepos.includes(repo));
  if (toProvision.length === 0) {
    return {
      newlyProvisionedRepos: [] as string[],
      provisionedRepos: [...provisionedRepos],
    };
  }

  await onProvisioningStart?.(toProvision);
  const provisioned = await provisionRepos({
    adapter: thread.adapter.name,
    client,
    repos: toProvision,
    repositoryRoot: config.reposRoot,
    threadID: thread.id,
    workspaceRoot: config.workspaceRoot,
  });

  const updatedProvisioned = availableRepos.filter(
    (repo) => provisionedRepos.includes(repo) || provisioned.includes(repo),
  );
  await thread.setState({
    availableRepos: [...availableRepos],
    provisionedRepos: updatedProvisioned,
  });

  return {
    newlyProvisionedRepos: provisioned,
    provisionedRepos: updatedProvisioned,
  };
};

type SteerActiveTurnOptions = {
  client: OpenCodeClient;
  config: OpenCodeConfig;
  message: Message;
  provisionRepos: typeof provisionWorkspaceRepos;
  selectRepos: typeof selectRepositories;
  thread: Thread<ThreadState>;
  turn: ActiveTurn;
  uiAdapters?: readonly string[];
  userTimezone?: (userId: string) => Promise<string | undefined>;
};

const steerActiveTurn = ({
  client,
  config,
  message,
  provisionRepos,
  selectRepos,
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
      const { messages, priorMessages } = await collectThreadMessages(thread, turn.lastMessageID);
      if (!messages.some((item) => item.id === message.id)) {
        messages.push(message);
      }
      const contextMessages = messages.filter((item) => !item.author.isMe);
      const lastMessageID = contextMessages.at(-1)?.id ?? message.id;

      const state = await thread.state;
      const availableRepos = state?.availableRepos;
      let provisionedRepos = state?.provisionedRepos;
      let newlyProvisionedRepos: string[] = [];

      if (availableRepos && provisionedRepos && state?.repositoryRoot) {
        const result = await ensureReposForMessages({
          availableRepos,
          client,
          config,
          contextMessages,
          onProvisioningStart: () => {
            turn.onStatus?.('Preparing repositories...');
          },
          priorMessages,
          provisionRepos,
          provisionedRepos,
          repositoryRoot: state.repositoryRoot,
          selectRepos,
          signal: thread.signal,
          thread,
          userTimezone,
        });
        newlyProvisionedRepos = result.newlyProvisionedRepos;
        provisionedRepos = result.provisionedRepos;
      }

      if (turn.closing) return false;

      const prompt = await buildThreadPrompt({
        adapterName: thread.adapter.name,
        firstTurn: false,
        messages: contextMessages,
        uiAdapters,
        userTimezone,
        ...(availableRepos && provisionedRepos
          ? {
              workspace: {
                availableRepos,
                newlyProvisionedRepos,
                provisionedRepos,
              },
            }
          : {}),
      });

      await client.session.prompt({
        delivery: 'steer',
        files: await threadImageFiles(contextMessages),
        metadata: {
          ...(availableRepos ? { availableRepos } : {}),
          lastMessageID,
          ...(provisionedRepos ? { provisionedRepos } : {}),
          source: thread.adapter.name,
          threadID: thread.id,
        },
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
      if (error instanceof TurnAbortedError || thread.signal.aborted) {
        return false;
      }
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
  getLastMessageID,
  initialStatus,
  onChunk,
  onSessionReady,
  onStatus,
  provisionRepos = provisionWorkspaceRepos,
  selectRepos = selectRepositories,
  shouldContinueWaiting,
  signal,
  thread,
  triggeringMessage,
  uiAdapters,
  userTimezone,
  workspace,
}: ProcessMentionOptions) => {
  let currentStatus = initialStatus;
  const updateStatus = async (status: string) => {
    if (currentStatus === status) return;
    currentStatus = status;
    await setTypingStatus(thread, status);
  };

  const state = await thread.state;
  const availableRepos = [...workspace.availableRepos];
  const session = await getOrCreateThreadSession({
    adapterName: thread.adapter.name,
    availableRepos,
    client,
    config,
    directory: workspace.directory,
    provisionedRepos: [...workspace.provisionedRepos],
    state,
    threadID: thread.id,
  });

  await thread.setState({
    availableRepos,
    directory: workspace.directory,
    provisionedRepos: [...workspace.provisionedRepos],
    repositoryRoot: workspace.repositoryRoot,
    sessionID: session.sessionID,
  });
  if (session.created) {
    await sendSessionInstructions({
      sessionID: session.sessionID,
      thread,
      userID: triggeringMessage.author.userId,
    });
    // Posting an ephemeral message clears Slack's assistant status indicator.
    currentStatus = undefined;
  }
  await updateStatus('Thinking...');

  const { messages, priorMessages } = await collectThreadMessages(thread, session.lastMessageID);
  if (!messages.some((item) => item.id === triggeringMessage.id)) {
    messages.push(triggeringMessage);
  }

  const contextMessages = messages.filter((item) => !item.author.isMe);
  const lastMessageID = contextMessages.at(-1)?.id;
  if (!lastMessageID) throw new Error('No new messages found in the thread');

  const { newlyProvisionedRepos, provisionedRepos } = await ensureReposForMessages({
    availableRepos,
    client,
    config,
    contextMessages,
    onProvisioningStart: () => updateStatus('Preparing repositories...'),
    priorMessages,
    provisionRepos,
    provisionedRepos: workspace.provisionedRepos,
    repositoryRoot: workspace.repositoryRoot,
    selectRepos,
    signal,
    thread,
    userTimezone,
  });

  await updateStatus('Thinking...');

  const prompt = await buildThreadPrompt({
    adapterName: thread.adapter.name,
    firstTurn: session.created,
    messages: contextMessages,
    uiAdapters,
    userTimezone,
    workspace: {
      availableRepos,
      newlyProvisionedRepos,
      provisionedRepos,
    },
  });

  onSessionReady?.(session.sessionID, lastMessageID);

  const response = await runSessionTurn({
    adapterName: thread.adapter.name,
    client,
    files: await threadImageFiles(contextMessages),
    metadata: {
      availableRepos,
      lastMessageID,
      provisionedRepos,
      source: thread.adapter.name,
      threadID: thread.id,
    },
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
