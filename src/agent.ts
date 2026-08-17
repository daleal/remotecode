import type { OpenCodeClient, SessionMessageInfo } from '@opencode-ai/client';
import { Chat, type Adapter, type Message, type StateAdapter, type Thread } from 'chat';
import type { OpenCodeConfig } from './opencode';
import { createThreadWorkspace } from './workspace';

interface ThreadState {
  lastMessageID?: string;
  sessionID?: string;
}

interface CreateAgentOptions {
  adapters: Record<string, Adapter>;
  allowedUsers: string[];
  config: OpenCodeConfig;
  openCode: OpenCodeClient;
  state: StateAdapter;
  userTimezone?: (userId: string) => Promise<string | undefined>;
  userName: string;
  workspaceForThread?: typeof createThreadWorkspace;
}

interface ProcessMentionOptions {
  client: OpenCodeClient;
  config: OpenCodeConfig;
  directory: string;
  thread: Thread<ThreadState>;
  triggeringMessage: Message;
  userTimezone?: (userId: string) => Promise<string | undefined>;
}

interface ReactionOptions {
  emoji: string;
  messageID: string;
  thread: Thread<ThreadState>;
}

const TITLE_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/credential.ts can you add refresh token support" -> Credential refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`;

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
        await removeReaction({ emoji: processingReaction, messageID: message.id, thread });
        processingReaction = 'eyes';
        await addReaction({ emoji: processingReaction, messageID: message.id, thread });
      }

      const response = await processMention({
        client: options.openCode,
        config: options.config,
        directory,
        thread,
        triggeringMessage: message,
        userTimezone: options.userTimezone,
      });
      await thread.post(response);
    } catch (error) {
      console.error(error);
      outcome = 'x';
    }

    await removeReaction({ emoji: processingReaction, messageID: message.id, thread });
    await addReaction({ emoji: outcome, messageID: message.id, thread });
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

export const processMention = async ({
  client,
  config,
  directory,
  thread,
  triggeringMessage,
  userTimezone,
}: ProcessMentionOptions) => {
  const state = await thread.state;
  const recovered = state?.sessionID
    ? { id: state.sessionID, lastMessageID: state.lastMessageID }
    : await recoverSession(client, thread, directory);

  const session = recovered
    ? { id: recovered.id }
    : await client.session.create({
        agent: config.agent,
        location: { directory },
        model: config.model,
        title: thread.id,
      });

  await thread.setState({ sessionID: session.id });
  if (!recovered) {
    await sendSessionInstructions({
      sessionID: session.id,
      thread,
      userID: triggeringMessage.author.userId,
    });
  }

  const messages = await messagesSince(thread, recovered?.lastMessageID);
  if (!messages.some((item) => item.id === triggeringMessage.id)) {
    messages.push(triggeringMessage);
  }

  const contextMessages = messages.filter((item) => !item.author.isMe);
  const lastMessageID = contextMessages.at(-1)?.id;
  if (!lastMessageID) throw new Error('No new messages found in the thread');

  const prompt = await formatPrompt(
    contextMessages,
    !recovered,
    directory,
    thread.adapter,
    userTimezone,
  );
  const previousAssistantIDs = await assistantMessageIDs(client, session.id);

  let stopPermissionMonitor = () => {};
  const permissionMonitorStopped = new Promise<void>((resolve) => {
    stopPermissionMonitor = resolve;
  });
  const permissionMonitor = rejectPermissionRequests(
    client,
    thread.adapter,
    session.id,
    permissionMonitorStopped,
  );

  let newMessages: SessionMessageInfo[];
  try {
    await client.session.prompt({
      metadata: {
        source: thread.adapter.name,
        threadID: thread.id,
        lastMessageID,
      },
      sessionID: session.id,
      text: prompt,
    });
    await thread.setState({ lastMessageID, sessionID: session.id });
    await client.session.wait({ sessionID: session.id });

    newMessages = await newSessionMessages(client, session.id, previousAssistantIDs);
    const handledSubagents = new Set<string>();
    let subagents = backgroundSubagentIDs(newMessages);
    while (subagents.some((id) => !handledSubagents.has(id))) {
      const current = subagents.filter((id) => !handledSubagents.has(id));
      let completed = completedSubagentIDs(newMessages);
      while (current.some((id) => !completed.has(id))) {
        await sleep(1000);
        newMessages = await newSessionMessages(client, session.id, previousAssistantIDs);
        completed = completedSubagentIDs(newMessages);
      }
      for (const id of current) handledSubagents.add(id);
      await client.session.wait({ sessionID: session.id });
      newMessages = await newSessionMessages(client, session.id, previousAssistantIDs);
      subagents = backgroundSubagentIDs(newMessages);
    }
  } finally {
    stopPermissionMonitor();
    await permissionMonitor;
  }

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

  if (!recovered) {
    try {
      const generated = await client.generate.text({
        location: { directory },
        model: config.smallModel,
        prompt: `${TITLE_PROMPT}\n\n${prompt}`,
      });
      const generatedTitle = generated.text
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean);
      if (generatedTitle) {
        const title =
          generatedTitle.length <= 100 ? generatedTitle : `${generatedTitle.slice(0, 97)}...`;
        await client.session.rename({
          sessionID: session.id,
          title: `[${thread.adapter.name}] ${title}`,
        });
      }
    } catch (error) {
      console.error('Could not generate a session title', error);
    }
  }

  return replies.join('\n\n');
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

