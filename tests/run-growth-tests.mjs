/**
 * growth-report.ts 单元测试（快照 / 对比 / 月季年报告）。
 * 运行：npm run test:growth
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, "..", ".test-build");
const growthMod = await import(pathToFileURL(path.join(buildDir, "growth-report.js")).href);
const lib = growthMod.default ?? growthMod;
const { buildGrowthReport, buildSnapshot, compareSnapshots, resolveWindow, availableMonths } = lib;

const IMPORT = "chatgpt-test123";
let seq = 0;
function mkRow(importId, convId, title, createdAt) {
  return { id: `${importId}:${convId}`, title, platform: "ChatGPT", messageCount: 0, importedAt: "2026-11-05", createdAt, sourceImportId: importId, sourceConversationId: convId };
}
function mkMsg(importId, convId, mid, role, text, createdAt) {
  return { key: `${importId}:${convId}:${mid}`, importId, conversationId: convId, sourceMessageId: mid, parentMessageId: null, role, authorName: "", createdAt, text, rawJson: "{}", sequence: seq++ };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ✓", name);
  } catch (error) {
    failures.push({ name, error });
    console.error("  ✗", name, "\n   ", error instanceof Error ? error.message : error);
  }
}

/* 数据：10 月 2 个 AI 会话（4 条用户消息），11 月 1 个 AI 会话（1 条）+ 1 个创业会话；目标与日志 */
const conversations = [
  mkRow(IMPORT, "c1", "AI 十月一", "2026-10-05T10:00:00Z"),
  mkRow(IMPORT, "c2", "AI 十月二", "2026-10-18T10:00:00Z"),
  mkRow(IMPORT, "c3", "AI 十一月", "2026-11-05T10:00:00Z"),
  mkRow(IMPORT, "c4", "创业 十一月", "2026-11-08T10:00:00Z")
];
const messages = [
  mkMsg(IMPORT, "c1", "m1", "user", "AI 大模型 学习心得", "2026-10-05T10:01:00Z"),
  mkMsg(IMPORT, "c1", "m2", "assistant", "回复", "2026-10-05T10:02:00Z"),
  mkMsg(IMPORT, "c2", "m3", "user", "AI agent 实践", "2026-10-18T10:01:00Z"),
  mkMsg(IMPORT, "c2", "m4", "assistant", "回复", "2026-10-18T10:02:00Z"),
  mkMsg(IMPORT, "c3", "m5", "user", "AI 复盘 学习", "2026-11-05T10:01:00Z"),
  mkMsg(IMPORT, "c3", "m6", "assistant", "回复", "2026-11-05T10:02:00Z"),
  mkMsg(IMPORT, "c4", "m7", "user", "创业 变现 思路", "2026-11-08T10:01:00Z")
];
const insights = [
  { id: "i1", title: "【兴趣领域】AI", detail: "", kind: "fact", evidence: "", confidence: 80, createdAt: "2026-10-20" },
  { id: "i2", title: "【能力技能】Python", detail: "", kind: "hypothesis", evidence: "", confidence: 60, createdAt: "2026-11-01" }
];
const goals = [
  { id: "g1", title: "目标A", category: "学习", deadline: "", progress: 40, status: "active", notes: "" },
  { id: "g2", title: "目标B", category: "学习", deadline: "", progress: 100, status: "done", notes: "" }
];
const growthLogs = [{ id: "l1", date: "2026-10-10", title: "十月的复盘", detail: "" }];

console.log("== 窗口解析 ==");

await test("resolveWindow：月度窗口起止正确", () => {
  const w = resolveWindow("2026-10", "month");
  assert.equal(w.start, "2026-10-01");
  assert.equal(w.end, "2026-10-31");
});

await test("resolveWindow：季度窗口跨 3 个月", () => {
  const w = resolveWindow("2026-11", "quarter");
  assert.equal(w.start, "2026-10-01");
  assert.equal(w.end, "2026-12-31");
});

await test("resolveWindow：年度窗口覆盖全年", () => {
  const w = resolveWindow("2026-01", "year");
  assert.equal(w.start, "2026-01-01");
  assert.equal(w.end, "2026-12-31");
});

