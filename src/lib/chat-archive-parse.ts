/**
 * ChatGPT 导出解析的通用工具与类型。
 * 平台适配器（ChatGPT / Claude / Gemini）见 platform-adapters.ts。
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
  /** 数据来源平台（由适配器标注） */
  platform: string;
  conversations: ChatConversationIndex[];
  messages: StoredChatMessage[];
  originalFileName: string;
  totalRawMessages: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const obj = asRecord(value);
  if (typeof obj.text === "string") return obj.text;
  if (Array.isArray(obj.parts)) return obj.parts.map(extractText).filter(Boolean).join("\n");
  if (typeof obj.content === "string") return obj.content;
  return "";
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

export function decodeJsonBytes(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8").decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("文件内容不是有效的 JSON 文本，可能在导出或传输中损坏。");
  }
}

export function unzipBytes(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch {
    throw new Error("ZIP 文件损坏或无法解压，请确认这是完整下载的官方导出文件。");
  }
}

/** 在 ZIP 条目或直接给定的 JSON 字节中找到对话数据（由各适配器提供识别函数） */
export function findJsonEntry(files: Record<string, Uint8Array>, isTarget: (name: string) => boolean): Uint8Array | null {
  const candidate = Object.entries(files).find(([name]) => isTarget(name.toLowerCase().split("/").pop() ?? ""));
  return candidate ? candidate[1] : null;
}

export { asRecord, isoTime };
