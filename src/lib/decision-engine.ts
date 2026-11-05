/**
 * MIND OS 3.0 智能决策参考引擎（第四阶段）。
 *
 * 流程（对照产品需求）：用户提问 → 检索相关历史 → 加载画像 → 综合分析
 *   → 七段结构化参考（问题理解/相关个人历史/支持因素/风险因素/可行方案/
 *      推荐方案及理由/不确定性）→ 展示依据（可跳转原始对话）→ 用户反馈。
 *
 * 诚实边界：
 * - 本地检索 + 规则分析，不是大模型推断；回答永远包含「不确定性」段。
 * - 证据不足时如实说明（相关会话 < 2 条时拒绝给出倾向性推荐）。
 * - 不构成任何确定预测；最终决策归用户。
 * - 健康数据不参与决策参考。
 */
import type { Conversation, Goal, Insight } from "./types";
import type { StoredChatMessage } from "./chat-archive";
import { TOPIC_RULES } from "./profile-analyzer";

export type DecisionEvidence = {
  conversationRowId: string;
  title: string;
  date: string | null;
  matched: string[];
};

export type DecisionSection = {
  title: string;
  body: string;
  evidenceRefs: string[];
};

export type DecisionAnswer = {
  question: string;
  sections: DecisionSection[];
  relatedCount: number;
  /** 相关证据是否足以给出倾向性推荐（<2 条相关会话时为 false） */
  sufficient: boolean;
};

const MIN_RELATED_FOR_RECOMMENDATION = 2;
const MAX_EVIDENCE = 4;

function extractOptions(question: string): { a?: string; b?: string } {
  const aMatch = question.match(/方案\s*A[：:]([\s\S]*?)(?=方案\s*B[：:]|$)/);
  const bMatch = question.match(/方案\s*B[：:]([\s\S]*)$/);
  return {
    a: aMatch ? aMatch[1].trim() : undefined,
    b: bMatch ? bMatch[1].trim() : undefined
  };
}

