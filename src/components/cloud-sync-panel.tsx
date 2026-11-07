"use client";

import { useEffect, useState } from "react";
import type { AppData, LcConfig } from "@/lib/types";
import type { LcUser } from "@/lib/leancloud";
import {
  cloudIsNewer,
  fetchState,
  isLcReady,
  lcCurrentUser,
  lcLogIn,
  lcLogOut,
  lcSignUp,
  uploadState
} from "@/lib/leancloud";
import { getLocalUpdatedAt } from "@/lib/storage";

type Props = {
  lc: LcConfig;
  data: AppData;
  onLcChange: (lc: LcConfig) => void;
  /** 从云端拉取的结构化数据交由 workspace 整体替换本地 */
  onPull: (data: AppData) => void;
};

const SERVER_PRESETS = [
  { label: "LeanCloud 华东", url: "https://leancloud.cn" },
  { label: "LeanCloud 华北", url: "https://lncldapi.com" },
  { label: "LeanCloud 国际版", url: "https://api.lcapp.app" }
];

export function CloudSyncPanel({ lc, data, onLcChange, onPull }: Props) {
  const [user, setUser] = useState<LcUser | null>(null);
  const [userChecked, setUserChecked] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const configured = isLcReady(lc);

  // 配置就绪后检查登录态
  useEffect(() => {
    let cancelled = false;
    if (!configured) {
      setUser(null);
      setUserChecked(true);
      return;
    }
    lcCurrentUser()
      .then(user => { if (!cancelled) { setUser(user); setError(""); } })
      .catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : "初始化失败。"); })
      .finally(() => { if (!cancelled) setUserChecked(true); });
    return () => { cancelled = true; };
  }, [lc.appId, lc.appKey, lc.server, lc.enabled, configured]);

  async function runAuth() {
    setError("");
    setBusy(true);
    try {
      const result = authMode === "signup" ? await lcSignUp(username, password) : await lcLogIn(username, password);
      setUser(result);
      setNotice(`登录成功：${result.username}`);
    } catch (err) {
      setError(`登录失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setBusy(false);
    }
  }

  async function doUpload() {
    setError("");
    setBusy(true);
    try {
      const { updatedAt } = await uploadState(lc, data);
      setNotice(`已上传到云端（${updatedAt.slice(0, 19).replace("T", " ")}）。`);
    } catch (err) {
      setError(`上传失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setBusy(false);
    }
  }

  async function doPull() {
    setError("");
    setBusy(true);
    try {
      const cloud = await fetchState(lc);
      if (!cloud) {
        setNotice("云端暂无数据：请先执行一次「上传到云端」。");
        return;
      }
      const localUpdated = getLocalUpdatedAt();
      if (cloudIsNewer(cloud.updatedAt, localUpdated)) {
        if (!confirm(`云端数据（${cloud.updatedAt.slice(0, 19).replace("T", " ")}）比本地（${localUpdated.slice(0, 19).replace("T", " ")}）更新。\n确定用云端覆盖本地吗？`)) {
          setNotice("已取消拉取，本地数据未更改。");
          return;
        }
        onPull(cloud.data);
        setNotice("已从云端拉取（覆盖本地）。");
      } else {
        if (!confirm(`本地数据（${localUpdated.slice(0, 19).replace("T", " ")}）比云端（${cloud.updatedAt.slice(0, 19).replace("T", " ")}）更新。\n仍要用云端覆盖本地吗？覆盖将丢失本地较新的改动。`)) {
          setNotice("已取消拉取，本地数据未更改。");
          return;
        }
        onPull(cloud.data);
        setNotice("已从云端拉取（按你的确认覆盖了较新的本地数据）。");
      }
    } catch (err) {
      setError(`拉取失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setBusy(false);
    }
  }

  function doLogout() {
    lcLogOut();
    setUser(null);
    setNotice("已退出登录。");
  }

  return (
    <Panel title="云端同步（LeanCloud）">
      <p className="muted">
        注册 / 登录 LeanCloud 账号后，可将画像、目标、设置等结构化数据上传到云端，实现跨浏览器与跨设备迁移。
        数据以 ACL 保护（仅创建者本人可读写）。聊天正文（IndexedDB）的文件同步为后续阶段。
      </p>

      {!configured && (
        <>
          <div className="formgrid">
            <Field label="AppID" full>
              <input value={lc.appId} onChange={e => onLcChange({ ...lc, appId: e.target.value })} placeholder="LeanCloud 控制台 → 应用凭证 → AppID" />
            </Field>
            <Field label="AppKey" full>
              <input value={lc.appKey} onChange={e => onLcChange({ ...lc, appKey: e.target.value })} placeholder="应用凭证 → AppKey（前端公开凭证，安全由 ACL 保障）" />
            </Field>
            <Field label="服务器地址" full>
              <select value={SERVER_PRESETS.some(p => p.url === lc.server) ? lc.server : lc.server ? "__custom" : ""} onChange={e => onLcChange({ ...lc, server: e.target.value === "__custom" ? "" : e.target.value })}>
                <option value="">选择区域…</option>
                {SERVER_PRESETS.map(p => <option key={p.url} value={p.url}>{p.label}</option>)}
                {lc.server && !SERVER_PRESETS.some(p => p.url === lc.server) && <option value="__custom">{lc.server}</option>}
              </select>
            </Field>
          </div>
          <p className="muted">请在 LeanCloud 控制台创建应用（开发版免费）后复制凭证；并记得在「域名白名单」中加入本站地址。</p>
        </>
      )}

      {configured && !userChecked && <p className="muted">正在检查登录状态…</p>}

      {configured && userChecked && !user && (
        <>
          <div className="formgrid">
            <Field label="用户名"><input value={username} onChange={e => setUsername(e.target.value)} placeholder="用于 LeanCloud 账号" /></Field>
            <Field label="密码"><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="至少 6 位" /></Field>
          </div>
          <div className="actions">
            <button className="btn primary" disabled={busy || !username.trim() || password.length < 6} onClick={() => void runAuth()}>
              {busy ? "处理中…" : authMode === "signup" ? "注册并登录" : "登录"}
            </button>
            <button className="btn" disabled={busy} onClick={() => setAuthMode(authMode === "signup" ? "login" : "signup")}>
              {authMode === "signup" ? "已有账号？去登录" : "没有账号？去注册"}
            </button>
          </div>
        </>
      )}

      {configured && userChecked && user && (
        <>
          <p className="muted">当前账号：<strong style={{ color: "var(--ink,#18212f)" }}>{user.username}</strong>（注册于 {user.createdAt.slice(0, 10)}）</p>
          <div className="actions">
            <button className="btn primary" disabled={busy} onClick={() => void doUpload()}>↑ 上传到云端</button>
            <button className="btn" disabled={busy} onClick={() => void doPull()}>↓ 从云端拉取</button>
            <button className="btn" disabled={busy} onClick={doLogout}>退出登录</button>
          </div>
          <p className="muted">
            本地最后修改：{getLocalUpdatedAt() ? getLocalUpdatedAt().slice(0, 19).replace("T", " ") : "未知"}。
            拉取会覆盖本地全部结构化数据（LLM Key 需重新填写，详见备份说明）；上传不含 API Key。
          </p>
        </>
      )}

      {notice && <p className="muted" style={{ marginTop: 8 }}>{notice}</p>}
      {error && <p className="muted" style={{ color: "#bd4d46", marginTop: 8 }}>{error}</p>}
      {!configured && <p className="muted">填写上方凭证后即可启用云端同步；不配置则一切保持本地，功能不受影响。</p>}
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head"><h3>{title}</h3></div>
      {children}
    </section>
  );
}

function Field({ label, children, full = false }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label className={`field ${full ? "full" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
