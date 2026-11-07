/**
 * 平台适配器：把各平台官方导出格式转换为 MIND OS 统一结构。
 *
 * 支持与状态（诚实标注）：
 * - ChatGPT：官方导出 ZIP（conversations.json / mapping 树）——已用真实数据验证。
 * - Claude：官方数据导出（conversations.json，chat_messages / sender）——基于官方格式
 *   开发并用合成样本验证；真实数据验证待用户提供导出文件。
 * - Gemini：Google Takeout「Gemini Apps / MyActivity.json」——实验性支持，
 *   Takeout 格式随版本变化，解析失败会明确报错。
 * - 其他平台（DeepSeek / 智谱清言等）：无官方导出格式，暂不接入。
 */
import type { ChatConversationIndex, ChatRole, ParsedChatArchive, StoredChatMessage } from "./chat-archive-parse";
import {
  asRecord,
  decodeJsonBytes,
  extractText,
  findJsonEntry,
  isoTime,
  sha256Hex,
  unzipBytes
} from "./chat-archive-parse";

type AdapterContext = {
  bytes: Uint8Array;
  fileName: string;
  /** ZIP 解包后的条目；原始 JSON 文件上传时为 null */
  files: Record<string, Uint8Array> | null;
};

type PlatformAdapter = {
  platform: "ChatGPT" | "Claude" | "Gemini";
  /** 格式匹配则解析并返回；明确不是本平台格式时返回 null（交给下一个适配器） */
  tryParse: (ctx: AdapterContext) => Promise<ParsedChatArchive | null>;
};

type DraftConversation = {
  conversationId: string;
  title: string;
  createdAt: string | null;
  messages: StoredChatMessage[];
};

function finalize(
  platform: string,
  fileHash: string,
  fileName: string,
  drafts: DraftConversation[]
): ParsedChatArchive {
  const conversations: ChatConversationIndex[] = [];
  const messages: StoredChatMessage[] = [];
  const now = new Date().toISOString();
  drafts.forEach(draft => {
    const userCount = draft.messages.filter(message => message.role === "user").length;
    const assistantCount = draft.messages.filter(message => message.role === "assistant").length;
    const firstUser = draft.messages.find(message => message.role === "user" && message.text.trim());
    conversations.push({
      conversationId: draft.conversationId,
      title: draft.title || `未命名对话 ${conversations.length + 1}`,
      createdAt: draft.createdAt ?? now,
      messageCount: draft.messages.length,
      userMessageCount: userCount,
      assistantMessageCount: assistantCount,
      otherMessageCount: draft.messages.length - userCount - assistantCount,
      preview: (firstUser?.text ?? draft.messages.find(message => message.text)?.text ?? "未解析出文本内容（原始消息节点仍会保留）").slice(0, 180)
    });
    messages.push(...draft.messages);
  });
  return {
    fileHash,
    platform,
    conversations,
    messages,
    originalFileName: fileName,
    totalRawMessages: messages.length
  };
}

function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/* ---------------- ChatGPT 适配器 ---------------- */

function chatgptMappingMessages(conversation: Record<string, unknown>): StoredChatMessage[] {
  const mapping = asRecord(conversation.mapping);
  const nodes: Array<{ nodeId: string; parentId: string | null; raw: Record<string, unknown> }> = [];
  for (const [nodeId, nodeValue] of Object.entries(mapping)) {
    const node = asRecord(nodeValue);
    const message = asRecord(node.message);
    if (!Object.keys(message).length) continue;
    nodes.push({ nodeId, parentId: typeof node.parent === "string" ? node.parent : null, raw: message });
  }
  const sequenceById = new Map<string, number>();
  let sequence = 0;
  const visit = (nodeId: string, seen: Set<string>) => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    sequenceById.set(nodeId, sequence++);
    const node = asRecord(mapping[nodeId]);
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) if (typeof child === "string") visit(child, seen);
  };
  const roots = Object.entries(mapping).filter(([, value]) => !asRecord(value).parent).map(([key]) => key);
  const visited = new Set<string>();
  roots.forEach(root => visit(root, visited));
  nodes.sort((a, b) => {
    const ai = sequenceById.get(a.nodeId);
    const bi = sequenceById.get(b.nodeId);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    return (isoTime(a.raw.create_time)?.localeCompare(isoTime(b.raw.create_time) ?? "") ?? 0);
  });
  return nodes.map((node, index) => {
    const author = asRecord(node.raw.author);
    const rawRole = String(author.role ?? node.raw.role ?? "").toLowerCase();
    const role: ChatRole = rawRole === "user" ? "user" : rawRole === "assistant" ? "assistant" : rawRole === "system" || rawRole === "developer" ? "system" : rawRole === "tool" || rawRole === "function" ? "tool" : "other";
    const content = asRecord(node.raw.content);
    const text = extractText(content.parts ?? content);
    const sourceMessageId = String(node.raw.id ?? node.nodeId ?? `message-${index + 1}`);
    return {
      key: "",
      importId: "",
      conversationId: String(conversation.id ?? conversation.conversation_id ?? ""),
      sourceMessageId,
      parentMessageId: node.parentId,
      role,
      authorName: String(author.name ?? ""),
      createdAt: isoTime(node.raw.create_time ?? node.raw.created_at),
      text,
      rawJson: JSON.stringify(node.raw),
      sequence: index
    };
  });
}

