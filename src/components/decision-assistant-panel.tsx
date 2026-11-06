"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Conversation, Goal, Insight, LlmConfig } from "@/lib/types";
import { listAllMessages, type StoredChatMessage } from "@/lib/chat-archive";
import { answerDecision, answerDecisionWithLLM, type DecisionAnswer } from "@/lib/decision-engine";
import { isLlmReady } from "@/lib/llm";

type Props = {
  conversations: Conversation[];
  insights: Insight[];
  goals: Goal[];
  llm: LlmConfig;
};

export default function DecisionAssistantPanel({ conversations, insights, goals, llm }: Props) {
  const router = useRouter();
  const [messages, setMessages] = useState<StoredChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<DecisionAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let cancelled = false;
    listAllMessages()
      .then(rows => { if (!cancelled) setMessages(rows); })
      .catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : "读取本地消息失败。"); })
      .finally(() => { if (!cancelled) setMessagesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function generate() {
    setError("");
    setFeedback("");
    if (messagesLoading) {
      setError("正在读取本地消息，请稍候。");
      return;
    }
    setBusy(true);
    const ctx = { conversations, messages, insights, goals };
    const runRules = (prefix?: string) => {
      setAnswer(answerDecision(question, ctx));
      if (prefix) setError(prefix);
    };
    try {
      if (isLlmReady(llm)) {
        void answerDecisionWithLLM(question, ctx, llm)
          .then(result => setAnswer(result))
          .catch(error => {
            setAnswer(answerDecision(question, ctx));
            setError(`模型调用失败，已回退本地规则引擎：${error instanceof Error ? error.message : "未知错误"}`);
          });
      } else {
        runRules();
      }
    } catch (error) {
      runRules(error instanceof Error ? `生成失败：${error.message}，已回退本地规则引擎。` : undefined);
    } finally {
      setBusy(false);
    }
  }

  function jumpToConversation(rowId: string) {
    sessionStorage.setItem("mind-os-jump-conversation", rowId);
    router.push("/integrations");
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>智能决策参考（本地规则 · 实验）</h3>
      </div>
      <p className="muted">
        输入你的决策问题（可附「方案 A：… 方案 B：…」），系统会检索相关历史对话并结合画像，
        按七段结构给出参考。全部本地运行，答案永远包含「不确定性」说明，不构成确定预测。
      </p>
      <div className="formgrid">
        <Field label="需要做出的选择" full>
          <textarea
            rows={2}
            value={question}
            onChange={event => setQuestion(event.target.value)}
            placeholder="例如：是否应该启动某个项目？方案 A：… 方案 B：…"
          />
        </Field>
      </div>
      <div className="actions">
        <button className="btn primary" disabled={busy || messagesLoading || !question.trim()} onClick={generate}>
          {busy ? "正在分析…" : messagesLoading ? "正在读取本地消息…" : "生成决策参考"}
        </button>
      </div>
      {error && <p className="muted" style={{ color: "#bd4d46" }}>{error}</p>}

      {answer && (
        <div className="decision" style={{ marginTop: 14 }}>
          {answer.sections.map(section => (
            <div key={section.title} style={{ marginBottom: 10 }}>
              <b style={{ fontSize: 11 }}>{section.title}</b>
              <p style={{ whiteSpace: "pre-wrap" }}>{section.body}</p>
              {section.evidenceRefs.length > 0 && (
                <div className="actions">
                  {section.evidenceRefs.map(ref => {
                    const row = conversations.find(c => c.id === ref);
                    return row ? (
                      <button key={ref} className="btn" onClick={() => jumpToConversation(ref)} title={row.title}>
                        查看对话：{row.title.length > 14 ? `${row.title.slice(0, 14)}…` : row.title}
                      </button>
                    ) : null;
                  })}
                </div>
              )}
            </div>
          ))}
          <div className="actions">
            <button className="btn" onClick={() => setFeedback("有帮助：已记录本次反馈（仅保存在当前页面）。")}>👍 有帮助</button>
            <button className="btn" onClick={() => setFeedback("没帮助：已记录本次反馈（仅保存在当前页面）。")}>👎 没帮助</button>
          </div>
          {feedback && <p className="muted">{feedback}</p>}
          <p className="muted" style={{ marginTop: 8 }}>
            相关证据 {answer.relatedCount} 条 · {answer.sufficient ? "证据量足够给出倾向" : "证据量不足，请谨慎参考"} ·
            {answer.generatedBy === "llm" ? ` 由模型 ${answer.model ?? ""} 生成` : " 由本地规则引擎生成"}
          </p>
        </div>
      )}
    </section>
  );
}

function Field({ label, children, full = false }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label className={`field ${full ? "full" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
