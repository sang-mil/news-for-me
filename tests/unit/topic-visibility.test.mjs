import test from "node:test";
import assert from "node:assert/strict";
import { listTopics, getTopic } from "../../apps/worker/src/db/repositories/topics.ts";
import { getTopicForCollection, getCollectionRun } from "../../apps/worker/src/db/repositories/news.ts";

function createDbMock() {
  const calls = [];
  const db = {
    prepare(sql) {
      const call = { sql, values: [] };
      calls.push(call);
      const statement = {
        bind(...values) {
          call.values = values;
          return this;
        },
        async all() {
          return { results: [] };
        },
        async first() {
          return call.sql.includes("COUNT(*)") ? { count: 2 } : null;
        }
      };
      return statement;
    }
  };
  return { db, calls };
}

test("topic listing returns only owned or explicitly public topics", async () => {
  const { db, calls } = createDbMock();
  const result = await listTopics(db, "viewer-1", 2, 5);
  const listQuery = calls.find((call) => call.sql.includes("LEFT JOIN users"));
  const countQuery = calls.find((call) => call.sql.includes("COUNT(*) AS count FROM topics WHERE"));

  assert.ok(listQuery);
  assert.match(listQuery.sql, /WHERE t\.user_id\s*=\s*\? OR t\.is_public\s*=\s*1/);
  assert.deepEqual(listQuery.values, ["viewer-1", "viewer-1", 5, 5]);
  assert.ok(countQuery);
  assert.match(countQuery.sql, /WHERE user_id=\? OR is_public=1/);
  assert.deepEqual(countQuery.values, ["viewer-1"]);
  assert.equal(result.totalCount, 2);
});

test("individual topic lookup excludes another user's private topics", async () => {
  const { db, calls } = createDbMock();
  const topic = await getTopic(db, "viewer-1", "topic-private");
  const query = calls[0];

  assert.equal(topic, null);
  assert.match(query.sql, /WHERE t\.id\s*=\s*\? AND \(t\.user_id\s*=\s*\? OR t\.is_public\s*=\s*1\)/);
  assert.deepEqual(query.values, ["viewer-1", "topic-private", "viewer-1"]);
});

test("collection routes and jobs require the owning account", async () => {
  const { db, calls } = createDbMock();

  await getTopicForCollection(db, "topic-1", "owner-1");
  await getCollectionRun(db, "topic-1", "run-1", "owner-1");

  assert.match(calls[0].sql, /WHERE id = \? AND user_id = \? AND is_active = 1/);
  assert.deepEqual(calls[0].values, ["topic-1", "owner-1"]);
  assert.match(calls[1].sql, /WHERE cr\.id = \? AND cr\.topic_id = \? AND t\.user_id = \?/);
  assert.deepEqual(calls[1].values, ["run-1", "topic-1", "owner-1"]);
});
