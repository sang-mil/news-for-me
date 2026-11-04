const EMAIL_RE = /^[^\\s@,;]+@[^\\s@,;]+\\.[^\\s@,;]+$/;

export function normalizeNewsletterRecipient(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}
