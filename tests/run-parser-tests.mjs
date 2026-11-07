/**
 * chat-archive.ts 解析层单元测试（Node 运行，不依赖浏览器 IndexedDB）。
 * 前置：npm run compile:lib（把 src/lib/chat-archive.ts 编译到 .test-build/）
 * 运行：node tests/run-parser-tests.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
const buildDir = path.join(projectRoot, ".test-build");

const parserMod = await import(pathToFileURL(path.join(buildDir, "chat-archive-parse.js")).href);
const { parseChatGPTZip } = parserMod.default ?? parserMod;

const fixtures = path.join(here, "fixtures");
const load = name => new File([fs.readFileSync(path.join(fixtures, name))], name, { type: "application/zip" });

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

console.log("== A/B. 正常解析与数据完整性 ==");

const validFile = load("valid.zip");
const valid = await parseChatGPTZip(validFile);

await test("解析出 3 个会话", () => {
  assert.equal(valid.conversations.length, 3);
});

await test("会话 ID / 标题正确", () => {
  assert.deepEqual(valid.conversations.map(c => c.conversationId), ["conv-001", "conv-002", "conv-003"]);
  assert.equal(valid.conversations[0].title, "职业规划讨论");
});

await test("mapping 树顺序正确（root 跳过，system→user→assistant→user→assistant）", () => {
  const conv1Messages = valid.messages.filter(m => m.conversationId === "conv-001");
  assert.equal(conv1Messages.length, 5);
  assert.deepEqual(conv1Messages.map(m => m.sourceMessageId), ["msg-sys", "msg-u1", "msg-a1", "msg-u2", "msg-a2"]);
  assert.deepEqual(conv1Messages.map(m => m.sequence), [0, 1, 2, 3, 4]);
});

await test("角色识别：system / user / assistant / tool", () => {
  const byId = Object.fromEntries(valid.messages.map(m => [m.sourceMessageId, m]));
  assert.equal(byId["msg-sys"].role, "system");
  assert.equal(byId["msg-u1"].role, "user");
  assert.equal(byId["msg-a1"].role, "assistant");
  assert.equal(byId["msg-t1"].role, "tool");
});

await test("父消息 ID 正确", () => {
  const byId = Object.fromEntries(valid.messages.map(m => [m.sourceMessageId, m]));
  assert.equal(byId["msg-u1"].parentMessageId, "msg-sys");
  assert.equal(byId["msg-a2"].parentMessageId, "msg-u2");
  assert.equal(byId["msg-sys"].parentMessageId, "root-000");
});

await test("消息时间：epoch → ISO；缺失 create_time → null", () => {
  const byId = Object.fromEntries(valid.messages.map(m => [m.sourceMessageId, m]));
  assert.equal(byId["msg-u1"].createdAt, "2025-01-01T00:00:02.000Z");
  assert.equal(byId["msg-t1"].createdAt, null);
});

await test("正文完整保留，非文本 part 不破坏文本提取", () => {
  const byId = Object.fromEntries(valid.messages.map(m => [m.sourceMessageId, m]));
  assert.equal(byId["msg-u1"].text, "我想转行做 AI 开发，有什么建议？");
  assert.equal(byId["msg-u2"].text, "用项目方式学习呢？");
});

await test("非文本消息不被丢弃：rawJson 保留原始结构（含 image_asset_pointer）", () => {
  const byId = Object.fromEntries(valid.messages.map(m => [m.sourceMessageId, m]));
  const raw = JSON.parse(byId["msg-u2"].rawJson);
  assert.equal(raw.content.parts[0].content_type, "image_asset_pointer");
  assert.equal(raw.author.name, "小明");
});

await test("rawJson 可完整还原原始消息对象", () => {
  const byId = Object.fromEntries(valid.messages.map(m => [m.sourceMessageId, m]));
  const raw = JSON.parse(byId["msg-a2"].rawJson);
  assert.equal(raw.id, "msg-a2");
  assert.equal(raw.create_time, 1735689605);
});

await test("空会话：0 条消息但仍建立索引，预览如实说明", () => {
  const conv3 = valid.conversations.find(c => c.conversationId === "conv-003");
  assert.equal(conv3.messageCount, 0);
  assert.equal(conv3.title, "空会话");
  assert.match(conv3.preview, /未解析出文本内容/);
});

await test("总数与分类计数一致", () => {
  assert.equal(valid.totalRawMessages, 5 + 3 + 0);
  const conv1 = valid.conversations[0];
  assert.deepEqual(
    [conv1.messageCount, conv1.userMessageCount, conv1.assistantMessageCount, conv1.otherMessageCount],
    [5, 2, 2, 1]
  );
});

await test("SHA-256 文件哈希：相同文件哈希一致，不同文件不同", async () => {
  const again = await parseChatGPTZip(load("valid.zip"));
  assert.equal(again.fileHash, valid.fileHash);
  const overlap = await parseChatGPTZip(load("overlap.zip"));
  assert.notEqual(overlap.fileHash, valid.fileHash);
});

await test("跨批次同 ID 会话：解析层保持同 ID（隔离由存储复合索引保证）", async () => {
  const overlap = await parseChatGPTZip(load("overlap.zip"));
  assert.equal(overlap.conversations[0].conversationId, "conv-001");
  assert.equal(overlap.conversations[0].title, "同 ID 的另一个会话");
  assert.equal(overlap.totalRawMessages, 1);
});

console.log("== A. 异常输入 ==");

await test("conversations.json 缺失 → 明确报错", async () => {
  await assert.rejects(() => parseChatGPTZip(load("missing-conversations.zip")), /没有在 ZIP 内找到 conversations\.json/);
});

await test("JSON 格式错误 → 明确报错", async () => {
  await assert.rejects(() => parseChatGPTZip(load("bad-json.zip")), /不是有效的 JSON/);
});

await test("ZIP 损坏（原始坏字节）→ 明确报错", async () => {
  await assert.rejects(() => parseChatGPTZip(load("corrupted.zip")), /损坏或无法解压/);
});

await test("空文件（0 字节）→ 明确报错", async () => {
  await assert.rejects(() => parseChatGPTZip(load("empty.zip")), /损坏或无法解压/);
});

await test("合法但无条目的 ZIP → 提示缺少 conversations.json", async () => {
  await assert.rejects(() => parseChatGPTZip(load("empty-archive.zip")), /没有在 ZIP 内找到 conversations\.json/);
});

await test("空对话数组 → 明确报错", async () => {
  await assert.rejects(() => parseChatGPTZip(load("empty-conversations.zip")), /没有包含任何对话/);
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  process.exitCode = 1;
  for (const f of failures) console.error("失败：", f.name);
}
