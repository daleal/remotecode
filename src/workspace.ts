import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { OpenCodeClient } from '@opencode-ai/client';

const PROVISION_CONCURRENCY = 8;

const PROVISION_SCRIPT = String.raw`
expand_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "$(printf '%s' "$1" | cut -c3-)" ;;
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$PWD" "$1" ;;
  esac
}

repository_root=$(expand_path "$1")
workspace_root=$(expand_path "$2")
key=$3
concurrency=$4
directory="$workspace_root/sessions/$key"
ready="$directory/.remotecode-ready"

if [ -f "$ready" ]; then
  printf 'REMOTECODE_WORKSPACE=%s\n' "$directory"
  exit 0
fi

mkdir -p "$directory"

prepare_repository() {
  local repository=$1
  local target=$2
  local branch="remotecode/$key"

  git -C "$repository" fetch --prune origin \
    '+refs/heads/main:refs/remotes/origin/main'
  git -C "$repository" worktree prune
  if git -C "$repository" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repository" worktree add "$target" "$branch"
  else
    git -C "$repository" worktree add -b "$branch" "$target" refs/remotes/origin/main
  fi
  printf '%s\n' "$key" > "$target/.remotecode-ready"
}

found=false
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

for repository in "$repository_root"/*; do
  [ -e "$repository/.git" ] || continue
  found=true
  name=$(basename "$repository")
  target="$directory/$name"
  branch="remotecode/$key"

  if [ -e "$target" ]; then
    if [ "$(cat "$target/.remotecode-ready" 2>/dev/null)" = "$key" ] &&
      [ -e "$target/.git" ] &&
      [ "$(git -C "$target" symbolic-ref -q HEAD 2>/dev/null)" = "refs/heads/$branch" ]; then
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

[ "$found" = true ] || {
  printf 'No Git repositories found directly under %s\n' "$repository_root" >&2
  exit 1
}

while [ "$running" -gt 0 ]; do
  wait_for_repository
done
[ "$failed" = false ] || exit 1

printf '%s\n' "$key" > "$ready"
printf 'REMOTECODE_WORKSPACE=%s\n' "$directory"
`;

let provisionQueue = Promise.resolve();

interface CreateThreadWorkspaceOptions {
  adapter: string;
  client: OpenCodeClient;
  repositoryRoot: string;
  threadID: string;
  workspaceRoot: string;
}

export const createThreadWorkspace = async ({
  adapter,
  client,
  repositoryRoot,
  threadID,
  workspaceRoot,
}: CreateThreadWorkspaceOptions) => {
  const key = createHash('sha256').update(`${adapter}\0${threadID}`).digest('hex').slice(0, 20);
  const operation = provisionQueue
    .catch(() => {})
    .then(async () => {
      const command = `bash -ceu ${quote(PROVISION_SCRIPT)} -- ${quote(repositoryRoot)} ${quote(workspaceRoot)} ${quote(key)} ${PROVISION_CONCURRENCY}`;
      const started = await client.shell.create({ command, timeout: 2 * 60 * 1000 });

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

        const marker = result.data.output
          .split('\n')
          .find((line) => line.startsWith('REMOTECODE_WORKSPACE='));
        if (!marker) throw new Error('Remote workspace command returned no directory');
        const directory = marker.slice('REMOTECODE_WORKSPACE='.length);
        if (!posix.isAbsolute(directory))
          throw new Error('Remote workspace directory is not absolute');
        return directory;
      } finally {
        await client.shell.remove({ id: started.data.id }).catch(() => {});
      }
    });
  provisionQueue = operation.then(() => undefined);
  return operation;
};

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
