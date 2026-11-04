export const NEWSLETTER_SCHEDULE_MIN_LEAD_MS = 5 * 60 * 1000;
export const NEWSLETTER_SCHEDULE_MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

export type NewsletterScheduleValidation =
  | { ok: true; scheduledAt: string }
  | { ok: false; error: string };

const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateNewsletterScheduledAt(
  value: unknown,
  nowMs = Date.now()
): NewsletterScheduleValidation {
  if (typeof value !== "string" || !ISO_WITH_TIMEZONE.test(value)) {
    return { ok: false, error: "예약 시간은 시간대가 포함된 ISO 날짜여야 합니다." };
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, error: "예약 날짜와 시간을 올바르게 입력하세요." };
  }
  if (timestamp < nowMs + NEWSLETTER_SCHEDULE_MIN_LEAD_MS) {
    return { ok: false, error: "예약 발송은 현재 시각보다 최소 5분 이후로 설정하세요." };
  }
  if (timestamp > nowMs + NEWSLETTER_SCHEDULE_MAX_HORIZON_MS) {
    return { ok: false, error: "예약 발송은 최대 30일 이내로 설정할 수 있습니다." };
  }

  return { ok: true, scheduledAt: new Date(timestamp).toISOString() };
}
