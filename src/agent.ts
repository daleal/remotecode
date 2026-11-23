import type { AutomationInfo, OpenCodeClient } from '@opencode/client';
import {
  Chat,
  type Adapter,
  type Message,
  type StateAdapter,
  type StreamChunk,
  type Thread,
} from 'chat';
import type { OpenCodeConfig } from './opencode';
import { selectRepositories } from './repo-selector';
import { generateAndApplySessionTitle } from './session-title';
import {
  inspectAutonomousTurn,
  isAutonomousInboxItem,
  isAutonomousSyntheticMetadata,
  observeSessionTurn,
  runSessionTurn,
  TurnAbortedError,
  type OpenCodeEvent,
  type SessionEventStream,
} from './session-turn';
import { shouldRespond } from './should-respond';
import { buildThreadPrompt, collectThreadMessages, threadImageFiles } from './thread-prompt';
import {
  getOrCreateThreadSession,
  resolveSessionThreadID,
  type ThreadState,
} from './thread-session';
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
  onAssistantMessage?: (assistantMessageID: string) => void;
  onChunk?: (chunk: StreamChunk) => void;
  onMessageEnd?: () => void;
  onSessionReady?: (sessionID: string, lastMessageID: string) => void;
  onStatus?: (status: string, options?: { force?: boolean }) => Promise<void> | void;
  provisionRepos?: typeof provisionWorkspaceRepos;
  selectRepos?: typeof selectRepositories;
  shouldContinueWaiting?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
  subscribeEvents?: SessionEventStream;
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
  onSteerStart?: () => void;
  rejectSession: (error: unknown) => void;
  resolveFinished: () => void;
  resolveSession: (sessionID: string) => void;
  sessionReady: Promise<string>;
  sessionSettled: boolean;
  steerChain: Promise<void>;
  steerEpoch: number;
  steeredMessageIDs: string[];
  wakeEpoch: number;
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
    wakeEpoch: 0,
  };
};

class AsyncQueue<Item> implements AsyncIterable<Item> {
  private closed = false;
  private readonly queue: Item[] = [];
  private waiting: ((result: IteratorResult<Item>) => void) | undefined;

  push(item: Item) {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: false, value: item });
      return;
    }
    this.queue.push(item);
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

  [Symbol.asyncIterator](): AsyncIterator<Item> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ done: false, value: this.queue.shift() as Item });
        }
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

type EventHub = {
  start: () => void;
  stop: () => Promise<void>;
  subscribe: SessionEventStream;
};

const createEventHub = (
  client: OpenCodeClient,
  onEvent: (event: OpenCodeEvent) => void,
): EventHub | undefined => {
  if (typeof client.event?.subscribe !== 'function') return undefined;

  const controller = new AbortController();
  const subscribers = new Set<AsyncQueue<OpenCodeEvent>>();
  let ended = false;
  let pumpPromise: Promise<void> | undefined;
  let started = false;

  const closeSubscribers = () => {
    for (const subscriber of subscribers) {
      subscriber.close();
    }
    subscribers.clear();
  };

  const pump = async () => {
    while (!controller.signal.aborted) {
      let sawServerConnected = false;
      try {
        for await (const event of client.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) return;
          if (event.type === 'server.connected') {
            sawServerConnected = true;
          }
          for (const subscriber of subscribers) {
            subscriber.push(event);
          }
          onEvent(event);
        }
        if (!sawServerConnected || controller.signal.aborted) {
          ended = true;
          closeSubscribers();
          return;
        }
        console.warn('OpenCode event stream closed; reconnecting');
        await sleep(1000, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn('OpenCode event stream failed; reconnecting', error);
        await sleep(1000, controller.signal);
      }
    }
  };

  const start = () => {
    if (started || controller.signal.aborted) return;
    started = true;
    pumpPromise = pump();
  };

  const stop = async () => {
    controller.abort();
    ended = true;
    closeSubscribers();
    await pumpPromise;
  };

  const subscribe: SessionEventStream = (signal) => {
    const queue = new AsyncQueue<OpenCodeEvent>();
    if (signal.aborted || ended) {
      queue.close();
      return queue;
    }
    subscribers.add(queue);
    const cleanup = () => {
      subscribers.delete(queue);
      queue.close();
    };
    signal.addEventListener('abort', cleanup, { once: true });
    return queue;
  };

  return { start, stop, subscribe };
};

