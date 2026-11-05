/**
 * MIND OS 3.0 画像分析引擎（第二阶段）。
 *
 * 定位与边界（务必保持诚实）：
 * - 本地规则分析：关键词匹配 + 统计规则，完全可解释、可在本机复现；不是大模型推断。
 * - 只读输入：仅消费已导入的会话索引与消息，绝不修改原始数据。
 * - 产出全部为「行为观察 / 待确认推测」，永远不会自动标记为「事实」；
 *   只有用户在画像页确认（采纳并修改类型）后才升级。
 * - 最低证据门槛：同一话题至少命中 2 个会话才生成结论，不凭一次对话下结论。
 * - 健康数据不参与画像分析（本引擎只读聊天消息）。
 */
import type { Conversation } from "./types";
import type { StoredChatMessage } from "./chat-archive";

export type EvidenceItem = {
  /** 会话索引行 id（`${importId}:${conversationId}`），用于跳转查看原始对话 */
  conversationRowId: string;
  title: string;
  date: string | null;
  matched: string[];
};

export type CandidateCategory = "兴趣领域" | "能力技能" | "思维习惯" | "行为趋势";

export type CandidateInsight = {
  title: string;
  category: CandidateCategory;
  kind: "observation" | "hypothesis";
  detail: string;
  evidenceText: string;
  evidenceRefs: string[];
  /** 结构化证据：可直接跳转到对应会话查看原始消息 */
  evidence: EvidenceItem[];
  confidence: number;
  timeRange: string;
};

/** 最低证据门槛：命中会话数不足该值的话题不生成候选结论 */
const MIN_CONVERSATIONS_FOR_TOPIC = 2;
/** 思维习惯类需要的最小用户消息样本量 */
const MIN_USER_MESSAGES_FOR_HABIT = 10;
/** 置信度区间（诚实上限：规则分析不给自己开高分） */
const CONFIDENCE_MIN = 35;
const CONFIDENCE_MAX = 80;

export const TOPIC_RULES: { name: string; patterns: RegExp[] }[] = [
  { name: "人工智能与大模型", patterns: [/\bAI\b|人工智能|大模型|LLM|GPT|ChatGPT|Claude|Gemini|DeepSeek|提示词|prompt|智能体|agent|token|微调/i] },
  { name: "编程开发", patterns: [/代码|编程|开发|python|javascript|typescript|react|next\.?js|api|前端|后端|报错|部署|\bgit\b|github|调试|函数|脚本/i] },
  { name: "职业发展", patterns: [/职业|职场|简历|面试|求职|跳槽|岗位|实习|升职|加薪|转行|offer/i] },
  { name: "创业与商业", patterns: [/创业|商业|变现|盈利|商业模式|获客|市场|融资|定价|副业|收入|成本/i] },
  { name: "学习方法", patterns: [/学习|教程|入门|课程|复习|考试|英语|四级|备考|掌握|基础|效率|笔记/i] },
  { name: "产品与设计", patterns: [/产品|原型|ui|ux|用户体验|需求文档|prd|交互|figma|设计/i] },
  { name: "写作与内容", patterns: [/写作|文案|文章|公众号|博客|内容创作|标题|排版|短视频/i] },
  { name: "健康与生活", patterns: [/健康|饮食|运动|睡眠|减肥|体重|营养|健身|作息/i] }
];

export const SKILL_RULES: { name: string; pattern: RegExp }[] = [
  { name: "Python", pattern: /\bpython\b|python3|\bpip\b|\.py\b/i },
  { name: "JavaScript / TypeScript", pattern: /javascript|typescript|\bjs\b|\bts\b|\bnode\b/i },
  { name: "React / Next.js", pattern: /react|next\.?js|\bjsx\b|\btsx\b/i },
  { name: "SQL / 数据库", pattern: /\bsql\b|数据库|mysql|postgres|sqlite| mongo/i },
  { name: "提示词工程", pattern: /提示词|prompt|few-?shot|角色设定|系统指令/i },
  { name: "Git / 版本控制", pattern: /\bgit\b|github|版本控制|合并冲突/i },
  { name: "AI API 集成", pattern: /openai|api\s*key|chat.?completion|embedding|接口调用|sdk/i },
  { name: "产品原型设计", pattern: /原型|figma|墨刀|线框图/i }
];

const HABIT_STRUCTURED = /步骤|首先|其次|再次|最后|第一[步，、]|第二[步，、]|[123][.、、)]|清单|列表|框架|拆解/;
const HABIT_DECISION = /应该|选择|哪个|值得|还是|建议|怎么办|怎么选|如何取舍|犹豫|纠结/;

