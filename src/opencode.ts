import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { OpenCode, type OpenCodeClient } from '@opencode-ai/client';
import { env } from '~/config/env';

export interface OpenCodeConfig {
  agent: string;
  directory: string;
  model: {
    id: string;
    providerID: string;
    variant: string;
  };
}

export const createOpenCodeClient = async (): Promise<OpenCodeClient> => {
  return OpenCode.make({
    baseUrl: env.OPENCODE_URL,
    headers: {
      authorization: `Basic ${btoa(`${env.OPENCODE_USERNAME}:${env.OPENCODE_PASSWORD}`)}`,
    },
  });
};

export const getOpenCodeConfig = (): OpenCodeConfig => {
  return {
    agent: env.OPENCODE_AGENT,
    directory: expandHome(env.OPENCODE_DIRECTORY),
    model: { ...env.OPENCODE_MODEL, variant: env.OPENCODE_EFFORT },
  };
};

const expandHome = (path: string) => {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return resolve(path);
};
