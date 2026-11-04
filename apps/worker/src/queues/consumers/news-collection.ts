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
import { createThreadsPostsSource } from "../../services/news/sources/threads";
import { isSoftwareOrTechTopic } from "../../services/news/relevance";
import { summarizeCollectedArticles } from "../../services/ai/summarizer";
import type { AIEnvironment } from "../../services/ai/types";
import type { CollectionJobMessage, NewsSource } from "../../services/news/types";
import { getUserIntegration, type IntegrationProvider } from "../../services/integrations";

interface CollectionConsumerEnv extends AIEnvironment { DB: D1Database; INTEGRATION_ENCRYPTION_KEY?: string; YOUTUBE_API_KEY?: string; X_BEARER_TOKEN?: string; THREADS_ACCESS_TOKEN?: string; }

function parseKeywords(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

async function loadIntegration(
  db: D1Database,
  userId: string,
  provider: IntegrationProvider,
  encryptionKey?: string
) {
  const exists = await db.prepare(
    "SELECT 1 AS found FROM user_integrations WHERE user_id = ? AND provider = ? LIMIT 1"
  ).bind(userId, provider).first<{ found: number }>();
  if (!exists) return null;
  if (!encryptionKey?.trim()) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY is required to read saved user integrations.");
  }
  return getUserIntegration(db, userId, provider, encryptionKey);
}

function useSavedSecret(
  saved: Awaited<ReturnType<typeof loadIntegration>>,
  fallback: string | undefined
): string | undefined {
  if (saved) return saved.config.enabled === false ? undefined : saved.credentials.secret;
  return fallback?.trim() || undefined;
}


async function processCollectionJob(job: CollectionJobMessage, env: CollectionConsumerEnv): Promise<void> {
  await markCollectionStarted(env.DB, job.runId);
  const topic = await getTopicForCollection(env.DB, job.userId, job.topicId);
  if (!topic) throw new Error("Topic no longer exists or is inactive.");

  const maxArticles = Math.min(30, Math.max(5, Math.floor(job.maxArticles ?? 10)));
  const searchInput = { topicName: topic.name, includeKeywords: parseKeywords(topic.include_keywords_json), excludeKeywords: parseKeywords(topic.exclude_keywords_json), maxResults: maxArticles };

  const [geminiIntegration, openRouterIntegration, youtubeIntegration, xIntegration, threadsIntegration] = await Promise.all([
    loadIntegration(env.DB, job.userId, "gemini", env.INTEGRATION_ENCRYPTION_KEY),
    loadIntegration(env.DB, job.userId, "openrouter", env.INTEGRATION_ENCRYPTION_KEY),
    loadIntegration(env.DB, job.userId, "youtube", env.INTEGRATION_ENCRYPTION_KEY),
    loadIntegration(env.DB, job.userId, "x", env.INTEGRATION_ENCRYPTION_KEY),
    loadIntegration(env.DB, job.userId, "threads", env.INTEGRATION_ENCRYPTION_KEY)
  ]);

  const aiEnvironment: AIEnvironment = {
    ...env,
    GEMINI_API_KEY_1: useSavedSecret(geminiIntegration, env.GEMINI_API_KEY_1),
    GEMINI_API_KEY_2: geminiIntegration ? undefined : env.GEMINI_API_KEY_2,
    GEMINI_PROJECT_SLOT_1: geminiIntegration?.config.projectSlot ?? env.GEMINI_PROJECT_SLOT_1,
    GEMINI_PROJECT_SLOT_2: geminiIntegration ? undefined : env.GEMINI_PROJECT_SLOT_2,
    GEMINI_MODEL_PRIMARY: geminiIntegration?.config.modelPrimary ?? env.GEMINI_MODEL_PRIMARY,
    GEMINI_MODEL_FALLBACK: geminiIntegration?.config.modelFallback ?? env.GEMINI_MODEL_FALLBACK,
    OPENROUTER_API_KEY: useSavedSecret(openRouterIntegration, env.OPENROUTER_API_KEY),
    OPENROUTER_MODEL: openRouterIntegration?.config.model ?? env.OPENROUTER_MODEL,
    OPENROUTER_ALLOW_PAID: openRouterIntegration
      ? (openRouterIntegration.config.allowPaid === true ? "true" : "false")
      : env.OPENROUTER_ALLOW_PAID
  };

  const youtubeApiKey = useSavedSecret(youtubeIntegration, env.YOUTUBE_API_KEY);
  const xBearerToken = useSavedSecret(xIntegration, env.X_BEARER_TOKEN);
  const threadsAccessToken = useSavedSecret(threadsIntegration, env.THREADS_ACCESS_TOKEN);
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

  if (youtubeApiKey) {
    sources.push(createYouTubeVideosSource(youtubeApiKey));
  } else {
    skippedSources.push("youtube-data-api (missing YOUTUBE_API_KEY)");
    console.warn("[NewsForMe][YouTube] source skipped: YOUTUBE_API_KEY is not available in this Worker deployment");
  }

  if (xBearerToken) {
    sources.push(createXPostsSource(xBearerToken));
  } else {
    skippedSources.push("x-api (missing X_BEARER_TOKEN)");
  }

  if (threadsAccessToken) {
    sources.push(createThreadsPostsSource(threadsAccessToken));
  } else {
    skippedSources.push("threads-api (missing THREADS_ACCESS_TOKEN)");
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
  const result = await summarizeCollectedArticles(env.DB, job.runId, job.topicId, storedArticles, aiEnvironment);
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
