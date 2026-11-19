import {
  Message,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type CardChild,
  type CardElement,
  type ChatInstance,
  type EphemeralMessage,
  type FetchOptions,
  type FormattedContent,
  type RawMessage,
  type StreamChunk,
  type StreamOptions,
  type ThreadInfo,
} from 'chat';

type MockThreadID = {
  channel: string;
  thread: string;
};

type MockRawMessage = {
  dateSent: Date;
  id: string;
  isBot: boolean;
  isMe: boolean;
  text: string;
  threadId: string;
};

export class MockAdapter implements Adapter<MockThreadID, MockRawMessage> {
  readonly name = 'mock';
  readonly userName: string;
  readonly botUserId = 'mock-bot';
  readonly supportsTurnCancellation = true;
  readonly assistantTitles: string[] = [];
  readonly cards: CardElement[] = [];
  readonly ephemeralOutputs: Array<{ text: string; userId: string }> = [];
  readonly outputs: string[] = [];
  readonly reactions: Array<{ emoji: string; messageId: string }> = [];
  readonly removedReactions: Array<{ emoji: string; messageId: string }> = [];
  readonly streamChunks: Array<string | StreamChunk> = [];
  readonly typingStatuses: string[] = [];
  endTypingCount = 0;

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

    await this.chat.processMessage(this, threadId, message);
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
    const card = extractCard(post);
    if (card) this.cards.push(card);
    const message = this.makeMessage(threadId, postableText(post), true);
    this.messages(threadId).push(message);
    this.outputs.push(message.text);
    console.log(`\n${this.userName}: ${message.text}\n`);
    return this.raw(message);
  }

  async postEphemeral(
    threadId: string,
    userId: string,
    post: AdapterPostableMessage,
  ): Promise<EphemeralMessage<MockRawMessage>> {
    const message = this.makeMessage(threadId, postableText(post), true);
    this.ephemeralOutputs.push({ text: message.text, userId });
    return { id: message.id, raw: message.raw, threadId, usedFallback: false };
  }

  renderFormatted(content: FormattedContent) {
    return stringifyMarkdown(content);
  }

  async startTyping(_threadId: string, status?: string) {
    this.typingStatuses.push(status ?? '');
  }

  async endTyping() {
    this.endTypingCount += 1;
  }

  async setAssistantTitle(_channelId: string, _threadTs: string, title: string) {
    this.assistantTitles.push(title);
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    options?: StreamOptions,
  ): Promise<RawMessage<MockRawMessage>> {
    let accumulated = '';
    for await (const chunk of textStream) {
      if (options?.signal?.aborted) break;
      this.streamChunks.push(chunk);
      if (typeof chunk === 'string') {
        accumulated += chunk;
      } else if (chunk.type === 'markdown_text') {
        accumulated += chunk.text;
      } else if (chunk.type === 'task_update') {
        console.log(`[task ${chunk.status}] ${chunk.title}`);
      }
    }
    const text = accumulated.trim();
    const message = this.makeMessage(threadId, text, true);
    this.messages(threadId).push(message);
    if (text) {
      this.outputs.push(text);
      console.log(`\n${this.userName}: ${text}\n`);
    }
    return this.raw(message);
  }

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

const extractCard = (post: AdapterPostableMessage): CardElement | undefined => {
  if (!post || typeof post !== 'object') return undefined;
  if ('type' in post && post.type === 'card') return post;
  if ('card' in post && post.card) return post.card;
  return undefined;
};

const renderCardChild = (child: CardChild): string | undefined => {
  if (child.type === 'text') return child.content;
  if (child.type === 'link') return `${child.label} (${child.url})`;
  if (child.type === 'fields') {
    return child.children.map((field) => `${field.label}: ${field.value}`).join('\n');
  }
  if (child.type === 'table') {
    return [child.headers.join(' | '), ...child.rows.map((row) => row.join(' | '))].join('\n');
  }
  if (child.type === 'chart') return `[Chart: ${child.title} (${child.chart.type})]`;
  if (child.type === 'image') return `[Image: ${child.alt ?? child.url}]`;
  if (child.type === 'divider') return '---';
  if (child.type === 'actions') {
    return child.children
      .map((item) => {
        if (item.type === 'button') {
          const value = item.value ? `=${item.value}` : '';
          return `[Button: ${item.label} (${item.id}${value})]`;
        }
        if (item.type === 'link-button') return `[Link: ${item.label} (${item.url})]`;
        return `[${item.type}]`;
      })
      .join(' ');
  }
  if (child.type === 'section') {
    return child.children.map(renderCardChild).filter(Boolean).join('\n');
  }
  if (child.type === 'text_input') return child.label;
  return undefined;
};

const renderCardText = (card: CardElement) => {
  const parts: string[] = [];
  if (card.title) parts.push(`**${card.title}**`);
  if (card.subtitle) parts.push(card.subtitle);
  for (const child of card.children) {
    const rendered = renderCardChild(child);
    if (rendered) parts.push(rendered);
  }
  return parts.join('\n');
};

const postableText = (post: AdapterPostableMessage) => {
  if (typeof post === 'string') return post;
  const card = extractCard(post);
  if (card) return renderCardText(card);
  if ('markdown' in post) return post.markdown;
  if ('ast' in post) return stringifyMarkdown(post.ast);
  if ('raw' in post) return String(post.raw);
  if ('fallbackText' in post && post.fallbackText) return post.fallbackText;
  return '[unsupported mock message]';
};
