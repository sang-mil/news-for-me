import type { TopicInput } from "@news-for-me/shared";
import {
  createTopic,
  deleteTopic,
  getTopic,
  listTopics,
  updateTopic
} from "../db/repositories/topics";
import { jsonResponse } from "../lib/http";

interface TopicPayload {
  name?: unknown;
  description?: unknown;
  includeKeywords?: unknown;
  excludeKeywords?: unknown;
}

interface ValidationResult {
  value?: Partial<TopicInput> & { name?: string };
  errors: string[];
}

function normalizeKeywords(value: unknown, fieldName: string, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array of strings.`);
    return undefined;
  }
  if (value.length > 20) {
    errors.push(`${fieldName} can contain at most 20 keywords.`);
    return undefined;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      errors.push(`${fieldName} must contain only strings.`);
      continue;
    }
    const keyword = item.trim();
    if (!keyword) continue;
    if (keyword.length > 60) {
      errors.push(`Each ${fieldName} keyword must be 60 characters or fewer.`);
      continue;
    }
    const key = keyword.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(keyword);
    }
  }

  return normalized;
}

function validatePayload(payload: unknown, partial: boolean): ValidationResult {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { errors: ["Request body must be a JSON object."] };
  }

  const body = payload as TopicPayload;
  const value: Partial<TopicInput> & { name?: string } = {};
  const allowedKeys = new Set(["name", "description", "includeKeywords", "excludeKeywords"]);

  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) errors.push(`Unknown field: ${key}`);
  }

  if (!partial || body.name !== undefined) {
    if (typeof body.name !== "string") {
      errors.push("name is required and must be a string.");
    } else {
      const name = body.name.trim();
      if (name.length < 1 || name.length > 80) {
        errors.push("name must be between 1 and 80 characters.");
      } else {
        value.name = name;
      }
    }
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      errors.push("description must be a string or null.");
    } else if (typeof body.description === "string" && body.description.trim().length > 500) {
      errors.push("description must be 500 characters or fewer.");
    } else {
      value.description = typeof body.description === "string"
        ? body.description.trim() || null
        : null;
    }
  } else if (!partial) {
    value.description = null;
  }

  const includeKeywords = normalizeKeywords(body.includeKeywords, "includeKeywords", errors);
  const excludeKeywords = normalizeKeywords(body.excludeKeywords, "excludeKeywords", errors);

  if (includeKeywords !== undefined) value.includeKeywords = includeKeywords;
  else if (!partial) value.includeKeywords = [];

  if (excludeKeywords !== undefined) value.excludeKeywords = excludeKeywords;
  else if (!partial) value.excludeKeywords = [];

  if (partial && Object.keys(body).length === 0) {
    errors.push("At least one field must be provided.");
  }

  return { value, errors };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("Request body must contain valid JSON.");
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("unique constraint");
}

export async function handleTopicsRequest(
  request: Request,
  db: D1Database,
  userId: string,
  allowedOrigin: string
): Promise<Response> {
  const url = new URL(request.url);
  const collectionPath = url.pathname === "/api/topics";
  const topicMatch = url.pathname.match(/^\/api\/topics\/([^/]+)$/);

  if (!collectionPath && !topicMatch) {
    return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);
  }

  if (collectionPath && request.method === "GET") {
    const topics = await listTopics(db, userId);
    return jsonResponse({ data: topics }, 200, allowedOrigin);
  }

  if (collectionPath && request.method === "POST") {
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (error) {
      return jsonResponse({ error: (error as Error).message }, 400, allowedOrigin);
    }

    const validation = validatePayload(body, false);
    if (validation.errors.length || !validation.value) {
      return jsonResponse({ error: "Validation failed", details: validation.errors }, 400, allowedOrigin);
    }

    try {
      const topic = await createTopic(db, userId, validation.value as Required<TopicInput>);
      return jsonResponse({ data: topic }, 201, allowedOrigin);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return jsonResponse({ error: "A topic with this name already exists." }, 409, allowedOrigin);
      }
      throw error;
    }
  }

  if (topicMatch) {
    let topicId: string;
    try {
      topicId = decodeURIComponent(topicMatch[1]);
    } catch {
      return jsonResponse({ error: "Invalid topic ID." }, 400, allowedOrigin);
    }

    if (!topicId || topicId.length > 100) {
      return jsonResponse({ error: "Invalid topic ID." }, 400, allowedOrigin);
    }

    if (request.method === "GET") {
      const topic = await getTopic(db, userId, topicId);
      return topic
        ? jsonResponse({ data: topic }, 200, allowedOrigin)
        : jsonResponse({ error: "Topic not found." }, 404, allowedOrigin);
    }

    if (request.method === "PATCH") {
      let body: unknown;
      try {
        body = await readJson(request);
      } catch (error) {
        return jsonResponse({ error: (error as Error).message }, 400, allowedOrigin);
      }

      const validation = validatePayload(body, true);
      if (validation.errors.length || !validation.value) {
        return jsonResponse({ error: "Validation failed", details: validation.errors }, 400, allowedOrigin);
      }

      try {
        const topic = await updateTopic(db, userId, topicId, validation.value);
        return topic
          ? jsonResponse({ data: topic }, 200, allowedOrigin)
          : jsonResponse({ error: "Topic not found." }, 404, allowedOrigin);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return jsonResponse({ error: "A topic with this name already exists." }, 409, allowedOrigin);
        }
        throw error;
      }
    }

    if (request.method === "DELETE") {
      const deleted = await deleteTopic(db, userId, topicId);
      return deleted
        ? jsonResponse({ ok: true }, 200, allowedOrigin)
        : jsonResponse({ error: "Topic not found." }, 404, allowedOrigin);
    }
  }

  return jsonResponse(
    { error: "Method not allowed." },
    405,
    allowedOrigin
  );
}
