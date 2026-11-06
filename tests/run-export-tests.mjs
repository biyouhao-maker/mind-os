/**
 * markdown-export.ts 单元测试。
 * 运行：npm run test:export
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, "..", ".test-build");
const exportMod = await import(pathToFileURL(path.join(buildDir, "markdown-export.js")).href);
const { growthReportToMarkdown, decisionAnswerToMarkdown, downloadTextFile } = exportMod.default ?? exportMod;

const report = {
  id: "r1",
  createdAt: "2026-11-06",
  periodLabel: "2026-11 月度报告",
  windowStart: "2026-11-01",
  windowEnd: "2026-11-30",
  content: {
    periodLabel: "2026-11 月度报告",
    windowStart: "2026-11-01",
    windowEnd: "2026-11-30",
    conversations: 4,
    messages: 1608,
    activeDays: 2,
    topTopics: [{ name: "编程开发", count: 182 }],
    recurringTopics: [],
    insightsAdopted: 1,
    insightsConfirmed: 0,
    goals: { total: 0, active: 0, done: 0, avgProgress: 0 },
    growthLogs: { count: 0, titles: [] },
    highlights: ["窗口内共 4 个会话、1608 条消息，活跃 2 天。"]
  }
};

const answer = {
  question: "我是否应该继续深入学习 AI？",
  sections: [
    { title: "1. 问题理解", body: "问题涉及 AI。", evidenceRefs: [] },
    { title: "2. 相关个人历史", body: "检索到 2 个相关会话。", evidenceRefs: ["chatgpt-x:conv-1"] },
    { title: "3. 支持因素", body: "画像线索支持。", evidenceRefs: [] },
    { title: "4. 风险因素", body: "样本有限。", evidenceRefs: [] },
    { title: "5. 可行方案", body: "方案 A / B。", evidenceRefs: [] },
    { title: "6. 推荐方案及理由", body: "倾向方案 B。", evidenceRefs: ["chatgpt-x:conv-1"] },
    { title: "7. 不确定性", body: "不是确定预测。", evidenceRefs: [] }
  ],
  relatedCount: 2,
  sufficient: true,
  generatedBy: "llm",
  model: "test-model"
};

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

await test("报告 Markdown：标题、表格、全部章节齐全", () => {
  const md = growthReportToMarkdown(report);
  assert.match(md, /^# 2026-11 月度报告/);
  assert.match(md, /## 总览/);
  assert.match(md, /\| 会话 \| 4 \|/);
  assert.match(md, /\| 消息 \| 1608 \|/);
  assert.match(md, /## 重点话题/);
  assert.match(md, /编程开发：182 条消息/);
  assert.match(md, /## 目标概况/);
  assert.match(md, /## 如实记录/);
  assert.match(md, /MIND OS 在本地生成/);
});

await test("报告 Markdown：空话题与空日志如实显示", () => {
  const md = growthReportToMarkdown({ ...report, content: { ...report.content, topTopics: [], recurringTopics: [], growthLogs: { count: 0, titles: [] } } });
  assert.match(md, /没有识别到话题关键词/);
  assert.match(md, /0 条/);
});

await test("决策 Markdown：七段 + 证据标题解析 + 来源标注", () => {
  const md = decisionAnswerToMarkdown(answer, rowId => (rowId.includes("conv-1") ? "某个真实会话标题" : rowId));
  assert.match(md, /^# 决策参考/);
  assert.match(md, /> 问题：我是否应该继续深入学习 AI/);
  assert.match(md, /## 1\. 问题理解/);
  assert.match(md, /## 7\. 不确定性/);
  assert.match(md, /生成方式：模型推断（test-model）/);
  assert.match(md, /- 某个真实会话标题/);
  assert.match(md, /不构成确定预测/);
});

await test("决策 Markdown：证据无解析函数时回退显示原始 ID", () => {
  const md = decisionAnswerToMarkdown(answer);
  assert.match(md, /chatgpt-x:conv-1/);
});

await test("downloadTextFile 仅在浏览器调用（Node 导入不报错）", () => {
  assert.equal(typeof downloadTextFile, "function");
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  process.exitCode = 1;
  for (const f of failures) console.error("失败：", f.name);
}
