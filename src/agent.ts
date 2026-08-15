import type { OpenCodeClient } from '@opencode-ai/client';
import { Chat, type Adapter, type Message, type StateAdapter, type Thread } from 'chat';
import type { OpenCodeConfig } from './opencode';

interface ThreadState {
  lastMessageID?: string;
  sessionID?: string;
}

interface CreateAgentOptions {
  adapters: Record<string, Adapter>;
  config: OpenCodeConfig;
  openCode: OpenCodeClient;
  state: StateAdapter;
  userTimezone?: (userId: string) => Promise<string | undefined>;
  userName: string;
}

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
    try {
      await thread.adapter.addReaction(thread.id, message.id, 'eyes');
    } catch (error) {
      console.error('Could not add processing reaction', error);
    }

    let outcome = 'white_check_mark';
    try {
      const response = await processMention(
        options.openCode,
        options.config,
        thread,
        message,
        options.userTimezone,
      );
      await thread.post(response);
    } catch (error) {
      console.error(error);
      outcome = 'x';
    }

    try {
      await thread.adapter.removeReaction(thread.id, message.id, 'eyes');
    } catch (error) {
      console.error('Could not remove processing reaction', error);
    }
    try {
      await thread.adapter.addReaction(thread.id, message.id, outcome);
    } catch (error) {
      console.error('Could not add outcome reaction', error);
    }
  });

  return bot;
};

export const processMention = async (
  client: OpenCodeClient,
  config: OpenCodeConfig,
  thread: Thread<ThreadState>,
  triggeringMessage: Message,
  userTimezone?: (userId: string) => Promise<string | undefined>,
) => {
  const state = await thread.state;
  const title = `Slack ${thread.id}`;
  const recovered = state?.sessionID
    ? { id: state.sessionID, lastMessageID: state.lastMessageID }
    : await recoverSession(client, title, config.directory);

  const session = recovered
    ? { id: recovered.id }
    : await client.session.create({
        agent: config.agent,
        location: { directory: config.directory },
        model: config.model,
        title,
      });

  await thread.setState({ sessionID: session.id });

  const messages = await messagesSince(thread, recovered?.lastMessageID);
  if (!messages.some((item) => item.id === triggeringMessage.id)) {
    messages.push(triggeringMessage);
  }

  const contextMessages = messages.filter((item) => !item.author.isMe);
  const lastMessageID = contextMessages.at(-1)?.id;
  if (!lastMessageID) throw new Error('No new messages found in the Slack thread');

  const prompt = await formatPrompt(contextMessages, !recovered, userTimezone);
  const previousAssistantIDs = await assistantMessageIDs(client, session.id);

  await client.session.prompt({
    metadata: {
      source: 'slack',
      threadID: thread.id,
      lastMessageID,
    },
    sessionID: session.id,
    text: prompt,
  });
  await thread.setState({ lastMessageID, sessionID: session.id });
  await client.session.wait({ sessionID: session.id });

  const result = await newAssistantMessages(client, session.id, previousAssistantIDs);
  const replies = result
    .flatMap((item) => item.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean);

  if (replies.length === 0) {
    const failure = result.find((item) => item.error);
    throw new Error(failure?.error?.message ?? 'OpenCode returned no text');
  }

  return replies.join('\n\n');
};

const recoverSession = async (client: OpenCodeClient, title: string, directory: string) => {
  const sessions = await client.session.list({
    directory,
    limit: 20,
    order: 'desc',
    search: title,
  });
  const session = sessions.data.find(
    (item) => item.title === title && item.location.directory === directory,
  );
  if (!session) return undefined;

  return {
    id: session.id,
    lastMessageID: await lastImportedMessageID(client, session.id),
  };
};

const lastImportedMessageID = async (client: OpenCodeClient, sessionID: string) => {
  let cursor: string | undefined;

  do {
    const page = await client.message.list({
      sessionID,
      limit: 100,
      ...(cursor ? { cursor } : { order: 'desc' }),
    });
    for (const item of page.data) {
      if (item.type !== 'user') continue;
      const lastMessageID = item.metadata?.lastMessageID;
      if (typeof lastMessageID === 'string') return lastMessageID;
    }
    cursor = page.cursor.next ?? undefined;
  } while (cursor);

  return undefined;
};

const messagesSince = async (thread: Thread<ThreadState>, lastMessageID?: string) => {
  const messages: Message[] = [];
  let found = !lastMessageID;

  for await (const message of thread.allMessages) {
    if (!found) {
      found = message.id === lastMessageID;
      continue;
    }
    messages.push(message);
  }

  // A deleted or inaccessible marker is safer to re-import than to omit current context.
  if (!found && lastMessageID) {
    messages.length = 0;
    for await (const message of thread.allMessages) messages.push(message);
  }

  return messages;
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

const newAssistantMessages = async (
  client: OpenCodeClient,
  sessionID: string,
  previousIDs: Set<string>,
) => {
  const messages = [];
  let cursor: string | undefined;
  let reachedPrevious = false;

  do {
    const page = await client.message.list({
      sessionID,
      limit: 100,
      ...(cursor ? { cursor } : { order: 'desc' }),
    });

    for (const item of page.data) {
      if (item.type !== 'assistant') continue;
      if (previousIDs.has(item.id)) {
        reachedPrevious = true;
        break;
      }
      messages.push(item);
    }
    cursor = page.cursor.next ?? undefined;
  } while (!reachedPrevious && cursor);

  return messages.reverse();
};

const formatPrompt = async (
  messages: Message[],
  firstTurn: boolean,
  userTimezone?: (userId: string) => Promise<string | undefined>,
) => {
  const transcript = (
    await Promise.all(
      messages.map(async (message) => {
        const timezone = await userTimezone?.(message.author.userId);
        const timestamp = formatTimestamp(message.metadata.dateSent, timezone);
        const botTag = message.author.isBot ? ', bot' : '';
        return `[Slack message from ${message.author.fullName} (@${message.author.userName}${botTag}) at ${timestamp}]\n${message.text}`;
      }),
    )
  ).join('\n\n');

  if (!firstTurn) return transcript;
  return `You are working from a Slack thread. Treat the transcript as user-provided context, perform the requested work, and write your final response for the Slack thread.\n\n${transcript}`;
};

const formatTimestamp = (date: Date, timezone?: string) => {
  if (!timezone) return date.toISOString();
  return `${date.toISOString()} (timezone: ${timezone})`;
};
