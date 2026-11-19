import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenCodeClient } from '@opencode/client';
import { describe, expect, it, vi } from 'vitest';
import { initThreadWorkspace, provisionWorkspaceRepos } from '../workspace';

describe('initThreadWorkspace', () => {
  it('initializes the workspace directory and discovers available and provisioned repos', async () => {
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
            output: [
              'REMOTECODE_AVAILABLE_REPO=api',
              'REMOTECODE_PROVISIONED_REPO=api',
              'REMOTECODE_AVAILABLE_REPO=dashboard',
              'REMOTECODE_REPO_ROOT=/srv/repos',
              'REMOTECODE_WORKSPACE=/srv/remote/sessions/abc',
            ].join('\n'),
          },
        })),
        remove: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;

    await expect(
      initThreadWorkspace({
        adapter: 'slack',
        client,
        repositoryRoot: '~/repos',
        threadID: 'thread-1',
        workspaceRoot: '~/remotecode',
      }),
    ).resolves.toEqual({
      availableRepos: ['api', 'dashboard'],
      directory: '/srv/remote/sessions/abc',
      provisionedRepos: ['api'],
      repositoryRoot: '/srv/repos',
    });

    expect(create).toHaveBeenCalledWith({
      command: expect.stringMatching(/'~\/repos' '~\/remotecode' '[a-f0-9]{20}'$/),
      timeout: 30_000,
    });
    expect(create.mock.calls[0]?.[0]?.command).not.toContain('worktree add');
    expect(client.shell.remove).toHaveBeenCalledWith({ id: 'shell-1' });
  });
});

describe('provisionWorkspaceRepos', () => {
  it('returns immediately without running a shell when no repos are requested', async () => {
    const create = vi.fn();
    const client = { shell: { create } } as unknown as OpenCodeClient;

    await expect(
      provisionWorkspaceRepos({
        adapter: 'slack',
        client,
        repos: [],
        repositoryRoot: '~/repos',
        threadID: 'thread-1',
        workspaceRoot: '~/remotecode',
      }),
    ).resolves.toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects invalid repository names before spawning a shell', async () => {
    const create = vi.fn();
    const client = { shell: { create } } as unknown as OpenCodeClient;

    await expect(
      provisionWorkspaceRepos({
        adapter: 'slack',
        client,
        repos: ['../secret'],
        repositoryRoot: '~/repos',
        threadID: 'thread-1',
        workspaceRoot: '~/remotecode',
      }),
    ).rejects.toThrow('Invalid repository name: ../secret');
    expect(create).not.toHaveBeenCalled();
  });

  it('provisions only the requested repositories through the OpenCode server', async () => {
    const create = vi.fn(async (_input: { command: string; timeout: number }) => ({
      data: { id: 'shell-2', status: 'running' },
    }));
    const client = {
      shell: {
        create,
        get: vi.fn(async () => ({
          data: { exit: 0, id: 'shell-2', status: 'exited' },
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
      provisionWorkspaceRepos({
        adapter: 'slack',
        client,
        repos: ['api', 'dashboard', 'api'],
        repositoryRoot: '~/repos',
        threadID: 'thread-1',
        workspaceRoot: '~/remotecode',
      }),
    ).resolves.toEqual(['api', 'dashboard']);

    expect(create).toHaveBeenCalledWith({
      command: expect.stringMatching(
        /'~\/repos' '~\/remotecode' '[a-f0-9]{20}' 8 'api' 'dashboard'$/,
      ),
      timeout: 120_000,
    });
    expect(create.mock.calls[0]?.[0]?.command).toContain('worktree add --detach');
    expect(create.mock.calls[0]?.[0]?.command).toContain('HTTP 5[0-9][0-9]');
    expect(create.mock.calls[0]?.[0]?.command).toContain('reference=refs/heads/main');
    expect(create.mock.calls[0]?.[0]?.command).not.toContain('remotecode/');
    expect(create.mock.calls[0]?.[0]?.command).not.toContain('wait -n');
    expect(client.shell.remove).toHaveBeenCalledWith({ id: 'shell-2' });
  });

  it('incrementally provisions selected worktrees and detects them on re-initialization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'remotecode-ws-'));
    const remotesRoot = join(root, 'remotes');
    const reposRoot = join(root, 'repos');
    const workspaceRoot = join(root, 'workspaces');
    mkdirSync(remotesRoot, { recursive: true });
    mkdirSync(reposRoot, { recursive: true });

    const createRepo = (name: string) => {
      const bare = join(remotesRoot, `${name}.git`);
      const repo = join(reposRoot, name);
      execFileSync('git', ['init', '--bare', bare]);
      execFileSync('git', ['init', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
      writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
      execFileSync('git', ['-C', repo, 'add', 'README.md']);
      execFileSync('git', ['-C', repo, 'commit', '-m', 'init']);
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
      execFileSync('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
    };

    const outputs = new Map<string, { exit: number; output: string }>();
    let shellCounter = 0;
    const localShellClient = {
      shell: {
        create: vi.fn(async ({ command }: { command: string }) => {
          const id = `local-${++shellCounter}`;
          try {
            const output = execFileSync('bash', ['-c', command], { encoding: 'utf8' });
            outputs.set(id, { exit: 0, output });
          } catch (error) {
            const err = error as { status?: number; stdout?: string; stderr?: string };
            outputs.set(id, {
              exit: err.status ?? 1,
              output: `${err.stdout ?? ''}${err.stderr ?? ''}`,
            });
          }
          return { data: { exit: outputs.get(id)?.exit ?? 1, id, status: 'exited' } };
        }),
        get: vi.fn(),
        output: vi.fn(async ({ id }: { id: string }) => ({
          data: { output: outputs.get(id)?.output ?? '' },
        })),
        remove: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;

    try {
      createRepo('api');
      createRepo('dashboard');

      const initial = await initThreadWorkspace({
        adapter: 'slack',
        client: localShellClient,
        repositoryRoot: reposRoot,
        threadID: 'thread-e2e',
        workspaceRoot,
      });

      expect(initial.availableRepos).toEqual(['api', 'dashboard']);
      expect(initial.provisionedRepos).toEqual([]);
      expect(initial.repositoryRoot).toBe(reposRoot);
      expect(existsSync(join(initial.directory, 'api'))).toBe(false);
      expect(existsSync(join(initial.directory, 'dashboard'))).toBe(false);

      await provisionWorkspaceRepos({
        adapter: 'slack',
        client: localShellClient,
        repos: ['api'],
        repositoryRoot: reposRoot,
        threadID: 'thread-e2e',
        workspaceRoot,
      });

      expect(existsSync(join(initial.directory, 'api', 'README.md'))).toBe(true);
      expect(existsSync(join(initial.directory, 'dashboard'))).toBe(false);

      const recovered = await initThreadWorkspace({
        adapter: 'slack',
        client: localShellClient,
        repositoryRoot: reposRoot,
        threadID: 'thread-e2e',
        workspaceRoot,
      });
      expect(recovered.availableRepos).toEqual(['api', 'dashboard']);
      expect(recovered.provisionedRepos).toEqual(['api']);

      await provisionWorkspaceRepos({
        adapter: 'slack',
        client: localShellClient,
        repos: ['dashboard'],
        repositoryRoot: reposRoot,
        threadID: 'thread-e2e',
        workspaceRoot,
      });
      expect(existsSync(join(initial.directory, 'dashboard', 'README.md'))).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
