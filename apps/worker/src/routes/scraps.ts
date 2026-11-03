import type { SavedNewsArticle, SavedNewsTag } from "@news-for-me/shared";
import { jsonResponse } from "../lib/http";
import {
  createUserTag,
  deleteUserTag,
  listSavedArticles,
  listUserTags,
  removeSavedArticle,
  replaceSavedArticleTags,
  saveArticleForUser,
  updateSavedArticleNote,
  updateUserTag
} from "../db/repositories/scraps";

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validTagName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 30;
}

function validColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export async function handleScrapsRequest(
  request: Request,
  db: D1Database,
  userId: string,
  allowedOrigin: string
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/scraps" && request.method === "GET") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? "100");
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(200, Math.max(1, Math.floor(requestedLimit)))
      : 100;
    const data: SavedNewsArticle[] = await listSavedArticles(db, userId, limit);
    return jsonResponse({ data }, 200, allowedOrigin);
  }

  if (url.pathname === "/api/tags" && request.method === "GET") {
    const data: SavedNewsTag[] = await listUserTags(db, userId);
    return jsonResponse({ data }, 200, allowedOrigin);
  }

  if (url.pathname === "/api/tags" && request.method === "POST") {
    const body = await readJson(request);
    const name = body?.name;
    if (!validTagName(name)) {
      return jsonResponse({ error: "Tag name must contain 1–30 characters." }, 400, allowedOrigin);
    }
    const colorValue = body?.color === undefined ? "#64748b" : body.color;
    if (!validColor(colorValue)) {
      return jsonResponse({ error: "Tag color must be a six-digit hex color." }, 400, allowedOrigin);
    }
    try {
      const data = await createUserTag(db, userId, name.trim(), colorValue);
      return jsonResponse({ data }, 201, allowedOrigin);
    } catch {
      return jsonResponse({ error: "A tag with this name already exists." }, 409, allowedOrigin);
    }
  }

  const tagMatch = url.pathname.match(/^\/api\/tags\/([^/]+)$/);
  if (tagMatch && request.method === "PATCH") {
    let tagId: string;
    try { tagId = decodeURIComponent(tagMatch[1]); }
    catch { return jsonResponse({ error: "Invalid tag ID." }, 400, allowedOrigin); }

    const body = await readJson(request);
    if (!body) return jsonResponse({ error: "Invalid JSON body." }, 400, allowedOrigin);
    const name = body.name === undefined ? null : body.name;
    const color = body.color === undefined ? null : body.color;
    if (name !== null && !validTagName(name)) {
      return jsonResponse({ error: "Tag name must contain 1–30 characters." }, 400, allowedOrigin);
    }
    if (color !== null && !validColor(color)) {
      return jsonResponse({ error: "Tag color must be a six-digit hex color." }, 400, allowedOrigin);
    }
    if (name === null && color === null) {
      return jsonResponse({ error: "Provide a tag name or color to update." }, 400, allowedOrigin);
    }
    try {
      const data = await updateUserTag(
        db, userId, tagId,
        typeof name === "string" ? name.trim() : null,
        typeof color === "string" ? color : null
      );
      return data
        ? jsonResponse({ data }, 200, allowedOrigin)
        : jsonResponse({ error: "Tag not found." }, 404, allowedOrigin);
    } catch {
      return jsonResponse({ error: "A tag with this name already exists." }, 409, allowedOrigin);
    }
  }

  if (tagMatch && request.method === "DELETE") {
    let tagId: string;
    try { tagId = decodeURIComponent(tagMatch[1]); }
    catch { return jsonResponse({ error: "Invalid tag ID." }, 400, allowedOrigin); }
    await deleteUserTag(db, userId, tagId);
    return jsonResponse({ ok: true }, 200, allowedOrigin);
  }

  const noteMatch = url.pathname.match(/^\/api\/scraps\/([^/]+)\/note$/);
  if (noteMatch && request.method === "PATCH") {
    let articleId: string;
    try { articleId = decodeURIComponent(noteMatch[1]); }
    catch { return jsonResponse({ error: "Invalid article ID." }, 400, allowedOrigin); }
    const body = await readJson(request);
    if (!body || typeof body.note !== "string" || body.note.length > 5000) {
      return jsonResponse({ error: "Note must be a string up to 5000 characters." }, 400, allowedOrigin);
    }
    const note = body.note.trim() || null;
    const data = await updateSavedArticleNote(db, userId, articleId, note);
    return data
      ? jsonResponse({ data }, 200, allowedOrigin)
      : jsonResponse({ error: "Saved article not found." }, 404, allowedOrigin);
  }

  const articleTagsMatch = url.pathname.match(/^\/api\/scraps\/([^/]+)\/tags$/);
  if (articleTagsMatch && request.method === "PUT") {
    let articleId: string;
    try { articleId = decodeURIComponent(articleTagsMatch[1]); }
    catch { return jsonResponse({ error: "Invalid article ID." }, 400, allowedOrigin); }
    const body = await readJson(request);
    if (!body || !Array.isArray(body.tagIds) || body.tagIds.length > 20 ||
        !body.tagIds.every((id) => typeof id === "string" && id.length <= 100)) {
      return jsonResponse({ error: "tagIds must be an array of up to 20 tag IDs." }, 400, allowedOrigin);
    }
    const tagIds = [...new Set(body.tagIds as string[])];
    const ok = await replaceSavedArticleTags(db, userId, articleId, tagIds);
    if (!ok) {
      return jsonResponse({ error: "Saved article or one of the tags was not found." }, 404, allowedOrigin);
    }
    const data = await listSavedArticles(db, userId, 200);
    const article = data.find((item) => item.id === articleId);
    return article
      ? jsonResponse({ data: article }, 200, allowedOrigin)
      : jsonResponse({ error: "Saved article not found." }, 404, allowedOrigin);
  }

  const saveMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/articles\/([^/]+)\/scrap$/);
  if (saveMatch && request.method === "POST") {
    let topicId: string;
    let articleId: string;
    try {
      topicId = decodeURIComponent(saveMatch[1]);
      articleId = decodeURIComponent(saveMatch[2]);
    } catch {
      return jsonResponse({ error: "Invalid topic or article ID." }, 400, allowedOrigin);
    }
    const saved = await saveArticleForUser(db, userId, topicId, articleId);
    if (!saved) {
      return jsonResponse({ error: "Article not found in one of your topics." }, 404, allowedOrigin);
    }
    return jsonResponse({ data: saved }, 201, allowedOrigin);
  }

  const removeMatch = url.pathname.match(/^\/api\/scraps\/([^/]+)$/);
  if (removeMatch && request.method === "DELETE") {
    let articleId: string;
    try { articleId = decodeURIComponent(removeMatch[1]); }
    catch { return jsonResponse({ error: "Invalid article ID." }, 400, allowedOrigin); }
    await removeSavedArticle(db, userId, articleId);
    return jsonResponse({ ok: true }, 200, allowedOrigin);
  }

  return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);
}