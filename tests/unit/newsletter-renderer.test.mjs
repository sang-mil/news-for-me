import test from "node:test";
import assert from "node:assert/strict";
import { renderNewsletter } from "../../apps/worker/src/services/email/renderer.ts";
import { handleNewsletterRequest } from "../../apps/worker/src/routes/newsletter.ts";

const article = {
  articleId: "article-1",
  topicName: "AI",
  title: "A <script>alert(1)</script> headline",
  canonicalUrl: "javascript:alert(1)",
  sourceName: "Example",
  publishedAt: "2026-11-05T01:00:00.000Z",
  summary: "Summary with <unsafe> markup.",
  detailedSummary: null,
  keyPoints: ["First point", "Second point"],
  insight: "A useful insight.",
  importance: "high",
  modelProvider: "gemini",
  modelName: "gemini-test",
  isSaved: false
};

test("newsletter renderer returns email HTML and plain-text fallback", () => {
  const preview = renderNewsletter([article], 7);
  assert.equal(preview.articleCount, 1);
  assert.match(preview.subject, /최근 7일 뉴스 브리핑/);
  assert.match(preview.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(preview.html, /href="javascript:/);
  assert.match(preview.html, /href="#"|원문 기사 보기/);
  assert.match(preview.text, /A <script>alert\(1\)<\/script> headline/);
  assert.match(preview.text, /First point/);
  assert.match(preview.text, /원문:/);
});

test("newsletter renderer handles an empty preview without throwing", () => {
  const preview = renderNewsletter([], 7);
  assert.equal(preview.articleCount, 0);
  assert.match(preview.html, /AI 분석 기사 0개/);
  assert.match(preview.text, /기사 0개/);
});

test("newsletter preview endpoint returns an explicit empty preview instead of 404", async () => {
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async all() { return { results: [] }; }
      };
    }
  };
  const request = new Request("https://news-for-me.test/api/newsletter/preview");
  const response = await handleNewsletterRequest(
    request,
    { DB: db },
    "user-1",
    "https://news-for-me.test"
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.articleCount, 0);
  assert.equal(body.data.periodDays, 7);
  assert.match(body.data.html, /AI 분석 기사 0개/);
});
