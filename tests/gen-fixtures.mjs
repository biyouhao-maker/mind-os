/**
 * 生成合成 ChatGPT 官方导出 ZIP 测试数据（全部为编造内容，不含任何真实用户数据）。
 * 运行：node tests/gen-fixtures.mjs
 */
import { zipSync, strToU8 } from "fflate";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
fs.mkdirSync(outDir, { recursive: true });

/* conv-001：完整会话。root(空) → system → user → assistant → user(含非文本 part) → assistant */
const conv1 = {
  id: "conv-001",
  title: "职业规划讨论",
  create_time: 1735689600,
  mapping: {
    "root-000": { id: "root-000", message: {}, parent: null, children: ["msg-sys"] },
    "msg-sys": { id: "msg-sys", parent: "root-000", children: ["msg-u1"], message: { id: "msg-sys", author: { role: "system" }, create_time: 1735689601, content: { content_type: "text", parts: ["You are a helpful assistant."] } } },
    "msg-u1": { id: "msg-u1", parent: "msg-sys", children: ["msg-a1"], message: { id: "msg-u1", author: { role: "user" }, create_time: 1735689602, content: { content_type: "text", parts: ["我想转行做 AI 开发，有什么建议？"] } } },
    "msg-a1": { id: "msg-a1", parent: "msg-u1", children: ["msg-u2"], message: { id: "msg-a1", author: { role: "assistant" }, create_time: 1735689603, content: { content_type: "text", parts: ["建议先打好 Python 基础，再做项目。"] } } },
    "msg-u2": { id: "msg-u2", parent: "msg-a1", children: ["msg-a2"], message: { id: "msg-u2", author: { role: "user", name: "小明" }, create_time: 1735689604, content: { content_type: "text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://pic-1" }, "用项目方式学习呢？"] } } },
    "msg-a2": { id: "msg-a2", parent: "msg-u2", children: [], message: { id: "msg-a2", author: { role: "assistant" }, create_time: 1735689605, content: { content_type: "text", parts: ["很好，从小项目入手是最好的路径。"] } } }
  }
};

/* conv-002：含 tool 角色消息与缺失 create_time 的消息 */
const conv2 = {
  id: "conv-002",
  title: "代码调试",
  create_time: 1735776000,
  mapping: {
    "root-002": { id: "root-002", message: {}, parent: null, children: ["msg-u3"] },
    "msg-u3": { id: "msg-u3", parent: "root-002", children: ["msg-t1"], message: { id: "msg-u3", author: { role: "user" }, create_time: 1735776001, content: { content_type: "text", parts: ["这段 Python 代码有什么问题？"] } } },
    "msg-t1": { id: "msg-t1", parent: "msg-u3", children: ["msg-a3"], message: { id: "msg-t1", author: { role: "tool", name: "python" }, content: { content_type: "execution_output", text: "Traceback: NameError" } } },
    "msg-a3": { id: "msg-a3", parent: "msg-t1", children: [], message: { id: "msg-a3", author: { role: "assistant" }, create_time: 1735776002, content: { content_type: "text", parts: ["错误在于变量未定义。"] } } }
  }
};

/* conv-003：空会话（只有空根节点，0 条消息） */
const conv3 = {
  id: "conv-003",
  title: "空会话",
  create_time: 1735862400,
  mapping: {
    "root-003": { id: "root-003", message: {}, parent: null, children: [] }
  }
};

/* 与 conv-001 同 ID 但内容不同的会话，用于跨批次隔离测试 */
const overlapConv = {
  id: "conv-001",
  title: "同 ID 的另一个会话",
  create_time: 1735689600,
  mapping: {
    "r": { id: "r", message: {}, parent: null, children: ["m1"] },
    "m1": { id: "m1", parent: "r", children: [], message: { id: "m1", author: { role: "user" }, create_time: 1735689601, content: { content_type: "text", parts: ["这是第二个批次里的内容。"] } } }
  }
};

function writeZip(name, files) {
  const bytes = zipSync(files, { level: 6 });
  fs.writeFileSync(path.join(outDir, name), bytes);
  console.log("生成", name, `${bytes.length} bytes`);
}

writeZip("valid.zip", { "conversations.json": strToU8(JSON.stringify([conv1, conv2, conv3])) });
writeZip("overlap.zip", { "conversations.json": strToU8(JSON.stringify([overlapConv])) });
writeZip("missing-conversations.zip", { "user.json": strToU8(JSON.stringify({ name: "test" })) });
writeZip("bad-json.zip", { "conversations.json": strToU8("这不是 JSON {{{") });
writeZip("empty-conversations.zip", { "conversations.json": strToU8(JSON.stringify([])) });
// 整个文件就是坏字节（不是 ZIP 结构）
fs.writeFileSync(path.join(outDir, "corrupted.zip"), Buffer.from(new Uint8Array(2048).map((_, i) => (i * 37 + 11) % 256)));
console.log("生成 corrupted.zip（原始坏字节，2048 bytes）");
// 0 字节文件
fs.writeFileSync(path.join(outDir, "empty.zip"), Buffer.alloc(0));
console.log("生成 empty.zip（0 字节）");
// 合法但没有条目的 ZIP
writeZip("empty-archive.zip", {});

/* Claude 官方导出（单文件 JSON 与 ZIP 两种） */
const claudeConv = {
  uuid: "claude-conv-01",
  name: "Claude 里的职业讨论",
  created_at: "2026-09-15T08:00:00.000Z",
  chat_messages: [
    { uuid: "cm-1", sender: "human", text: "我在考虑转做 AI 产品经理", created_at: "2026-09-15T08:01:00.000Z" },
    { uuid: "cm-2", sender: "assistant", text: "这个方向需要产品+技术双能力。", created_at: "2026-09-15T08:02:00.000Z" }
  ]
};
fs.writeFileSync(path.join(outDir, "claude-export.json"), JSON.stringify([claudeConv]));
console.log("生成 claude-export.json");
writeZip("claude-export.zip", { "conversations.json": strToU8(JSON.stringify([claudeConv])) });
console.log("生成 claude-export.zip");

/* Gemini Takeout（实验格式） */
const geminiTakeout = {
  "Gemini Apps": [
    {
      Title: "Gemini 学习规划",
      Time: "2026-10-10T09:00:00Z",
      Interaction: [
        { prompt: "帮我制定 Gemini 使用计划", answer: ["好的，计划如下…"], Time: "2026-10-10T09:05:00Z" }
      ]
    }
  ]
};
fs.writeFileSync(path.join(outDir, "gemini-takeout.json"), JSON.stringify(geminiTakeout));
console.log("生成 gemini-takeout.json");
// 合法 ZIP 截断一半（PK 头存在但中央目录损坏）
writeZip("empty-archive.zip", {});
{
  const full = fs.readFileSync(path.join(outDir, "valid.zip"));
  fs.writeFileSync(path.join(outDir, "truncated.zip"), full.subarray(0, Math.floor(full.length / 2)));
  console.log("生成 truncated.zip（合法 ZIP 截断一半）");
}
console.log("全部 fixtures 生成完毕 →", outDir);
