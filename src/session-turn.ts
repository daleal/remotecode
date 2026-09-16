import type { OpenCodeClient, SessionMessageInfo } from '@opencode/client';

type RunSessionTurnOptions = {
  adapterName: string;
  client: OpenCodeClient;
  metadata: {
    lastMessageID: string;
    source: string;
    threadID: string;
  };
  prompt: string;
  sessionID: string;
};

export const runSessionTurn = async ({
  adapterName,
  client,
  metadata,
  prompt,
  sessionID,
}: RunSessionTurnOptions) => {
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

  let newMessages: SessionMessageInfo[];
  try {
    await client.session.prompt({ metadata, sessionID, text: prompt });
    await waitForSession(client, sessionID);

    newMessages = await newSessionMessages(client, sessionID, previousAssistantIDs);
    const handledSubagents = new Set<string>();
    let subagents = backgroundSubagentIDs(newMessages);
    while (subagents.some((id) => !handledSubagents.has(id))) {
      const current = subagents.filter((id) => !handledSubagents.has(id));
      let completed = completedSubagentIDs(newMessages);
      while (current.some((id) => !completed.has(id))) {
        await sleep(1000);
        newMessages = await newSessionMessages(client, sessionID, previousAssistantIDs);
        completed = completedSubagentIDs(newMessages);
      }
      for (const id of current) handledSubagents.add(id);
      await waitForSession(client, sessionID);
      newMessages = await newSessionMessages(client, sessionID, previousAssistantIDs);
      subagents = backgroundSubagentIDs(newMessages);
    }
  } finally {
    stopRequestMonitor();
    await requestMonitor;
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

  return replies.join('\n\n');
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

const waitForSession = async (client: OpenCodeClient, sessionID: string) => {
  for (;;) {
    try {
      await client.session.wait({ sessionID });
      return;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.warn(`OpenCode wait connection failed for ${sessionID}; reconnecting`, error);
      await sleep(1000);
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

  while (running) {
    await rejectPermissionRequests(client, adapterName, sessionID);
    await Promise.race([sleep(1000), stopped]);
  }
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

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
