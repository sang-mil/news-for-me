export type NewsletterScheduleStatus = "scheduled" | "sending" | "sent" | "failed" | "cancelled";

export interface NewsletterSchedule {
  id: string;
  recipientEmail: string;
  scheduledAt: string;
  status: NewsletterScheduleStatus;
  createdAt: string;
  sentAt: string | null;
  errorMessage: string | null;
}

interface NewsletterScheduleRow {
  id: string;
  recipient_email: string;
  scheduled_at: string;
  status: NewsletterScheduleStatus;
  created_at: string;
  sent_at: string | null;
  error_message: string | null;
}

function mapSchedule(row: NewsletterScheduleRow): NewsletterSchedule {
  return {
    id: row.id,
    recipientEmail: row.recipient_email,
    scheduledAt: row.scheduled_at,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    errorMessage: row.error_message
  };
}

export async function createNewsletterSchedule(
  db: D1Database,
  input: { id: string; userId: string; recipientEmail: string; scheduledAt: string }
): Promise<void> {
  await db.prepare(`
    INSERT INTO newsletter_schedules (
      id, user_id, recipient_email, scheduled_at, status
    ) VALUES (?, ?, ?, ?, 'scheduled')
  `).bind(input.id, input.userId, input.recipientEmail, input.scheduledAt).run();
}

export async function listNewsletterSchedules(
  db: D1Database,
  userId: string,
  limit = 20
): Promise<NewsletterSchedule[]> {
  const result = await db.prepare(`
    SELECT id, recipient_email, scheduled_at, status, created_at, sent_at, error_message
    FROM newsletter_schedules
    WHERE user_id = ?
    ORDER BY
      CASE status WHEN 'scheduled' THEN 0 WHEN 'sending' THEN 1 ELSE 2 END,
      CASE WHEN status IN ('scheduled', 'sending') THEN scheduled_at ELSE created_at END ASC
    LIMIT ?
  `).bind(userId, Math.min(50, Math.max(1, Math.floor(limit)))).all<NewsletterScheduleRow>();
  return result.results.map(mapSchedule);
}

export async function listDueNewsletterSchedules(
  db: D1Database,
  now: string,
  limit = 10
): Promise<Array<NewsletterSchedule & { userId: string }>> {
  const result = await db.prepare(`
    SELECT id, user_id, recipient_email, scheduled_at, status, created_at, sent_at, error_message
    FROM newsletter_schedules
    WHERE status = 'scheduled' AND scheduled_at <= ?
    ORDER BY scheduled_at ASC
    LIMIT ?
  `).bind(now, limit).all<NewsletterScheduleRow & { user_id: string }>();
  return result.results.map((row) => ({ ...mapSchedule(row), userId: row.user_id }));
}

export async function claimNewsletterSchedule(
  db: D1Database,
  id: string,
  now: string
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE newsletter_schedules
    SET status = 'sending', updated_at = ?
    WHERE id = ? AND status = 'scheduled'
  `).bind(now, id).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function markNewsletterScheduleSent(
  db: D1Database,
  id: string,
  deliveryId: string
): Promise<void> {
  await db.prepare(`
    UPDATE newsletter_schedules
    SET status = 'sent',
        delivery_id = ?,
        sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        error_message = NULL
    WHERE id = ? AND status = 'sending'
  `).bind(deliveryId, id).run();
}

export async function markNewsletterScheduleFailed(
  db: D1Database,
  id: string,
  errorMessage: string
): Promise<void> {
  await db.prepare(`
    UPDATE newsletter_schedules
    SET status = 'failed', error_message = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND status = 'sending'
  `).bind(errorMessage.slice(0, 1000), id).run();
}

export async function cancelNewsletterSchedule(
  db: D1Database,
  userId: string,
  id: string
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE newsletter_schedules
    SET status = 'cancelled',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND user_id = ? AND status = 'scheduled'
  `).bind(id, userId).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function failStaleNewsletterSchedules(
  db: D1Database,
  now: string
): Promise<number> {
  const result = await db.prepare(`
    UPDATE newsletter_schedules
    SET status = 'failed',
        error_message = '발송 작업이 제한 시간 안에 완료되지 않았습니다. 중복 발송 방지를 위해 자동 재시도하지 않았습니다.',
        updated_at = ?
    WHERE status = 'sending'
      AND julianday(updated_at) < julianday(?, '-20 minutes')
  `).bind(now, now).run();
  return result.meta.changes ?? 0;
}
