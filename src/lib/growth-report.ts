/**
 * MIND OS 3.0 动态个人成长系统（第三阶段）。
 *
 * - 画像快照：把当前画像线索列表定格成一份只读快照，用于跨时间对比。
 * - 快照对比：新增 / 移除 / 升级为事实 三类变化。
 * - 成长报告：按月 / 季 / 年窗口，对会话、消息、活跃天数、话题、
 *   画像线索采纳情况、目标概况、成长日志做本地规则统计。
 *
 * 诚实边界：所有数字都来自用户本机真实数据；样本不足时如实说明，
 * 不生成没有数据支撑的"进步"叙述。健康数据不参与。
 */
import type { Conversation, Goal, GrowthLog, GrowthReportData, Insight, Report, Snapshot } from "./types";
import type { StoredChatMessage } from "./chat-archive";
import { TOPIC_RULES } from "./profile-analyzer";

function inWindow(iso: string | null | undefined, start: string, end: string): boolean {
  if (!iso) return false;
  const day = iso.slice(0, 10);
  return day >= start && day <= end;
}

function topicCountsInWindow(conversations: Conversation[], messages: StoredChatMessage[], start: string, end: string) {
  const rowsInWindow = new Set(conversations.filter(row => inWindow(row.createdAt, start, end)).map(row => row.id));
  const counts = new Map<string, { count: number; months: Set<string> }>();
  for (const message of messages) {
    const rowId = `${message.importId}:${message.conversationId}`;
    if (!rowsInWindow.has(rowId) || message.role !== "user" || !message.text.trim()) continue;
    const month = (message.createdAt ?? "").slice(0, 7);
    for (const rule of TOPIC_RULES) {
      if (hitsInText(message.text, rule.patterns)) {
        const entry = counts.get(rule.name) ?? { count: 0, months: new Set<string>() };
        entry.count += 1;
        if (month) entry.months.add(month);
        counts.set(rule.name, entry);
      }
    }
  }
  return counts;
}

