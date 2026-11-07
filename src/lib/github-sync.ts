/**
 * MIND OS 云端同步（GitHub Gist 接入层）。
 *
 * 用 GitHub secret gist 作为云端存储：用户创建 fine-grained PAT（勾选 Gist 权限）
 * 后填入设置页，即可将备份 JSON 上传 / 拉取到自己的 GitHub 账号。
 *
 * 安全模型：
 * - PAT 仅保存在本机浏览器 localStorage，备份导出时自动剔除。
 * - Gist 标记为 secret（不被搜索，但知道 URL 的人可访问——不适合高度敏感数据）。
 * - 备份数据中的 API Key 已被剔除（导出时已脱敏）。
 * - Gist 描述含 MindOS-Sync 标记用于识别。
 */
import type { AppData } from "./types";

const GIST_FILENAME = "mind-os-backup.json";
const GIST_MARKER = "MindOS-Sync";

export type GhConfig = { token: string; gistId: string };

export function isGhReady(config: GhConfig): boolean {
  return Boolean(config.token.trim() && config.gistId.trim());
}

/** 从 GitHub API 响应中提取可读的错误信息 */
function ghError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) return `GitHub API 返回 ${status}：${parsed.message}`;
  } catch { /* ignore */ }
  return `GitHub API 返回 ${status}。`;
}

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  Accept: "application/vnd.github+json"
});

/** 创建一个 secret gist 并返回 gist id（首次上传时调用） */
export async function createGist(token: string, data: AppData): Promise<string> {
  const content = JSON.stringify(data, null, 2);
  const response = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: GH_HEADERS(token),
    body: JSON.stringify({
      description: `${GIST_MARKER} — MIND OS 云端备份`,
      public: false,
      files: { [GIST_FILENAME]: { content } }
    })
  });
  if (!response.ok) throw new Error(ghError(response.status, await response.text()));
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error("GitHub 未返回 gist id。");
  return json.id;
}

/** 上传备份 JSON 到已有 gist（覆盖同名文件内容） */
export async function uploadToGist(token: string, gistId: string, data: AppData): Promise<{ updatedAt: string }> {
  const content = JSON.stringify(data, null, 2);
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: GH_HEADERS(token),
    body: JSON.stringify({
      description: `${GIST_MARKER} — MIND OS 云端备份`,
      files: { [GIST_FILENAME]: { content } }
    })
  });
  if (!response.ok) throw new Error(ghError(response.status, await response.text()));
  const json = (await response.json()) as { updated_at?: string };
  return { updatedAt: json.updated_at ?? new Date().toISOString() };
}

export type GhFetchedState = { data: AppData; updatedAt: string } | null;

/** 从 gist 拉取备份数据；gist 不存在时返回 null */
export async function fetchFromGist(token: string, gistId: string): Promise<GhFetchedState> {
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: GH_HEADERS(token)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(ghError(response.status, await response.text()));
  const json = (await response.json()) as {
    files?: Record<string, { content?: string }>;
    updated_at?: string;
  };
  const file = json.files?.[GIST_FILENAME];
  if (!file?.content) return null;
  const parsed = JSON.parse(file.content) as AppData;
  return { data: parsed, updatedAt: json.updated_at ?? "" };
}

/** 校验 PAT 有效性（调用用户信息端点） */
export async function validatePat(token: string): Promise<{ login: string }> {
  const response = await fetch("https://api.github.com/user", { headers: GH_HEADERS(token) });
  if (!response.ok) throw new Error(ghError(response.status, await response.text()));
  const json = (await response.json()) as { login?: string };
  return { login: json.login ?? "" };
}
