import type { OpenCodeClient } from '@opencode-ai/client';
import { describe, expect, it, vi } from 'vitest';
import { createThreadWorkspace } from './workspace';

describe('createThreadWorkspace', () => {
  it('provisions the workspace through the OpenCode server', async () => {
    const create = vi.fn(async (_input: { command: string; timeout: number }) => ({
      data: { id: 'shell-1', status: 'running' },
    }));
    const client = {
      shell: {
        create,
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
    expect(create).toHaveBeenCalledWith({
      command: expect.stringMatching(/'~\/repos' '~\/remotecode' '[a-f0-9]{20}' 8$/),
      timeout: 120_000,
    });
    expect(create.mock.calls[0]?.[0]?.command).toContain('worktree add --detach');
    expect(create.mock.calls[0]?.[0]?.command).toContain('HTTP 5[0-9][0-9]');
    expect(create.mock.calls[0]?.[0]?.command).toContain('reference=refs/heads/main');
    expect(create.mock.calls[0]?.[0]?.command).not.toContain('remotecode/');
    expect(create.mock.calls[0]?.[0]?.command).not.toContain('wait -n');
    expect(client.shell.remove).toHaveBeenCalledWith({ id: 'shell-1' });
  });
});
