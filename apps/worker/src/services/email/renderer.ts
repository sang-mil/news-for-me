import type { NewsletterArticle, NewsletterContent } from "./types";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "#";
  } catch {
    return "#";
  }
}

function formatDate(value: string | null): string {
  if (!value) return "발행일 정보 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "발행일 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function importanceLabel(value: NewsletterArticle["importance"]): string {
  switch (value) {
    case "urgent": return "긴급";
    case "high": return "중요";
    case "normal": return "일반";
    default: return "참고";
  }
}

function renderArticle(article: NewsletterArticle, index: number): string {
  const title = escapeHtml(article.title);
  const topic = escapeHtml(article.topicName);
  const source = escapeHtml(article.sourceName ?? "출처 미상");
  const date = escapeHtml(formatDate(article.publishedAt));
  const summary = escapeHtml(article.summary);
  const url = escapeHtml(safeHttpUrl(article.canonicalUrl));
  const importance = escapeHtml(importanceLabel(article.importance));
  const savedLabel = article.isSaved ? '<span style="color:#2563eb;font-size:12px;font-weight:700;">스크랩 보관</span>' : "";
  const points = article.keyPoints.length
    ? `<ul style="margin:10px 0 0;padding-left:20px;color:#475569;">${article.keyPoints.map((point) => `<li style="margin:5px 0;">${escapeHtml(point)}</li>`).join("")}</ul>`
    : "";
  const insight = article.insight
    ? `<p style="margin:12px 0 0;padding:10px 12px;background:#f8fafc;border-left:3px solid #64748b;color:#475569;font-size:13px;line-height:1.65;"><strong>AI 관점</strong><br>${escapeHtml(article.insight)}</p>`
    : "";

  return `
    <tr><td style="padding:0 0 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:12px;border-collapse:separate;">
        <tr><td style="padding:18px 20px;">
          <div style="font-size:12px;color:#64748b;margin-bottom:8px;">${topic} · ${importance} · ${savedLabel}</div>
          <h2 style="font-size:18px;line-height:1.5;margin:0 0 8px;color:#0f172a;">${index + 1}. ${title}</h2>
          <div style="font-size:12px;color:#64748b;margin-bottom:12px;">${source} · ${date}</div>
          <p style="font-size:14px;line-height:1.75;color:#334155;margin:0;">${summary}</p>
          ${points}
          ${insight}
          <p style="margin:15px 0 0;"><a href="${url}" style="color:#2563eb;font-size:13px;font-weight:700;text-decoration:none;">원문 기사 보기 →</a></p>
          <p style="font-size:11px;color:#94a3b8;margin:12px 0 0;">분석 모델: ${escapeHtml(article.modelName)} (${escapeHtml(article.modelProvider)})</p>
        </td></tr>
      </table>
    </td></tr>`;
}

export function renderNewsletter(
  articles: NewsletterArticle[],
  periodDays = 7
): NewsletterContent {
  const now = new Date();
  const dateLabel = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now).replace(/\.\s*/g, ".").replace(/\.$/, "");
  const subject = `News for Me | 최근 ${periodDays}일 뉴스 브리핑 (${dateLabel})`;
  const cards = articles.map(renderArticle).join("\n");
  const html = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,'Noto Sans KR',sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:24px 8px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;background:#ffffff;border-radius:16px;">
        <tr><td style="padding:28px 24px 20px;border-bottom:1px solid #e2e8f0;">
          <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:#2563eb;">YOUR PERSONAL AI NEWS BRIEFING</div>
          <h1 style="font-size:27px;line-height:1.3;margin:12px 0 8px;color:#0f172a;">이번 주 놓치지 말아야 할 뉴스</h1>
          <p style="margin:0;color:#64748b;font-size:13px;">최근 ${periodDays}일 · AI 분석 기사 ${articles.length}개 · ${escapeHtml(dateLabel)}</p>
        </td></tr>
        <tr><td style="padding:22px 18px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cards}</table>
        </td></tr>
        <tr><td style="padding:20px 24px 26px;border-top:1px solid #e2e8f0;">
          <p style="font-size:12px;line-height:1.7;color:#64748b;margin:0;">이 메일은 News for Me에서 관심 항목을 바탕으로 자동 생성한 개인 뉴스 브리핑입니다. AI 요약은 제공된 기사 제목과 발췌 정보를 바탕으로 작성되며, 정확한 내용은 원문 기사를 확인해 주세요.</p>
          <p style="font-size:12px;color:#94a3b8;margin:12px 0 0;">News for Me · Your Personal News Archive</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const textLines = [
    "News for Me | 개인 AI 뉴스 브리핑",
    `최근 ${periodDays}일 · 기사 ${articles.length}개 · ${dateLabel}`,
    ""
  ];
  articles.forEach((article, index) => {
    textLines.push(`${index + 1}. [${importanceLabel(article.importance)}] ${article.title}`);
    textLines.push(`${article.topicName} · ${article.sourceName ?? "출처 미상"} · ${formatDate(article.publishedAt)}`);
    textLines.push(article.summary);
    for (const point of article.keyPoints) textLines.push(`- ${point}`);
    if (article.insight) textLines.push(`AI 관점: ${article.insight}`);
    textLines.push(`원문: ${safeHttpUrl(article.canonicalUrl)}`);
    textLines.push("");
  });
  textLines.push("AI 요약은 기사 제목과 발췌 정보를 바탕으로 작성되었습니다. 정확한 내용은 원문을 확인해 주세요.");

  return {
    subject,
    html,
    text: textLines.join("\n"),
    articleCount: articles.length,
    periodDays,
    generatedAt: now.toISOString()
  };
}
