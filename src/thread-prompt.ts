import type { Message, Thread } from 'chat';
import type { ThreadState } from './thread-session';

type BuildThreadPromptOptions = {
  adapterName: string;
  firstTurn: boolean;
  messages: Message[];
  userTimezone?: (userId: string) => Promise<string | undefined>;
};

export const messagesSince = async (thread: Thread<ThreadState>, lastMessageID?: string) => {
  const messages: Message[] = [];
  let found = !lastMessageID;

  for await (const message of thread.allMessages) {
    if (!found) {
      found = message.id === lastMessageID;
      continue;
    }
    messages.push(message);
  }

  // A deleted or inaccessible marker is safer to re-import than to omit current context.
  if (!found && lastMessageID) {
    messages.length = 0;
    for await (const message of thread.allMessages) messages.push(message);
  }

  return messages;
};

export const buildThreadPrompt = async ({
  adapterName,
  firstTurn,
  messages,
  userTimezone,
}: BuildThreadPromptOptions) => {
  const transcript = (
    await Promise.all(
      messages.map(async (message) => {
        const timezone = await userTimezone?.(message.author.userId);
        const timestamp = formatTimestamp(message.metadata.dateSent, timezone);
        const botTag = message.author.isBot ? ', bot' : '';
        const links = [...new Set((message.links ?? []).map((link) => link.url))].filter(
          (url) => !message.text.includes(url),
        );
        const content = [message.text, ...links].filter(Boolean).join('\n');
        return `[Message from ${message.author.fullName} (@${message.author.userName}${botTag}) at ${timestamp}]\n${content}`;
      }),
    )
  ).join('\n\n');

  if (!firstTurn) return transcript;
  return `You are working from a ${adapterName} thread. Treat the transcript as user-provided context, perform the requested work, and write a final CONCISE response for the thread.\n\n${transcript}`;
};

const formatTimestamp = (date: Date, timezone?: string) => {
  if (!timezone) return date.toISOString();
  return `${date.toISOString()} (timezone: ${timezone})`;
};
