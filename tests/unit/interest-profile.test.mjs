import test from "node:test";
import assert from "node:assert/strict";
import { parseInterestProfileResponse } from "../../apps/worker/src/services/ai/interest-profile.ts";

test("parses a Markdown profile and bounded search hints", () => {
  const result = parseInterestProfileResponse(JSON.stringify({
    markdown: "# 관심사 프로필\n\n- AI 에이전트\n- 로컬 LLM",
    searchKeywords: ["AI 에이전트", " 로컬 LLM ", "AI 에이전트", "x".repeat(80)],
    excludeKeywords: ["코인 광고", "코인 광고"]
  }));

  assert.match(result.markdown, /관심사 프로필/);
  assert.deepEqual(result.searchKeywords, ["AI 에이전트", "로컬 LLM", "x".repeat(60)]);
  assert.deepEqual(result.excludeKeywords, ["코인 광고"]);
});

test("accepts Gemini JSON fenced code blocks", () => {
  const result = parseInterestProfileResponse(```json
{
  "markdown": "# 개인 뉴스 프로필",
  "searchKeywords": ["Cloudflare"],
  "excludeKeywords": []
}
```);
  assert.equal(result.markdown, "# 개인 뉴스 프로필");
  assert.deepEqual(result.searchKeywords, ["Cloudflare"]);
});

test("rejects responses without a Markdown profile", () => {
  assert.throws(
    () => parseInterestProfileResponse(JSON.stringify({ searchKeywords: ["AI"] })),
    /Markdown 관심사 프로필/
  );
});

test("ignores malformed keyword arrays but requires valid JSON", () => {
  const result = parseInterestProfileResponse(JSON.stringify({
    markdown: "# profile",
    searchKeywords: "not-an-array",
    excludeKeywords: [null, "광고"]
  }));
  assert.deepEqual(result.searchKeywords, []);
  assert.deepEqual(result.excludeKeywords, ["광고"]);
  assert.throws(() => parseInterestProfileResponse("not json"));
});