const chatgptAdapter: PlatformAdapter = {
  platform: "ChatGPT",
  async tryParse(ctx) {
    if (!ctx.files) return null;
    const entry = findJsonEntry(ctx.files, name => name === "conversations.json");
    if (!entry) return null;
    const parsed = decodeJsonBytes(entry);
    const list = Array.isArray(parsed) ? parsed : null;
    if (!list || !list.some(item => asRecord(item).mapping)) return null; // 不是 ChatGPT mapping 结构
    const drafts: DraftConversation[] = list.map((rawConversation, index) => {
      const conversation = asRecord(rawConversation);
      return {
        conversationId: String(conversation.id ?? conversation.conversation_id ?? `conversation-${index + 1}`),
        title: String(conversation.title ?? conversation.name ?? `未命名对话 ${index + 1}`).trim(),
        createdAt: isoTime(conversation.create_time ?? conversation.created_at),
        messages: chatgptMappingMessages(conversation)
      };
    });
    if (!drafts.length) throw new Error("conversations.json 中没有包含任何对话，没有可导入的内容。");
    return finalize("ChatGPT", await sha256Hex(ctx.bytes), ctx.fileName, drafts);
  }
};

/* ---------------- Claude 适配器 ---------------- */

function claudeMessages(conversation: Record<string, unknown>): StoredChatMessage[] {
  const list = Array.isArray(conversation.chat_messages) ? conversation.chat_messages : [];
  return list.map((raw, index) => {
    const message = asRecord(raw);
    const sender = String(message.sender ?? "").toLowerCase();
    const role: ChatRole = sender.includes("human") ? "user" : sender.includes("assistant") ? "assistant" : "other";
    return {
      key: "",
      importId: "",
      conversationId: String(conversation.uuid ?? `conversation-${index + 1}`),
      sourceMessageId: String(message.uuid ?? `message-${index + 1}`),
      parentMessageId: null,
      role,
      authorName: "",
      createdAt: isoTime(message.created_at),
      text: extractText(message.text ?? message.content),
      rawJson: JSON.stringify(message),
      sequence: index
    };
  }).filter(message => message.text.trim() || message.role !== "other");
}

const claudeAdapter: PlatformAdapter = {
  platform: "Claude",
  async tryParse(ctx) {
    // 来源一：ZIP 内的 conversations.json
    if (ctx.files) {
      const entry = findJsonEntry(ctx.files, name => name === "conversations.json");
      if (!entry) return null;
      const parsed = decodeJsonBytes(entry);
      const list = Array.isArray(parsed) ? parsed : null;
      if (!list || !list.some(item => asRecord(item).chat_messages)) return null;
      const drafts: DraftConversation[] = list.map((rawConversation, index) => {
        const conversation = asRecord(rawConversation);
        return {
          conversationId: String(conversation.uuid ?? `conversation-${index + 1}`),
          title: String(conversation.name ?? conversation.title ?? `未命名对话 ${index + 1}`).trim(),
          createdAt: isoTime(conversation.created_at),
          messages: claudeMessages(conversation)
        };
      });
      if (!drafts.length) throw new Error("Claude 导出中没有包含任何对话，没有可导入的内容。");
      return finalize("Claude", await sha256Hex(ctx.bytes), ctx.fileName, drafts);
    }
    // 来源二：直接上传的 Claude 导出 JSON 文件
    if (/\.json$/i.test(ctx.fileName)) {
      const parsed = decodeJsonBytes(ctx.bytes);
      const list = Array.isArray(parsed) ? parsed : null;
      if (!list || !list.some(item => asRecord(item).chat_messages)) return null;
      const drafts: DraftConversation[] = list.map((rawConversation, index) => {
        const conversation = asRecord(rawConversation);
        return {
          conversationId: String(conversation.uuid ?? `conversation-${index + 1}`),
          title: String(conversation.name ?? conversation.title ?? `未命名对话 ${index + 1}`).trim(),
          createdAt: isoTime(conversation.created_at),
          messages: claudeMessages(conversation)
        };
      });
      if (!drafts.length) throw new Error("Claude 导出中没有包含任何对话，没有可导入的内容。");
      return finalize("Claude", await sha256Hex(ctx.bytes), ctx.fileName, drafts);
    }
    return null;
  }
};

