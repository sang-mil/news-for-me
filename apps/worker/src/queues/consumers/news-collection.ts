import {
  getTopicForCollection, markCollectionDeadLettered, markCollectionRetrying,
  markCollectionStarted, storeCollectedArticles
} from "../../db/repositories/news";
import { collectFromSources } from "../../services/news/collection-engine";
import { googleNewsRssSource } from "../../services/news/sources/google-news-rss";
import { searchBingNewsRss } from "../../services/news/sources/bing-news-rss";
import { searchGitHubRepositories } from "../../services/news/sources/github-search";
import { searchV2exTopics } from "../../services/news/sources/v2ex";
import { createYouTubeVideosSource } from "../../services/news/sources/youtube";
import { createXPostsSource } from "../../services/news/sources/x";
import { isSoftwareOrTechTopic } from "../../services/news/relevance";
import { summarizeCollectedArticles } from "../../services/ai/summarizer";
import type { AIEnvironment } from "../../services/ai/types";
import type { CollectionJobMessage, NewsSource } from "../../services/news/types";

interface CollectionConsumerEnv extends AIEnvironment { DB: D1Database; YOUTUBE_API_KEY?: string; X_BEARER_TOKEN?: string; }

function parseKeywords(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

async function processCollectionJob(job: CollectionJobMessage, env: CollectionConsumerEnv): Promise<void> {
  await markCollectionStarted(env.DB, job.runId);
  const topic = await getTopicForCollection(env.DB, job.userId, job.topicId);
  if (!topic) throw new Error("Topic no longer exists or is inactive.");

  const maxArticles = Math.min(30, Math.max(5, Math.floor(job.maxArticles ?? 10)));
  const searchInput = { topicName: topic.name, includeKeywords: parseKeywords(topic.include_keywords_json), excludeKeywords: parseKeywords(topic.exclude_keywords_json), maxResults: maxArticles };
  const sources: NewsSource[] = [
    googleNewsRssSource,
    { id: "bing-news-rss", contentType: "article", search: async (input) => (await searchBingNewsRss(input)).items }
  ];
  const skippedSources: string[] = [];
  const softwareTopic = isSoftwareOrTechTopic(searchInput);

  if (softwareTopic) {
    sources.push(
      { id: "github-search", contentType: "repository", search: (input) => searchGitHubRepositories(input) },
      { id: "v2ex-public-api", contentType: "discussion", search: (input) => searchV2exTopics(input) }
    );
  } else {
    skippedSources.push("github-search (not a software/technology topic)", "v2ex-public-api (not a software/technology topic)");
  }

  if (env.YOUTUBE_API_KEY?.trim()) {
    sources.push(createYouTubeVideosSource(env.YOUTUBE_API_KEY.trim()));
  } else {
    skippedSources.push("youtube-data-api (missing YOUTUBE_API_KEY)");
    console.warn("[NewsForMe][YouTube] source skipped: YOUTUBE_API_KEY is not available in this Worker deployment");
  }

  if (env.X_BEARER_TOKEN?.trim()) {
    sources.push(createXPostsSource(env.X_BEARER_TOKEN.trim()));
  } else {
    skippedSources.push("x-api (missing X_BEARER_TOKEN)");
  }
  const collection = await collectFromSources(sources, searchInput, maxArticles);
  const sourceSummary = Object.entries(collection.sourceCounts).map(([id, count]) => id + "=" + count).join(", ");
  const failureSummary = collection.failures.map((failure) => failure.sourceId + ": " + failure.message).join(" | ");
  const collectionNote = [
    "Requested up to " + maxArticles + " items.",
    "Source counts: " + (sourceSummary || "none") + ".",
    failureSummary ? "Partial source failures: " + failureSummary : null,
    skippedSources.length ? "Skipped sources: " + skippedSources.join(", ") : null
  ].filter(Boolean).join(" ");

  const storedArticles = await storeCollectedArticles(env.DB, job, collection.items, collectionNote);
  const result = await summarizeCollectedArticles(env.DB, job.runId, job.topicId, storedArticles, env);
  console.log("News collection pipeline completed", job.runId, "items:", storedArticles.length, "sources:", sourceSummary, "summarized:", result.summarized, "skipped:", result.skipped);
}

export async function handleNewsCollectionQueue(batch: MessageBatch<CollectionJobMessage>, env: CollectionConsumerEnv): Promise<void> {
  const isDeadLetterQueue = batch.queue === "news-for-me-collection-dlq";
  for (const message of batch.messages) {
    if (isDeadLetterQueue) {
      try { await markCollectionDeadLettered(env.DB, message.body.runId); console.error("News collection moved to dead-letter queue", message.body.runId); message.ack(); }
      catch (error) { console.error("Could not finalize dead-lettered collection", error); message.retry({ delaySeconds: 30 }); }
      continue;
    }
    console.info("[NewsForMe][Collection] job started", { runId: message.body.runId, topicId: message.body.topicId, queue: batch.queue });
    try {
      await processCollectionJob(message.body, env);
      console.info("[NewsForMe][Collection] job completed", { runId: message.body.runId, topicId: message.body.topicId });
      message.ack();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown collection error";
      try { await markCollectionRetrying(env.DB, message.body.runId, detail); }
      catch (dbError) { console.error("[NewsForMe][Collection] could not persist retry state", { runId: message.body.runId, error: dbError instanceof Error ? dbError.message : String(dbError) }); }
      console.error("[NewsForMe][Collection] job failed; retry scheduled", { runId: message.body.runId, topicId: message.body.topicId, retryDelaySeconds: 30, errorName: error instanceof Error ? error.name : "UnknownError", error: detail });
      message.retry({ delaySeconds: 30 });
    }
  }
}
