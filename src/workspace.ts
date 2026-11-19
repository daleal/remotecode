import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { OpenCodeClient } from '@opencode/client';

const PROVISION_CONCURRENCY = 8;

const EXPAND_PATH_FN = String.raw`
expand_path() {
  local value
  case "$1" in
    "~") value="$HOME" ;;
    "~/"*) value="$HOME/$(printf '%s' "$1" | cut -c3-)" ;;
    /*) value="$1" ;;
    *) value="$PWD/$1" ;;
  esac
  if [ "$value" != "/" ]; then
    value=$(printf '%s' "$value" | sed 's:/*$::')
  fi
  printf '%s\n' "$value"
}
`;

const INIT_WORKSPACE_SCRIPT = String.raw`
${EXPAND_PATH_FN}

repository_root=$(expand_path "$1")
workspace_root=$(expand_path "$2")
key=$3
directory="$workspace_root/sessions/$key"

mkdir -p "$directory"

found=false
for repository in "$repository_root"/*; do
  [ -e "$repository/.git" ] || continue
  found=true
  name=$(basename "$repository")
  printf 'REMOTECODE_AVAILABLE_REPO=%s\n' "$name"
  target="$directory/$name"
  if [ -e "$target" ] &&
    [ "$(cat "$target/.remotecode-ready" 2>/dev/null)" = "$key" ] &&
    [ -e "$target/.git" ] &&
    ! git -C "$target" symbolic-ref -q HEAD >/dev/null 2>&1; then
    printf 'REMOTECODE_PROVISIONED_REPO=%s\n' "$name"
  fi
done

[ "$found" = true ] || {
  printf 'No Git repositories found directly under %s\n' "$repository_root" >&2
  exit 1
}

printf 'REMOTECODE_REPO_ROOT=%s\n' "$repository_root"
printf 'REMOTECODE_WORKSPACE=%s\n' "$directory"
`;

const PROVISION_REPOS_SCRIPT = String.raw`
${EXPAND_PATH_FN}

repository_root=$(expand_path "$1")
workspace_root=$(expand_path "$2")
key=$3
concurrency=$4
shift 4
directory="$workspace_root/sessions/$key"

mkdir -p "$directory"

prepare_repository() {
  local repository=$1
  local target=$2
  local reference=refs/remotes/origin/main
  local fetch_output
  local fetch_status
  local attempt

  for attempt in 1 2 3; do
    fetch_status=0
    fetch_output=$(git -C "$repository" fetch --prune origin \
      '+refs/heads/main:refs/remotes/origin/main' 2>&1) || fetch_status=$?
    [ "$fetch_status" -ne 0 ] || break
    printf '%s\n' "$fetch_output" | grep -Eq 'incorrect old value|cannot lock ref|Unable to create .*\.lock' || break
    sleep "$attempt"
  done

  if [ "$fetch_status" -eq 0 ]; then
    [ -z "$fetch_output" ] || printf '%s\n' "$fetch_output" >&2
  else
    printf '%s\n' "$fetch_output" >&2
    if printf '%s\n' "$fetch_output" | grep -Eq 'HTTP 5[0-9][0-9]|returned error: 5[0-9][0-9]'; then
      reference=refs/heads/main
      printf 'Remote unavailable; using local main for %s\n' "$repository" >&2
    else
      return 1
    fi
  fi
  git -C "$repository" worktree prune
  git -C "$repository" worktree add --detach "$target" "$reference"
  printf '%s\n' "$key" > "$target/.remotecode-ready"
}

failed=false
running=0
pids=''

wait_for_repository() {
  set -- $pids
  pid=$1
  shift
  pids=" $*"
  if ! wait "$pid"; then
    failed=true
  fi
  running=$((running - 1))
}

for name in "$@"; do
  repository="$repository_root/$name"
  [ -e "$repository/.git" ] || {
    printf 'Git repository not found: %s\n' "$repository" >&2
    failed=true
    continue
  }
  target="$directory/$name"

  if [ -e "$target" ]; then
    if [ "$(cat "$target/.remotecode-ready" 2>/dev/null)" = "$key" ] &&
      [ -e "$target/.git" ] &&
      ! git -C "$target" symbolic-ref -q HEAD >/dev/null 2>&1; then
      continue
    fi
    rm -rf -- "$target"
  fi

  prepare_repository "$repository" "$target" &
  pids="$pids $!"
  running=$((running + 1))
  if [ "$running" -ge "$concurrency" ]; then
    wait_for_repository
  fi
done

while [ "$running" -gt 0 ]; do
  wait_for_repository
done
[ "$failed" = false ] || exit 1

printf 'REMOTECODE_WORKSPACE=%s\n' "$directory"
`;