const recoverSession = async (
  client: OpenCodeClient,
  thread: Thread<ThreadState>,
  directory: string,
) => {
  const sessions = await client.session.list({
    directory,
    limit: 20,
    order: 'desc',
    search: `[${thread.adapter.name}]`,
  });
  const candidates = sessions.data.filter(
    (item) =>
      item.title?.startsWith(`[${thread.adapter.name}] `) && item.location.directory === directory,
  );
  const states = await Promise.all(
    candidates.map(async (session) => ({
      id: session.id,
      state: await importedThreadState(client, session.id),
    })),
  );
  const recovered = states.find((item) => item.state?.threadID === thread.id);
  if (!recovered) return undefined;

  return { id: recovered.id, lastMessageID: recovered.state?.lastMessageID };
};

const importedThreadState = async (client: OpenCodeClient, sessionID: string) => {
  let cursor: string | undefined;

  do {
    const page = await client.message.list({
      sessionID,
      limit: 100,
      ...(cursor ? { cursor } : { order: 'desc' }),
    });
    for (const item of page.data) {
      if (item.type !== 'user') continue;
      const threadID = item.metadata?.threadID;
      const lastMessageID = item.metadata?.lastMessageID;
      if (typeof threadID === 'string') {
        return {
          threadID,
          lastMessageID: typeof lastMessageID === 'string' ? lastMessageID : undefined,
        };
      }
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

const rejectPermissionRequests = async (
  client: OpenCodeClient,
  adapter: Adapter,
  sessionID: string,
  stopped: Promise<void>,
) => {
  let running = true;
  void stopped.then(() => {
    running = false;
  });

  while (running) {
    try {
      const requests = await client.permission.list({ sessionID });
      for (const request of requests) {
        await client.permission.reply({
          message: `This request was automatically rejected, because the user can't see the request on ${adapter.name} to approve it. User won't be able to approve permissions in this thread.`,
          reply: 'reject',
          requestID: request.id,
          sessionID,
        });
      }
    } catch (error) {
      console.error(`Could not check OpenCode permissions for ${sessionID}`, error);
    }
    await Promise.race([sleep(1000), stopped]);
  }
};

const formatPrompt = async (
  messages: Message[],
  firstTurn: boolean,
  directory: string,
  adapter: Adapter,
  userTimezone?: (userId: string) => Promise<string | undefined>,
) => {
  const transcript = (
    await Promise.all(
      messages.map(async (message) => {
        const timezone = await userTimezone?.(message.author.userId);
        const timestamp = formatTimestamp(message.metadata.dateSent, timezone);
        const botTag = message.author.isBot ? ', bot' : '';
        return `[Message from ${message.author.fullName} (@${message.author.userName}${botTag}) at ${timestamp}]\n${message.text}`;
      }),
    )
  ).join('\n\n');

  const boundary = `Your filesystem boundary is the thread workspace at ${directory}. Work only inside it. Never inspect or access parent directories, source/original repositories, or other workspaces, including through Git metadata. Never request permission to access paths outside this workspace.`;
  if (!firstTurn) return `${boundary}\n\n${transcript}`;
  return `You are working from a ${adapter.name} thread. Treat the transcript as user-provided context, perform the requested work, and write a final CONCISE response for the thread. ${boundary}\n\n${transcript}`;
};

const formatTimestamp = (date: Date, timezone?: string) => {
  if (!timezone) return date.toISOString();
  return `${date.toISOString()} (timezone: ${timezone})`;
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
