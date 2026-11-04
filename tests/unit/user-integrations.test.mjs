import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials
} from "../../apps/worker/src/services/integrations.ts";

function makeKey() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

test("AES-GCM credentials round-trip without exposing plaintext", async () => {
  const key = makeKey();
  const secret = "private-api-key-value";
  const encrypted = await encryptIntegrationCredentials({ secret }, key, "account-a:gemini");

  assert.equal(encrypted.includes(secret), false);
  assert.deepEqual(await decryptIntegrationCredentials(encrypted, key, "account-a:gemini"), { secret });
});

test("AES-GCM uses a fresh IV for every encryption", async () => {
  const key = makeKey();
  const credentials = { secret: "same-secret" };
  const first = await encryptIntegrationCredentials(credentials, key, "account-a:gemini");
  const second = await encryptIntegrationCredentials(credentials, key, "account-a:gemini");

  assert.notEqual(first, second);
  assert.deepEqual(await decryptIntegrationCredentials(first, key, "account-a:gemini"), credentials);
  assert.deepEqual(await decryptIntegrationCredentials(second, key, "account-a:gemini"), credentials);
});

test("credentials cannot be decrypted with another user's key", async () => {
  const encrypted = await encryptIntegrationCredentials({ secret: "user-one-secret" }, makeKey(), "account-a:threads");
  await assert.rejects(() => decryptIntegrationCredentials(encrypted, makeKey(), "account-a:threads"));
});

test("tampered ciphertext is rejected", async () => {
  const key = makeKey();
  const encrypted = await encryptIntegrationCredentials({ secret: "tamper-check" }, key, "account-a:x");
  const bytes = Buffer.from(encrypted, "base64");
  bytes[bytes.length - 1] ^= 1;

  await assert.rejects(() => decryptIntegrationCredentials(bytes.toString("base64"), key, "account-a:x"));
});

test("invalid encryption key sizes are rejected", async () => {
  await assert.rejects(
    () => encryptIntegrationCredentials({ secret: "not-saved" }, Buffer.from("too-short").toString("base64"), "account-a:gemini"),
    /exactly 32 bytes/
  );
});


test("ciphertext is bound to its user and provider context", async () => {
  const key = makeKey();
  const encrypted = await encryptIntegrationCredentials(
    { secret: "account-bound-secret" }, key, "user-a:threads"
  );
  await assert.rejects(() => decryptIntegrationCredentials(encrypted, key, "user-b:threads"));
  await assert.rejects(() => decryptIntegrationCredentials(encrypted, key, "user-a:x"));
});
