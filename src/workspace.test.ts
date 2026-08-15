import type { OpenCodeClient } from '@opencode-ai/client';
import { describe, expect, it, vi } from 'vitest';
import { createThreadWorkspace } from './workspace';

describe('createThreadWorkspace', () => {
  it('provisions the workspace through the OpenCode server', async () => {
    const client = {
      shell: {
        create: vi.fn(async () => ({
          data: { id: 'shell-1', status: 'running' },
        })),
        get: vi.fn(async () => ({
          data: { exit: 0, id: 'shell-1', status: 'exited' },
        })),
        output: vi.fn(async () => ({
          data: {
            output: 'Preparing worktree\nREMOTECODE_WORKSPACE=/srv/remote/sessions/abc\n',
          },
        })),
        remove: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;

    await expect(
      createThreadWorkspace({
        adapter: 'slack',
        client,
        repositoryRoot: '~/repos',
        threadID: 'thread-1',
        workspaceRoot: '~/remotecode',
      }),
    ).resolves.toBe('/srv/remote/sessions/abc');
    expect(client.shell.create).toHaveBeenCalledWith({
      command: expect.stringMatching(/'~\/repos' '~\/remotecode' '[a-f0-9]{20}' 8$/),
      timeout: 120_000,
    });
    expect(client.shell.remove).toHaveBeenCalledWith({ id: 'shell-1' });
  });
});
