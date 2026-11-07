"use client";

import { useEffect, useRef, useState } from "react";
import type { Conversation } from "@/lib/types";
import {
  deleteArchive,
  findImportByHash,
  getConversationMessages,
  listImports,
  parseChatGPTZipAuto,
  saveArchive,
  type ImportRecord,
  type ParsedChatArchive,
  type StoredChatMessage
} from "@/lib/chat-archive";

type Props = {
  conversations: Conversation[];
  onImported: (rows: Conversation[]) => void;
  onRemoved: (importId: string) => void;
};

function roleLabel(role: StoredChatMessage["role"]) {
  return ({ user: "用户", assistant: "助手", system: "系统", tool: "工具", other: "其他" })[role];
}

export default function ChatImportPanel({ conversations, onImported, onRemoved }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [batches, setBatches] = useState<ImportRecord[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{ archive: ParsedChatArchive; fileName: string } | null>(null);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<StoredChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showAllRoles, setShowAllRoles] = useState(true);

  // 批次列表以 IndexedDB 的导入记录为唯一数据源，挂载后读取。
  useEffect(() => {
    let cancelled = false;
    listImports()
      .then(rows => { if (!cancelled) setBatches(rows); })
      .catch(error => { if (!cancelled) setNotice(error instanceof Error ? error.message : "读取导入批次失败。"); })
      .finally(() => { if (!cancelled) setBatchesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // 支持从画像分析页「查看对话」跳转直达指定会话
  useEffect(() => {
    const jump = sessionStorage.getItem("mind-os-jump-conversation");
    if (!jump) return;
    sessionStorage.removeItem("mind-os-jump-conversation");
    const row = conversations.find(c => c.id === jump);
    if (row) void openConversation(row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function refreshBatches() {
    listImports()
      .then(rows => setBatches(rows))
      .catch(error => setNotice(error instanceof Error ? error.message : "读取导入批次失败。"));
  }

  // 第一步：解析 + 查重 + 生成预览。此阶段不写入任何数据库。
  async function handleFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setNotice("");
    setPreview(null);
    try {
      if (!file.name.toLowerCase().endsWith(".zip")) {
        throw new Error("请选择 ChatGPT 官方导出的 ZIP 文件，而不是单独的 JSON。");
      }
      if (file.size > 250 * 1024 * 1024) {
        throw new Error("ZIP 文件超过 250MB。为避免浏览器内存不足，本版本暂不处理这么大的文件。");
      }
      const archive = await parseChatGPTZipAuto(file);
      const duplicate = await findImportByHash(archive.fileHash);
      if (duplicate) {
        setNotice(`检测到重复文件：${duplicate.fileName}（导入于 ${new Date(duplicate.importedAt).toLocaleString()}）。本次未重复导入，原有批次仍保留。`);
        return;
      }
      setPreview({ archive, fileName: file.name });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导入失败，请检查 ZIP 文件。");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  // 第二步：用户在预览中确认后才写入 IndexedDB 与会话索引。
  async function confirmImport() {
    if (!preview) return;
    setBusy(true);
    setNotice("");
    try {
      const { archive } = preview;
      const importId = `chatgpt-${archive.fileHash.slice(0, 20)}`;
      const duplicate = await findImportByHash(archive.fileHash);
      if (duplicate) {
        setNotice(`检测到重复文件：${duplicate.fileName}。未写入任何数据。`);
        setPreview(null);
        return;
      }
      await saveArchive(archive, importId);
      const importedAt = new Date().toISOString();
      const rows: Conversation[] = archive.conversations.map(item => ({
        id: `${importId}:${item.conversationId}`,
        sourceImportId: importId,
        sourceConversationId: item.conversationId,
        title: item.title,
        platform: "ChatGPT",
        messageCount: item.messageCount,
        importedAt,
        createdAt: item.createdAt,
        preview: item.preview
      }));
      onImported(rows);
      setNotice(`导入成功：${rows.length} 个对话，${archive.totalRawMessages} 条原始消息。消息正文与原始 JSON 已保存到本机 IndexedDB。`);
      setPreview(null);
      refreshBatches();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "写入本地数据库失败，本次未导入。");
    } finally {
      setBusy(false);
    }
  }

  function cancelImport() {
    setPreview(null);
    setNotice("已取消导入：没有向本机数据库写入任何数据。");
  }

  async function openConversation(row: Conversation) {
    setSelected(row);
    setLoadingMessages(true);
    setMessages([]);
    try {
      const found = await getConversationMessages(row.sourceImportId ?? "", row.sourceConversationId ?? "");
      setMessages(showAllRoles ? found : found.filter(item => item.role === "user" || item.role === "assistant"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取消息失败。");
    } finally {
      setLoadingMessages(false);
    }
  }

  async function toggleRoles(enabled: boolean) {
    setShowAllRoles(enabled);
    if (!selected) return;
    setLoadingMessages(true);
    try {
      const found = await getConversationMessages(selected.sourceImportId ?? "", selected.sourceConversationId ?? "");
      setMessages(enabled ? found : found.filter(item => item.role === "user" || item.role === "assistant"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取消息失败。");
    } finally {
      setLoadingMessages(false);
    }
  }

  async function removeBatch(batch: ImportRecord) {
    if (!window.confirm(`确定删除导入批次“${batch.fileName}”吗？\n将删除该批次的 ${batch.conversationCount} 个会话索引和 ${batch.messageCount} 条原始消息，此操作不可撤销。`)) return;
    try {
      await deleteArchive(batch.id);
      onRemoved(batch.id);
      refreshBatches();
      if (selected?.sourceImportId === batch.id) {
        setSelected(null);
        setMessages([]);
      }
      setNotice("该批次及其原始消息已从本机删除。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除批次失败。");
    }
  }

  const roleCounts = preview
    ? {
        user: preview.archive.messages.filter(item => item.role === "user").length,
        assistant: preview.archive.messages.filter(item => item.role === "assistant").length,
        other: preview.archive.messages.filter(item => item.role === "system" || item.role === "tool" || item.role === "other").length
      }
    : null;

  return (
    <div className="chat-import-v3">
      <section className="panel">
        <div className="panel-head">
          <div>
            <div className="eyebrow">CHATGPT OFFICIAL EXPORT</div>
            <h3>导入 ChatGPT 完整历史</h3>
            <p>选择 ChatGPT 官方数据导出 ZIP。文件在浏览器本地解析，不会上传到任何服务器。</p>
          </div>
          <span className="count-pill">3.0 修正版</span>
        </div>
        <div className="notice">
          <b>本地存储说明</b>
          <span>会话索引保存在 MIND OS 本地数据中；完整消息正文、角色、时间、消息 ID、父消息关系和原始消息 JSON 保存在浏览器 IndexedDB。清理浏览器网站数据可能导致这些记录丢失，请保留原始 ZIP 备份。</span>
        </div>
        <div className="drop-zone">
          <div className="upload-icon">⇧</div>
          <b>{busy ? "正在解析文件…" : "选择 ChatGPT 官方导出 ZIP"}</b>
          <p>支持 ZIP 内含 conversations.json 的常见官方导出结构；当前单个 ZIP 限制 250MB。</p>
          <input ref={inputRef} type="file" accept=".zip,application/zip" hidden onChange={event => void handleFile(event.target.files?.[0])} />
          <button className="button button-primary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "请稍候…" : "选择 ZIP 文件"}
          </button>
        </div>
        {notice && <div className="inline-message" role="status">{notice}</div>}
      </section>

      {preview && roleCounts && (
        <section className="panel section-gap">
          <div className="panel-head">
            <div>
              <div className="eyebrow">IMPORT PREVIEW</div>
              <h3>导入预览（尚未写入）</h3>
              <p>{preview.fileName}</p>
            </div>
            <span className="count-pill">待确认</span>
          </div>
          <div className="preview-stats">
            <div><b>{preview.archive.conversations.length}</b><small>对话</small></div>
            <div><b>{preview.archive.totalRawMessages}</b><small>原始消息</small></div>
            <div><b>{roleCounts.user}</b><small>用户消息</small></div>
            <div><b>{roleCounts.assistant}</b><small>助手消息</small></div>
            <div><b>{roleCounts.other}</b><small>系统 / 工具 / 其他</small></div>
          </div>
          <ul className="preview-list">
            {preview.archive.conversations.slice(0, 10).map(item => (
              <li key={item.conversationId}>
                <span>{item.title}</span>
                <small>{item.messageCount} 条消息 · {item.createdAt ? item.createdAt.slice(0, 10) : "时间未知"}</small>
              </li>
            ))}
          </ul>
          {preview.archive.conversations.length > 10 && (
            <p className="muted-line">仅预览前 10 个会话，确认后将导入全部 {preview.archive.conversations.length} 个。</p>
          )}
          <p className="muted-line">点击“确认导入”之前，不会向本机数据库写入任何数据。</p>
          <div className="actions">
            <button className="button button-primary" disabled={busy} onClick={() => void confirmImport()}>
              {busy ? "正在写入…" : "✓ 确认导入"}
            </button>
            <button className="button button-secondary" disabled={busy} onClick={cancelImport}>取消</button>
          </div>
        </section>
      )}

      <section className="panel section-gap">
        <div className="panel-head">
          <div>
            <div className="eyebrow">CONVERSATION LIBRARY</div>
            <h3>会话索引</h3>
            <p>共 {conversations.length} 个会话。选择一条可从 IndexedDB 读取完整消息。</p>
          </div>
          <span className="count-pill">{conversations.length} 个会话</span>
        </div>
        {conversations.length ? (
          <div className="table-list">
            {conversations.slice(0, 100).map(row => (
              <div className="table-row" key={row.id}>
                <span className="file-badge">GPT</span>
                <div className="table-main">
                  <b>{row.title}</b>
                  <small>{row.createdAt ? new Date(row.createdAt).toLocaleString() : "时间未知"} · {row.messageCount} 条消息</small>
                </div>
                <button className="button button-secondary" onClick={() => void openConversation(row)}>查看完整消息</button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state"><b>还没有导入 ChatGPT 历史</b><p>导入 ZIP 并确认后，会话索引会显示在这里。</p></div>
        )}
        {conversations.length > 100 && <p className="muted-line">当前显示前 100 个会话；其余索引仍保存在本地。</p>}
      </section>

      {selected && (
        <section className="panel section-gap">
          <div className="panel-head">
            <div>
              <div className="eyebrow">FULL CONVERSATION</div>
              <h3>{selected.title}</h3>
              <p>{selected.platform} · 批次 {selected.sourceImportId} · {selected.messageCount} 条消息</p>
            </div>
            <button className="button button-secondary" onClick={() => { setSelected(null); setMessages([]); }}>关闭</button>
          </div>
          <label className="inline-toggle">
            <input type="checkbox" checked={showAllRoles} onChange={event => void toggleRoles(event.target.checked)} />
            显示系统 / 工具 / 其他消息
          </label>
          {loadingMessages ? <p className="muted-line">正在从 IndexedDB 读取消息…</p> : (
            <div className="message-thread">
              {messages.map((message, index) => (
                <article className={`chat-message role-${message.role}`} key={message.key || `${message.sourceMessageId}-${index}`}>
                  <div className="chat-message-head">
                    <b>{roleLabel(message.role)}{message.authorName ? ` · ${message.authorName}` : ""}</b>
                    <small>{message.createdAt ? new Date(message.createdAt).toLocaleString() : "时间未知"} · #{index + 1}</small>
                  </div>
                  <pre>{message.text || (message.role === "tool" ? "[工具消息 / 非文本内容]" : "[该消息没有可展示的文本正文]")}</pre>
                  <details><summary>查看原始消息 JSON</summary><pre className="raw-json">{JSON.stringify(JSON.parse(message.rawJson), null, 2)}</pre></details>
                  {message.parentMessageId && <small className="muted-line">父消息节点：{message.parentMessageId}</small>}
                </article>
              ))}
              {!messages.length && (
                <div className="empty-state">
                  <b>没有找到该会话的原始消息</b>
                  <p>可能原因：数据是通过备份恢复迁移过来的（备份文件不包含 IndexedDB 中的原始消息），或对应批次已被删除。重新导入原始 ZIP 即可重建。</p>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <section className="panel section-gap">
        <div className="panel-head">
          <div>
            <div className="eyebrow">IMPORT BATCHES</div>
            <h3>导入批次</h3>
            <p>重复 ZIP 会通过 SHA-256 文件哈希拦截。删除批次会同时删除其原始消息。</p>
          </div>
          <span className="count-pill">{batches.length} 个批次</span>
        </div>
        {batchesLoading ? (
          <p className="muted-line">正在读取导入批次…</p>
        ) : batches.length ? (
          <div className="table-list">
            {batches.map(batch => (
              <div className="table-row" key={batch.id}>
                <span className="file-badge">ZIP</span>
                <div className="table-main"><b>{batch.fileName}</b><small>{new Date(batch.importedAt).toLocaleString()}</small></div>
                <span className="table-meta">{batch.conversationCount} 个会话 · {batch.messageCount} 条消息</span>
                <button className="delete-button" onClick={() => void removeBatch(batch)}>删除</button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state"><b>暂无导入批次</b><p>成功导入后会在这里记录文件和消息数量。</p></div>
        )}
      </section>
    </div>
  );
}
