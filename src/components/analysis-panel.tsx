"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Conversation, Insight, LlmConfig } from "@/lib/types";
import { listAllMessages } from "@/lib/chat-archive";
import { analyzeChatHistory, analyzeChatHistoryWithLLM, type AnalysisResult, type CandidateInsight } from "@/lib/profile-analyzer";
import { isLlmReady } from "@/lib/llm";

type Props = {
  conversations: Conversation[];
  insights: Insight[];
  llm: LlmConfig;
  onAdopt: (items: Insight[]) => void;
};

const CATEGORY_COLOR: Record<string, string> = {
  兴趣领域: "#5b6ee1",
  能力技能: "#3d9970",
  思维习惯: "#8a6fd1",
  行为趋势: "#d18a3d"
};

function toInsight(candidate: CandidateInsight): Insight {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: `【${candidate.category}】${candidate.title}`,
    detail: `${candidate.detail}\n\n[分析依据] ${candidate.evidenceText}\n[时间范围] ${candidate.timeRange}\n[说明] 本结论由本地规则分析生成（非大模型推断），置信度 ${candidate.confidence}%。请在核对原始对话后，把类型调整为「事实」或继续保留为观察 / 推测。`,
    kind: candidate.kind,
    evidence: candidate.evidenceText,
    confidence: candidate.confidence,
    createdAt: new Date().toISOString().slice(0, 10),
    evidenceRefs: candidate.evidenceRefs
  };
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head"><h3>{title}</h3></div>
      {children}
    </section>
  );
}

export default function AnalysisPanel({ conversations, insights, llm, onAdopt }: Props) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const adoptedTitles = new Set(insights.map(item => item.title));

  async function run() {
    setRunning(true);
    setError("");
    try {
      const messages = await listAllMessages();
      const analysis = isLlmReady(llm)
        ? await analyzeChatHistoryWithLLM(conversations, messages, llm)
        : analyzeChatHistory(conversations, messages);
      setResult(analysis);
      setDismissed(new Set());
      if (analysis.llmError) setError(`模型分析未完成，已回退本地规则结果：${analysis.llmError}`);
    } catch (error) {
      if (isLlmReady(llm)) {
        try {
          const ruleMessages = await listAllMessages();
          const ruleResult = analyzeChatHistory(conversations, ruleMessages);
          ruleResult.llmError = error instanceof Error ? error.message : "LLM 分析失败。";
          setResult(ruleResult);
          setError(`模型分析失败，已回退本地规则结果：${ruleResult.llmError}`);
        } catch (ruleError) {
          setError(ruleError instanceof Error ? ruleError.message : "分析失败，请重试。");
          setResult(null);
        }
      } else {
        setError(error instanceof Error ? error.message : "分析失败，请重试。");
        setResult(null);
      }
    } finally {
      setRunning(false);
    }
  }

  function adopt(candidate: CandidateInsight) {
    onAdopt([toInsight(candidate)]);
    setDismissed(prev => new Set(prev).add(candidate.title));
  }

  function adoptAll() {
    if (!result) return;
    const items = result.candidates
      .filter(candidate => !adoptedTitles.has(`【${candidate.category}】${candidate.title}`) && !dismissed.has(candidate.title))
      .map(toInsight);
    if (items.length) onAdopt(items);
    setDismissed(new Set(result.candidates.map(candidate => candidate.title)));
  }

  function jumpToConversation(rowId: string) {
    sessionStorage.setItem("mind-os-jump-conversation", rowId);
    router.push("/integrations");
  }

  const visible = result
    ? result.candidates.filter(candidate => !adoptedTitles.has(`【${candidate.category}】${candidate.title}`) && !dismissed.has(candidate.title))
    : [];
  const processedCount = result ? result.candidates.length - visible.length : 0;

  return (
    <Panel title="画像分析引擎（本地规则 · 实验）">
      <p className="muted">
        对已导入的对话运行本地关键词与统计规则分析，产出候选画像线索。每条候选都附带证据会话与置信度，
        且永远不会自动标记为「事实」——只有你核对并确认后才能升级。健康数据不参与本分析。
      </p>
      <div className="actions">
        <button className="btn primary" disabled={running || !conversations.length} onClick={() => void run()}>
          {running ? "正在分析…" : "▶ 运行分析"}
        </button>
        {result && visible.length > 0 && (
          <button className="btn" onClick={adoptAll}>采纳全部（{visible.length} 条）</button>
        )}
      </div>
      {!conversations.length && <p className="muted">还没有已导入的对话，请先到 AI 数据中心导入 ChatGPT ZIP。</p>}
      {error && <p className="muted" style={{ color: "#bd4d46" }}>{error}</p>}
      {result && (
        <p className="muted">
          分析窗口：{result.stats.windowStart ?? "未知"} ~ {result.stats.windowEnd ?? "未知"} ·
          会话 {result.stats.conversationsAnalyzed} 个 · 消息 {result.stats.messagesAnalyzed} 条
          （其中用户消息 {result.stats.userMessagesAnalyzed} 条）
          {result.generatedBy === "llm" ? ` · 本次候选由模型 ${result.llmModel} 生成（已经校验）` : " · 本次候选由本地规则引擎生成"}
          {processedCount > 0 ? ` · 已采纳或忽略 ${processedCount} 条候选` : ""}
        </p>
      )}
      {visible.map(candidate => (
        <div className="item" key={candidate.title}>
          <div className="item-head">
            <b>
              <span style={{ color: CATEGORY_COLOR[candidate.category] ?? "#5b6ee1" }}>{candidate.category}</span>
              {" ｜ "}
              {candidate.title}
            </b>
            <span className="kind">{candidate.kind === "observation" ? "行为观察" : "待确认推测"}</span>
          </div>
          <p>{candidate.detail}</p>
          <small>证据：{candidate.evidenceText || "（无）"} · 置信度 {candidate.confidence}% · 时间范围 {candidate.timeRange}</small>
          {candidate.evidence.length > 0 && (
            <div className="actions" style={{ marginTop: 8 }}>
              {candidate.evidence.map(ev => (
                <button
                  key={ev.conversationRowId}
                  className="btn"
                  onClick={() => jumpToConversation(ev.conversationRowId)}
                  title={ev.title}
                >
                  查看对话：{ev.title.length > 14 ? `${ev.title.slice(0, 14)}…` : ev.title}
                </button>
              ))}
            </div>
          )}
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="btn primary" onClick={() => adopt(candidate)}>采纳进画像</button>
            <button className="btn" onClick={() => setDismissed(prev => new Set(prev).add(candidate.title))}>忽略</button>
          </div>
        </div>
      ))}
      {result && !visible.length && (
        <p className="muted">全部候选已处理。对话数据变化后可再次「运行分析」刷新结论。</p>
      )}
    </Panel>
  );
}
