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
  /** 源级会话 ID；localStorage 会话索引行的 id 由调用方组合为 `${importId}:${conversationId}` */
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

const DB_NAME = "mind-os-chat-archive";
const DB_VERSION = 2;
const MESSAGE_STORE = "messages";
const IMPORT_STORE = "imports";

export type ImportRecord = {
  id: string;
  fileHash: string;
  fileName: string;
  importedAt: string;
  conversationCount: number;
  messageCount: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前浏览器不支持 IndexedDB，无法安全保存完整聊天记录。"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const upgradeTx = request.transaction;
      if (!upgradeTx) {
        reject(new Error("本地消息数据库初始化失败。"));
        return;
      }
      let messageStore: IDBObjectStore;
      if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
        messageStore = db.createObjectStore(MESSAGE_STORE, { keyPath: "key" });
      } else {
        // 已有旧版本数据库：在升级事务中补齐缺失索引
        messageStore = upgradeTx.objectStore(MESSAGE_STORE);
      }
      const indexNames = Array.from(messageStore.indexNames);
      if (!indexNames.includes("by_import")) {
        messageStore.createIndex("by_import", "importId", { unique: false });
      }
      if (!indexNames.includes("by_conversation")) {
        messageStore.createIndex("by_conversation", "conversationId", { unique: false });
      }
      if (!indexNames.includes("by_batch_conversation")) {
        // 复合索引：同一查询同时限定导入批次与会话，跨批次数据互不混淆
        messageStore.createIndex("by_batch_conversation", ["importId", "conversationId"], { unique: false });
      }
      if (!db.objectStoreNames.contains(IMPORT_STORE)) {
        db.createObjectStore(IMPORT_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("打开本地消息数据库失败。"));
    request.onblocked = () => reject(new Error("本地消息数据库正被其他标签页占用，请关闭其他 MIND OS 标签页后重试。"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地数据库操作失败。"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("本地数据库写入失败。"));
    tx.onabort = () => reject(tx.error ?? new Error("本地数据库写入已取消。"));
  });
}

function messageKey(importId: string, conversationId: string, sourceMessageId: string): string {
  return `${importId}:${conversationId}:${sourceMessageId}`;
}

export async function findImportByHash(fileHash: string): Promise<ImportRecord | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(IMPORT_STORE, "readonly");
    const rows = await requestResult(tx.objectStore(IMPORT_STORE).getAll()) as ImportRecord[];
    await transactionDone(tx);
    return rows.find(row => row.fileHash === fileHash) ?? null;
  } finally {
    db.close();
  }
}

export async function listImports(): Promise<ImportRecord[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(IMPORT_STORE, "readonly");
    const rows = await requestResult(tx.objectStore(IMPORT_STORE).getAll()) as ImportRecord[];
    await transactionDone(tx);
    return rows.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  } finally {
    db.close();
  }
}

/** 读取本机全部已导入消息（画像分析引擎的数据入口）。消息量大时请一次性调用、避免循环内反复查询。 */
export async function listAllMessages(): Promise<StoredChatMessage[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(MESSAGE_STORE, "readonly");
    const rows = await requestResult(tx.objectStore(MESSAGE_STORE).getAll()) as StoredChatMessage[];
    await transactionDone(tx);
    return rows;
  } finally {
    db.close();
  }
}

export async function saveArchive(archive: ParsedChatArchive, importId: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([MESSAGE_STORE, IMPORT_STORE], "readwrite");
    const messageStore = tx.objectStore(MESSAGE_STORE);
    for (const message of archive.messages) {
      const stored: StoredChatMessage = {
        ...message,
        importId,
        key: messageKey(importId, message.conversationId, message.sourceMessageId)
      };
      messageStore.put(stored);
    }
    tx.objectStore(IMPORT_STORE).put({
      id: importId,
      fileHash: archive.fileHash,
      fileName: archive.originalFileName,
      importedAt: new Date().toISOString(),
      conversationCount: archive.conversations.length,
      messageCount: archive.messages.length
    } satisfies ImportRecord);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function getConversationMessages(importId: string, conversationId: string): Promise<StoredChatMessage[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(MESSAGE_STORE, "readonly");
    // 复合索引：同时限定导入批次与会话，跨批次相同会话 ID 的消息互不混淆
    const index = tx.objectStore(MESSAGE_STORE).index("by_batch_conversation");
    const rows = await requestResult(index.getAll([importId, conversationId])) as StoredChatMessage[];
    await transactionDone(tx);
    return rows.sort((a, b) => a.sequence - b.sequence);
  } finally {
    db.close();
  }
}

export async function deleteArchive(importId: string): Promise<void> {
  const db = await openDb();
  try {
    // 第一段（readonly 事务）：读出该批次的全部消息 key，并等待事务完成。
    const listTx = db.transaction(MESSAGE_STORE, "readonly");
    const keys = await requestResult(listTx.objectStore(MESSAGE_STORE).index("by_import").getAllKeys(importId));
    await transactionDone(listTx);
    // 第二段（新的 readwrite 事务）：删除消息与导入记录，避免事务自动提交后再操作的错误。
    const tx = db.transaction([MESSAGE_STORE, IMPORT_STORE], "readwrite");
    const messageStore = tx.objectStore(MESSAGE_STORE);
    keys.forEach(key => messageStore.delete(key));
    tx.objectStore(IMPORT_STORE).delete(importId);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

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

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
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

export async function parseChatGPTZip(file: File): Promise<ParsedChatArchive> {
  const fileHash = await sha256(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
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
      // 非文本消息不会被丢弃：正文为空时仍保留在 messages 中（rawJson 完整），预览如实说明。
      preview: (firstUser?.text ?? conversationMessages.find(message => message.text)?.text ?? "未解析出文本内容（原始消息节点仍会保留）").slice(0, 180)
    });
    messages.push(...conversationMessages);
  });

  return {
    fileHash,
    conversations,
    messages,
    originalFileName: file.name,
    totalRawMessages: messages.length
  };
}