/* ---------------- Gemini 适配器（实验） ---------------- */

function geminiMessages(activity: Record<string, unknown>): StoredChatMessage[] {
  const interactions = Array.isArray(activity.Interaction) ? activity.Interaction : [];
  const result: StoredChatMessage[] = [];
  interactions.forEach((rawInteraction, interactionIndex) => {
    const interaction = asRecord(rawInteraction);
    const prompt = typeof interaction.prompt === "string" ? interaction.prompt : "";
    if (prompt.trim()) {
      result.push({
        key: "",
        importId: "",
        conversationId: "",
        sourceMessageId: `i${interactionIndex}-prompt`,
        parentMessageId: null,
        role: "user",
        authorName: "",
        createdAt: isoTime(interaction.Time ?? interaction.time),
        text: prompt,
        rawJson: JSON.stringify(interaction),
        sequence: result.length
      });
    }
    const answers = Array.isArray(interaction.answer) ? interaction.answer : typeof interaction.answer === "string" ? [interaction.answer] : [];
    const answerText = extractText(answers);
    if (answerText.trim()) {
      result.push({
        key: "",
        importId: "",
        conversationId: "",
        sourceMessageId: `i${interactionIndex}-answer`,
        parentMessageId: null,
        role: "assistant",
        authorName: "",
        createdAt: isoTime(interaction.Time ?? interaction.time),
        text: answerText,
        rawJson: JSON.stringify(interaction),
        sequence: result.length
      });
    }
  });
  return result;
}

const geminiAdapter: PlatformAdapter = {
  platform: "Gemini",
  async tryParse(ctx) {
    // Takeout 结构：MyActivity.json（可能嵌套在 Takeout/… 目录下）
    if (!ctx.files) {
      if (!/\.json$/i.test(ctx.fileName)) return null;
      const parsed = decodeJsonBytes(ctx.bytes);
      const root = asRecord(parsed);
      if (!Array.isArray(root["Gemini Apps"])) return null;
      const activities = root["Gemini Apps"] as unknown[];
      const drafts: DraftConversation[] = activities.map((rawActivity, index) => {
        const activity = asRecord(rawActivity);
        const messages = geminiMessages(activity);
        return {
          conversationId: `gemini-${index}`,
          title: String(activity.Title ?? `Gemini 对话 ${index + 1}`).trim(),
          createdAt: isoTime(activity.Time ?? activity.time),
          messages
        };
      });
      if (!drafts.length) throw new Error("Gemini Takeout 中没有包含任何对话，没有可导入的内容。");
      return finalize("Gemini", await sha256Hex(ctx.bytes), ctx.fileName, drafts);
    }
    const entry = findJsonEntry(ctx.files, name => name === "myactivity.json");
    if (!entry) return null;
    const parsed = decodeJsonBytes(entry);
    const root = asRecord(parsed);
    if (!Array.isArray(root["Gemini Apps"])) return null;
    const activities = root["Gemini Apps"] as unknown[];
    const drafts: DraftConversation[] = activities.map((rawActivity, index) => {
      const activity = asRecord(rawActivity);
      const messages = geminiMessages(activity);
      return {
        conversationId: `gemini-${index}`,
        title: String(activity.Title ?? `Gemini 对话 ${index + 1}`).trim(),
        createdAt: isoTime(activity.Time ?? activity.time),
        messages
      };
    });
    if (!drafts.length) throw new Error("Gemini Takeout 中没有包含任何对话，没有可导入的内容。");
    return finalize("Gemini", await sha256Hex(ctx.bytes), ctx.fileName, drafts);
  }
};

/* ---------------- 调度 ---------------- */

const ADAPTERS: PlatformAdapter[] = [chatgptAdapter, claudeAdapter, geminiAdapter];

export const SUPPORTED_FORMATS_TEXT =
  "当前支持：ChatGPT 官方导出 ZIP、Claude 官方导出（JSON 或 ZIP）、Gemini Takeout（实验性）。";

/**
 * 自动识别并解析：依次尝试各平台适配器，第一个匹配的生效。
 * 全部不匹配时给出列出支持格式的明确错误。
 */
export async function parseArchiveAuto(bytes: Uint8Array, fileName: string): Promise<ParsedChatArchive> {
  const files = isZipBytes(bytes) ? unzipBytes(bytes) : null;
  const ctx: AdapterContext = { bytes, fileName, files };
  for (const adapter of ADAPTERS) {
    const result = await adapter.tryParse(ctx);
    if (result) return result;
  }
  throw new Error(`无法识别的导出格式。${SUPPORTED_FORMATS_TEXT}`);
}

/** 兼容别名：旧调用点使用的名称 */
export const parseChatGPTZip = parseArchiveAuto;