let provisionQueue = Promise.resolve();

export type ThreadWorkspace = {
  availableRepos: string[];
  directory: string;
  provisionedRepos: string[];
  repositoryRoot: string;
};

export type InitThreadWorkspaceOptions = {
  adapter: string;
  client: OpenCodeClient;
  repositoryRoot: string;
  threadID: string;
  workspaceRoot: string;
};

export type ProvisionWorkspaceReposOptions = {
  adapter: string;
  client: OpenCodeClient;
  repos: readonly string[];
  repositoryRoot: string;
  threadID: string;
  workspaceRoot: string;
};

export const initThreadWorkspace = async ({
  adapter,
  client,
  repositoryRoot,
  threadID,
  workspaceRoot,
}: InitThreadWorkspaceOptions): Promise<ThreadWorkspace> => {
  const key = workspaceKey(adapter, threadID);
  const command = `bash -ceu ${quote(INIT_WORKSPACE_SCRIPT)} -- ${quote(repositoryRoot)} ${quote(workspaceRoot)} ${quote(key)}`;
  const output = await runRemoteShell(client, command, 30 * 1000);
  const lines = output.split('\n');

  const directory = markerValue(lines, 'REMOTECODE_WORKSPACE=');
  if (!directory) throw new Error('Remote workspace command returned no directory');
  if (!posix.isAbsolute(directory)) throw new Error('Remote workspace directory is not absolute');

  const resolvedRepositoryRoot = markerValue(lines, 'REMOTECODE_REPO_ROOT=');
  if (!resolvedRepositoryRoot) {
    throw new Error('Remote workspace command returned no repository root');
  }
  if (!posix.isAbsolute(resolvedRepositoryRoot)) {
    throw new Error('Remote repository root is not absolute');
  }

  const availableRepos = markerValues(lines, 'REMOTECODE_AVAILABLE_REPO=');
  const provisionedRepos = markerValues(lines, 'REMOTECODE_PROVISIONED_REPO=');

  return {
    availableRepos,
    directory,
    provisionedRepos,
    repositoryRoot: resolvedRepositoryRoot,
  };
};

export const provisionWorkspaceRepos = async ({
  adapter,
  client,
  repos,
  repositoryRoot,
  threadID,
  workspaceRoot,
}: ProvisionWorkspaceReposOptions): Promise<string[]> => {
  const uniqueRepos = [...new Set(repos.map(validateRepoName))];
  if (uniqueRepos.length === 0) return [];

  const key = workspaceKey(adapter, threadID);
  const operation = provisionQueue
    .catch(() => {})
    .then(async () => {
      const repoArgs = uniqueRepos.map(quote).join(' ');
      const command = `bash -ceu ${quote(PROVISION_REPOS_SCRIPT)} -- ${quote(repositoryRoot)} ${quote(workspaceRoot)} ${quote(key)} ${PROVISION_CONCURRENCY} ${repoArgs}`;
      const output = await runRemoteShell(client, command, 2 * 60 * 1000);

      const directory = markerValue(output.split('\n'), 'REMOTECODE_WORKSPACE=');
      if (!directory) throw new Error('Remote workspace command returned no directory');
      if (!posix.isAbsolute(directory)) {
        throw new Error('Remote workspace directory is not absolute');
      }
      return uniqueRepos;
    });
  provisionQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
};

const runRemoteShell = async (client: OpenCodeClient, command: string, timeout: number) => {
  const started = await client.shell.create({ command, timeout });

  try {
    let shell = started.data;
    while (shell.status === 'running') {
      await sleep(100);
      shell = (await client.shell.get({ id: shell.id })).data;
    }

    const result = await client.shell.output({ id: shell.id });
    if (shell.status !== 'exited' || shell.exit !== 0) {
      throw new Error(result.data.output.trim() || `Remote workspace command ${shell.status}`);
    }

    return result.data.output;
  } finally {
    await client.shell.remove({ id: started.data.id }).catch(() => {});
  }
};

const workspaceKey = (adapter: string, threadID: string) =>
  createHash('sha256').update(`${adapter}\0${threadID}`).digest('hex').slice(0, 20);

const validateRepoName = (name: string) => {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error(`Invalid repository name: ${name}`);
  }
  return name;
};

const markerValue = (lines: string[], prefix: string) => {
  const line = lines.find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length) : undefined;
};

const markerValues = (lines: string[], prefix: string) => [
  ...new Set(
    lines
      .filter((item) => item.startsWith(prefix))
      .map((item) => item.slice(prefix.length))
      .filter(Boolean),
  ),
];

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