function hitsInText(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

/** 生成当前画像快照（线索的只读定格） */
export function buildSnapshot(insights: Insight[], snapshotId: string, createdAt: string): Snapshot {
  return {
    id: snapshotId,
    createdAt,
    insights: insights.map(item => ({ title: item.title, kind: item.kind, confidence: item.confidence }))
  };
}

/** 对比两份快照：added = 新增线索；removed = 已移除；promoted = 类型升级为事实 */
export function compareSnapshots(base: Snapshot, target: Snapshot): { added: string[]; removed: string[]; promoted: string[] } {
  const baseMap = new Map(base.insights.map(item => [item.title, item]));
  const targetMap = new Map(target.insights.map(item => [item.title, item]));
  const added = [...targetMap.keys()].filter(title => !baseMap.has(title));
  const removed = [...baseMap.keys()].filter(title => !targetMap.has(title));
  const promoted = [...targetMap.entries()]
    .filter(([title, item]) => item.kind === "fact" && baseMap.get(title)?.kind !== "fact")
    .map(([title]) => title);
  return { added, removed, promoted };
}

export type ReportWindow = { start: string; end: string };

/** 由选择的月份推导窗口：月度 / 季度 / 年度 */
export function resolveWindow(month: string, kind: "month" | "quarter" | "year"): ReportWindow {
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const m = Number(monthStr);
  if (kind === "month") {
    const lastDay = new Date(year, m, 0).getDate();
    return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, "0")}` };
  }
  if (kind === "quarter") {
    const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
    const qEndMonth = qStartMonth + 2;
    const lastDay = new Date(year, qEndMonth, 0).getDate();
    return {
      start: `${year}-${String(qStartMonth).padStart(2, "0")}-01`,
      end: `${year}-${String(qEndMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
    };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

export function buildGrowthReport(
  window: ReportWindow,
  conversations: Conversation[],
  messages: StoredChatMessage[],
  insights: Insight[],
  goals: Goal[],
  growthLogs: GrowthLog[]
): GrowthReportData {
  const convsInWindow = conversations.filter(row => inWindow(row.createdAt, window.start, window.end));
  const msgsInWindow = messages.filter(message => inWindow(message.createdAt, window.start, window.end));
  const activeDays = new Set(msgsInWindow.map(message => (message.createdAt ?? "").slice(0, 10)).filter(Boolean)).size;

  const counts = topicCountsInWindow(conversations, msgsInWindow, window.start, window.end);
  const topTopics = [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(([name, entry]) => ({ name, count: entry.count }));

  // 反复出现的话题：窗口内跨越 ≥2 个自然月
  const recurringTopics = [...counts.entries()]
    .filter(([, entry]) => entry.months.size >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(([name]) => name);

  const insightsAdopted = insights.filter(item => inWindow(item.createdAt, window.start, window.end)).length;
  const insightsConfirmed = insights.filter(item => item.kind === "fact").length;

  const active = goals.filter(goal => goal.status === "active");
  const done = goals.filter(goal => goal.status === "done");
  const avgProgress = goals.length ? Math.round(goals.reduce((sum, goal) => sum + goal.progress, 0) / goals.length) : 0;

  const logsInWindow = growthLogs.filter(log => inWindow(log.date, window.start, window.end));

  const highlights: string[] = [];
  highlights.push(`窗口内共 ${convsInWindow.length} 个会话、${msgsInWindow.length} 条消息，活跃 ${activeDays} 天。`);
  if (topTopics.length) {
    highlights.push(`最活跃话题：${topTopics.map(topic => `${topic.name}（${topic.count} 条消息）`).join("、")}。`);
  } else {
    highlights.push("窗口内没有识别到话题关键词（可能消息较少或主题分散）。");
  }
  if (recurringTopics.length) {
    highlights.push(`跨月反复出现的话题：${recurringTopics.join("、")}——长期投入的方向，值得回顾积累。`);
  }
  highlights.push(`新增画像线索 ${insightsAdopted} 条；当前标记为「事实」的线索共 ${insightsConfirmed} 条。`);
  highlights.push(`目标概况：进行中 ${active.length} 个、已完成 ${done.length} 个、平均进度 ${avgProgress}%。`);
  highlights.push(`成长日志 ${logsInWindow.length} 条${logsInWindow.length ? "，坚持记录是成长最可靠的证据" : "——哪怕一句话也值得记下来"}。`);
  if (!convsInWindow.length && !logsInWindow.length) {
    highlights.push("该窗口内没有数据：这不是退步，只是没有记录。选择有数据的窗口再试。");
  }

  return {
    periodLabel: "",
    windowStart: window.start,
    windowEnd: window.end,
    conversations: convsInWindow.length,
    messages: msgsInWindow.length,
    activeDays,
    topTopics,
    recurringTopics,
    insightsAdopted,
    insightsConfirmed,
    goals: { total: goals.length, active: active.length, done: done.length, avgProgress },
    growthLogs: { count: logsInWindow.length, titles: logsInWindow.slice(0, 3).map(log => log.title) },
    highlights
  };
}

export function makeReport(id: string, createdAt: string, periodLabel: string, window: ReportWindow, content: GrowthReportData): Report {
  return {
    id,
    createdAt,
    periodLabel,
    windowStart: window.start,
    windowEnd: window.end,
    content: { ...content, periodLabel }
  };
}

/** 从会话数据推导可选择的月份列表（降序） */
export function availableMonths(conversations: Conversation[]): string[] {
  const months = new Set<string>();
  for (const row of conversations) {
    const month = monthOfDate(row.createdAt);
    if (month) months.add(month);
  }
  months.add(new Date().toISOString().slice(0, 7));
  return [...months].sort().reverse();
}

function monthOfDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const month = iso.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(month) ? month : null;
}