await test("availableMonths：从会话数据推导并降序", () => {
  const months = availableMonths(conversations);
  assert.deepEqual(months.slice(0, 2), ["2026-11", "2026-10"]);
});

console.log("== 月度报告 ==");

const octReport = buildGrowthReport(
  resolveWindow("2026-10", "month"),
  conversations,
  messages,
  insights,
  goals,
  growthLogs
);

await test("窗口过滤：10 月报告只统计 10 月数据", () => {
  assert.equal(octReport.conversations, 2);
  assert.equal(octReport.messages, 4);
  assert.equal(octReport.activeDays, 2);
});

await test("话题统计：10 月用户消息命中 AI 与学习方法", () => {
  const ai = octReport.topTopics.find(t => t.name === "人工智能与大模型");
  assert.ok(ai && ai.count === 2, `AI 话题应 2 条，实际 ${JSON.stringify(octReport.topTopics)}`);
});

await test("画像线索按 createdAt 归入窗口", () => {
  assert.equal(octReport.insightsAdopted, 1);
});

await test("目标概况为全量快照式统计", () => {
  assert.deepEqual(octReport.goals, { total: 2, active: 1, done: 1, avgProgress: 70 });
});

await test("成长日志按日期归入窗口", () => {
  assert.equal(octReport.growthLogs.count, 1);
  assert.deepEqual(octReport.growthLogs.titles, ["十月的复盘"]);
});

await test("月度窗口内没有跨月话题时 recurringTopics 为空", () => {
  assert.equal(octReport.recurringTopics.length, 0);
});

console.log("== 季度报告与反复话题 ==");

const q4Report = buildGrowthReport(
  resolveWindow("2026-11", "quarter"),
  conversations,
  messages,
  insights,
  goals,
  growthLogs
);

await test("季度窗口：AI 话题跨 10/11 两月 → 进入反复话题", () => {
  assert.ok(q4Report.recurringTopics.includes("人工智能与大模型"), `实际 ${JSON.stringify(q4Report.recurringTopics)}`);
});

await test("季度窗口统计覆盖 10+11 月", () => {
  assert.equal(q4Report.conversations, 4);
  assert.equal(q4Report.messages, 7);
});

await test("空窗口：如实说明而不是编造进步", () => {
  const empty = buildGrowthReport({ start: "2025-01-01", end: "2025-01-31" }, conversations, messages, insights, goals, growthLogs);
  assert.equal(empty.conversations, 0);
  assert.ok(empty.highlights.some(line => line.includes("没有数据")));
});

console.log("== 快照与对比 ==");

await test("buildSnapshot：定格线索的标题/类型/置信度", () => {
  const snap = buildSnapshot(insights, "s1", "2026-10-31");
  assert.equal(snap.insights.length, 2);
  assert.equal(snap.insights[0].title, "【兴趣领域】AI");
  assert.equal(snap.insights[0].kind, "fact");
});

await test("compareSnapshots：新增 / 移除 / 升级为事实", () => {
  const base = { id: "s1", createdAt: "2026-10-31", insights: [
    { title: "线索A", kind: "observation", confidence: 60 },
    { title: "线索B", kind: "hypothesis", confidence: 50 }
  ]};
  const target = { id: "s2", createdAt: "2026-11-30", insights: [
    { title: "线索A", kind: "fact", confidence: 90 },
    { title: "线索C", kind: "observation", confidence: 55 }
  ]};
  const diff = compareSnapshots(base, target);
  assert.deepEqual(diff.added, ["线索C"]);
  assert.deepEqual(diff.removed, ["线索B"]);
  assert.deepEqual(diff.promoted, ["线索A"]);
});

await test("compareSnapshots：完全一致时三类变化均为空", () => {
  const snap = buildSnapshot(insights, "s1", "2026-10-31");
  const same = buildSnapshot(insights, "s2", "2026-11-30");
  const diff = compareSnapshots(snap, same);
  assert.equal(diff.added.length + diff.removed.length + diff.promoted.length, 0);
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  process.exitCode = 1;
  for (const f of failures) console.error("失败：", f.name);
}
