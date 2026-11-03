import {
  getTopicForCollection,
  markCollectionDeadLettered,
  markCollectionRetrying,
  markCollectionStarted,
  storeCollectedArticles
} from "../../db/repositories/news";
import { googleNewsRssSource } from "../../services/news/sources/google-news-rss";
import { searchBingNewsRss } from "../../services/news/sources/bing-news-rss";
import { searchGitHubRepositories } from "../../services/news/sources/github-search";
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

  const maxArticles = Math.min(30, Math.max(5, Math.floor(job.maxArticles ?? 10)));
  const searchInput = {
    topicName: topic.name,
    includeKeywords: parseKeywords(topic.include_keywords_json),
    excludeKeywords: parseKeywords(topic.exclude_keywords_json),
    maxResults: maxArticles
  };

  const sources = [
    { id: "google-news-rss", search: () => googleNewsRssSource.search(searchInput) },
    { id: "bing-news-rss", search: async () => (await searchBingNewsRss(searchInput, maxArticles)).items },
    { id: "github-search", search: () => searchGitHubRepositories(searchInput, maxArticles) }
  ];
  const settled = await Promise.allSettled(sources.map((source) => source.search()));
  const failures: string[] = [];
  const combined = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") {
      console.info("[NewsForMe][RSS] source completed", {
        runId: job.runId, topicId: job.topicId,
        source: sources[index].id, articlesFound: result.value.length
      });
      return result.value;
    }
    const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push(`${sources[index].id}: ${detail.slice(0, 240)}`);
    console.warn("[NewsForMe][RSS] source failed", {
      runId: job.runId, topicId: job.topicId, source: sources[index].id, error: detail
    });
    return [];
  });

  if (settled.every((result) => result.status === "rejected")) {
    throw new Error(`All news sources failed. ${failures.join(" | ")}`);
  }

  const seenUrls = new Set<string>();
  const items = combined.filter((item) => {
    try {
      const normalized = new URL(item.url);
      normalized.hash = "";
      const key = normalized.toString();
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    } catch {
      return false;
    }
  }).slice(0, maxArticles);

  const collectionNote = [
    `Requested up to ${maxArticles} articles.`,
    `Sources: ${[...new Set(items.map((item) => item.provider))].join(", ") || "none"}.`,
    failures.length ? `Partial source failures: ${failures.join(" | ")}` : null
  ].filter(Boolean).join(" ");

  const storedArticles = await storeCollectedArticles(env.DB, job, items, collectionNote);
  const result = await summarizeCollectedArticles(
    env.DB, job.runId, job.topicId, storedArticles, env
  );

  console.log(
    "News collection pipeline completed",
    job.runId,
    "articles:",
    storedArticles.length,
    "providers:",
    [...new Set(items.map((item) => item.provider))],
    "diagnostic:",
    collectionNote,
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