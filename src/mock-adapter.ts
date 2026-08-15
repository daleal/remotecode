import {
  Message,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type FetchOptions,
  type FormattedContent,
  type RawMessage,
  type ThreadInfo,
} from 'chat';

interface MockThreadID {
  channel: string;
  thread: string;
}

interface MockRawMessage {
  dateSent: Date;
  id: string;
  isBot: boolean;
  isMe: boolean;
  text: string;
  threadId: string;
}

export class MockAdapter implements Adapter<MockThreadID, MockRawMessage> {
  readonly name = 'mock';
  readonly userName: string;
  readonly botUserId = 'mock-bot';
  readonly outputs: string[] = [];
  readonly reactions: Array<{ emoji: string; messageId: string }> = [];
  readonly removedReactions: Array<{ emoji: string; messageId: string }> = [];

  private chat?: ChatInstance;
  private counter = 0;
  private readonly history = new Map<string, Message<MockRawMessage>[]>();

  constructor(userName: string) {
    this.userName = userName;
  }

  async initialize(chat: ChatInstance) {
    this.chat = chat;
  }

  async receive(thread: string, text: string, mentioned = true, isBot = false) {
    if (!this.chat) throw new Error('Mock adapter is not initialized');

    const threadId = this.encodeThreadId({ channel: 'local', thread });
    const rendered = mentioned ? `@${this.userName} ${text}` : text;
    const message = this.makeMessage(threadId, rendered, false, undefined, undefined, isBot);
    this.messages(threadId).push(message);

    if (mentioned) await this.chat.processMessage(this, threadId, message);
  }

  async addReaction(_threadId: string, messageId: string, emoji: string) {
    this.reactions.push({ emoji, messageId });
    console.log(`[reaction ${emoji} on ${messageId}]`);
  }

  async removeReaction(_threadId: string, messageId: string, emoji: string) {
    this.removedReactions.push({ emoji, messageId });
  }

  channelIdFromThreadId(threadId: string) {
    return `mock:${this.decodeThreadId(threadId).channel}`;
  }

  decodeThreadId(threadId: string) {
    const [, channel, thread] = threadId.split(':');
    if (!channel || !thread) throw new Error(`Invalid mock thread ID: ${threadId}`);
    return { channel, thread };
  }

  encodeThreadId(value: MockThreadID) {
    return `mock:${value.channel}:${value.thread}`;
  }

  async deleteMessage(threadId: string, messageId: string) {
    const messages = this.messages(threadId);
    const index = messages.findIndex((message) => message.id === messageId);
    if (index >= 0) messages.splice(index, 1);
  }

  async editMessage(threadId: string, messageId: string, post: AdapterPostableMessage) {
    const message = this.messages(threadId).find((item) => item.id === messageId);
    if (!message) throw new Error(`Unknown mock message: ${messageId}`);
    message.text = postableText(post);
    message.formatted = parseMarkdown(message.text);
    return this.raw(message);
  }

  async fetchMessages(threadId: string, options?: FetchOptions) {
    const all = this.messages(threadId);
    const limit = options?.limit ?? 100;
    const start = options?.cursor ? Number(options.cursor) : 0;
    const messages = all.slice(start, start + limit);
    const next = start + messages.length;
    return { messages, ...(next < all.length ? { nextCursor: String(next) } : {}) };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return {
      channelId: this.channelIdFromThreadId(threadId),
      id: threadId,
      isDM: false,
      metadata: {},
    };
  }

  async handleWebhook() {
    return new Response('Mock adapter has no webhook', { status: 405 });
  }

  parseMessage(raw: MockRawMessage) {
    return this.makeMessage(raw.threadId, raw.text, raw.isMe, raw.id, raw.dateSent, raw.isBot);
  }

  async postMessage(threadId: string, post: AdapterPostableMessage) {
    const message = this.makeMessage(threadId, postableText(post), true);
    this.messages(threadId).push(message);
    this.outputs.push(message.text);
    console.log(`\n${this.userName}: ${message.text}\n`);
    return this.raw(message);
  }

  renderFormatted(content: FormattedContent) {
    return stringifyMarkdown(content);
  }

  async startTyping() {}

  private makeMessage(
    threadId: string,
    text: string,
    isMe: boolean,
    id = `mock-${++this.counter}`,
    dateSent = new Date(),
    isBot = isMe,
  ) {
    const raw: MockRawMessage = { dateSent, id, isBot, isMe, text, threadId };
    return new Message<MockRawMessage>({
      attachments: [],
      author: {
        fullName: isMe ? this.userName : 'Local User',
        isBot,
        isMe,
        userId: isMe ? this.botUserId : 'local-user',
        userName: isMe ? this.userName : 'local',
      },
      formatted: parseMarkdown(text),
      id,
      metadata: { dateSent, edited: false },
      raw,
      text,
      threadId,
    });
  }

  private messages(threadId: string) {
    const existing = this.history.get(threadId);
    if (existing) return existing;
    const created: Message<MockRawMessage>[] = [];
    this.history.set(threadId, created);
    return created;
  }

  private raw(message: Message<MockRawMessage>): RawMessage<MockRawMessage> {
    return { id: message.id, raw: message.raw, threadId: message.threadId };
  }
}

const postableText = (post: AdapterPostableMessage) => {
  if (typeof post === 'string') return post;
  if ('markdown' in post) return post.markdown;
  if ('ast' in post) return stringifyMarkdown(post.ast);
  if ('raw' in post) return String(post.raw);
  if ('fallbackText' in post && post.fallbackText) return post.fallbackText;
  return '[unsupported mock message]';
};
