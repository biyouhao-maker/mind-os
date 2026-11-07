/// <reference lib="webworker" />
/**
 * 解析 Worker：unzipSync + JSON.parse + mapping 树提取都在本线程执行，
 * 主线程只接收结构化结果（buffer 以零拷贝转移进来）。
 */
import { parseChatArchiveFromBytes } from "./chat-archive-parse";
import type { ParsedChatArchive } from "./chat-archive-parse";

type WorkerRequest = { buffer: ArrayBuffer; fileName: string };
type WorkerResponse = { ok: true; archive: ParsedChatArchive } | { ok: false; error: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const archive = await parseChatArchiveFromBytes(new Uint8Array(request.buffer), request.fileName);
    (self as unknown as { postMessage: (data: WorkerResponse) => void }).postMessage({ ok: true, archive });
  } catch (error) {
    (self as unknown as { postMessage: (data: WorkerResponse) => void }).postMessage({
      ok: false,
      error: error instanceof Error ? error.message : "解析线程失败。"
    });
  }
};
