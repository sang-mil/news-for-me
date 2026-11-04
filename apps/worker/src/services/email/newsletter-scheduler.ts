import {
  claimNewsletterSchedule,
  failStaleNewsletterSchedules,
  listDueNewsletterSchedules,
  markNewsletterScheduleFailed,
  markNewsletterScheduleSent
} from "../../db/repositories/newsletter-schedules";
import { sendNewsletterForUser } from "./send-newsletter";
import type { GmailEnvironment } from "./types";

export async function processDueNewsletterSchedules(
  db: D1Database,
  env: GmailEnvironment,
  scheduledTime = Date.now()
): Promise<{ examined: number; sent: number; failed: number; staleFailed: number }> {
  const now = new Date(scheduledTime).toISOString();
  const staleFailed = await failStaleNewsletterSchedules(db, now);
  const due = await listDueNewsletterSchedules(db, now, 10);
  let sent = 0;
  let failed = 0;

  for (const schedule of due) {
    const claimed = await claimNewsletterSchedule(db, schedule.id, now);
    if (!claimed) continue;

    try {
      const result = await sendNewsletterForUser(db, env, schedule.userId, schedule.recipientEmail);
      await markNewsletterScheduleSent(db, schedule.id, result.deliveryId);
      sent += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown newsletter delivery error";
      await markNewsletterScheduleFailed(db, schedule.id, detail);
      console.error("Scheduled newsletter failed", schedule.id, detail);
      failed += 1;
    }
  }

  return { examined: due.length, sent, failed, staleFailed };
}
