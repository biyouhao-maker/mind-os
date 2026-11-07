import { NextResponse } from "next/server";

/**
 * LLM 同源代理：浏览器端 BYOK 调用云端 LLM API 时的转发层。
 *
 * 存在原因：多数 LLM API（OpenAI / 智谱 / Moonshot 等）不返回 CORS 头，
 * 浏览器无法直连；本路由以同源请求转发到用户自己配置的接口。
 *
 * 安全约束：
 * - 仅允许 http/https 协议。
 * - 默认拒绝环回 / 私有 / 保留地址（SSRF 防护）；
 *   部署者如需支持本地模型（Ollama 等），显式设置环境变量
 *   LLM_ALLOW_PRIVATE_ENDPOINTS=1 后才放行。
 * - API Key 由调用方传入、仅在本次转发中使用，服务端不存储、不写日志。
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "metadata.google.internal" || host === "metadata.goog") return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  // IPv6 私网 / 链路本地 / 环回（按前缀简化判断）
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host === "::1" || host === "::") {
    return true;
  }
  return false;
}

export async function POST(request: Request) {
  let body: {
    baseUrl?: unknown;
    apiKey?: unknown;
    model?: unknown;
    messages?: unknown;
    temperature?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是有效 JSON" }, { status: 400 });
  }

  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const model = typeof body.model === "string" ? body.model : "";
  const temperature = typeof body.temperature === "number" ? body.temperature : 0.4;

  if (!baseUrl || !apiKey || !model || !Array.isArray(body.messages)) {
    return NextResponse.json({ error: "缺少必要字段（baseUrl / apiKey / model / messages）" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(`${baseUrl}/chat/completions`);
  } catch {
    return NextResponse.json({ error: "baseUrl 无效" }, { status: 400 });
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return NextResponse.json({ error: "仅支持 http / https 协议" }, { status: 400 });
  }

  const allowPrivate = process.env.LLM_ALLOW_PRIVATE_ENDPOINTS === "1";
  if (!allowPrivate && isBlockedHost(target.hostname)) {
    return NextResponse.json(
      { error: "端点地址被安全策略拒绝（环回 / 私有 / 保留地址）。如需连接本地模型，请在部署环境设置 LLM_ALLOW_PRIVATE_ENDPOINTS=1" },
      { status: 403 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: body.messages, temperature, stream: false })
    });
  } catch {
    return NextResponse.json({ error: "代理无法连接上游接口" }, { status: 502 });
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
