import {
  cancelNewsletterSchedule,
  createNewsletterSchedule,
  listNewsletterSchedules
} from "../db/repositories/newsletter-schedules";
import { listRecentNewsletterArticles } from "../db/repositories/newsletter";
import { jsonResponse } from "../lib/http";
import { hasNewsletterMailConfiguration, sendNewsletterForUser } from "../services/email/send-newsletter";
import { normalizeNewsletterRecipient } from "../services/email/recipient";
import { validateNewsletterScheduledAt } from "../services/email/newsletter-schedule";
import { renderNewsletter } from "../services/email/renderer";
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
  allowedOrigin: string
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/newsletter/preview" && request.method === "GET") {
    const preview = await buildPreview(env.DB, userId);
    return jsonResponse({ data: preview }, 200, allowedOrigin);
  }

  if (url.pathname === "/api/newsletter/send-test" && request.method === "POST") {
    const body = await request.json().catch(() => null) as { confirm?: unknown; recipient?: unknown } | null;
    if (body?.confirm !== true) {
      return jsonResponse({ error: "메일 발송 확인값이 필요합니다." }, 400, allowedOrigin);
    }
    const recipient = normalizeNewsletterRecipient(body.recipient);
    if (!recipient) {
      return jsonResponse({ error: "받는 사람 이메일 주소를 올바르게 입력하세요." }, 400, allowedOrigin);
    }
    if (!hasNewsletterMailConfiguration(env)) {
      return jsonResponse({ error: "Gmail 설정이 부족합니다. GMAIL_SENDER와 Google OAuth Secret을 확인하세요." }, 503, allowedOrigin);
    }

    try {
      const result = await sendNewsletterForUser(env.DB, env, userId, recipient);
      return jsonResponse({ data: result }, 200, allowedOrigin);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown Gmail error";
      console.error("Newsletter email failed", detail);
      return jsonResponse({ error: "뉴스레터 메일 발송에 실패했습니다.", details: [detail.slice(0, 300)] }, 502, allowedOrigin);
    }
  }

  if (url.pathname === "/api/newsletter/schedules" && request.method === "GET") {
    const schedules = await listNewsletterSchedules(env.DB, userId);
    return jsonResponse({ data: schedules }, 200, allowedOrigin);
  }

  if (url.pathname === "/api/newsletter/schedules" && request.method === "POST") {
    const body = await request.json().catch(() => null) as {
      confirm?: unknown;
      recipient?: unknown;
      scheduledAt?: unknown;
    } | null;
    if (body?.confirm !== true) {
      return jsonResponse({ error: "예약 발송 확인값이 필요합니다." }, 400, allowedOrigin);
    }

    const recipient = normalizeNewsletterRecipient(body.recipient);
    if (!recipient) {
      return jsonResponse({ error: "받는 사람 이메일 주소를 올바르게 입력하세요." }, 400, allowedOrigin);
    }
    const validation = validateNewsletterScheduledAt(body.scheduledAt);
    if (!validation.ok) {
      return jsonResponse({ error: validation.error }, 400, allowedOrigin);
    }
    if (!hasNewsletterMailConfiguration(env)) {
      return jsonResponse({ error: "Gmail 설정이 부족합니다. GMAIL_SENDER와 Google OAuth Secret을 확인하세요." }, 503, allowedOrigin);
    }

    const preview = await buildPreview(env.DB, userId);
    if (preview.articleCount === 0) {
      return jsonResponse({ error: "예약할 뉴스레터가 없습니다. 먼저 뉴스 수집을 실행하세요." }, 404, allowedOrigin);
    }

    const id = crypto.randomUUID();
    await createNewsletterSchedule(env.DB, {
      id,
      userId,
      recipientEmail: recipient,
      scheduledAt: validation.scheduledAt
    });
    return jsonResponse({
      data: {
        id,
        recipientEmail: recipient,
        scheduledAt: validation.scheduledAt,
        status: "scheduled"
      }
    }, 201, allowedOrigin);
  }

  const schedulePrefix = "/api/newsletter/schedules/";
  if (url.pathname.startsWith(schedulePrefix) && request.method === "DELETE") {
    const scheduleId = decodeURIComponent(url.pathname.slice(schedulePrefix.length));
    if (!scheduleId || scheduleId.includes("/")) {
      return jsonResponse({ error: "예약 ID가 올바르지 않습니다." }, 400, allowedOrigin);
    }
    const cancelled = await cancelNewsletterSchedule(env.DB, userId, scheduleId);
    if (!cancelled) {
      return jsonResponse({ error: "취소할 수 없는 예약입니다. 이미 발송되었거나 처리 중일 수 있습니다." }, 409, allowedOrigin);
    }
    return jsonResponse({ data: { ok: true, id: scheduleId } }, 200, allowedOrigin);
  }

  return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);
}
