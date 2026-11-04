import {
  createDeliveryLog,
  markDeliveryFailed,
  markDeliverySending,
  markDeliverySent
} from "../../db/repositories/delivery";
import { listRecentNewsletterArticles } from "../../db/repositories/newsletter";
import { normalizeNewsletterRecipient } from "./recipient";
import { sendGmailMessage } from "./gmail";
import { renderNewsletter } from "./renderer";
import type { GmailEnvironment } from "./types";

export interface NewsletterSendResult {
  ok: true;
  deliveryId: string;
  recipient: string;
  messageId: string | null;
  articleCount: number;
}

export function hasNewsletterMailConfiguration(env: GmailEnvironment): boolean {
  return Boolean(
    normalizeNewsletterRecipient(env.GMAIL_SENDER) &&
    env.GOOGLE_CLIENT_ID?.trim() &&
    env.GOOGLE_CLIENT_SECRET?.trim() &&
    env.GOOGLE_REFRESH_TOKEN?.trim()
  );
}

export async function sendNewsletterForUser(
  db: D1Database,
  env: GmailEnvironment,
  userId: string,
  recipientInput: unknown
): Promise<NewsletterSendResult> {
  const recipient = normalizeNewsletterRecipient(recipientInput);
  if (!recipient) throw new Error("받는 사람 이메일 주소를 올바르게 입력하세요.");
  if (!hasNewsletterMailConfiguration(env)) {
    throw new Error("Gmail 설정이 부족합니다. GMAIL_SENDER와 Google OAuth Secret을 확인하세요.");
  }

  const articles = await listRecentNewsletterArticles(db, userId, 7, 25);
  const preview = renderNewsletter(articles, 7);
  if (preview.articleCount === 0) {
    throw new Error("발송할 AI 요약 뉴스가 없습니다.");
  }

  const deliveryId = crypto.randomUUID();
  const idempotencyKey = `newsletter:${userId}:${deliveryId}`;
  await createDeliveryLog(db, {
    id: deliveryId,
    userId,
    recipientEmail: recipient,
    subject: preview.subject,
    idempotencyKey
  });
  await markDeliverySending(db, deliveryId);

  try {
    const result = await sendGmailMessage(
      env,
      recipient,
      preview.subject,
      preview.html,
      preview.text,
      "News for Me"
    );
    await markDeliverySent(db, deliveryId, result.messageId);
    return {
      ok: true,
      deliveryId,
      recipient,
      messageId: result.messageId,
      articleCount: preview.articleCount
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown Gmail error";
    await markDeliveryFailed(db, deliveryId, detail);
    throw error;
  }
}
