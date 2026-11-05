import test from "node:test";
import assert from "node:assert/strict";
import { collectFromSources } from "../../apps/worker/src/services/news/collection-engine.ts";
import { googleNewsRssSource } from "../../apps/worker/src/services/news/sources/google-news-rss.ts";
import { searchBingNewsRss } from "../../apps/worker/src/services/news/sources/bing-news-rss.ts";
import { searchGdeltNews } from "../../apps/worker/src/services/news/sources/gdelt-news.ts";

const baseInput = {
  topicName: "인공지능",
  includeKeywords: ["AI 에이전트"],
  excludeKeywords: ["광고"],
  maxResults: 3
};

function rss(items) {
  const itemXml = items.map((item) => `
    <item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <description>${item.description ?? ""}</description>
      <pubDate>Wed, 05 Nov 2026 10:00:00 +0900</pubDate>
      <source>테스트 뉴스</source>
    </item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${itemXml}</channel></rss>`;
}

test("Google News retries a transient 503 and reports rejected items", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("<html><title>Sorry</title></html>", {
        status: 503,
        headers: { "Content-Type": "text/html" }
      });
    }
    return new Response(rss([
      { title: "인공지능 새 모델 공개", link: "https://news.example.com/ai" },
      { title: "오늘의 스포츠 경기", link: "https://news.example.com/sports" }
    ]), { status: 200, headers: { "Content-Type": "application/rss+xml" } });
  };

  try {
    const result = await googleNewsRssSource.search({ ...baseInput, maxResults: 3 });
    assert.equal(calls, 2);
    assert.equal(result.items.length, 1);
    assert.equal(result.diagnostics.fetchedCount, 2);
    assert.equal(result.diagnostics.rejected.topicMismatch, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bing continues with the topic-only query when the first query is short", async () => {
  const originalFetch = globalThis.fetch;
  const requestedQueries = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedQueries.push(url.searchParams.get("q"));
    const body = requestedQueries.length === 1
      ? rss([
          { title: "인공지능 정책 발표", link: "https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fnews.example.com%2Fone" },
          { title: "연예계 소식", link: "https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fnews.example.com%2Firrelevant" }
        ])
      : rss([
          { title: "인공지능 산업 동향", link: "https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fnews.example.com%2Ftwo" },
          { title: "인공지능 정책 발표", link: "https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fnews.example.com%2Fone" }
        ]);
    return new Response(body, { status: 200, headers: { "Content-Type": "application/rss+xml" } });
  };

  try {
    const result = await searchBingNewsRss(baseInput, 3);
    assert.equal(requestedQueries.length, 2);
    assert.equal(result.items.length, 2);
    assert.equal(result.sourceDiagnostics.acceptedCount, 2);
    assert.equal(result.sourceDiagnostics.rejected.topicMismatch, 1);
    assert.equal(result.sourceDiagnostics.rejected.duplicateAcrossQueries, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GDELT widens its query and exposes relevance/exclusion counts", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    const url = new URL(String(input));
    const isBroadQuery = url.searchParams.get("query")?.includes("AI 에이전트");
    const articles = isBroadQuery
      ? [
          { title: "인공지능 AI 에이전트 도입", url: "https://global.example.com/one", seendate: "20261105T010203Z", domain: "global.example.com", language: "Korean" },
          { title: "인공지능 광고 상품", url: "https://global.example.com/ad", domain: "global.example.com", language: "Korean" },
          { title: "축구 경기 결과", url: "https://global.example.com/sports", domain: "global.example.com", language: "Korean" }
        ]
      : [
          { title: "인공지능 반도체 동향", url: "https://global.example.com/two", seendate: "20261104T010203Z", domain: "global.example.com", language: "Korean" }
        ];
    return Response.json({ articles });
  };

  try {
    const result = await searchGdeltNews(baseInput, 3);
    assert.equal(calls, 2);
    assert.equal(result.items.length, 3);
    assert.equal(result.diagnostics.fetchedCount, 4);
    assert.equal(result.diagnostics.rejected.excludedKeyword, 1);
    assert.equal(result.diagnostics.observations.titleNotMatched, 1);
    assert.equal(result.items[0].publishedAt, "2026-11-05T01:02:03.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("collection engine keeps the requested maximum, deduplicates providers and preserves diagnostics", async () => {
  const item = (url, provider) => ({
    title: provider,
    url,
    sourceName: provider,
    publishedAt: null,
    excerpt: null,
    provider
  });
  const result = await collectFromSources([
    {
      id: "source-a",
      contentType: "article",
      search: async () => ({
        items: [
          item("https://example.com/one?utm_source=a", "source-a"),
          item("https://example.com/two", "source-a")
        ],
        diagnostics: { fetchedCount: 5, acceptedCount: 2, rejected: { topicMismatch: 3 } }
      })
    },
    {
      id: "source-b",
      contentType: "article",
      search: async () => [item("https://example.com/one?utm_source=b", "source-b"), item("https://example.com/three", "source-b")]
    },
    {
      id: "source-failing",
      contentType: "article",
      search: async () => { throw new Error("temporary outage"); }
    }
  ], baseInput, 5);

  assert.equal(result.items.length, 3);
  assert.equal(result.mergeDiagnostics.candidateCount, 4);
  assert.equal(result.mergeDiagnostics.uniqueCount, 3);
  assert.equal(result.mergeDiagnostics.duplicateCount, 1);
  assert.equal(result.sourceDiagnostics["source-a"].rejected.topicMismatch, 3);
  assert.equal(result.failures[0].sourceId, "source-failing");
});
