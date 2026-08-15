import * as zod from 'zod';
import { modelSchema } from './model';

const envSchema = zod.object({
  SLACK_BOT_TOKEN: zod.string(),
  SLACK_APP_TOKEN: zod.string(),
  SLACK_BOT_NAME: zod.string().optional().default('remotecode'),
  ALLOWED_SLACK_USERS: zod
    .string()
    .optional()
    .default('')
    .transform((value) =>
      value
        .split(';')
        .map((user) => user.trim())
        .filter(Boolean),
    ),
  REPOS_ROOT: zod.string().optional().default('~/repos'),
  WORKSPACE_ROOT: zod.string().optional().default('~/remotecode'),
  OPENCODE_URL: zod.url().optional().default('http://127.0.0.1:4096'),
  OPENCODE_AGENT: zod.string().optional().default('build'),
  OPENCODE_MODEL: modelSchema.optional().default({ providerID: 'openai', id: 'gpt-5.6-sol' }),
  OPENCODE_SMALL_MODEL: modelSchema
    .optional()
    .default({ providerID: 'openai', id: 'gpt-5.6-luna' }),
  OPENCODE_EFFORT: zod.string().optional().default('medium'),
  OPENCODE_USERNAME: zod.string().optional().default('opencode'),
  OPENCODE_PASSWORD: zod.string(),
});

export type Env = zod.infer<typeof envSchema>;
export const env = envSchema.parse(process.env);
