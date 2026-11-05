import test from "node:test";
import assert from "node:assert/strict";
import { cleanupExpiredYouTubeData } from "../../apps/worker/src/services/maintenance/article-cleanup.ts";

test("YouTube retention cleanup removes dependent data before article rows", async () => {
  const now = "2026-11-05T12:00:00.000Z";
  const prepared = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        }
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      assert.equal(statements.length, 5);
      return statements.map((statement, index) => ({
        meta: { changes: index + 1 },
        sql: statement.sql,
        values: statement.values
      }));
    }
  };

  const result = await cleanupExpiredYouTubeData(db, now);

  assert.deepEqual(prepared.map((statement) => statement.sql.match(/DELETE FROM ([a-z_]+)/)?.[1]), [
    "article_user_events",
    "article_saves",
    "user_topic_articles",
    "topic_articles",
    "articles"
  ]);
  for (const statement of prepared) {
    assert.match(statement.sql, /provider = 'youtube-data-api'/);
    assert.match(statement.sql, /provider_data_refreshed_at/);
    assert.match(statement.sql, /julianday\(\?, '-29 days'\)/);
    assert.deepEqual(statement.values, [now]);
  }
  assert.deepEqual(result, {
    behaviorEventsDeleted: 1,
    savedItemsDeleted: 2,
    personalFeedLinksDeleted: 3,
    topicArticleLinksDeleted: 4,
    articlesDeleted: 5
  });
});


import { selectSummarizableArticles } from "../../apps/worker/src/services/ai/summarization-filter.ts";

test("YouTube API results are excluded from AI summarization", () => {
  const video = {
    articleId: "video-1",
    item: { provider: "youtube-data-api", title: "Video title" }
  };
  const news = {
    articleId: "news-1",
    item: { provider: "google-news-rss", title: "News title" }
  };

  assert.deepEqual(selectSummarizableArticles([video, news, video]), [news]);
});
