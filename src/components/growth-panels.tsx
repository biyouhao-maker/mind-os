"use client";

import { useEffect, useState } from "react";
import type { Conversation, Goal, GrowthLog, Insight, Report, Snapshot } from "@/lib/types";
import { listAllMessages, type StoredChatMessage } from "@/lib/chat-archive";
import {
  availableMonths,
  buildGrowthReport,
  buildSnapshot,
  compareSnapshots,
  makeReport,
  resolveWindow
} from "@/lib/growth-report";

/* ================= 画像快照面板（数字画像页） ================= */

type SnapshotPanelProps = {
  insights: Insight[];
  snapshots: Snapshot[];
  onSnapshot: (snapshot: Snapshot) => void;
  onDeleteSnapshot: (id: string) => void;
};

export function SnapshotPanel({ insights, snapshots, onSnapshot, onDeleteSnapshot }: SnapshotPanelProps) {
  const [compareId, setCompareId] = useState<string | null>(null);
  const latest = snapshots[0];
  const compareBase = snapshots.find(snapshot => snapshot.id === compareId) ?? null;
  const diff = latest && compareBase && latest.id !== compareBase.id ? compareSnapshots(compareBase, latest) : null;

  return (
    <section className="panel">
      <div className="panel-head"><h3>画像快照</h3></div>
      <p className="muted">
        把当前画像线索定格成一份只读快照。数据会随时间变化，快照让你随时能回答
        “一段时间前的我和现在有什么不同”。
      </p>
      <div className="actions">
        <button
          className="btn primary"
          disabled={!insights.length}
          onClick={() => onSnapshot(buildSnapshot(insights, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, new Date().toISOString().slice(0, 10)))}
        >
          ◇ 生成当前画像快照
        </button>
      </div>
      {!insights.length && <p className="muted">还没有画像线索，先手动填写或采纳分析候选。</p>}
      {snapshots.length ? (
        <div className="snapshot-list">
          {snapshots.map((snapshot, index) => (
            <div className="table-row" key={snapshot.id}>
              <div className="table-main">
                <b>快照 · {snapshot.createdAt}</b>
                <small>{snapshot.insights.length} 条线索</small>
              </div>
              {index > 0 && (
                <button className="btn" onClick={() => setCompareId(compareId === snapshot.id ? null : snapshot.id)}>
                  {compareId === snapshot.id ? "收起对比" : "与最新对比"}
                </button>
              )}
              <button className="delete" onClick={() => { if (compareId === snapshot.id) setCompareId(null); onDeleteSnapshot(snapshot.id); }}>删除</button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">还没有快照。建议每月生成一次，积累后就能看到画像的变化轨迹。</p>
      )}
      {diff && compareBase && (
        <div className="snapshot-diff">
          <b>对比结果（{compareBase.createdAt} → {latest.createdAt}）</b>
          <p><strong>新增线索：</strong>{diff.added.length ? diff.added.join("；") : "无"}</p>
          <p><strong>已移除：</strong>{diff.removed.length ? diff.removed.join("；") : "无"}</p>
          <p><strong>升级为事实：</strong>{diff.promoted.length ? diff.promoted.join("；") : "无"}</p>
        </div>
      )}
    </section>
  );
}

/* ================= 成长报告面板（个人成长页） ================= */

type GrowthReportPanelProps = {
  conversations: Conversation[];
  insights: Insight[];
  goals: Goal[];
  growthLogs: GrowthLog[];
  reports: Report[];
  onSaveReport: (report: Report) => void;
  onDeleteReport: (id: string) => void;
};

type ReportKind = "month" | "quarter" | "year";

const KIND_NAME: Record<ReportKind, string> = { month: "月度", quarter: "季度", year: "年度" };

export function GrowthReportPanel({ conversations, insights, goals, growthLogs, reports, onSaveReport, onDeleteReport }: GrowthReportPanelProps) {
  const months = availableMonths(conversations);
  const [month, setMonth] = useState(months[0] ?? new Date().toISOString().slice(0, 7));
  const [kind, setKind] = useState<ReportKind>("month");
  const [messages, setMessages] = useState<StoredChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [report, setReport] = useState<Report | null>(null);
  const [savedViewId, setSavedViewId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    listAllMessages()
      .then(rows => { if (!cancelled) setMessages(rows); })
      .catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : "读取本地消息失败。"); })
      .finally(() => { if (!cancelled) setMessagesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function generate() {
    setError("");
    if (messagesLoading) {
      setError("正在读取本地消息，请稍候。");
      return;
    }
    try {
      const window = resolveWindow(month, kind);
      const content = buildGrowthReport(window, conversations, messages, insights, goals, growthLogs);
      const quarter = Math.floor((Number(month.slice(5)) - 1) / 3) + 1;
      const periodLabel = kind === "year" ? `${month.slice(0, 4)} 年度报告` : kind === "quarter" ? `${month.slice(0, 4)} Q${quarter} 季度报告` : `${month} 月度报告`;
      setReport(makeReport(`report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, new Date().toISOString().slice(0, 10), periodLabel, window, content));
      setSavedViewId(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "报告生成失败。");
    }
  }

  const viewReport = savedViewId ? reports.find(item => item.id === savedViewId) ?? null : report;

  return (
    <>
      <section className="panel">
        <div className="panel-head"><h3>成长报告引擎</h3></div>
        <p className="muted">
          按月 / 季 / 年窗口统计你的真实数据：对话、活跃天数、话题、画像线索、目标与日志。
          所有数字来自本机记录，不夸大、不虚构“进步”。
        </p>
        <div className="formgrid">
          <Field label="月份">
            <select value={month} onChange={event => setMonth(event.target.value)}>
              {months.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="报告类型">
            <select value={kind} onChange={event => setKind(event.target.value as ReportKind)}>
              {(Object.keys(KIND_NAME) as ReportKind[]).map(k => <option key={k} value={k}>{KIND_NAME[k]}</option>)}
            </select>
          </Field>
        </div>
        <div className="actions">
          <button className="btn primary" disabled={messagesLoading} onClick={generate}>生成报告</button>
        </div>
        {error && <p className="muted" style={{ color: "#bd4d46" }}>{error}</p>}
      </section>

      {viewReport && (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3>{viewReport.content.periodLabel}（{viewReport.content.windowStart} ~ {viewReport.content.windowEnd}）</h3>
          </div>
          <div className="stats">
            <Stat label="会话" value={String(viewReport.content.conversations)} />
            <Stat label="消息" value={String(viewReport.content.messages)} />
            <Stat label="活跃天数" value={String(viewReport.content.activeDays)} />
            <Stat label="新增线索" value={String(viewReport.content.insightsAdopted)} />
          </div>
          <b className="muted" style={{ fontSize: 11 }}>重点话题</b>
          <p className="muted">
            {viewReport.content.topTopics.length
              ? viewReport.content.topTopics.map(topic => `${topic.name}（${topic.count} 条消息）`).join("、")
              : "本窗口没有识别到话题关键词。"}
          </p>
          <b className="muted" style={{ fontSize: 11 }}>跨月反复出现的话题</b>
          <p className="muted">{viewReport.content.recurringTopics.length ? viewReport.content.recurringTopics.join("、") : "无"}</p>
          <b className="muted" style={{ fontSize: 11 }}>目标概况</b>
          <p className="muted">
            共 {viewReport.content.goals.total} 个 · 进行中 {viewReport.content.goals.active} · 已完成 {viewReport.content.goals.done} · 平均进度 {viewReport.content.goals.avgProgress}%
          </p>
          <b className="muted" style={{ fontSize: 11 }}>成长日志</b>
          <p className="muted">{viewReport.content.growthLogs.count} 条{viewReport.content.growthLogs.titles.length ? `：${viewReport.content.growthLogs.titles.join("、")}` : ""}</p>
          <b className="muted" style={{ fontSize: 11 }}>如实记录</b>
          <div className="snapshot-diff">
            {viewReport.content.highlights.map((line, index) => <p key={index}>{line}</p>)}
          </div>
          {!savedViewId && report && (
            <div className="actions">
              <button className="btn primary" onClick={() => { onSaveReport(report); setSavedViewId(report.id); }}>保存这份报告</button>
            </div>
          )}
        </section>
      )}

      {reports.length > 0 && (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head"><h3>已保存的报告 · {reports.length} 份</h3></div>
          <div className="snapshot-list">
            {reports.map(item => (
              <div className="table-row" key={item.id}>
                <div className="table-main">
                  <b>{item.content.periodLabel}</b>
                  <small>生成于 {item.createdAt} · {item.content.conversations} 会话 · {item.content.messages} 消息</small>
                </div>
                <button className="btn" onClick={() => { setReport(item); setSavedViewId(item.id); }}>查看</button>
                <button className="delete" onClick={() => { if (savedViewId === item.id) { setSavedViewId(null); setReport(null); } onDeleteReport(item.id); }}>删除</button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
