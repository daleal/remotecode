import { createInterface } from 'node:readline/promises';
import { createMemoryState } from '@chat-adapter/state-memory';
import { env } from '~/config/env';
import { createAgent } from './agent';
import { MockAdapter } from './mock-adapter';
import { createOpenCodeClient, getOpenCodeConfig } from './opencode';

const adapter = new MockAdapter(env.SLACK_BOT_NAME);
const openCode = await createOpenCodeClient();
const bot = createAgent({
  adapters: { mock: adapter },
  allowedUsers: env.ALLOWED_SLACK_USERS,
  config: getOpenCodeConfig(),
  openCode,
  state: createMemoryState(),
  userName: env.SLACK_BOT_NAME,
});

await openCode.server.info();
await bot.initialize();

const terminal = createInterface({ input: process.stdin, output: process.stdout });
let thread = 'default';

console.log('Mock Slack ready. Enter a prompt, /say <context>, /thread <name>, or /quit.');

while (true) {
  const input = (await terminal.question(`[${thread}] > `)).trim();
  if (!input) continue;
  if (input === '/quit') break;
  if (input.startsWith('/thread ')) {
    thread = input.slice('/thread '.length).trim() || 'default';
    continue;
  }
  if (input.startsWith('/say ')) {
    await adapter.receive(thread, input.slice('/say '.length), false);
    continue;
  }
  await adapter.receive(thread, input);
}

terminal.close();
await bot.shutdown();
