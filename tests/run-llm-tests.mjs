/**
 * llm.ts 单元测试（JSON 解析与校验逻辑，不发真实网络请求）。
 * 运行：npm run test:llm
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, "..", ".test-build");
const llmMod = await import(pathToFileURL(path.join(buildDir, "llm.js")).href);
const lib = llmMod.default ?? llmMod;
const { extractJson, isLlmReady, llmStatusText } = lib;

const CONFIG_OK = { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "test-model", enabled: true };
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

console.log("== extractJson ==");

await test("裸 JSON 直接解析", () => {
  const parsed = extractJson('{"a":1}');
  assert.deepEqual(parsed, { a: 1 });
});

await test("markdown 代码块围栏被剥离", () => {
  const parsed = extractJson('好的，以下是结果：\n```json\n{"a": [1,2]}\n```\n以上。');
  assert.deepEqual(parsed, { a: [1, 2] });
});

await test("无围栏但有前后说明文字 → 报错（不猜测）", () => {
  assert.throws(() => extractJson("结果如下：{\"a\":1} 请查收"), /无法解析为 JSON/);
});

await test("完全不是 JSON → 报错", () => {
  assert.throws(() => extractJson("我很抱歉，我不能……"), /无法解析为 JSON/);
});

console.log("== isLlmReady / llmStatusText ==");

await test("四项配置齐全且启用 → ready", () => {
  assert.equal(isLlmReady(CONFIG_OK), true);
});

await test("缺任一项或未启用 → 不 ready", () => {
  assert.equal(isLlmReady({ ...CONFIG_OK, enabled: false }), false);
  assert.equal(isLlmReady({ ...CONFIG_OK, apiKey: "" }), false);
  assert.equal(isLlmReady({ ...CONFIG_OK, baseUrl: "" }), false);
  assert.equal(isLlmReady({ ...CONFIG_OK, model: "" }), false);
});

await test("状态文案如实反映配置", () => {
  assert.match(llmStatusText({ ...CONFIG_OK, enabled: false }), /未启用/);
  assert.match(llmStatusText({ ...CONFIG_OK, apiKey: "" }), /配置不完整/);
  assert.match(llmStatusText(CONFIG_OK), /LLM 模式已启用/);
});

console.log("== chatCompletion 客户端 ==");

await test("未配置完整 → 拒绝调用", async () => {
  await assert.rejects(
    () => lib.chatCompletion({ ...CONFIG_OK, enabled: false }, "sys", "user"),
    /LLM 未配置完整/
  );
});

await test("非法协议 → 拒绝调用", async () => {
  await assert.rejects(
    () => lib.chatCompletion({ ...CONFIG_OK, baseUrl: "ftp://example.com/v1" }, "sys", "user"),
    /仅支持 http \/ https/
  );
});

await test("地址格式错误 → 报错", async () => {
  await assert.rejects(
    () => lib.chatCompletion({ ...CONFIG_OK, baseUrl: ":::" }, "sys", "user"),
    /接口地址无效/
  );
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  process.exitCode = 1;
  for (const f of failures) console.error("失败：", f.name);
}
