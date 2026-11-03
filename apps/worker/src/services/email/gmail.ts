import type { GmailEnvironment, GmailSendResult } from "./types";

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64Url(value: string): string {
  return utf8Base64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function encodeMimeHeader(value: string): string {
  return `=?UTF-8?B?${utf8Base64(value)}?=`;
}

function safeHeader(value: string, maxLength: number): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

export async function sendGmailMessage(
  env: GmailEnvironment,
  recipient: string,
  subject: string,
  html: string,
  plainText: string,
  senderLabel = "News for Me"
): Promise<GmailSendResult> {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = env.GOOGLE_REFRESH_TOKEN?.trim();
  const sender = env.GMAIL_SENDER?.trim();
  if (!clientId || !clientSecret || !refreshToken || !sender) {
    throw new Error("Gmail 설정이 부족합니다. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GMAIL_SENDER를 확인하세요.");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const tokenBody = await tokenResponse.json().catch(() => ({})) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenResponse.ok || !tokenBody.access_token) {
    const reason = tokenBody.error_description ?? tokenBody.error ?? `HTTP ${tokenResponse.status}`;
    throw new Error(`Google OAuth 토큰 갱신 실패: ${reason}`);
  }

  const safeSubject = safeHeader(subject, 150);
  const safeSenderLabel = safeHeader(senderLabel, 80) || "News for Me";
  const boundary = `news_for_me_${crypto.randomUUID().replace(/-/g, "")}`;
  const plainBase64 = wrapBase64(utf8Base64(plainText));
  const htmlBase64 = wrapBase64(utf8Base64(html));
  const mime = [
    `From: ${encodeMimeHeader(safeSenderLabel)} <${sender}>`,
    `To: ${recipient}`,
    `Subject: ${encodeMimeHeader(safeSubject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    plainBase64,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    htmlBase64,
    `--${boundary}--`
  ].join("\r\n");

  const sendResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenBody.access_token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ raw: base64Url(mime) })
  });
  const sendBody = await sendResponse.json().catch(() => ({})) as {
    id?: string;
    threadId?: string;
    error?: { message?: string };
  };
  if (!sendResponse.ok) {
    throw new Error(`Gmail API 전송 실패 (${sendResponse.status}): ${sendBody.error?.message ?? "응답 내용을 확인할 수 없습니다."}`);
  }
  return {
    messageId: sendBody.id ?? null,
    threadId: sendBody.threadId ?? null
  };
}
