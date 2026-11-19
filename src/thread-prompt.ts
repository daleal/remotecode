import type { Message, Thread } from 'chat';
import type { ThreadState } from './thread-session';
import { adapterPrefix, supportsUI, uiInstructions } from './ui';

export type WorkspacePromptContext = {
  availableRepos: readonly string[];
  newlyProvisionedRepos?: readonly string[];
  provisionedRepos: readonly string[];
};

type BuildThreadPromptOptions = {
  adapterName: string;
  firstTurn: boolean;
  messages: Message[];
  uiAdapters?: readonly string[];
  userTimezone?: (userId: string) => Promise<string | undefined>;
  workspace?: WorkspacePromptContext;
};

export const collectThreadMessages = async (
  thread: Thread<ThreadState>,
  lastMessageID?: string,
  recentLimit = 10,
) => {
  const all: Message[] = [];
  const since: Message[] = [];
  let found = !lastMessageID;

  for await (const message of thread.allMessages) {
    all.push(message);
    if (!found) {
      found = message.id === lastMessageID;
      continue;
    }
    since.push(message);
  }

  // A deleted or inaccessible marker is safer to re-import than to omit current context.
  if (!found && lastMessageID) {
    return { messages: all, priorMessages: [] as Message[] };
  }

  const priorCount = all.length - since.length;
  const priorMessages =
    priorCount > 0 ? all.slice(Math.max(0, priorCount - recentLimit), priorCount) : [];

  return { messages: since, priorMessages };
};

export const messagesSince = async (thread: Thread<ThreadState>, lastMessageID?: string) => {
  const { messages } = await collectThreadMessages(thread, lastMessageID, 0);
  return messages;
};

export const formatThreadTranscript = async (
  messages: Message[],
  userTimezone?: (userId: string) => Promise<string | undefined>,
) =>
  (
    await Promise.all(
      messages.map(async (message) => {
        const timezone = await userTimezone?.(message.author.userId);
        const timestamp = formatTimestamp(message.metadata.dateSent, timezone);
        const botTag = message.author.isBot ? ', bot' : '';
        const links = [...new Set((message.links ?? []).map((link) => link.url))].filter(
          (url) => !message.text.includes(url),
        );
        const images = imageAttachments(message).map(
          (image) => `[Image attached: ${image.name ?? 'unnamed'}]`,
        );
        const content = [message.text, ...links, ...images].filter(Boolean).join('\n');
        return `[Message from ${message.author.fullName} (@${message.author.userName}${botTag}) at ${timestamp}]\n${content}`;
      }),
    )
  ).join('\n\n');

export const buildThreadPrompt = async ({
  adapterName,
  firstTurn,
  messages,
  uiAdapters,
  userTimezone,
  workspace,
}: BuildThreadPromptOptions) => {
  const transcript = await formatThreadTranscript(messages, userTimezone);
  const prefix = adapterPrefix(adapterName);
  const workspaceNotice = formatWorkspaceNotice(workspace, firstTurn);

  if (!firstTurn) {
    if (!workspaceNotice) return `${prefix}\n${transcript}`;
    return `${prefix}\n${workspaceNotice}\n\n${transcript}`;
  }

  const sections = [
    `${prefix}\nYou are working from a ${adapterName} thread. Treat the transcript as user-provided context, perform the requested work, and write a final CONCISE response for the thread.`,
  ];
  if (workspaceNotice) sections.push(workspaceNotice);
  if (supportsUI(adapterName, uiAdapters)) {
    const instructions = uiInstructions(uiAdapters);
    if (instructions) sections.push(instructions);
  }
  sections.push(transcript);
  return sections.join('\n\n');
};

const formatWorkspaceNotice = (
  workspace: WorkspacePromptContext | undefined,
  firstTurn: boolean,
) => {
  if (!workspace || workspace.availableRepos.length === 0) return undefined;

  if (!firstTurn) {
    const newlyProvisioned = workspace.newlyProvisionedRepos ?? [];
    if (newlyProvisioned.length === 0) return undefined;
    return `Newly provisioned workspace repositories: ${newlyProvisioned.join(', ')}. Workspace repositories currently checked out: ${workspace.provisionedRepos.join(', ')}.`;
  }

  const unprovisioned = workspace.availableRepos.filter(
    (repo) => !workspace.provisionedRepos.includes(repo),
  );
  if (workspace.provisionedRepos.length === 0) {
    return `No repository worktrees are provisioned in this workspace yet. Available repositories: ${workspace.availableRepos.join(', ')}.`;
  }
  if (unprovisioned.length === 0) {
    return `Workspace repositories provisioned: ${workspace.provisionedRepos.join(', ')}.`;
  }
  return `Workspace repositories provisioned: ${workspace.provisionedRepos.join(', ')}. Other available repositories not checked out: ${unprovisioned.join(', ')}.`;
};

export const threadImageFiles = async (messages: Message[]) => {
  const files = await Promise.all(
    messages.flatMap(imageAttachments).map(async (image) => {
      try {
        const data = image.data ?? (await image.fetchData?.());
        if (!data) return [];
        const bytes = data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : data;
        const uri = `data:${image.mimeType};base64,${bytes.toString('base64')}`;
        return [{ uri, ...(image.name ? { name: image.name } : {}) }];
      } catch (error) {
        console.error(`Could not download image ${image.name ?? image.url}`, error);
        return [];
      }
    }),
  );
  return files.flat();
};

const imageAttachments = (message: Message) =>
  (message.attachments ?? []).filter(
    (attachment) => attachment.type === 'image' && attachment.mimeType?.startsWith('image/'),
  );

const formatTimestamp = (date: Date, timezone?: string) => {
  if (!timezone) return date.toISOString();
  return `${date.toISOString()} (timezone: ${timezone})`;
};
