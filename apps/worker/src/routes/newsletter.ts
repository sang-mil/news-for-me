import { listRecentNewsletterArticles } from "../db/repositories/newsletter";
import {
  createDeliveryLog,
  markDeliveryFailed,
  markDeliverySending,
  markDeliverySent
} from "../db/repositories/delivery";
import { jsonResponse } from "../lib/http";
import { sendGmailMessage } from "../services/email/gmail";
import { renderNewsletter } from "../services/email/renderer";
import { normalizeNewsletterRecipient } from "../services/email/recipient";
import type { GmailEnvironment } from "../services/email/types";

interface NewsletterEnv extends GmailEnvironment {
  DB: D1Database;
}

async function buildPreview(db: D1Database, userId: string) {
  const articles = await listRecentNewsletterArticles(db, userId, 7, 25);
  return renderNewsletter(articles, 7);
}

export async function handleNewsletterRequest(
  request: Request,
  env: NewsletterEnv,
  userId: string,
  authenticatedEmail: string,
  allowedOrigin: string
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/newsletter/preview" && request.method === "GET") {
    const preview = await buildPreview(env.DB, userId);
    if (preview.articleCount === 0) {
      return jsonResponse({ error: "최근 7일 내 발송할 AI 요약 뉴스가 없습니다. 먼저 뉴스 수집을 실행하세요." }, 404, allowedOrigin);
    }
    return jsonResponse({ data: preview }, 200, allowedOrigin);
  }

  if (url.pathname === "/api/newsletter/send-test" && request.method === "POST") {
    const body = await request.json().catch(() => null) as { confirm?: unknown; recipient?: unknown } | null;
    if (body?.confirm !== true) {
      return jsonResponse({ error: "메일 발송 확인값이 필요합니다." }, 400, allowedOrigin);
    }

    const recipient = normalizeNewsletterRecipient(body.recipient);
    const sender = normalizeNewsletterRecipient(env.GMAIL_SENDER);
    if (!recipient) {
      return jsonResponse({ error: "받는 사람 이메일 주소를 올바르게 입력하세요." }, 400, allowedOrigin);
    }
    if (!sender) {
      return jsonResponse({ error: "GMAIL_SENDER에 올바른 Gmail 발신 주소를 설정하세요." }, 503, allowedOrigin);
    }
    if (!env.GOOGLE_CLIENT_ID?.trim() || !env.GOOGLE_CLIENT_SECRET?.trim() || !env.GOOGLE_REFRESH_TOKEN?.trim()) {
      return jsonResponse({ error: "Google OAuth 설정이 부족합니다. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN을 확인하세요." }, 503, allowedOrigin);
    }

    const preview = await buildPreview(env.DB, userId);
    if (preview.articleCount === 0) {
      return jsonResponse({ error: "발송할 AI 요약 뉴스가 없습니다." }, 404, allowedOrigin);
    }

    const deliveryId = crypto.randomUUID();
    const idempotencyKey = `newsletter:${userId}:${deliveryId}`;
    await createDeliveryLog(env.DB, {
      id: deliveryId,
      userId,
      recipientEmail: recipient,
      subject: preview.subject,
      idempotencyKey
    });
    await markDeliverySending(env.DB, deliveryId);

    try {
      const result = await sendGmailMessage(
        env,
        recipient,
        preview.subject,
        preview.html,
        preview.text,
        "News for Me"
      );
      await markDeliverySent(env.DB, deliveryId, result.messageId);
      return jsonResponse({
        data: {
          ok: true,
          deliveryId,
          recipient,
          messageId: result.messageId,
          articleCount: preview.articleCount
        }
      }, 200, allowedOrigin);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown Gmail error";
      await markDeliveryFailed(env.DB, deliveryId, detail);
      console.error("Newsletter email failed", deliveryId, detail);
      return jsonResponse({ error: "뉴스레터 메일 발송에 실패했습니다.", details: [detail.slice(0, 300)], deliveryId }, 502, allowedOrigin);
    }
  }

  return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);
}
