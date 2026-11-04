import test from "node:test";
import assert from "node:assert/strict";
import {
  NEWSLETTER_SCHEDULE_MAX_HORIZON_MS,
  NEWSLETTER_SCHEDULE_MIN_LEAD_MS,
  validateNewsletterScheduledAt
} from "../../apps/worker/src/services/email/newsletter-schedule.ts";

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

test("normalizes a valid scheduled timestamp to UTC", () => {
  const result = validateNewsletterScheduledAt("2026-11-04T21:10:00+09:00", NOW);
  assert.deepEqual(result, { ok: true, scheduledAt: "2026-11-04T12:10:00.000Z" });
});

test("requires an explicit timezone", () => {
  const result = validateNewsletterScheduledAt("2026-11-04T21:10:00", NOW);
  assert.equal(result.ok, false);
});

test("rejects invalid dates", () => {
  const result = validateNewsletterScheduledAt("2026-02-30T21:10:00+09:00", NOW);
  assert.equal(result.ok, false);
});

test("rejects timestamps less than five minutes in the future", () => {
  const tooSoon = new Date(NOW + NEWSLETTER_SCHEDULE_MIN_LEAD_MS - 1).toISOString();
  assert.equal(validateNewsletterScheduledAt(tooSoon, NOW).ok, false);
});

test("rejects timestamps more than 30 days in the future", () => {
  const tooFar = new Date(NOW + NEWSLETTER_SCHEDULE_MAX_HORIZON_MS + 1).toISOString();
  assert.equal(validateNewsletterScheduledAt(tooFar, NOW).ok, false);
});
