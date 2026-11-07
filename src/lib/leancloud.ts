/**
 * MIND OS 云端同步（LeanCloud 接入层）。
 *
 * 职责（本阶段）：账号注册 / 登录 / 退出 + 结构化数据（AppData）的上传与拉取。
 * 聊天正文（IndexedDB）的文件同步为后续阶段。
 *
 * 安全模型：
 * - AppID / AppKey 是 LeanCloud 的前端公开凭证（可出现在浏览器），
 *   数据隔离依赖 LeanCloud ACL：每条云端记录仅创建者本人可读写。
 * - 服务器地址由用户从 LeanCloud 控制台复制（区域相关）。
 * - 同步策略：上传 / 拉取均为显式操作（不做自动同步），覆盖前必须二次确认。
 * - SDK 通过动态 import 引入：避免其 Node 适配器（formidable 动态 require）
 *   进入 Next.js 服务端构建。
 */
import type { AppData, LcConfig } from "./types";
import type { User as AvUser } from "leancloud-storage";

type AvModule = typeof import("leancloud-storage");

export type LcUser = { username: string; createdAt: string };

let cached: AvModule | null = null;
let initializedKey = "";

async function getAV(): Promise<AvModule> {
  if (!cached) cached = await import("leancloud-storage");
  return cached;
}

async function ensureInit(config: LcConfig): Promise<AvModule> {
  const AV = await getAV();
  if (!config.appId.trim() || !config.appKey.trim() || !config.server.trim()) {
    throw new Error("LeanCloud 配置不完整（AppID / AppKey / 服务器地址）。");
  }
  const configKey = `${config.appId}|${config.appKey}|${config.server}`;
  if (initializedKey === configKey) return AV;
  AV.init({ appId: config.appId.trim(), appKey: config.appKey.trim(), serverURL: config.server.trim() });
  initializedKey = configKey;
  return AV;
}

export function isLcReady(config: LcConfig): boolean {
  return Boolean(config.enabled && config.appId.trim() && config.appKey.trim() && config.server.trim());
}

export async function lcCurrentUser(): Promise<LcUser | null> {
  const AV = await getAV();
  const user = AV.User.current();
  return user ? { username: user.getUsername() ?? "", createdAt: user.createdAt?.toISOString() ?? "" } : null;
}

export async function lcSignUp(username: string, password: string): Promise<LcUser> {
  const AV = await getAV();
  const user = new AV.User();
  user.setUsername(username);
  user.setPassword(password);
  const created = (await user.signUp()) as AvUser;
  return { username: created.getUsername() ?? username, createdAt: created.createdAt?.toISOString() ?? "" };
}

export async function lcLogIn(username: string, password: string): Promise<LcUser> {
  const AV = await getAV();
  const user = (await AV.User.logIn(username, password)) as AvUser;
  return { username: user.getUsername() ?? username, createdAt: user.createdAt?.toISOString() ?? "" };
}

export async function lcLogOut(): Promise<void> {
  const AV = await getAV();
  AV.User.logOut();
}

const STATE_CLASS = "MindOsState";

/** 上传本地结构化数据到云端（覆盖本人现有记录，ACL 仅本人可读写；API Key 不上传） */
export async function uploadState(config: LcConfig, data: AppData): Promise<{ updatedAt: string }> {
  const AV = await ensureInit(config);
  const user = AV.User.current();
  if (!user) throw new Error("尚未登录 LeanCloud，无法上传。");
  const query = new AV.Query(STATE_CLASS);
  query.equalTo("user", user);
  const existing = await query.first();
  const payload = JSON.stringify({ ...data, llm: { ...data.llm, apiKey: "" } });
  const record = existing ?? new AV.Object(STATE_CLASS);
  record.set("user", user);
  record.set("data", payload);
  record.setACL(new AV.ACL(user));
  const saved = await record.save();
  return { updatedAt: saved.updatedAt?.toISOString() ?? new Date().toISOString() };
}

export type FetchedState = { data: AppData; updatedAt: string } | null;

/** 从云端拉取本人结构化数据；云端无记录时返回 null */
export async function fetchState(config: LcConfig): Promise<FetchedState> {
  const AV = await ensureInit(config);
  const user = AV.User.current();
  if (!user) throw new Error("尚未登录 LeanCloud，无法拉取。");
  const query = new AV.Query(STATE_CLASS);
  query.equalTo("user", user);
  query.descending("updatedAt");
  const record = await query.first();
  if (!record) return null;
  const payload = record.get("data");
  if (typeof payload !== "string") return null;
  const parsed = JSON.parse(payload) as AppData;
  return { data: parsed, updatedAt: record.updatedAt?.toISOString() ?? new Date().toISOString() };
}

/** 拉取冲突判定：云端比本地新 → 需要用户确认覆盖 */
export function cloudIsNewer(cloudUpdatedAt: string, localUpdatedAt: string): boolean {
  return cloudUpdatedAt > localUpdatedAt;
}
