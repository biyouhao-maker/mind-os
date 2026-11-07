/**
 * ChatGPT 导出 ZIP 的纯解析层：不依赖 IndexedDB / DOM，
 * 可在主线程与 Web Worker 中运行，也可在 Node 中单元测试。
 */
import { unzipSync } from "fflate";

export type ChatRole = "user" | "assistant" | "system" | "tool" | "other";

export type StoredChatMessage = {
  /** `${importId}:${conversationId}:${sourceMessageId}`，写入时生成 */
  key: string;
  importId: string;
  /** 源级会话 ID（不含 importId 前缀）；跨批次隔离由复合索引保证 */
  conversationId: string;
  sourceMessageId: string;
  parentMessageId: string | null;
  role: ChatRole;
  authorName: string;
  createdAt: string | null;
  text: string;
  rawJson: string;
  sequence: number;
};

export type ChatConversationIndex = {
  conversationId: string;
  title: string;
  createdAt: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  otherMessageCount: number;
  preview: string;
};

export type ParsedChatArchive = {
  fileHash: string;
  conversations: ChatConversationIndex[];
  messages: StoredChatMessage[];
  originalFileName: string;
  totalRawMessages: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const obj = asRecord(value);
  if (typeof obj.text === "string") return obj.text;
  if (Array.isArray(obj.parts)) return obj.parts.map(extractText).filter(Boolean).join("\n");
  if (typeof obj.content === "string") return obj.content;
  return "";
}

function normalizeRole(message: Record<string, unknown>): { role: ChatRole; authorName: string } {
  const author = asRecord(message.author);
  const rawRole = String(author.role ?? message.role ?? "").toLowerCase();
  const authorName = String(author.name ?? message.author_name ?? "");
  if (rawRole === "user") return { role: "user", authorName };
  if (rawRole === "assistant") return { role: "assistant", authorName };
  if (rawRole === "system" || rawRole === "developer") return { role: "system", authorName };
  if (rawRole === "tool" || rawRole === "function") return { role: "tool", authorName };
  if (authorName || rawRole) return { role: "other", authorName };
  return { role: "other", authorName: "" };
}

function isoTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function decodeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8").decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("conversations.json 不是有效的 JSON 文本，文件可能在导出或传输中损坏。");
  }
}

function findConversations(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  const root = asRecord(parsed);
  if (Array.isArray(root.conversations)) return root.conversations;
  if (Array.isArray(root.chats)) return root.chats;
  if (Array.isArray(root.history)) return root.history;
  if (root.mapping && typeof root.mapping === "object") return [parsed];
  throw new Error("conversations.json 的结构不符合预期：没有找到对话数组或 ChatGPT mapping 结构。");
}

function mappingMessages(conversation: Record<string, unknown>): Array<{ nodeId: string; parentId: string | null; raw: Record<string, unknown> }> {
  const mapping = asRecord(conversation.mapping);
  const result: Array<{ nodeId: string; parentId: string | null; raw: Record<string, unknown> }> = [];
  for (const [nodeId, nodeValue] of Object.entries(mapping)) {
    const node = asRecord(nodeValue);
    const message = asRecord(node.message);
    if (!Object.keys(message).length) continue;
    const parentId = typeof node.parent === "string" ? node.parent : null;
    result.push({ nodeId, parentId, raw: message });
  }
  // 优先按导出方提供的 children 链还原树顺序（可覆盖编辑分支）；缺失时退回时间戳排序。
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
  result.sort((a, b) => {
    const ai = sequenceById.get(a.nodeId);
    const bi = sequenceById.get(b.nodeId);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    return (isoTime(a.raw.create_time)?.localeCompare(isoTime(b.raw.create_time) ?? "") ?? 0);
  });
  return result;
}

/** 纯解析入口：字节 → 结构化归档。主线程包装与 Web Worker 都调用它。 */
export async function parseChatArchiveFromBytes(bytes: Uint8Array, fileName: string): Promise<ParsedChatArchive> {
  const fileHash = await sha256Hex(bytes);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("ZIP 文件损坏或无法解压，请确认这是完整下载的 ChatGPT 官方导出文件。");
  }
  const candidate = Object.entries(files).find(([name]) => name.toLowerCase().split("/").pop() === "conversations.json");
  if (!candidate) throw new Error("没有在 ZIP 内找到 conversations.json。请使用 ChatGPT 官方数据导出 ZIP。");
  const parsed = decodeJson(candidate[1]);
  const rawConversations = findConversations(parsed);
  if (!rawConversations.length) throw new Error("conversations.json 中没有包含任何对话，没有可导入的内容。");
  const messages: StoredChatMessage[] = [];
  const conversations: ChatConversationIndex[] = [];
  const now = new Date().toISOString();

  rawConversations.forEach((rawConversation, conversationIndex) => {
    const conversation = asRecord(rawConversation);
    const conversationId = String(conversation.id ?? conversation.conversation_id ?? `conversation-${conversationIndex + 1}`);
    const title = String(conversation.title ?? conversation.name ?? `未命名对话 ${conversationIndex + 1}`).trim();
    const nodes = mappingMessages(conversation);
    const conversationMessages: StoredChatMessage[] = nodes.map((node, index) => {
      const identity = normalizeRole(node.raw);
      const content = asRecord(node.raw.content);
      const text = extractText(content.parts ?? content);
      const createdAt = isoTime(node.raw.create_time ?? node.raw.created_at);
      const sourceMessageId = String(node.raw.id ?? node.nodeId ?? `message-${index + 1}`);
      return {
        key: "",
        importId: "",
        conversationId,
        sourceMessageId,
        parentMessageId: node.parentId,
        role: identity.role,
        authorName: identity.authorName,
        createdAt,
        text,
        rawJson: JSON.stringify(node.raw),
        sequence: index
      };
    });
    const userCount = conversationMessages.filter(message => message.role === "user").length;
    const assistantCount = conversationMessages.filter(message => message.role === "assistant").length;
    const firstUser = conversationMessages.find(message => message.role === "user" && message.text.trim());
    conversations.push({
      conversationId,
      title: title || `未命名对话 ${conversationIndex + 1}`,
      createdAt: isoTime(conversation.create_time ?? conversation.created_at) ?? now,
      messageCount: conversationMessages.length,
      userMessageCount: userCount,
      assistantMessageCount: assistantCount,
      otherMessageCount: conversationMessages.length - userCount - assistantCount,
      preview: (firstUser?.text ?? conversationMessages.find(message => message.text)?.text ?? "未解析出文本内容（原始消息节点仍会保留）").slice(0, 180)
    });
    messages.push(...conversationMessages);
  });

  return {
    fileHash,
    conversations,
    messages,
    originalFileName: fileName,
    totalRawMessages: messages.length
  };
}

/** 主线程便捷入口：File → 结构化归档。 */
export async function parseChatGPTZip(file: File): Promise<ParsedChatArchive> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return parseChatArchiveFromBytes(bytes, file.name);
}
