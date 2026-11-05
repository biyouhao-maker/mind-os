/**
 * decision-engine.ts 单元测试（智能决策参考引擎）。
 * 运行：npm run test:decision
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, "..", ".test-build");
const decisionMod = await import(pathToFileURL(path.join(buildDir, "decision-engine.js")).href);
const { answerDecision, extractTerms } = decisionMod.default ?? decisionMod;

const IMPORT = "chatgpt-test123";
function mkRow(convId, title, createdAt) {
  return { id: `${IMPORT}:${convId}`, title, platform: "ChatGPT", messageCount: 0, importedAt: "2026-11-05", createdAt, sourceImportId: IMPORT, sourceConversationId: convId };
}
function mkMsg(convId, mid, role, text, createdAt) {
  return { key: `${IMPORT}:${convId}:${mid}`, importId: IMPORT, conversationId: convId, sourceMessageId: mid, parentMessageId: null, role, authorName: "", createdAt, text, rawJson: "{}", sequence: 0 };
}

const rows = [
  mkRow("ai-1", "AI 学习路线", "2026-10-01T00:00:00Z"),
  mkRow("ai-2", "AI 项目实践", "2026-10-15T00:00:00Z"),
  mkRow("ai-3", "AI 出海思考", "2026-11-01T00:00:00Z"),
  mkRow("other-1", "健身计划", "2026-10-20T00:00:00Z")
];
const messages = [
  mkMsg("ai-1", "m1", "user", "大模型 学习 第一步", "2026-10-01T01:00:00Z"),
  mkMsg("ai-1", "m2", "assistant", "回复", "2026-10-01T02:00:00Z"),
  mkMsg("ai-2", "m3", "user", "AI 项目 落地 Python", "2026-10-15T01:00:00Z"),
  mkMsg("ai-2", "m4", "assistant", "回复", "2026-10-15T02:00:00Z"),
  mkMsg("ai-3", "m5", "user", "AI 产品 出海", "2026-11-01T01:00:00Z"),
  mkMsg("other-1", "m6", "user", "跑步 计划", "2026-10-20T01:00:00Z")
];
const insights = [
  { id: "i1", title: "【兴趣领域】持续关注「人工智能与大模型」", detail: "6 个会话涉及 AI 话题", kind: "observation", evidence: "", confidence: 80, createdAt: "2026-11-05" },
  { id: "i2", title: "【能力技能】接触 / 使用「Python」", detail: "4 次提及", kind: "hypothesis", evidence: "", confidence: 65, createdAt: "2026-11-05" }
];
const goals = [{ id: "g1", title: "掌握 AI 应用开发", category: "学习", deadline: "2026-12-31", progress: 40, status: "active", notes: "" }];
const ctx = { conversations: rows, messages, insights, goals };

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

console.log("== 七段结构与证据 ==");

const answer = answerDecision("我是否应该继续深入学习 AI？方案 A：先补基础。方案 B：直接做 AI 项目。", ctx);

await test("七段结构完整且顺序正确", () => {
  assert.deepEqual(answer.sections.map(s => s.title), [
    "1. 问题理解", "2. 相关个人历史", "3. 支持因素", "4. 风险因素",
    "5. 可行方案", "6. 推荐方案及理由", "7. 不确定性"
  ]);
});

await test("检索命中 AI 相关会话（不含无关的健身会话）", () => {
  assert.ok(answer.relatedCount >= 2, `相关会话仅 ${answer.relatedCount} 条`);
  const titles = answer.sections[1].body;
  assert.ok(!titles.includes("健身计划"), "不应检索到无关会话");
});

await test("相关个人历史段带可跳转的证据引用", () => {
  const refs = answer.sections[1].evidenceRefs;
  assert.ok(refs.length >= 2);
  for (const ref of refs) assert.ok(ref.startsWith(`${IMPORT}:`), `证据引用格式错误：${ref}`);
});

await test("支持因素引用画像线索与目标", () => {
  const body = answer.sections[2].body;
  assert.ok(body.includes("人工智能与大模型"), "应引用 AI 兴趣线索");
  assert.ok(body.includes("掌握 AI 应用开发"), "应引用相关目标");
});

await test("不确定性段永远存在且声明非预测", () => {
  const body = answer.sections[6].body;
  assert.match(body, /不是确定预测/);
  assert.match(body, /规则分析/);
});

console.log("== 方案解析与推荐 ==");

await test("方案 A / B 从问题中解析", () => {
  const plan = answer.sections[4].body;
  assert.match(plan, /方案 A：先补基础/);
  assert.match(plan, /方案 B：直接做 AI 项目/);
});

await test("有证据时给出倾向并标注只是倾向", () => {
  const body = answer.sections[5].body;
  assert.match(body, /基于历史证据的倾向：方案 [AB]/);
  assert.match(body, /不是预测/);
});

await test("证据不足场景：拒绝倾向性推荐", () => {
  const weakCtx = { conversations: [mkRow("cook-1", "烹饪笔记", "2026-10-01T00:00:00Z")], messages: [mkMsg("cook-1", "m1", "user", "红烧肉 做法", "2026-10-01T01:00:00Z")], insights: [], goals: [] };
  const weak = answerDecision("我是否应该转行做厨师？方案 A：留在原行业。方案 B：转行厨师。", weakCtx);
  assert.match(weak.sections[5].body, /证据不足/);
  assert.equal(weak.sufficient, false);
  assert.match(weak.sections[3].body, /证据不足/);
});

await test("无备选方案时引导用户拟定，不做推荐", () => {
  const noPlan = answerDecision("AI 方向我该怎么走？", ctx);
  assert.match(noPlan.sections[4].body, /没有提供具体备选方案/);
  assert.match(noPlan.sections[5].body, /不做推荐/);
});

await test("空问题 → 明确报错", () => {
  assert.throws(() => answerDecision("   ", ctx), /请先输入你的问题/);
});

await test("空会话 → 明确报错", () => {
  assert.throws(() => answerDecision("任何问题", { conversations: [], messages: [], insights: [], goals: [] }), /还没有已导入的对话/);
});

console.log("== 分词 ==");

await test("extractTerms：中文二元切分 + 拉丁词保留 + 虚词过滤", () => {
  const terms = extractTerms("我应该继续深入学习 AI 吗？");
  assert.ok(terms.includes("深入"));
  assert.ok(terms.includes("学习"));
  assert.ok(terms.includes("ai"));
  assert.ok(!terms.includes("应该"), "虚词应被过滤");
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  process.exitCode = 1;
  for (const f of failures) console.error("失败：", f.name);
}
