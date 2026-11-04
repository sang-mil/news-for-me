import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNewsletterRecipient } from "../../apps/worker/src/services/email/recipient.ts";

test("normalizes recipient email addresses", () => {
  assert.equal(normalizeNewsletterRecipient("  Person+news@Example.com  "), "person+news@example.com");
});

test("rejects missing or non-string recipient values", () => {
  assert.equal(normalizeNewsletterRecipient(null), null);
  assert.equal(normalizeNewsletterRecipient(undefined), null);
  assert.equal(normalizeNewsletterRecipient(123), null);
  assert.equal(normalizeNewsletterRecipient(""), null);
});

test("rejects malformed and multi-recipient addresses", () => {
  assert.equal(normalizeNewsletterRecipient("not-an-email"), null);
  assert.equal(normalizeNewsletterRecipient("person@example"), null);
  assert.equal(normalizeNewsletterRecipient("person@example.com,other@example.com"), null);
  assert.equal(normalizeNewsletterRecipient("person@example.com;other@example.com"), null);
  assert.equal(normalizeNewsletterRecipient("person@example.com\\r\\nBcc:other@example.com"), null);
});

test("rejects addresses longer than the email length limit", () => {
  const longAddress = "a".repeat(245) + "@example.com";
  assert.equal(normalizeNewsletterRecipient(longAddress), null);
});
