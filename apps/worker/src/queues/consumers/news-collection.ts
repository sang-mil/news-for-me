import {
  getTopicForCollection,
  markCollectionDeadLettered,
  markCollectionRetrying,
  markCollectionStarted,
  storeCollectedArticles
} from "../../db/repositories/news";
import { googleNewsRssSource } from "../../services/news/sources/google-news-rss";
import { summarizeCollectedArticles } from "../../services/ai/summarizer";
import type { AIEnvironment } from "../../services/ai/types";
import type { CollectionJobMessage } from "../../services/news/types";

interface CollectionConsumerEnv extends AIEnvironment {
  DB: D1Database;
}

function parseKeywords(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function processCollectionJob(
  job: CollectionJobMessage,
  env: CollectionConsumerEnv
): Promise<void> {
  await markCollectionStarted(env.DB, job.runId);

  const topic = await getTopicForCollection(env.DB, job.userId, job.topicId);
  if (!topic) throw new Error("Topic no longer exists or is inactive.");

  const items = await googleNewsRssSource.search({
    topicName: topic.name,
    includeKeywords: parseKeywords(topic.include_keywords_json),
    excludeKeywords: parseKeywords(topic.exclude_keywords_json)
  });

  const storedArticles = await storeCollectedArticles(env.DB, job, items);
  const result = await summarizeCollectedArticles(
    env.DB, job.runId, job.topicId, storedArticles, env
  );

  console.log(
    "News collection pipeline completed",
    job.runId,
    "articles:",
    storedArticles.length,
    "summarized:",
    result.summarized,
    "skipped:",
    result.skipped
  );
}

export async function handleNewsCollectionQueue(
  batch: MessageBatch<CollectionJobMessage>,
  env: CollectionConsumerEnv
): Promise<void> {
  const isDeadLetterQueue = batch.queue === "news-for-me-collection-dlq";

  for (const message of batch.messages) {
    if (isDeadLetterQueue) {
      try {
        await markCollectionDeadLettered(env.DB, message.body.runId);
        console.error("News collection moved to dead-letter queue", message.body.runId);
        message.ack();
      } catch (error) {
        console.error("Could not finalize dead-lettered collection", error);
        message.retry({ delaySeconds: 30 });
      }
      continue;
    }

    try {
      await processCollectionJob(message.body, env);
      message.ack();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown collection error";
      try {
        await markCollectionRetrying(env.DB, message.body.runId, detail);
      } catch (dbError) {
        console.error("Could not record collection retry state", dbError);
      }
      console.error("News collection failed; queue will retry", message.body.runId, detail);
      message.retry({ delaySeconds: 30 });
    }
  }
}