/** 中文二元分词 + 拉丁词切分，生成检索用词项（去高频虚词） */
export function extractTerms(question: string): string[] {
  const cleaned = question.replace(/[，。？！、：；""''（）()\s]/g, " ");
  const terms = new Set<string>();
  for (const word of cleaned.split(/\s+/)) {
    if (/^[a-zA-Z0-9+#.]+$/.test(word) && word.length >= 2) {
      terms.add(word.toLowerCase());
      continue;
    }
    const chinese = word.match(/[\u4e00-\u9fa5]+/g) ?? [];
    for (const chunk of chinese) {
      if (chunk.length <= 2) {
        terms.add(chunk);
        continue;
      }
      for (let i = 0; i < chunk.length - 1; i += 1) terms.add(chunk.slice(i, i + 2));
    }
  }
  const STOP = ["什么", "怎么", "如何", "应该", "还是", "适合", "可以", "这个", "那个", "自己", "我的", "一个", "是否", "继续", "现在", "以及", "或者"];
  return [...terms].filter(term => !STOP.includes(term)).slice(0, 24);
}

function scoreConversation(text: string, terms: string[]): string[] {
  return terms.filter(term => text.toLowerCase().includes(term.toLowerCase()));
}

export function answerDecision(
  question: string,
  ctx: {
    conversations: Conversation[];
    messages: StoredChatMessage[];
    insights: Insight[];
    goals: Goal[];
  }
): DecisionAnswer {
  const trimmed = question.trim();
  if (!trimmed) throw new Error("请先输入你的问题。");
  if (!ctx.conversations.length) throw new Error("还没有已导入的对话，决策参考需要历史数据支撑。请先导入 ChatGPT ZIP。");

  const terms = extractTerms(trimmed);
  const options = extractOptions(trimmed);

  // 检索：按会话打分（用户消息命中的词项数）
  const scored: Array<{ row: Conversation; matched: string[]; snippet: string }> = [];
  for (const row of ctx.conversations) {
    const userTexts = (ctx.messages ?? [])
      .filter(message => `${message.importId}:${message.conversationId}` === row.id && message.role === "user")
      .map(message => message.text);
    if (!userTexts.length) continue;
    const blob = userTexts.join("\n");
    const matched = scoreConversation(blob, terms);
    if (!matched.length) continue;
    const firstMatch = userTexts.find(text => scoreConversation(text, terms).length) ?? userTexts[0];
    scored.push({
      row,
      matched,
      snippet: firstMatch.slice(0, 80)
    });
  }
  scored.sort((a, b) => b.matched.length - a.matched.length);
  const related = scored.slice(0, MAX_EVIDENCE);
  const sufficient = related.length >= MIN_RELATED_FOR_RECOMMENDATION;

  const topicsInQuestion = TOPIC_RULES.filter(rule => rule.patterns.some(pattern => pattern.test(trimmed))).map(rule => rule.name);

  /* ---------- 1. 问题理解 ---------- */
  const understandingParts: string[] = [];
  understandingParts.push(topicsInQuestion.length ? `问题涉及：${topicsInQuestion.join("、")}。` : "未识别到明确的既有话题分类。");
  if (options.a || options.b) understandingParts.push(`你提供了 ${[options.a && "方案 A", options.b && "方案 B"].filter(Boolean).join(" 与 ")} 两个备选。`);
  understandingParts.push(`问题原文：「${trimmed.slice(0, 80)}${trimmed.length > 80 ? "…" : ""}」。`);

  /* ---------- 2. 相关个人历史 ---------- */
  const evidence: DecisionEvidence[] = related.map(item => ({
    conversationRowId: item.row.id,
    title: item.row.title,
    date: item.row.createdAt ?? null,
    matched: item.matched.slice(0, 4)
  }));
  const historyBody = related.length
    ? `在 ${ctx.conversations.length} 个已导入会话中，检索到 ${related.length} 个相关会话（按命中关键词强度排序）：${related.map(item => `《${item.row.title}》`).join("、")}。可点击下方证据查看原始对话。`
    : `在 ${ctx.conversations.length} 个已导入会话中没有检索到与问题直接相关的记录。`;

  /* ---------- 3. 支持因素 ---------- */
  const supportFactors: string[] = [];
  for (const insight of ctx.insights) {
    const blob = `${insight.title} ${insight.detail}`;
    const matched = scoreConversation(blob, terms);
    if (matched.length || topicsInQuestion.some(topic => insight.title.includes(topic))) {
      supportFactors.push(`画像线索「${insight.title}」（${KIND_CN(insight.kind)}，置信度 ${insight.confidence}%）`);
    }
  }
  const relevantGoals = ctx.goals.filter(goal => {
    const blob = `${goal.title} ${goal.notes}`;
    return scoreConversation(blob, terms).length > 0 || topicsInQuestion.some(topic => goal.title.includes(topic.slice(0, 2)));
  });
  for (const goal of relevantGoals.slice(0, 2)) {
    supportFactors.push(`进行中的目标「${goal.title}」（进度 ${goal.progress}%）与问题方向相关`);
  }
  const supportBody = supportFactors.length
    ? supportFactors.map((factor, index) => `${index + 1}. ${factor}`).join("\n")
    : "未找到与问题直接相关的画像线索或目标。";

  /* ---------- 4. 风险因素 ---------- */
  const riskFactors: string[] = [];
  if (!sufficient) {
    riskFactors.push(`相关历史仅 ${related.length} 条，证据不足——任何倾向性结论都不可靠。`);
  }
  riskFactors.push("本参考由本地规则分析生成（非大模型推断），只能覆盖关键词能捕捉到的信息。");
  if (related.length) {
    riskFactors.push(`相关对话集中在 ${related.map(item => item.row.createdAt?.slice(0, 7) ?? "未知").filter((v, i, arr) => arr.indexOf(v) === i).join("、")}——时间窗口有限，不代表长期情况。`);
  }
  const conflicting = ctx.insights.filter(insight => insight.kind === "hypothesis").length;
  if (conflicting) {
    riskFactors.push(`画像中有 ${conflicting} 条「待确认推测」尚未经你确认，可能影响判断准确性。`);
  }
  const riskBody = riskFactors.map((factor, index) => `${index + 1}. ${factor}`).join("\n");

  /* ---------- 5. 可行方案 ---------- */
  let planBody: string;
  if (options.a || options.b) {
    planBody = [`方案 A：${options.a ?? "（未填写）"}`, `方案 B：${options.b ?? "（未填写）"}`, "提示：如还有其他备选，可在决策记录中补充。"].join("\n");
  } else {
    planBody = [
      "你没有提供具体备选方案。基于检索到的历史，可以从以下角度自行拟定：",
      related.length
        ? related.slice(0, 3).map(item => `· 围绕「${item.row.title}」的延续动作`).join("\n")
        : "· 先补充与问题相关的历史对话，再来生成参考",
      "拟好方案 A / B 后重新提问（例如「方案 A：… 方案 B：…」），我可以基于证据做对比。"
    ].join("\n");
  }

  /* ---------- 6. 推荐方案及理由 ---------- */
  let recommendBody: string;
  if (!sufficient) {
    recommendBody = "相关证据不足，规则引擎不做倾向性推荐。建议：补充相关历史数据，或先记录清楚每个方案的收益与风险。";
  } else if (options.a || options.b) {
    const profileBlob = ctx.insights.map(insight => insight.title).join("\n") + " " + ctx.insights.map(insight => insight.detail).join("\n");
    const aScore = options.a ? scoreConversation(options.a, terms).length + (topicsInQuestion.some(topic => (options.a ?? "").includes(topic.slice(0, 2))) ? 1 : 0) : 0;
    const bScore = options.b ? scoreConversation(options.b, terms).length + (topicsInQuestion.some(topic => (options.b ?? "").includes(topic.slice(0, 2))) ? 1 : 0) : 0;
    const aInProfile = options.a ? scoreConversation(profileBlob, extractTerms(options.a)).length : 0;
    const bInProfile = options.b ? scoreConversation(profileBlob, extractTerms(options.b)).length : 0;
    if (aScore === bScore && aInProfile === bInProfile) {
      recommendBody = "两个方案与你的历史证据匹配度接近，规则引擎不给出倾向——这通常意味着决策的关键因素不在历史数据里，建议结合现实约束判断。";
    } else {
      const lean = aInProfile > bInProfile ? "A" : bInProfile > aInProfile ? "B" : aScore > bScore ? "A" : "B";
      const leanText = lean === "A" ? options.a : options.b;
      recommendBody = `基于历史证据的倾向：方案 ${lean}（${(leanText ?? "").slice(0, 60)}）。理由：该方向与你的画像线索及历史对话重合度更高（画像匹配 ${Math.max(aInProfile, bInProfile)} 处）。这只是基于已有数据的倾向，不是预测。`;
    }
  } else {
    recommendBody = "没有具体备选方案时不做推荐。请拟好方案 A / B 后重新提问。";
  }

  /* ---------- 7. 不确定性 ---------- */
  const uncertaintyBody = [
    `本参考基于本机 ${ctx.conversations.length} 个会话的规则检索与分析，相关证据 ${related.length} 条。`,
    "规则分析无法理解语义深层含义，可能遗漏重要信息。",
    "本回答是决策参考，不是确定预测；最终决策及后果由你本人承担。"
  ].join("\n");

  const sections: DecisionSection[] = [
    { title: "1. 问题理解", body: understandingParts.join(" "), evidenceRefs: [] },
    { title: "2. 相关个人历史", body: historyBody, evidenceRefs: evidence.map(item => item.conversationRowId) },
    { title: "3. 支持因素", body: supportBody, evidenceRefs: [] },
    { title: "4. 风险因素", body: riskBody, evidenceRefs: [] },
    { title: "5. 可行方案", body: planBody, evidenceRefs: [] },
    { title: "6. 推荐方案及理由", body: recommendBody, evidenceRefs: sufficient && evidence.length ? [evidence[0].conversationRowId] : [] },
    { title: "7. 不确定性", body: uncertaintyBody, evidenceRefs: [] }
  ];

  return {
    question: trimmed,
    sections,
    relatedCount: related.length,
    sufficient
  };
}

function KIND_CN(kind: string): string {
  return kind === "fact" ? "事实" : kind === "observation" ? "行为观察" : "待确认推测";
}
