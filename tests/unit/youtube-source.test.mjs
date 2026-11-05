import test from "node:test";
import assert from "node:assert/strict";
import { createYouTubeVideosSource } from "../../apps/worker/src/services/news/sources/youtube.ts";

test("YouTube API result title and description are preserved verbatim", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    items: [{
      id: { kind: "youtube#video", videoId: "video-123" },
      snippet: {
        title: "  AI model launch  ",
        description: "  Original YouTube description.\nSecond line.  ",
        publishedAt: "2026-11-05T01:00:00.000Z",
        channelId: "channel-1",
        channelTitle: "Example channel",
        thumbnails: { high: { url: "https://i.ytimg.com/vi/video-123/hqdefault.jpg" } }
      }
    }]
  });

  try {
    const source = createYouTubeVideosSource("test-api-key");
    const result = await source.search({
      topicName: "AI",
      includeKeywords: ["AI"],
      excludeKeywords: [],
      maxResults: 1
    });

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, "  AI model launch  ");
    assert.equal(result.items[0].excerpt, "  Original YouTube description.\nSecond line.  ");
    assert.equal(result.items[0].provider, "youtube-data-api");
    assert.equal(result.items[0].url, "https://www.youtube.com/watch?v=video-123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