const AUTOMATION_REACTION_EMOJI = 'stopwatch';
const AUTOMATION_RECHECK_BUFFER_MS = 1500;
const MAX_TIMEOUT_MS = 2_147_483_647;

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
  const activeTurnBySession = new Map<string, ActiveTurn>();
  const adapterNames = new Set(Object.keys(options.adapters));
  const automationCheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const automationReactionBySession = new Map<string, string>();
  const autonomousTasks = new Set<Promise<void>>();
  const lastDeliveredAssistantBySession = new Map<string, string>();
  const pendingAutonomousSessions = new Set<string>();
  const sessionThreads = new Map<string, string | null>();
  const shutdownAbort = new AbortController();
  const initWorkspace = options.initWorkspace ?? initThreadWorkspace;
  const provisionRepos = options.provisionRepos ?? provisionWorkspaceRepos;
  const selectRepos = options.selectRepos ?? selectRepositories;

  const trackAutonomousTask = (task: Promise<void>) => {
    autonomousTasks.add(task);
    void task.finally(() => {
      autonomousTasks.delete(task);
    });
    return task;
  };

  const clearAutomationCheckTimer = (sessionID: string) => {
    const timer = automationCheckTimers.get(sessionID);
    if (!timer) return;
    clearTimeout(timer);
    automationCheckTimers.delete(sessionID);
  };

  const syncAutomationReaction = async (
    thread: Thread<ThreadState>,
    sessionID: string,
    candidateMessageID?: string,
  ) => {
    if (shutdownAbort.signal.aborted) return;
    const listAutomations = options.openCode.experimental?.automation?.list;
    if (typeof listAutomations !== 'function') return;

    let automations;
    try {
      automations = await listAutomations({ sessionID });
    } catch (error) {
      if (!shutdownAbort.signal.aborted) {
        console.warn(`Could not list OpenCode automations for ${sessionID}`, error);
      }
      return;
    }
    if (shutdownAbort.signal.aborted) return;

    const active = automations.filter((item) => item.status === 'active');
    const currentMessageID = automationReactionBySession.get(sessionID);

    if (active.length === 0) {
      clearAutomationCheckTimer(sessionID);
      if (currentMessageID) {
        automationReactionBySession.delete(sessionID);
        await removeReaction({
          emoji: AUTOMATION_REACTION_EMOJI,
          messageID: currentMessageID,
          thread,
        });
      }
      return;
    }

    if (!currentMessageID && candidateMessageID) {
      const added = await addReaction({
        emoji: AUTOMATION_REACTION_EMOJI,
        messageID: candidateMessageID,
        thread,
      });
      if (added) {
        automationReactionBySession.set(sessionID, candidateMessageID);
      }
    }

    clearAutomationCheckTimer(sessionID);
    const earliestSilentCheckAt = earliestSilentAutomationCheck(active);
    if (earliestSilentCheckAt === undefined) return;

    const delay = Math.min(
      Math.max(0, earliestSilentCheckAt - Date.now() + AUTOMATION_RECHECK_BUFFER_MS),
      MAX_TIMEOUT_MS,
    );
    const timer = setTimeout(() => {
      automationCheckTimers.delete(sessionID);
      void trackAutonomousTask(syncAutomationReaction(thread, sessionID));
    }, delay);
    automationCheckTimers.set(sessionID, timer);
  };

  const createWaitGuard = (turn: ActiveTurn) => {
    let observedSteerEpoch = turn.steerEpoch;
    let observedWakeEpoch = turn.wakeEpoch;
    return async () => {
      await turn.steerChain;
      if (turn.steerEpoch !== observedSteerEpoch || turn.wakeEpoch !== observedWakeEpoch) {
        observedSteerEpoch = turn.steerEpoch;
        observedWakeEpoch = turn.wakeEpoch;
        return true;
      }
      turn.closing = true;
      return false;
    };
  };

  const runAutonomousTurn = ({
    previousAssistantIDs,
    sessionID,
    threadID,
  }: {
    previousAssistantIDs?: ReadonlySet<string>;
    sessionID: string;
    threadID: string;
  }): Promise<void> => {
    const thread = bot.thread(threadID);
    const turn = createActiveTurn();
    turn.sessionSettled = true;
    turn.resolveSession(sessionID);
    activeTurns.set(thread.id, turn);
    activeTurnBySession.set(sessionID, turn);

    const messenger = createTurnMessenger({
      thread,
      uiAdapters: options.uiAdapters,
    });
    turn.onStatus = (status) => {
      void messenger.setStatus(status);
    };
    turn.onSteerStart = () => {
      void messenger.setStatus('Updating approach...', { force: true });
    };
    turn.onSteer = () => {
      void messenger.setStatus('Updating approach...');
    };

    void messenger.setStatus('Thinking...');

    // Start observing synchronously so the event hub subscriber attaches before the next event yields.
    const observation = observeSessionTurn({
      adapterName: thread.adapter.name,
      client: options.openCode,
      interruptOnAbort: false,
      onAssistantMessage: (assistantMessageID) => {
        lastDeliveredAssistantBySession.set(sessionID, assistantMessageID);
      },
      onChunk: messenger.emitChunk,
      onMessageEnd: messenger.endMessage,
      onStatus: (status) => {
        void messenger.setStatus(status);
      },
      previousAssistantIDs,
      sessionID,
      shouldContinueWaiting: createWaitGuard(turn),
      signal: shutdownAbort.signal,
      subscribeEvents: eventHub?.subscribe,
    });

    const task = (async () => {
      let posted = false;
      try {
        await thread.subscribe().catch((error) => {
          console.warn(`Could not subscribe to thread ${thread.id}`, error);
        });
        const existingState = await thread.state;
        if (existingState?.lastMessageID && !turn.lastMessageID) {
          turn.lastMessageID = existingState.lastMessageID;
        }
        if (!existingState?.sessionID) {
          await thread.setState({ sessionID }).catch((error) => {
            console.warn(`Could not persist session state for ${thread.id}`, error);
          });
        }

        const response = await observation;
        if (response !== undefined) {
          await messenger.finish(response);
          posted = true;
        } else {
          await messenger.abort();
        }
        await syncAutomationReaction(thread, sessionID, messenger.lastPostedMessageID());
      } catch (error) {
        await messenger.abort();
        if (!(error instanceof TurnAbortedError || shutdownAbort.signal.aborted)) {
          console.error(`Autonomous turn failed for OpenCode session ${sessionID}`, error);
        }
      } finally {
        turn.closing = true;
        await turn.steerChain.catch(() => {});
        if (activeTurns.get(thread.id) === turn) {
          activeTurns.delete(thread.id);
        }
        if (activeTurnBySession.get(sessionID) === turn) {
          activeTurnBySession.delete(sessionID);
        }
        turn.resolveFinished();
        await messenger.cleanup(!posted);
      }
    })();

    return trackAutonomousTask(task);
  };

  const maybeObserveAutonomousSession = (
    sessionID: string,
    { knownAutonomous }: { knownAutonomous: boolean },
  ) => {
    if (shutdownAbort.signal.aborted) return;

    const activeForSession = activeTurnBySession.get(sessionID);
    if (activeForSession && !activeForSession.closing) {
      if (knownAutonomous) {
        activeForSession.wakeEpoch += 1;
      }
      return;
    }

    if (pendingAutonomousSessions.has(sessionID)) return;

    const cachedThreadID = sessionThreads.get(sessionID);
    if (cachedThreadID === null) return;

    if (knownAutonomous && typeof cachedThreadID === 'string') {
      const existing = activeTurns.get(cachedThreadID);
      if (!existing) {
        const lastDelivered = lastDeliveredAssistantBySession.get(sessionID);
        void runAutonomousTurn({
          previousAssistantIDs: lastDelivered ? new Set([lastDelivered]) : undefined,
          sessionID,
          threadID: cachedThreadID,
        });
        return;
      }
    }

    pendingAutonomousSessions.add(sessionID);
    trackAutonomousTask(
      (async () => {
        try {
          let threadID: string | null | undefined = sessionThreads.get(sessionID);
          if (threadID === undefined) {
            threadID = await resolveSessionThreadID(options.openCode, sessionID, adapterNames);
            if (threadID !== undefined) {
              sessionThreads.set(sessionID, threadID);
            }
          }
          if (!threadID || shutdownAbort.signal.aborted) return;

          for (;;) {
            const existing = activeTurns.get(threadID);
            if (!existing) break;
            if (!existing.closing) {
              if (knownAutonomous && activeTurnBySession.get(sessionID) === existing) {
                existing.wakeEpoch += 1;
              }
              return;
            }
            await existing.finished;
            if (shutdownAbort.signal.aborted) return;
          }

          let previousAssistantIDs: Set<string> | undefined;
          const lastDelivered = lastDeliveredAssistantBySession.get(sessionID);
          if (knownAutonomous && lastDelivered) {
            previousAssistantIDs = new Set([lastDelivered]);
          } else {
            const inspection = await inspectAutonomousTurn(
              options.openCode,
              sessionID,
              lastDelivered,
            );
            if (shutdownAbort.signal.aborted) return;
            if (inspection.autonomous) {
              previousAssistantIDs = inspection.previousAssistantIDs;
            } else if (!knownAutonomous) {
              return;
            }
          }

          if (shutdownAbort.signal.aborted || activeTurns.has(threadID)) return;
          await runAutonomousTurn({ previousAssistantIDs, sessionID, threadID });
        } catch (error) {
          if (!shutdownAbort.signal.aborted) {
            console.warn(`Could not observe autonomous OpenCode session ${sessionID}`, error);
          }
        } finally {
          pendingAutonomousSessions.delete(sessionID);
        }
      })(),
    );
  };

  const reconcileActiveSessions = () => {
    if (shutdownAbort.signal.aborted) return;
    if (typeof options.openCode.session?.active !== 'function') return;
    trackAutonomousTask(
      options.openCode.session
        .active()
        .then((active) => {
          for (const sessionID of Object.keys(active)) {
            maybeObserveAutonomousSession(sessionID, { knownAutonomous: false });
          }
        })
        .catch((error) => {
          if (shutdownAbort.signal.aborted) return;
          console.warn('Could not list active OpenCode sessions', error);
        }),
    );
  };

  const handleOpenCodeEvent = (event: OpenCodeEvent) => {
    if (event.type === 'server.connected') {
      reconcileActiveSessions();
      return;
    }

    if (!('data' in event) || !event.data || !('sessionID' in event.data)) return;
    const sessionID = event.data.sessionID;
    if (typeof sessionID !== 'string') return;

    if (event.type === 'session.inbox.enqueued') {
      if (isAutonomousInboxItem(event.data.item)) {
        const knownAutonomous =
          event.data.item.type === 'user' ||
          (event.data.item.type === 'synthetic' &&
            event.data.item.payload.metadata?.notice !== 'restart');
        maybeObserveAutonomousSession(sessionID, { knownAutonomous });
      }
      return;
    }

    if (event.type === 'session.synthetic') {
      if (isAutonomousSyntheticMetadata(event.data.metadata)) {
        const knownAutonomous = event.data.metadata?.notice !== 'restart';
        maybeObserveAutonomousSession(sessionID, { knownAutonomous });
      }
      return;
    }

    if (
      event.type === 'session.execution.started' ||
      event.type === 'session.step.started' ||
      event.type === 'session.text.delta' ||
      (event.type === 'session.status' && event.data.status.type === 'busy')
    ) {
      maybeObserveAutonomousSession(sessionID, { knownAutonomous: false });
    }
  };

  const eventHub = createEventHub(options.openCode, handleOpenCodeEvent);

  const originalInitialize = bot.initialize.bind(bot);
  bot.initialize = async () => {
    await originalInitialize();
    eventHub?.start();
  };

  const originalShutdown = bot.shutdown.bind(bot);
  bot.shutdown = async () => {
    shutdownAbort.abort();
    for (const timer of automationCheckTimers.values()) {
      clearTimeout(timer);
    }
    automationCheckTimers.clear();
    await eventHub?.stop();
    await Promise.allSettled([...autonomousTasks]);
    await originalShutdown();
  };

  const handleMessage = async (thread: Thread<ThreadState>, message: Message) => {
    if (!options.allowedUsers.includes(message.author.userId)) return;
    const activeTurn = activeTurns.get(thread.id);
    const assistantRunning = Boolean(activeTurn && !activeTurn.closing);
    if (
      !(
        thread.isDM ||
        message.isMention ||
        (await shouldRespond(thread, message, { assistantRunning }))
      )
    ) {
      return;
    }

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
    const messenger = createTurnMessenger({
      thread,
      uiAdapters: options.uiAdapters,
    });
    const initialStatus = existingState?.sessionID ? 'Thinking...' : undefined;
    if (initialStatus) {
      await messenger.setStatus(initialStatus);
    }

    turn.onStatus = (status) => {
      void messenger.setStatus(status);
    };
    turn.onSteerStart = () => {
      void messenger.setStatus('Updating approach...', { force: true });
    };
    turn.onSteer = () => {
      void messenger.setStatus('Updating approach...');
    };

    let outcomeEmoji: 'octagonal_sign' | 'x' | undefined;
    let posted = false;
    let turnSessionID: string | undefined;
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

      const response = await processMention({
        client: options.openCode,
        config: options.config,
        getLastMessageID: () => turn.lastMessageID,
        initialStatus,
        onAssistantMessage: (assistantMessageID) => {
          if (turnSessionID) {
            lastDeliveredAssistantBySession.set(turnSessionID, assistantMessageID);
          }
        },
        onChunk: messenger.emitChunk,
        onMessageEnd: messenger.endMessage,
        onSessionReady: (sessionID, lastMessageID) => {
          turnSessionID = sessionID;
          sessionThreads.set(sessionID, thread.id);
          activeTurnBySession.set(sessionID, turn);
          turn.lastMessageID = lastMessageID;
          if (!turn.sessionSettled) {
            turn.sessionSettled = true;
            turn.resolveSession(sessionID);
          }
        },
        onStatus: (status, statusOptions) => messenger.setStatus(status, statusOptions),
        provisionRepos,
        selectRepos,
        shouldContinueWaiting: createWaitGuard(turn),
        signal: thread.signal,
        subscribeEvents: eventHub?.subscribe,
        thread,
        triggeringMessage: message,
        uiAdapters: options.uiAdapters,
        userTimezone: options.userTimezone,
        workspace,
      });

      await messenger.finish(response);
      posted = true;
      if (turnSessionID) {
        await syncAutomationReaction(thread, turnSessionID, messenger.lastPostedMessageID());
      }
    } catch (error) {
      await messenger.abort();
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
      if (turnSessionID && activeTurnBySession.get(turnSessionID) === turn) {
        activeTurnBySession.delete(turnSessionID);
      }
      turn.resolveFinished();
      await messenger.cleanup(!posted);
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
    turn.onSteerStart?.();

    try {
      const state = await thread.state;
      const { messages, priorMessages } = await collectThreadMessages(
        thread,
        turn.lastMessageID ?? state?.lastMessageID,
      );
      if (!messages.some((item) => item.id === message.id)) {
        messages.push(message);
      }
      const contextMessages = messages.filter((item) => !item.author.isMe);
      const lastMessageID = contextMessages.at(-1)?.id ?? message.id;

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
    const sent = await thread.post({ markdown: response });
    return sent?.id;
  }

  let lastMessageID: string | undefined;
  for (const part of parseResponseParts(response)) {
    const sent =
      part.type === 'card'
        ? await thread.post(part.card)
        : await thread.post({ markdown: part.markdown });
    if (sent?.id) lastMessageID = sent.id;
  }
  return lastMessageID;
};