function hitsInText(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function monthOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const month = iso.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(month) ? month : null;
}

function clampConfidence(value: number): number {
  return Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, Math.round(value)));
}

export type AnalyzedConversation = {
  row: Conversation;
  /** 命中的话题分类 */
  topics: string[];
  /** 用户消息命中的技能 */
  skills: string[];
  userMessageCount: number;
  messageCount: number;
  month: string | null;
};

export type AnalysisResult = {
  candidates: CandidateInsight[];
  stats: {
    conversationsAnalyzed: number;
    messagesAnalyzed: number;
    userMessagesAnalyzed: number;
    windowStart: string | null;
    windowEnd: string | null;
    generatedAt: string;
  };
};

/**
 * 主入口：对已导入的会话与消息运行规则分析，产出候选画像线索。
 * 输入的两个数组无需同序；通过 (importId, conversationId) 关联。
 */
export function analyzeChatHistory(conversations: Conversation[], messages: StoredChatMessage[]): AnalysisResult {
  if (!conversations.length) {
    throw new Error("还没有已导入的会话索引，请先在 AI 数据中心导入 ChatGPT ZIP。");
  }
  if (!messages.length) {
    throw new Error("没有在本机 IndexedDB 找到已导入的消息正文，请重新导入原始 ZIP 后再运行分析。");
  }

  // 按 (importId, conversationId) 建立消息索引，与会话索引行精确关联
  const messagesByRow = new Map<string, StoredChatMessage[]>();
  for (const message of messages) {
    const rowId = `${message.importId}:${message.conversationId}`;
    const bucket = messagesByRow.get(rowId);
    if (bucket) bucket.push(message);
    else messagesByRow.set(rowId, [message]);
  }

  const analyzed: AnalyzedConversation[] = [];
  let messagesAnalyzed = 0;
  let userMessagesAnalyzed = 0;
  let windowStart: string | null = null;
  let windowEnd: string | null = null;

  for (const row of conversations) {
    const bucket = messagesByRow.get(row.id) ?? [];
    if (!bucket.length) continue; // 备份恢复等场景下可能存在无正文的索引行，跳过且不报错
    const userTexts = bucket
      .filter(message => message.role === "user")
      .map(message => message.text)
      .filter(text => text.trim().length > 0);
    const userBlob = userTexts.join("\n");
    messagesAnalyzed += bucket.length;
    userMessagesAnalyzed += userTexts.length;
    const topics = TOPIC_RULES.filter(rule => hitsInText(userBlob, rule.patterns)).map(rule => rule.name);
    const skills = SKILL_RULES.filter(rule => hitsInText(userBlob, [rule.pattern])).map(rule => rule.name);
    const month = monthOf(row.createdAt);
    if (month) {
      if (!windowStart || month < windowStart) windowStart = month;
      if (!windowEnd || month > windowEnd) windowEnd = month;
    }
    analyzed.push({
      row,
      topics,
      skills,
      userMessageCount: userTexts.length,
      messageCount: bucket.length,
      month
    });
  }

  if (!analyzed.length) {
    throw new Error("会话索引存在，但没有可分析的消息正文。请确认已导入原始 ZIP。");
  }

  const candidates: CandidateInsight[] = [];
  const windowText = `${windowStart ?? "未知"} ~ ${windowEnd ?? "未知"}`;
  const rowById = new Map<string, Conversation>();
  for (const item of analyzed) rowById.set(item.row.id, item.row);

  /* ---------- 兴趣与关注领域 ---------- */
  const topicHits = new Map<string, { rows: Conversation[]; matchedKeywords: Set<string> }>();
  for (const item of analyzed) {
    for (const topic of item.topics) {
      const entry = topicHits.get(topic) ?? { rows: [], matchedKeywords: new Set<string>() };
      entry.rows.push(item.row);
      topicHits.set(topic, entry);
    }
  }
  // 收集每个话题的实际命中关键词（用于证据展示）
  for (const item of analyzed) {
    const userBlob = (messagesByRow.get(item.row.id) ?? [])
      .filter(message => message.role === "user")
      .map(message => message.text)
      .join("\n");
    for (const topic of item.topics) {
      const entry = topicHits.get(topic);
      if (!entry) continue;
      const rule = TOPIC_RULES.find(r => r.name === topic);
      if (rule) {
        for (const pattern of rule.patterns) {
          const found = userBlob.match(pattern);
          if (found) entry.matchedKeywords.add(found[0].slice(0, 24));
        }
      }
    }
  }

  const interestCandidates = [...topicHits.entries()]
    .filter(([, entry]) => entry.rows.length >= MIN_CONVERSATIONS_FOR_TOPIC)
    .sort((a, b) => b[1].rows.length - a[1].rows.length)
    .slice(0, 5);

  for (const [topic, entry] of interestCandidates) {
    const evidence: EvidenceItem[] = entry.rows
      .slice(0, 4)
      .map(row => ({ conversationRowId: row.id, title: row.title, date: row.createdAt ?? null, matched: [...entry.matchedKeywords].slice(0, 3) }));
    candidates.push({
      title: `持续关注「${topic}」`,
      category: "兴趣领域",
      kind: "observation",
      detail: `在 ${windowText} 的已导入对话中，有 ${entry.rows.length} 个会话涉及「${topic}」话题（命中关键词：${[...entry.matchedKeywords].slice(0, 5).join("、") || "匹配规则"}）。这反映当前阶段的关注方向，不构成能力或性格判断。`,
      evidenceText: evidence.map(item => `《${item.title}》(${item.date ? item.date.slice(0, 10) : "时间未知"})`).join("、"),
      evidenceRefs: evidence.map(item => item.conversationRowId),
      evidence,
      confidence: clampConfidence(35 + entry.rows.length * 6),
      timeRange: windowText
    });
  }

  /* ---------- 能力与技能 ---------- */
  const skillHits = new Map<string, { mentions: number; rows: Set<string>; sampleTitles: string[] }>();
  for (const item of analyzed) {
    const userBlob = (messagesByRow.get(item.row.id) ?? [])
      .filter(message => message.role === "user")
      .map(message => message.text)
      .join("\n");
    if (!userBlob) continue;
    for (const rule of SKILL_RULES) {
      const matches = userBlob.match(new RegExp(rule.pattern.source, "gi"));
      if (matches && matches.length) {
        const entry = skillHits.get(rule.name) ?? { mentions: 0, rows: new Set<string>(), sampleTitles: [] };
        entry.mentions += matches.length;
        entry.rows.add(item.row.id);
        if (entry.sampleTitles.length < 3 && item.row.title) entry.sampleTitles.push(item.row.title);
        skillHits.set(rule.name, entry);
      }
    }
  }

  const skillCandidates = [...skillHits.entries()]
    .filter(([, entry]) => entry.mentions >= 2)
    .sort((a, b) => b[1].mentions - a[1].mentions)
    .slice(0, 5);

  for (const [skill, entry] of skillCandidates) {
    const evidence: EvidenceItem[] = [...entry.rows].slice(0, 4).map(rowId => {
      const row = rowById.get(rowId);
      return { conversationRowId: rowId, title: row?.title ?? rowId, date: row?.createdAt ?? null, matched: [skill] };
    });
    candidates.push({
      title: `接触 / 使用「${skill}」`,
      category: "能力技能",
      kind: "hypothesis",
      detail: `用户消息中 ${entry.mentions} 次提及「${skill}」相关内容，分布在 ${entry.rows.size} 个会话中。这只说明接触过该技能领域，不代表熟练程度；熟练度需要结合项目成果进一步确认。`,
      evidenceText: entry.sampleTitles.map(title => `《${title}》`).join("、"),
      evidenceRefs: [...entry.rows].slice(0, 4),
      evidence,
      confidence: clampConfidence(35 + Math.min(entry.mentions, 6) * 5),
      timeRange: windowText
    });
  }

  /* ---------- 思维与决策习惯 ---------- */
  if (userMessagesAnalyzed >= MIN_USER_MESSAGES_FOR_HABIT) {
    let structuredCount = 0;
    let decisionCount = 0;
    let totalChars = 0;
    let charCount = 0;
    for (const item of analyzed) {
      for (const message of messagesByRow.get(item.row.id) ?? []) {
        if (message.role !== "user" || !message.text.trim()) continue;
        totalChars += message.text.length;
        charCount += 1;
        if (HABIT_STRUCTURED.test(message.text)) structuredCount += 1;
        if (HABIT_DECISION.test(message.text)) decisionCount += 1;
      }
    }
    const structuredRatio = structuredCount / Math.max(userMessagesAnalyzed, 1);
    const decisionRatio = decisionCount / Math.max(userMessagesAnalyzed, 1);
    const avgChars = Math.round(totalChars / Math.max(charCount, 1));
    const habitEvidence: EvidenceItem[] = analyzed
      .filter(item => item.userMessageCount > 0)
      .slice(0, 4)
      .map(item => ({ conversationRowId: item.row.id, title: item.row.title, date: item.row.createdAt ?? null, matched: [] }));

    if (structuredRatio >= 0.25) {
      candidates.push({
        title: "习惯结构化表达问题",
        category: "思维习惯",
        kind: "hypothesis",
        detail: `约 ${Math.round(structuredRatio * 100)}% 的用户消息包含分步、清单或结构化表述（样本 ${structuredCount}/${userMessagesAnalyzed} 条）。这是行为观察，不等于性格标签。`,
        evidenceText: `样本窗口 ${windowText}，共分析 ${userMessagesAnalyzed} 条用户消息`,
        evidenceRefs: habitEvidence.map(item => item.conversationRowId),
        evidence: habitEvidence,
        confidence: clampConfidence(40 + structuredRatio * 40),
        timeRange: windowText
      });
    }

    if (decisionRatio >= 0.2) {
      candidates.push({
        title: "决策前倾向征求多方意见",
        category: "思维习惯",
        kind: "hypothesis",
        detail: `约 ${Math.round(decisionRatio * 100)}% 的用户消息包含征求建议或比较选项的表述（样本 ${decisionCount}/${userMessagesAnalyzed} 条）。提示决策风格偏谨慎，但需要更多数据验证。`,
        evidenceText: `样本窗口 ${windowText}，共分析 ${userMessagesAnalyzed} 条用户消息`,
        evidenceRefs: habitEvidence.map(item => item.conversationRowId),
        evidence: habitEvidence,
        confidence: clampConfidence(38 + decisionRatio * 40),
        timeRange: windowText
      });
    }

    if (charCount >= MIN_USER_MESSAGES_FOR_HABIT && avgChars >= 80) {
      candidates.push({
        title: "问题描述偏详细",
        category: "思维习惯",
        kind: "observation",
        detail: `用户消息平均长度约 ${avgChars} 字（样本 ${charCount} 条）。较长的问题描述通常意味着提供了更多上下文。`,
        evidenceText: `样本窗口 ${windowText}`,
        evidenceRefs: habitEvidence.map(item => item.conversationRowId),
        evidence: habitEvidence,
        confidence: clampConfidence(40 + avgChars / 10),
        timeRange: windowText
      });
    }
  }

  /* ---------- 行为与目标变化（月度趋势） ---------- */
  const monthTrend = new Map<string, Map<string, number>>();
  for (const item of analyzed) {
    if (!item.month) continue;
    const byMonth = monthTrend.get(item.month) ?? new Map<string, number>();
    for (const topic of item.topics) byMonth.set(topic, (byMonth.get(topic) ?? 0) + 1);
    monthTrend.set(item.month, byMonth);
  }
  const months = [...monthTrend.keys()].sort();
  if (months.length >= 2) {
    const totals = new Map<string, number>();
    for (const byMonth of monthTrend.values()) {
      for (const [topic, count] of byMonth) totals.set(topic, (totals.get(topic) ?? 0) + count);
    }
    const trendCandidates = [...totals.entries()]
      .filter(([, total]) => total >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    for (const [topic, total] of trendCandidates) {
      const series = months.map(month => ({ month, count: monthTrend.get(month)?.get(topic) ?? 0 }));
      const first = series[0];
      const last = series[series.length - 1];
      if (first.count === last.count) continue;
      const direction = last.count > first.count ? "上升" : "回落";
      const detailSeries = series.map(point => `${point.month}:${point.count}`).join(" → ");
      const evidence: EvidenceItem[] = analyzed
        .filter(item => item.topics.includes(topic))
        .slice(0, 4)
        .map(item => ({ conversationRowId: item.row.id, title: item.row.title, date: item.row.createdAt ?? null, matched: [] }));
      candidates.push({
        title: `「${topic}」类对话呈${direction}趋势`,
        category: "行为趋势",
        kind: "observation",
        detail: `按月统计的会话数量变化：${detailSeries}（合计 ${total} 个会话）。窗口仅 ${months.length} 个月，短期波动可能主导趋势，请谨慎解读。`,
        evidenceText: `${direction}轨迹 ${detailSeries}`,
        evidenceRefs: evidence.map(item => item.conversationRowId),
        evidence,
        confidence: clampConfidence(35 + total * 3),
        timeRange: windowText
      });
    }
  }

  const categoryOrder: CandidateCategory[] = ["兴趣领域", "能力技能", "思维习惯", "行为趋势"];
  candidates.sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) || b.confidence - a.confidence);

  return {
    candidates: candidates.slice(0, 14),
    stats: {
      conversationsAnalyzed: analyzed.length,
      messagesAnalyzed,
      userMessagesAnalyzed,
      windowStart,
      windowEnd,
      generatedAt: new Date().toISOString()
    }
  };
}
