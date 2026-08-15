import { createSlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import { env } from '~/config/env';
import { createAgent } from './agent';
import { createOpenCodeClient, getOpenCodeConfig } from './opencode';

const state = createMemoryState();
const slack = createSlackAdapter({
  appToken: env.SLACK_APP_TOKEN,
  botToken: env.SLACK_BOT_TOKEN,
  mode: 'socket',
  userName: env.SLACK_BOT_NAME,
});
const timezoneCache = new Map<string, Promise<string | undefined>>();
const userTimezone = (userId: string) => {
  const cached = timezoneCache.get(userId);
  if (cached) return cached;

  const timezone = slack.webClient.users
    .info({ user: userId })
    .then((result) => result.user?.tz ?? undefined)
    .catch((error) => {
      console.error(`Could not resolve Slack timezone for ${userId}`, error);
      return undefined;
    });
  timezoneCache.set(userId, timezone);
  return timezone;
};
const openCode = await createOpenCodeClient();
const bot = createAgent({
  adapters: { slack },
  allowedUsers: env.ALLOWED_SLACK_USERS,
  config: getOpenCodeConfig(),
  openCode,
  state,
  userTimezone,
  userName: env.SLACK_BOT_NAME,
});

await openCode.health.get();
await bot.initialize();
console.log(`@${env.SLACK_BOT_NAME} is connected to Slack and ${env.OPENCODE_URL}`);

const shutdown = async () => {
  await bot.shutdown();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
