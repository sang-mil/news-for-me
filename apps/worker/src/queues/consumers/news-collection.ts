import {
  getTopicForCollection,
  markCollectionDeadLettered,
  markCollectionRetrying,
  markCollectionStarted,
  storeCollectedArticles
} from "../../db/repositories/news";
import { googleNewsRssSource } from "../../services/news/sources/google-news-rss";
import { searchBingNewsRss } from "../../services/news/sources/bing-news-rss";
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

  const searchInput = {
    topicName: topic.name,
    includeKeywords: parseKeywords(topic.include_keywords_json),
    excludeKeywords: parseKeywords(topic.exclude_keywords_json)
  };

  let items: Awaited<ReturnType<typeof googleNewsRssSource.search>> = [];
  let googleFailure: string | null = null;
  let collectionNote: string | null = null;

  try {
    items = await googleNewsRssSource.search(searchInput);
    if (items.length === 0) {
      googleFailure = "Google News RSS responded successfully but returned 0 matching articles.";
      console.warn("[NewsForMe][RSS] Google News RSS returned 0 articles; trying Bing fallback", {
        runId: job.runId,
        topicId: job.topicId
      });
    } else {
      console.info("[NewsForMe][RSS] Google News RSS succeeded", {
        runId: job.runId,
        topicId: job.topicId,
        articlesFound: items.length
      });
    }
  } catch (error) {
    googleFailure = error instanceof Error ? error.message : String(error);
    console.warn("[NewsForMe][RSS] Google News RSS failed; trying Bing fallback", {
      runId: job.runId,
      topicId: job.topicId,
      error: googleFailure
    });
  }

  if (items.length === 0) {
    try {
      const fallbackItems = await searchBingNewsRss(searchInput);
      items = fallbackItems;

      if (items.length > 0) {
        collectionNote = `Google News RSS unavailable or empty (${googleFailure ?? "no details"}). Bing News RSS fallback collected ${items.length} articles.`;
        console.info("[NewsForMe][RSS] Bing News RSS fallback succeeded", {
          runId: job.runId,
          topicId: job.topicId,
          articlesFound: items.length,
          primaryError: googleFailure
        });
      } else {
        collectionNote = `Google News RSS unavailable or empty (${googleFailure ?? "no details"}). Bing News RSS responded successfully but returned 0 matching articles.`;
        console.warn("[NewsForMe][RSS] both sources returned no usable articles", {
          runId: job.runId,
          topicId: job.topicId,
          primaryError: googleFailure,
          fallbackArticlesFound: 0
        });
      }
    } catch (error) {
      const fallbackFailure = error instanceof Error ? error.message : String(error);
      console.error("[NewsForMe][RSS] all RSS sources failed", {
        runId: job.runId,
        topicId: job.topicId,
        googleError: googleFailure,
        bingError: fallbackFailure
      });
      throw new Error(
        `All news RSS sources failed. Google News RSS: ${googleFailure ?? "no usable articles"}; Bing News RSS: ${fallbackFailure}`
      );
    }
  }

  const storedArticles = await storeCollectedArticles(env.DB, job, items, collectionNote);
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

    console.info("[NewsForMe][Collection] job started", {
      runId: message.body.runId,
      topicId: message.body.topicId,
      queue: batch.queue
    });

    try {
      await processCollectionJob(message.body, env);
      console.info("[NewsForMe][Collection] job completed", {
        runId: message.body.runId,
        topicId: message.body.topicId
      });
      message.ack();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown collection error";
      try {
        await markCollectionRetrying(env.DB, message.body.runId, detail);
      } catch (dbError) {
        console.error("[NewsForMe][Collection] could not persist retry state", {
          runId: message.body.runId,
          error: dbError instanceof Error ? dbError.message : String(dbError)
        });
      }
      console.error("[NewsForMe][Collection] job failed; retry scheduled", {
        runId: message.body.runId,
        topicId: message.body.topicId,
        retryDelaySeconds: 30,
        errorName: error instanceof Error ? error.name : "UnknownError",
        error: detail
      });
      message.retry({ delaySeconds: 30 });
    }
  }
}