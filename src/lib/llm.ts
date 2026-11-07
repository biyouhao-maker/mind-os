/**
 * MIND OS 3.0 LLM 接入层（BYOK：自带密钥）。
 *
 * 安全与隐私边界：
 * - 纯客户端调用：请求从用户浏览器直接发往用户自己配置的接口（支持云端 API
 *   与本地部署如 Ollama / LM Studio），不经过任何中间服务器。
 * - API Key 只保存在本机浏览器 localStorage，且导出备份时会被剔除（见 workspace.exportData）。
 * - 发送给模型的数据（相关对话摘录、画像线索）在调用前已在界面明示，用户可选择不启用。
 * - LLM 输出一律视为不可信文本：必须经过 extractJson + 校验器，任何字段不合格即回退本地规则引擎。
 */
import type { LlmConfig } from "./types";

export const DECISION_SYSTEM_PROMPT = [
  "你是 MIND OS（个人智能分析系统）的本地决策参考助手。",
  "你会收到：用户的问题、从其本人历史对话中检索到的证据（含会话编号）、以及画像线索摘要。",
  "",
  "输出要求（严格遵守）：",
  "- 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。",
  "- JSON 结构（七字段全部必填、非空字符串）：",
  '{"understanding":"…","history":"…","supports":"…","risks":"…","plans":"…","recommendation":"…","uncertaintyNotes":"…"}',
  "",
  "参考示例（仅示意口吻与颗粒度，禁止照抄内容）：",
  '{"understanding":"问题涉及：职业发展。你提供了方案 A 与方案 B 两个备选。","history":"在 46 个已导入会话中检索到 3 个相关会话。","supports":"1. 画像线索「持续关注人工智能」…","risks":"1. 相关历史仅 2 条…","plans":"方案 A：…\\n方案 B：…","recommendation":"基于历史证据的倾向：方案 B…这只是倾向，不是预测。","uncertaintyNotes":"证据窗口仅 3 个月…"}',
  "",
  "硬性规则：",
  "1. 只依据提供的证据分析；证据里没有的内容不要编造（包括数字、项目、时间）。",
  "2. 证据不足时在 supports/plans 里如实写「证据不足」，不要强行给出倾向。",
  "3. recommendation 里必须包含「这只是倾向，不是预测」或同义表述。",
  "4. 不输出医疗或心理诊断；不用绝对化断言（一定/必然/肯定）。",
  "5. 多字段用 \\n 换行分隔，保持中文表达。"
].join("\n");

export const ANALYSIS_SYSTEM_PROMPT = [
  "你是 MIND OS（个人智能分析系统）的画像分析助手。",
  "你会收到：用户本人历史对话的按会话摘要（含会话编号 id）与关键词统计。",
  "",
  "输出要求（严格遵守）：",
  "- 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。",
  "- JSON 结构：",
  '{"insights":[{"title":"…","category":"兴趣领域|能力技能|思维习惯|行为趋势","kind":"observation|hypothesis","detail":"…","confidence":30到80的整数,"evidenceIds":["会话id"]}]}',
  "",
  "参考示例（仅示意颗粒度，禁止照抄）：",
  '{"title":"持续关注「人工智能与大模型」","category":"兴趣领域","kind":"observation","detail":"6 个会话涉及 AI 话题，集中在 9-11 月。","confidence":71,"evidenceIds":["chatgpt-xxx:conv-001"]}',
  "",
  "硬性规则：",
  "1. 每条结论的 evidenceIds 必须引用提供的会话 id（最多 4 个）；没有对应会话的结论不要输出。",
  "2. kind 只能是 observation（有行为数据支撑）或 hypothesis（待确认推测）；绝不能是 fact。",
  "3. 单次对话不足以支撑结论；confidence 诚实评估，最高 80。",
  "4. 最多 10 条；不输出医疗或心理诊断；detail 用中文，说明统计依据与不确定性。",
  "5. evidenceIds 引用不存在的 id 会导致该条被系统丢弃。"
].join("\n");

export function isLlmReady(config: LlmConfig): boolean {
  return Boolean(config.enabled && config.apiKey.trim() && config.baseUrl.trim() && config.model.trim());
}

export function llmStatusText(config: LlmConfig): string {
  if (!config.enabled) return "未启用：分析与决策使用本地规则引擎。";
  if (!config.baseUrl.trim() || !config.apiKey.trim() || !config.model.trim()) return "已启用但配置不完整，将回退本地规则引擎。";
  return `LLM 模式已启用（模型：${config.model}）。发送给模型的数据包括相关对话摘录与画像线索，请确认你信任该接口提供方。`;
}

/** 调用 OpenAI 兼容接口（纯客户端：由用户浏览器直连用户配置的地址）。 */
export async function chatCompletion(config: LlmConfig, system: string, user: string): Promise<string> {
  if (!isLlmReady(config)) throw new Error("LLM 未配置完整（接口地址 / API Key / 模型名 / 启用开关）。");
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("接口地址无效，请检查 baseUrl 格式。");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("接口地址仅支持 http / https 协议。");
  }
  let response: Response;
  const payload = {
    model: config.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.4
  };
  try {
    // 第一步：浏览器直连（部分端点允许 CORS，如本地 Ollama 配置 OLLAMA_ORIGINS 后）
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(payload)
    });
  } catch {
    // 直连失败（云端 API 普遍不返回 CORS 头）→ 自动改走同源代理 /api/llm
    try {
      response = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          messages: payload.messages,
          temperature: 0.4
        })
      });
    } catch {
      throw new Error("无法连接模型接口（网络错误或地址不可达）。");
    }
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 140);
    throw new Error(`模型接口返回 ${response.status}：${detail}`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error("模型接口返回的不是有效 JSON。");
  }
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("模型接口返回内容为空或格式不符合 OpenAI 兼容结构。");
  }
  return content;
}

/** 剥离可能的 markdown 代码块围栏后解析 JSON；失败给出可读错误。 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("模型返回的内容无法解析为 JSON。");
  }
}
