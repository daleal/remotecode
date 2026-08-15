import { OpenCode, type OpenCodeClient } from '@opencode-ai/client';
import { env } from '~/config/env';

export interface OpenCodeConfig {
  agent: string;
  model: {
    id: string;
    providerID: string;
    variant: string;
  };
  smallModel: {
    id: string;
    providerID: string;
  };
  reposRoot: string;
  workspaceRoot: string;
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
    model: { ...env.OPENCODE_MODEL, variant: env.OPENCODE_EFFORT },
    reposRoot: env.REPOS_ROOT,
    smallModel: env.OPENCODE_SMALL_MODEL,
    workspaceRoot: env.WORKSPACE_ROOT,
  };
};
