export interface DeliveryLogInput {
  id: string;
  userId: string;
  recipientEmail: string;
  subject: string;
  idempotencyKey: string;
}

export async function createDeliveryLog(db: D1Database, input: DeliveryLogInput): Promise<void> {
  await db.prepare(`
    INSERT INTO delivery_logs (
      id, user_id, channel, recipient_email, subject, status,
      provider, idempotency_key
    ) VALUES (?, ?, 'email', ?, ?, 'queued', 'gmail', ?)
  `).bind(
    input.id, input.userId, input.recipientEmail, input.subject, input.idempotencyKey
  ).run();
}

export async function markDeliverySending(db: D1Database, id: string): Promise<void> {
  await db.prepare(`
    UPDATE delivery_logs SET status = 'sending'
    WHERE id = ? AND status = 'queued'
  `).bind(id).run();
}

export async function markDeliverySent(
  db: D1Database,
  id: string,
  messageId: string | null
): Promise<void> {
  await db.prepare(`
    UPDATE delivery_logs
    SET status = 'sent', external_message_id = ?, sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), error_message = NULL
    WHERE id = ?
  `).bind(messageId, id).run();
}

export async function markDeliveryFailed(
  db: D1Database,
  id: string,
  errorMessage: string
): Promise<void> {
  await db.prepare(`
    UPDATE delivery_logs
    SET status = 'failed', retry_count = retry_count + 1, error_message = ?
    WHERE id = ?
  `).bind(errorMessage.slice(0, 1000), id).run();
}
