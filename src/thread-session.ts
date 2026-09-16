import type { OpenCodeClient } from '@opencode/client';
import type { OpenCodeConfig } from './opencode';

export type ThreadState = {
  lastMessageID?: string;
  sessionID?: string;
};

type GetOrCreateThreadSessionOptions = {
  adapterName: string;
  client: OpenCodeClient;
  config: Pick<OpenCodeConfig, 'agent' | 'model'>;
  directory: string;
  state?: ThreadState | null;
  threadID: string;
};

export const getOrCreateThreadSession = async ({
  adapterName,
  client,
  config,
  directory,
  state,
  threadID,
}: GetOrCreateThreadSessionOptions) => {
  const recovered = state?.sessionID
    ? { id: state.sessionID, lastMessageID: state.lastMessageID }
    : await recoverSession(client, adapterName, threadID, directory);

  if (recovered) {
    return {
      created: false,
      lastMessageID: recovered.lastMessageID,
      sessionID: recovered.id,
    };
  }

  const session = await client.session.create({
    agent: config.agent,
    location: { directory },
    model: config.model,
    permissions: [{ action: 'question', resource: '*', effect: 'deny' }],
    title: threadID,
  });
  return { created: true, lastMessageID: undefined, sessionID: session.id };
};

const recoverSession = async (
  client: OpenCodeClient,
  adapterName: string,
  threadID: string,
  directory: string,
) => {
  const sessions = await client.session.list({
    directory,
    limit: 20,
    order: 'desc',
    search: `[${adapterName}]`,
  });
  const candidates = sessions.data.filter(
    (item) => item.title?.startsWith(`[${adapterName}] `) && item.location.directory === directory,
  );
  const states = await Promise.all(
    candidates.map(async (session) => ({
      id: session.id,
      state: await importedThreadState(client, session.id),
    })),
  );
  const recovered = states.find((item) => item.state?.threadID === threadID);
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
