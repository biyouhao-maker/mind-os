import { NextResponse } from "next/server";
import { lookup } from "dns/promises";

/**
 * LLM 同源代理：浏览器端 BYOK 调用云端 LLM API 时的转发层。
 *
 * 存在原因：多数 LLM API（OpenAI / 智谱 / Moonshot 等）不返回 CORS 头，
 * 浏览器无法直连；本路由以同源请求转发到用户自己配置的接口。
 *
 * 安全约束（v2 加固）：
 * - 仅允许 http/https 协议。
 * - 请求体大小限制（5MB）与基于客户端 IP 的简单限流。
 * - SSRF 防护（默认拒绝环回 / 私有 / 保留地址）：
 *   1. 主机名与 IP 字面量双重校验；
 *   2. 域名经 DNS 解析后，对所有解析出的 IP 再做私网校验（防 DNS 重绑定到内网）；
 *   3. 上游请求禁止跟随重定向（redirect: "error"，防止 302 跳转到内网）。
 *   部署者如需支持本地模型（Ollama 等），显式设置环境变量
 *   LLM_ALLOW_PRIVATE_ENDPOINTS=1 后才放行。
 * - IPv6 校验基于完整展开的 8 组十六段比较，而非简单前缀。
 * - API Key 由调用方传入、仅在本次转发中使用，服务端不存储、不写日志。
 * - 已知残余风险（如实说明）：DNS 校验与实际连接之间存在 TOCTOU 窗口；
 *   内存限流仅对单实例部署有效；本端点无用户认证，公网部署时建议
 *   另加鉴权网关或访问控制。
 */

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "local";
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = (rateBuckets.get(key) ?? []).filter(t => t > windowStart);
  if (hits.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(key, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 1000) {
    for (const [bucketKey, times] of rateBuckets) {
      if (times.every(t => t <= windowStart)) rateBuckets.delete(bucketKey);
    }
  }
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return true;
  const octets = match.slice(1).map(Number);
  if (octets.some(octet => octet > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && (b === 0 || b === 88)) return true;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

/** 展开 IPv6 为 8 组数值段（处理 :: 压缩与 IPv4 映射尾段），非法返回 null */
function expandIPv6(host: string): number[] | null {
  const cleaned = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!/^[0-9a-f:]+$/.test(cleaned)) return null;
  const parts = cleaned.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const tail = parts.length === 2 ? parts[1].split(":").filter(Boolean) : [];
  if (parts.length === 1 && head.length !== 8) return null;
  if (parts.length === 2 && head.length + tail.length > 7) return null;
  const fill = new Array(8 - head.length - tail.length).fill("0");
  const groups = [...head, ...fill, ...tail].map(group => parseInt(group || "0", 16));
  if (groups.some(group => Number.isNaN(group))) return null;
  return groups;
}

function isPrivateIPv6(groups: string[] | number[]): boolean {
  const g = groups.map(Number);
  if (g.some(group => Number.isNaN(group))) return true;
  // 环回 ::1、未指定 ::
  if (g.every(group => group === 0)) return true;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true;
  // IPv4 映射 ::ffff:0:0/96 —— 取出末 32 位按 IPv4 校验
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const v4 = `${Math.floor(g[6] / 256)}.${g[6] % 256}.${Math.floor(g[7] / 256)}.${g[7] % 256}`;
    return isPrivateIPv4(v4);
  }
  // 唯一本地 fc00::/7、链路本地 fe80::/10、组播 ff00::/8
  if (g[0] >= 0xfc00 && g[0] <= 0xfdff) return true;
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return true;
  if (g[0] >= 0xff00) return true;
  // 文档示例 2001:db8::/32
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  return false;
}

function isBlockedIpAddress(address: string): boolean {
  if (address.includes(":")) {
    const groups = expandIPv6(address);
    return groups ? isPrivateIPv6(groups) : true;
  }
  return isPrivateIPv4(address);
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "metadata.google.internal" || host === "metadata.goog") return true;
  if (isBlockedIpAddress(host)) return true;
  return false;
}

export async function POST(request: Request) {
  const rateKey = clientKey(request);
  if (isRateLimited(rateKey)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试（限流：30 次 / 分钟）。" }, { status: 429 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "请求体超过大小限制（5MB）。" }, { status: 413 });
  }

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
  // 主机名/IP 字面量直接校验
  if (!allowPrivate && isBlockedHostname(target.hostname)) {
    return NextResponse.json(
      { error: "端点地址被安全策略拒绝（环回 / 私有 / 保留地址）。如需连接本地模型，请在部署环境设置 LLM_ALLOW_PRIVATE_ENDPOINTS=1" },
      { status: 403 }
    );
  }
  // DNS 解析校验：域名最终指向的所有 IP 都必须通过私网检查（防解析到内网）
  if (!allowPrivate && !isBlockedIpAddress(target.hostname)) {
    try {
      const addresses = await lookup(target.hostname, { all: true });
      if (addresses.some(address => isBlockedIpAddress(address.address))) {
        return NextResponse.json(
          { error: "该域名解析到了被禁止的地址（环回 / 私有 / 保留 IP），请求已拒绝。" },
          { status: 403 }
        );
      }
    } catch {
      return NextResponse.json({ error: "无法解析接口域名，请检查 baseUrl。" }, { status: 400 });
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: body.messages, temperature, stream: false }),
      // 阻止跟随重定向：302 跳转可能绕过前面的地址校验
      redirect: "error"
    });
  } catch {
    return NextResponse.json({ error: "代理无法连接上游接口（或上游返回重定向，已阻止）。" }, { status: 502 });
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