const STATUS_KEEPALIVE_MS = 90_000;

type MessageStream = {
  chunkQueue: AsyncQueue<StreamChunk>;
  specFilter: SpecStreamFilter;
  started: boolean;
};

const createTurnMessenger = ({
  thread,
  uiAdapters,
}: {
  thread: Thread<ThreadState>;
  uiAdapters?: readonly string[];
}) => {
  const uiEnabled = supportsUI(thread.adapter.name, uiAdapters);
  let currentMessage: MessageStream | undefined;
  let desiredStatus: string | undefined;
  let hasActiveTypingStatus = false;
  let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPostedMessageID: string | undefined;
  let lastSentStatus: string | undefined;
  let pendingPosts = 0;
  let postChain: Promise<void> = Promise.resolve();
  let postedAnyMessage = false;
  let statusChain: Promise<void> = Promise.resolve();
  let statusDirty = false;
  let streamError: unknown;
  let turnEnded = false;

  const canShowStatus = () => !turnEnded && pendingPosts === 0 && !currentMessage?.started;

  const stopKeepalive = () => {
    if (!keepaliveTimer) return;
    clearTimeout(keepaliveTimer);
    keepaliveTimer = undefined;
  };

  const scheduleKeepalive = () => {
    stopKeepalive();
    if (!canShowStatus() || !desiredStatus) return;
    keepaliveTimer = setTimeout(() => {
      keepaliveTimer = undefined;
      if (!canShowStatus() || !desiredStatus) return;
      void setStatus(desiredStatus, { force: true });
    }, STATUS_KEEPALIVE_MS);
  };

  const setStatus = (
    status: string,
    { force = false }: { force?: boolean } = {},
  ): Promise<void> => {
    desiredStatus = status;
    if (!canShowStatus()) {
      statusDirty = true;
      return Promise.resolve();
    }
    if (!force && !statusDirty && lastSentStatus === status) {
      scheduleKeepalive();
      return Promise.resolve();
    }
    statusDirty = false;
    lastSentStatus = status;
    scheduleKeepalive();
    const call = statusChain.then(async () => {
      if (turnEnded) return;
      hasActiveTypingStatus = true;
      await setTypingStatus(thread, status);
    });
    statusChain = call;
    return call;
  };

  const flushPendingStatus = () => {
    if (!canShowStatus() || !desiredStatus || !statusDirty) return;
    void setStatus(desiredStatus, { force: true });
  };

  const enqueuePost = (task: () => Promise<void>) => {
    pendingPosts += 1;
    postChain = postChain
      .then(task)
      .catch((error) => {
        if (streamError === undefined) streamError = error;
      })
      .finally(() => {
        pendingPosts -= 1;
        flushPendingStatus();
      });
  };

  const ensureCurrentMessage = (): MessageStream => {
    if (currentMessage) return currentMessage;
    const message: MessageStream = {
      chunkQueue: new AsyncQueue<StreamChunk>(),
      specFilter: new SpecStreamFilter({
        enabled: uiEnabled,
        onSpecStart: () => {
          void setStatus('Rendering card...');
        },
      }),
      started: false,
    };
    currentMessage = message;
    return message;
  };

  const pushToStream = (message: MessageStream, chunk: StreamChunk) => {
    if (!message.started) {
      message.started = true;
      postedAnyMessage = true;
      statusDirty = true;
      stopKeepalive();
      enqueuePost(async () => {
        const sent = await thread.post(message.chunkQueue);
        if (sent?.id) lastPostedMessageID = sent.id;
        hasActiveTypingStatus = false;
      });
    }
    message.chunkQueue.push(chunk);
  };

  const emitChunk = (chunk: StreamChunk) => {
    const message = ensureCurrentMessage();
    if (chunk.type === 'markdown_text') {
      for (const filtered of message.specFilter.push(chunk.text)) {
        pushToStream(message, filtered);
      }
      return;
    }
    pushToStream(message, chunk);
  };

  const closeCurrentMessage = () => {
    const message = currentMessage;
    if (!message) return;
    currentMessage = undefined;

    const { cards, chunks } = message.specFilter.finish();
    for (const chunk of chunks) {
      pushToStream(message, chunk);
    }
    if (message.started) {
      message.chunkQueue.close();
    }
    if (cards.length > 0) {
      postedAnyMessage = true;
      statusDirty = true;
      stopKeepalive();
      enqueuePost(async () => {
        for (const card of cards) {
          const sent = await thread.post(card);
          if (sent?.id) lastPostedMessageID = sent.id;
        }
        hasActiveTypingStatus = false;
      });
    }
  };

  const finish = async (response: string) => {
    turnEnded = true;
    stopKeepalive();
    closeCurrentMessage();
    await postChain;
    if (streamError !== undefined) throw streamError;
    if (!postedAnyMessage) {
      const sentID = await postResponse(thread, response, uiAdapters);
      if (sentID) lastPostedMessageID = sentID;
      postedAnyMessage = true;
      hasActiveTypingStatus = false;
    }
  };

  const abort = async () => {
    turnEnded = true;
    stopKeepalive();
    const message = currentMessage;
    currentMessage = undefined;
    if (message?.started) {
      message.chunkQueue.close();
    }
    await postChain;
  };

  const cleanup = async (forceEndTyping: boolean) => {
    turnEnded = true;
    stopKeepalive();
    await statusChain;
    if (forceEndTyping || hasActiveTypingStatus) {
      await endTypingStatus(thread);
    }
  };

  return {
    abort,
    cleanup,
    emitChunk,
    endMessage: closeCurrentMessage,
    finish,
    lastPostedMessageID: () => lastPostedMessageID,
    setStatus,
  };
};

