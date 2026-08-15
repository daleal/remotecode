# RemoteCode

A single-workspace Slack agent backed by a local OpenCode v2 server. It responds only to
`@mentions`, reacts with `:eyes:` while working and `:white_check_mark:` or `:x:` when finished,
and creates one OpenCode session per Slack thread.

## How Thread Context Works

The first mention sends every message except RemoteCode's own messages in the Slack thread to a new
OpenCode session. Each later mention sends only messages added since the previous turn. OpenCode
retains its own assistant and tool history, so prior content is neither duplicated nor reordered
and the model's prompt prefix remains cacheable.

No database is required. The active process caches thread state in memory. For restart recovery,
the app finds the session by its deterministic Slack thread title and reads the last imported Slack
message ID from OpenCode prompt metadata.

## Slack Setup

1. Start the OpenCode v2 service at `http://127.0.0.1:4096` with `opencode2 service start`.
2. Create a Slack app from [`slack-manifest.yaml`](./slack-manifest.yaml).
3. Under **Basic Information > App-Level Tokens**, create a token with `connections:write`.
4. Install the app into the workspace and invite it to channels where it should work.
5. Create `.env` from `.env.example`. Set `SLACK_BOT_TOKEN` (`xoxb-...`), `SLACK_APP_TOKEN`
   (`xapp-...`), and `OPENCODE_PASSWORD` to the Basic auth password used by the running OpenCode
   server.
6. Run `bun install`, then `bun run start`.

Only `app_mention` is subscribed. Untagged thread replies are fetched as context when the next
tag arrives, but never trigger the agent themselves.

## Configuration

| Variable              | Default                 | Purpose                                     |
| --------------------- | ----------------------- | ------------------------------------------- |
| `SLACK_BOT_TOKEN`     | required                | Single-workspace bot token                  |
| `SLACK_APP_TOKEN`     | required                | Socket Mode app token                       |
| `SLACK_BOT_NAME`      | `remotecode`            | Mention username used by Chat SDK           |
| `ALLOWED_SLACK_USERS` | empty                   | Allowed user IDs; empty denies all mentions |
| `OPENCODE_URL`        | `http://127.0.0.1:4096` | OpenCode v2 server                          |
| `OPENCODE_DIRECTORY`  | `~/repos`               | Working directory for new sessions          |
| `OPENCODE_AGENT`      | `build`                 | OpenCode agent                              |
| `OPENCODE_MODEL`      | `openai/gpt-5.6-sol`    | Model in `provider/model` form              |
| `OPENCODE_EFFORT`     | `medium`                | Model variant/effort, such as `high`        |
| `OPENCODE_USERNAME`   | `opencode`              | OpenCode Basic auth username                |
| `OPENCODE_PASSWORD`   | required                | OpenCode Basic auth password                |

## Local Mock

After configuring `OPENCODE_PASSWORD`, run `bun run dev` to exercise the full Chat SDK and OpenCode
path without Slack credentials. Every normal line is treated as a mention. Useful commands:

```text
/say untagged context that should not trigger the agent
/thread another-thread
/quit
```

Each mock thread maps to an independent OpenCode session, matching Slack behavior.

## Docker Compose

The included [`compose.yaml`](./compose.yaml) runs the local mock in a Docker container and mounts the
repository for live code changes. Copy `.env.example` to `.env`, set `OPENCODE_PASSWORD`, start the
local OpenCode service, then run:

```bash
docker compose run --rm dev
```

The service uses `network_mode: host`, so the default `OPENCODE_URL=http://127.0.0.1:4096` reaches
OpenCode on the host. This setup requires Docker host-networking support and is intended for Linux.
The placeholder Slack tokens in `compose.yaml` are only used to satisfy configuration validation;
the local mock does not connect to Slack.

## Checks

```bash
bun run typecheck
bun run lint
bun run format:check
bun test
```
