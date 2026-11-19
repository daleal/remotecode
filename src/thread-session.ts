import type { OpenCodeClient } from '@opencode/client';
import type { OpenCodeConfig } from './opencode';

export type ThreadState = {
  availableRepos?: string[];
  directory?: string;
  lastMessageID?: string;
  provisionedRepos?: string[];
  repositoryRoot?: string;
  sessionID?: string;
};

type GetOrCreateThreadSessionOptions = {
  adapterName: string;
  availableRepos?: string[];
  client: OpenCodeClient;
  config: Pick<OpenCodeConfig, 'agent' | 'model'>;
  directory: string;
  provisionedRepos?: string[];
  state?: ThreadState | null;
  threadID: string;
};

export const getOrCreateThreadSession = async ({
  adapterName,
  availableRepos,
  client,
  config,
  directory,
  provisionedRepos,
  state,
  threadID,
}: GetOrCreateThreadSessionOptions) => {
  const recovered = state?.sessionID
    ? {
        availableRepos: state.availableRepos,
        id: state.sessionID,
        lastMessageID: state.lastMessageID,
        provisionedRepos: state.provisionedRepos,
      }
    : await recoverSession(client, adapterName, threadID, directory);

  if (recovered) {
    return {
      availableRepos: recovered.availableRepos,
      created: false,
      lastMessageID: recovered.lastMessageID,
      provisionedRepos: recovered.provisionedRepos,
      sessionID: recovered.id,
    };
  }

  const metadata =
    availableRepos || provisionedRepos
      ? {
          ...(availableRepos ? { availableRepos } : {}),
          ...(provisionedRepos ? { provisionedRepos } : {}),
          threadID,
        }
      : undefined;

  const session = await client.session.create({
    agent: config.agent,
    location: { directory },
    ...(metadata ? { metadata } : {}),
    model: config.model,
    permissions: [{ action: 'question', resource: '*', effect: 'deny' }],
    title: threadID,
  });
  return {
    availableRepos,
    created: true,
    lastMessageID: undefined,
    provisionedRepos,
    sessionID: session.id,
  };
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

  return {
    availableRepos: recovered.state?.availableRepos,
    id: recovered.id,
    lastMessageID: recovered.state?.lastMessageID,
    provisionedRepos: recovered.state?.provisionedRepos,
  };
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
          availableRepos: stringArray(item.metadata?.availableRepos),
          lastMessageID: typeof lastMessageID === 'string' ? lastMessageID : undefined,
          provisionedRepos: stringArray(item.metadata?.provisionedRepos),
          threadID,
        };
      }
    }
    cursor = page.cursor.next ?? undefined;
  } while (cursor);

  return undefined;
};

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
