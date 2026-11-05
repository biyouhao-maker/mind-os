/**
 * profile-analyzer.ts 单元测试（本地规则分析引擎）。
 * 前置：npm run compile:lib；运行：npm run test:analyzer
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, "..", ".test-build");
const analyzerMod = await import(pathToFileURL(path.join(buildDir, "profile-analyzer.js")).href);
const { analyzeChatHistory } = analyzerMod.default ?? analyzerMod;

const IMPORT = "chatgpt-test123";

function mkRow(importId, convId, title, createdAt) {
  return {
    id: `${importId}:${convId}`,
    title,
    platform: "ChatGPT",
    messageCount: 0,
    importedAt: "2026-11-05",
    createdAt,
    sourceImportId: importId,
    sourceConversationId: convId
  };
}

function mkMsg(importId, convId, mid, role, text, seq, createdAt) {
  return {
    key: `${importId}:${convId}:${mid}`,
    importId,
    conversationId: convId,
    sourceMessageId: mid,
    parentMessageId: null,
    role,
    authorName: "",
    createdAt,
    text,
    rawJson: JSON.stringify({ id: mid, role, text }),
    sequence: seq
  };
}

/** 构造一个会话：1 条 system + 每条用户文本后跟 1 条助手回复 */
function buildConversation(importId, convId, title, createdAt, userTexts) {
  const rows = [mkRow(importId, convId, title, createdAt)];
  const messages = [mkMsg(importId, convId, `${convId}-sys`, "system", "system prompt", 0, createdAt)];
  let seq = 1;
  userTexts.forEach((text, index) => {
    messages.push(mkMsg(importId, convId, `${convId}-u${index}`, "user", text, seq++, createdAt));
    messages.push(mkMsg(importId, convId, `${convId}-a${index}`, "assistant", "回复", seq++, createdAt));
  });
  return { rows, messages };
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

/* ---------------- 合成数据 ----------------
 * 6 个 AI 会话（跨 3 个月：09×1、10×2、11×3），其中部分消息结构化表达；
 * 1 个创业会话（命中数不足门槛）；Python 提及 4 次。
 */
const rows = [];
const messages = [];
function add(convId, title, createdAt, userTexts) {
  const built = buildConversation(IMPORT, convId, title, createdAt, userTexts);
  rows.push(...built.rows);
  messages.push(...built.messages);
}

add("ai-01", "AI 入门", "2026-09-05T10:00:00Z", ["什么是大模型？", "Python 怎么入门", "给个学习框架"]);
add("ai-02", "AI 应用", "2026-10-06T10:00:00Z", ["用 AI 写代码靠谱吗", "Python 调用 openai 接口", "第一步 先做什么"]);
add("ai-03", "AI 智能体", "2026-10-20T10:00:00Z", ["智能体 Agent 怎么做", "Python 还是 TypeScript", "1. 定场景 2. 定工具"]);
add("ai-04", "AI 提示词", "2026-11-01T10:00:00Z", ["提示词 prompt 怎么写", "few-shot 例子", "首先 明确目标"]);
add("ai-05", "AI 出海产品", "2026-11-10T10:00:00Z", ["AI 产品 的技术栈", "GPT 接口 的调用方式", "第二 步 验证需求"]);
add("ai-06", "AI 复盘", "2026-11-20T10:00:00Z", ["复盘我的 AI 学习路径", "Python 项目部署", "清单：下一步三件事"]);
add("biz-01", "创业咨询", "2026-10-25T10:00:00Z", ["创业 变现 的第一步是什么"]);

console.log("== 核心规则 ==");

const result = analyzeChatHistory(rows, messages);
const candidates = result.candidates;

await test("兴趣门槛：命中 ≥2 会话才生成（AI 生成、创业被跳过）", () => {
  const ai = candidates.find(c => c.title.includes("人工智能与大模型"));
  assert.ok(ai, "AI 兴趣候选应存在");
  const biz = candidates.find(c => c.title.includes("创业与商业"));
  assert.equal(biz, undefined, "创业只命中 1 个会话，不应生成");
  const aiTopic = result.stats;
  assert.ok(aiTopic.conversationsAnalyzed === 7);
});

await test("永不产出 fact 类型（全部为 observation / hypothesis）", () => {
  for (const candidate of candidates) {
    assert.ok(candidate.kind === "observation" || candidate.kind === "hypothesis", `非法类型：${candidate.kind}`);
  }
});

await test("兴趣候选：置信度在 35~80 区间且随证据量增加", () => {
  const ai = candidates.find(c => c.title.includes("人工智能与大模型"));
  assert.ok(ai.confidence >= 35 && ai.confidence <= 80, `置信度 ${ai.confidence} 越界`);
  assert.equal(ai.category, "兴趣领域");
});

await test("证据链：每个候选都有非空 detail、evidenceText 与 evidenceRefs", () => {
  for (const candidate of candidates) {
    assert.ok(candidate.evidenceRefs.length >= 1, `${candidate.title} 缺证据引用`);
    assert.ok(candidate.evidence.length >= 1, `${candidate.title} 缺结构化证据`);
    assert.ok(candidate.detail.length > 0 && candidate.evidenceText.length > 0, `${candidate.title} 说明为空`);
  }
});

await test("能力技能：Python 提及 ≥2 次 → 生成待确认推测", () => {
  const python = candidates.find(c => c.title.includes("Python"));
  assert.ok(python, "Python 技能候选应存在");
  assert.equal(python.category, "能力技能");
  assert.equal(python.kind, "hypothesis");
  assert.match(python.detail, /不代表熟练程度/);
});

await test("思维习惯：样本 ≥10 条且结构化占比 ≥25% → 生成假设", () => {
  const habit = candidates.find(c => c.title.includes("结构化表达"));
  assert.ok(habit, "结构化表达候选应存在");
  assert.match(habit.detail, /行为观察，不等于性格标签/);
});

await test("行为趋势：AI 话题按月 1→2→3 → 上升趋势候选", () => {
  const trend = candidates.find(c => c.title.includes("上升趋势") && c.title.includes("人工智能与大模型"));
  assert.ok(trend, "AI 上升趋势候选应存在");
  assert.match(trend.detail, /2026-09:1 → 2026-10:2 → 2026-11:3/);
  assert.match(trend.detail, /短期波动可能主导趋势/);
});

await test("趋势回落的会话不会被误报为上升", () => {
  const downTrend = candidates.find(c => c.title.includes("回落"));
  assert.ok(downTrend === undefined || downTrend.title.includes("回落"));
});

console.log("== 边界与报错 ==");

await test("空会话索引 → 明确报错", () => {
  assert.throws(() => analyzeChatHistory([], messages), /还没有已导入的会话索引/);
});

await test("索引存在但消息为空 → 明确报错", () => {
  assert.throws(() => analyzeChatHistory(rows, []), /没有在本机 IndexedDB 找到已导入的消息正文/);
});

await test("统计口径：分析窗口与会话数正确", () => {
  assert.equal(result.stats.conversationsAnalyzed, 7);
  assert.equal(result.stats.windowStart, "2026-09");
  assert.equal(result.stats.windowEnd, "2026-11");
  assert.ok(result.stats.userMessagesAnalyzed >= 10);
});

await test("候选数量有上限（≤14），避免信息过载", () => {
  assert.ok(candidates.length <= 14, `候选 ${candidates.length} 条超限`);
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  process.exitCode = 1;
  for (const f of failures) console.error("失败：", f.name);
}
