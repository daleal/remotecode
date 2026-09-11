import type { OpenCodeClient } from '@opencode-ai/client';
import { Chat, type Adapter, type Message, type StateAdapter, type Thread } from 'chat';
import type { OpenCodeConfig } from './opencode';
import { generateAndApplySessionTitle } from './session-title';
import { runSessionTurn } from './session-turn';
import { buildThreadPrompt, messagesSince } from './thread-prompt';
import { getOrCreateThreadSession, type ThreadState } from './thread-session';
import { createThreadWorkspace } from './workspace';

type CreateAgentOptions = {
  adapters: Record<string, Adapter>;
  allowedUsers: string[];
  config: OpenCodeConfig;
  openCode: OpenCodeClient;
  state: StateAdapter;
  userTimezone?: (userId: string) => Promise<string | undefined>;
  userName: string;
  workspaceForThread?: typeof createThreadWorkspace;
};

type ProcessMentionOptions = {
  client: OpenCodeClient;
  config: OpenCodeConfig;
  directory: string;
  thread: Thread<ThreadState>;
  triggeringMessage: Message;
  userTimezone?: (userId: string) => Promise<string | undefined>;
};

type ReactionOptions = {
  emoji: string;
  messageID: string;
  thread: Thread<ThreadState>;
};

export const createAgent = (options: CreateAgentOptions) => {
  const bot = new Chat<typeof options.adapters, ThreadState>({
    adapters: options.adapters,
    concurrency: {
      strategy: 'queue',
      maxQueueSize: 20,
      queueEntryTtlMs: 30 * 60 * 1000,
    },
    state: options.state,
    userName: options.userName,
  });

  bot.onNewMention(async (thread, message) => {
    if (!options.allowedUsers.includes(message.author.userId)) return;

    const hasSession = Boolean((await thread.state)?.sessionID);
    let processingReaction = hasSession ? 'eyes' : 'gear';
    await addReaction({ emoji: processingReaction, messageID: message.id, thread });

    let outcome = 'white_check_mark';
    try {
      const workspaceForThread = options.workspaceForThread ?? createThreadWorkspace;
      const directory = await workspaceForThread({
        adapter: thread.adapter.name,
        client: options.openCode,
        repositoryRoot: options.config.reposRoot,
        threadID: thread.id,
        workspaceRoot: options.config.workspaceRoot,
      });
      if (!hasSession) {
        const previousReaction = processingReaction;
        processingReaction = 'eyes';
        await transitionReaction({
          messageID: message.id,
          thread,
          from: previousReaction,
          to: processingReaction,
        });
      }

      const response = await processMention({
        client: options.openCode,
        config: options.config,
        directory,
        thread,
        triggeringMessage: message,
        userTimezone: options.userTimezone,
      });
      await thread.post({ markdown: response });
    } catch (error) {
      console.error(error);
      outcome = 'x';
    }

    await transitionReaction({
      messageID: message.id,
      thread,
      from: processingReaction,
      to: outcome,
    });
  });

  return bot;
};

const addReaction = async ({ emoji, messageID, thread }: ReactionOptions) => {
  try {
    await thread.adapter.addReaction(thread.id, messageID, emoji);
  } catch (error) {
    console.error(`Could not add ${emoji} reaction`, error);
  }
};

const removeReaction = async ({ emoji, messageID, thread }: ReactionOptions) => {
  try {
    await thread.adapter.removeReaction(thread.id, messageID, emoji);
  } catch (error) {
    console.error(`Could not remove ${emoji} reaction`, error);
  }
};

const transitionReaction = async ({
  messageID,
  thread,
  from,
  to,
}: Omit<ReactionOptions, 'emoji'> & { from: string; to: string }) => {
  await Promise.all([
    removeReaction({ emoji: from, messageID, thread }),
    addReaction({ emoji: to, messageID, thread }),
  ]);
};

export const processMention = async ({
  client,
  config,
  directory,
  thread,
  triggeringMessage,
  userTimezone,
}: ProcessMentionOptions) => {
  const session = await getOrCreateThreadSession({
    adapterName: thread.adapter.name,
    client,
    config,
    directory,
    state: await thread.state,
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
    userTimezone,
  });
  const response = await runSessionTurn({
    adapterName: thread.adapter.name,
    client,
    metadata: { lastMessageID, source: thread.adapter.name, threadID: thread.id },
    prompt,
    sessionID: session.sessionID,
  });
  await thread.setState({ lastMessageID, sessionID: session.sessionID });

  if (session.created) {
    await generateAndApplySessionTitle({
      adapterName: thread.adapter.name,
      client,
      directory,
      model: config.smallModel,
      prompt,
      sessionID: session.sessionID,
    });
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
