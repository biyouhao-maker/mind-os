/**
 * MIND OS 3.0 Markdown 导出（报告 / 决策参考）。
 * 纯字符串拼接，无 DOM 依赖（downloadTextFile 除外），可在 Node 中单测。
 */
import type { Report } from "./types";
import type { DecisionAnswer } from "./decision-engine";

export function growthReportToMarkdown(report: Report): string {
  const c = report.content;
  const lines: string[] = [];
  lines.push(`# ${c.periodLabel}`);
  lines.push("");
  lines.push(`- 窗口：${c.windowStart} ~ ${c.windowEnd}`);
  lines.push(`- 生成时间：${report.createdAt}`);
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("| --- | --- |");
  lines.push(`| 会话 | ${c.conversations} |`);
  lines.push(`| 消息 | ${c.messages} |`);
  lines.push(`| 活跃天数 | ${c.activeDays} |`);
  lines.push(`| 新增画像线索 | ${c.insightsAdopted} |`);
  lines.push(`| 标记为事实的线索 | ${c.insightsConfirmed} |`);
  lines.push("");
  lines.push("## 重点话题");
  lines.push("");
  lines.push(
    c.topTopics.length
      ? c.topTopics.map(topic => `- ${topic.name}：${topic.count} 条消息`).join("\n")
      : "本窗口没有识别到话题关键词。"
  );
  lines.push("");
  lines.push("## 跨月反复出现的话题");
  lines.push("");
  lines.push(c.recurringTopics.length ? c.recurringTopics.map(topic => `- ${topic}`).join("\n") : "无");
  lines.push("");
  lines.push("## 目标概况");
  lines.push("");
  lines.push(`共 ${c.goals.total} 个 · 进行中 ${c.goals.active} · 已完成 ${c.goals.done} · 平均进度 ${c.goals.avgProgress}%`);
  lines.push("");
  lines.push("## 成长日志");
  lines.push("");
  lines.push(
    c.growthLogs.count
      ? [`${c.growthLogs.count} 条：`, ...c.growthLogs.titles.map(title => `- ${title}`)].join("\n")
      : "0 条"
  );
  lines.push("");
  lines.push("## 如实记录");
  lines.push("");
  for (const line of c.highlights) lines.push(`- ${line}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*本报告由 MIND OS 在本地生成，数字来自浏览器内的真实记录。*");
  return lines.join("\n");
}

export function decisionAnswerToMarkdown(
  answer: DecisionAnswer,
  resolveTitle?: (rowId: string) => string | null
): string {
  const lines: string[] = [];
  lines.push("# 决策参考");
  lines.push("");
  lines.push(`> 问题：${answer.question}`);
  lines.push("");
  lines.push(`- 生成时间：${new Date().toISOString().slice(0, 10)}`);
  lines.push(`- 生成方式：${answer.generatedBy === "llm" ? `模型推断${answer.model ? `（${answer.model}）` : ""}` : "本地规则分析"}`);
  lines.push(`- 相关证据：${answer.relatedCount} 条（${answer.sufficient ? "证据量足够给出倾向" : "证据量不足，请谨慎参考"}）`);
  lines.push("");
  for (const section of answer.sections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    lines.push(section.body);
    if (section.evidenceRefs.length) {
      lines.push("");
      lines.push("**相关对话：**");
      for (const rowId of section.evidenceRefs) {
        const title = resolveTitle?.(rowId) ?? rowId;
        lines.push(`- ${title}`);
      }
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("*本参考由 MIND OS 本地生成，不构成确定预测；最终决策及后果由决策者本人承担。*");
  return lines.join("\n");
}

/** 触发浏览器下载（仅在浏览器环境调用）。 */
export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
