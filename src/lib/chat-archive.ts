/**
 * IndexedDB 存储层 + 解析调度。
 * 纯解析逻辑在 chat-archive-parse.ts（主线程 / Web Worker / Node 三处共用）；
 * 大文件解析优先走 Web Worker（chat-archive.worker.ts），避免阻塞界面。
 */
import type { ParsedChatArchive, StoredChatMessage } from "./chat-archive-parse";
import { parseArchiveAuto } from "./platform-adapters";

export type { ChatRole, ChatConversationIndex, StoredChatMessage, ParsedChatArchive } from "./chat-archive-parse";
export { parseArchiveAuto } from "./platform-adapters";

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

/**
 * 彻底删除整个聊天归档数据库（消息 + 导入记录）。
 * 用于「清空本地全部数据」：清空必须覆盖 IndexedDB，否则用户会误以为聊天正文已删除。
 * 其他标签页占用数据库时会 reject（onblocked），调用方据此如实提示失败。
 */
export async function clearAllChatData(): Promise<void> {
  if (typeof indexedDB === "undefined") {
    throw new Error("当前环境不支持 IndexedDB。");
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("删除本地消息数据库失败。"));
    request.onblocked = () => reject(new Error("本地消息数据库正被其他标签页占用，请关闭所有 MIND OS 标签页后重试。"));
  });
}

/**
 * 用备份中的数据整体替换 IndexedDB 聊天归档（先清空两库，再写入）。
 * 用于「从备份恢复」：恢复后的 IndexedDB 内容与备份完全一致，幂等可重放。
 */
export async function restoreChatArchiveReplace(imports: ImportRecord[], messages: StoredChatMessage[]): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([MESSAGE_STORE, IMPORT_STORE], "readwrite");
    const messageStore = tx.objectStore(MESSAGE_STORE);
    const importStore = tx.objectStore(IMPORT_STORE);
    messageStore.clear();
    importStore.clear();
    for (const message of messages) messageStore.put(message);
    for (const record of imports) importStore.put(record);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export class WorkerUnavailableError extends Error {}

/**
 * Web Worker 解析入口：解压与 JSON 解析在后台线程执行，不阻塞界面。
 * 环境不支持 Worker 时抛出 WorkerUnavailableError，调用方自动回退主线程解析。
 */
export async function parseChatGPTZipInWorker(file: File, timeoutMs = 120000): Promise<ParsedChatArchive> {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./chat-archive.worker.ts", import.meta.url));
  } catch {
    throw new WorkerUnavailableError("当前环境不支持 Web Worker。");
  }
  const buffer = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("解析超时（120 秒）。请确认文件完整，或改用更小的导出文件。"));
    }, timeoutMs);
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { ok: boolean; archive?: ParsedChatArchive; error?: string };
      clearTimeout(timer);
      worker.terminate();
      if (data.ok && data.archive) resolve(data.archive);
      else reject(new Error(data.error ?? "解析线程失败。"));
    };
    worker.onerror = (event: ErrorEvent) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || "解析线程发生错误。"));
    };
    // 转移 buffer 所有权：零拷贝传给 Worker
    worker.postMessage({ buffer, fileName: file.name }, [buffer]);
  });
}

/** 自动调度：优先 Web Worker，环境不支持时回退主线程解析。 */
export async function parseChatArchiveAuto(file: File): Promise<ParsedChatArchive> {
  try {
    return await parseChatGPTZipInWorker(file);
  } catch (error) {
    if (error instanceof WorkerUnavailableError) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return parseArchiveAuto(bytes, file.name);
    }
    throw error;
  }
}
