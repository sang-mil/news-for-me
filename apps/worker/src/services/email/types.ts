export interface GmailEnvironment {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  GMAIL_SENDER?: string;
}

export interface NewsletterArticle {
  articleId: string;
  topicName: string;
  title: string;
  canonicalUrl: string;
  sourceName: string | null;
  publishedAt: string | null;
  summary: string;
  detailedSummary: string | null;
  keyPoints: string[];
  insight: string | null;
  importance: "urgent" | "high" | "normal" | "low";
  modelProvider: string;
  modelName: string;
  isSaved: boolean;
}

export interface NewsletterContent {
  subject: string;
  html: string;
  text: string;
  articleCount: number;
  periodDays: number;
  generatedAt: string;
}

export interface GmailSendResult {
  messageId: string | null;
  threadId: string | null;
}
