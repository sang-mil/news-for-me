import type { CollectedNewsItem } from "../news/types";

export type AIProviderName = "gemini" | "openrouter";
export type SummaryImportance = "urgent" | "high" | "normal" | "low";

export interface AIEnvironment {
  GEMINI_API_KEY_1?: string;
  GEMINI_API_KEY_2?: string;
  GEMINI_PROJECT_SLOT_1?: string;
  GEMINI_PROJECT_SLOT_2?: string;
  GEMINI_MODEL_PRIMARY?: string;
  GEMINI_MODEL_FALLBACK?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_ALLOW_PAID?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_TITLE?: string;
}

export interface StoredArticleForAI {
  articleId: string;
  item: CollectedNewsItem;
}

export interface ArticleSummaryOutput {
  articleId: string;
  summary: string;
  detailedSummary: string;
  keyPoints: string[];
  insight: string;
  importance: SummaryImportance;
}

export interface ProviderTextResult {
  provider: AIProviderName;
  model: string;
  text: string;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}

export function hasAIProviderConfigured(env: AIEnvironment): boolean {
  return Boolean(
    env.GEMINI_API_KEY_1?.trim() ||
    env.GEMINI_API_KEY_2?.trim() ||
    env.OPENROUTER_API_KEY?.trim()
  );
}

export function toStoredArticleForAI(
  articleId: string,
  item: CollectedNewsItem
): StoredArticleForAI {
  return { articleId, item };
}