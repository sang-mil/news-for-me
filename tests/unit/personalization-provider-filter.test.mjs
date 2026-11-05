import test from "node:test";
import assert from "node:assert/strict";
import {
  recordArticleEvent,
  getUserBehaviorSignals,
  getInterestProfile
} from "../../apps/worker/src/db/repositories/personalization.ts";

function mockDb({ provider = "youtube-data-api" } = {}) {
  const calls = [];
  return {
    calls,
    db: {
      prepare(sql) {
        const call = { sql, values: [] };
        calls.push(call);
        return {
          bind(...values) {
            call.values = values;
            return this;
          },
          async first() {
            if (call.sql.includes("FROM articles")) {
              return { title: "YouTube title", source_name: "YouTube", provider };
            }
            if (call.sql.includes("FROM user_interest_profiles")) return null;
            if (call.sql.includes("COUNT(*)")) return { count: 0 };
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1 } };
          }
        };
      }
    }
  };
}

test("YouTube API article events are not copied into behavior event records", async () => {
  const { db, calls } = mockDb();
  await recordArticleEvent(db, "user-1", "video-1", "topic-1", "opened");

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /SELECT title, source_name, provider FROM articles/);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO article_user_events")), false);
});

test("interest profiling excludes YouTube metadata from saved and event signals", async () => {
  const { db, calls } = mockDb({ provider: "google-news-rss" });
  await getUserBehaviorSignals(db, "user-1");

  const eventsQuery = calls.find((call) => call.sql.includes("FROM article_user_events"));
  const savedQuery = calls.find((call) => call.sql.includes("FROM article_saves"));

  assert.match(eventsQuery.sql, /provider = 'youtube-data-api'/);
  assert.match(savedQuery.sql, /a\.provider <> 'youtube-data-api'/);
});

test("interest profile event counts exclude YouTube API records", async () => {
  const { db, calls } = mockDb();
  await getInterestProfile(db, "user-1");
  const countQuery = calls.find((call) => call.sql.includes("COUNT(*) AS count"));

  assert.match(countQuery.sql, /provider = 'youtube-data-api'/);
});