type SlackAssistantAdapter = Adapter & {
  endTyping?: (threadId: string, status?: 'active') => Promise<void>;
  setAssistantStatus?: (channelId: string, threadTs: string, status: string) => Promise<void>;
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
  if (typeof adapter.setAssistantStatus === 'function') {
    const parts = decodedThreadParts(thread);
    if (!parts) return;
    try {
      await adapter.setAssistantStatus(parts.channel, parts.threadTs, '');
    } catch (error) {
      console.error('Could not clear typing status', error);
    }
    return;
  }

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

const earliestSilentAutomationCheck = (automations: readonly AutomationInfo[]) => {
  let earliest: number | undefined;
  for (const item of automations) {
    const candidates = [item.action.type !== 'prompt' ? item.nextDueAt : undefined, item.expires];
    for (const timestamp of candidates) {
      if (typeof timestamp !== 'number') continue;
      if (earliest === undefined || timestamp < earliest) {
        earliest = timestamp;
      }
    }
  }
  return earliest;
};

const addReaction = async ({ emoji, messageID, thread }: ReactionOptions) => {
  try {
    await thread.adapter.addReaction(thread.id, messageID, emoji);
    return true;
  } catch (error) {
    console.error(`Could not add ${emoji} reaction`, error);
    return false;
  }
};

const removeReaction = async ({ emoji, messageID, thread }: ReactionOptions) => {
  try {
    await thread.adapter.removeReaction(thread.id, messageID, emoji);
  } catch (error) {
    console.error(`Could not remove ${emoji} reaction`, error);
  }
};

export const processMention = async ({
  client,
  config,
  getLastMessageID,
  initialStatus,
  onAssistantMessage,
  onChunk,
  onMessageEnd,
  onSessionReady,
  onStatus,
  provisionRepos = provisionWorkspaceRepos,
  selectRepos = selectRepositories,
  shouldContinueWaiting,
  signal,
  subscribeEvents,
  thread,
  triggeringMessage,
  uiAdapters,
  userTimezone,
  workspace,
}: ProcessMentionOptions) => {
  let currentStatus = initialStatus;
  let forceNextStatus = false;
  const updateStatus = async (status: string) => {
    if (!forceNextStatus && currentStatus === status) return;
    const force = forceNextStatus;
    forceNextStatus = false;
    currentStatus = status;
    await (onStatus ? onStatus(status, { force }) : setTypingStatus(thread, status));
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
    forceNextStatus = true;
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
    onAssistantMessage,
    onChunk,
    onMessageEnd,
    onStatus: onStatus ? (status) => void onStatus(status) : undefined,
    prompt,
    sessionID: session.sessionID,
    shouldContinueWaiting,
    signal,
    subscribeEvents,
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
