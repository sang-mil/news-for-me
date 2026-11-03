$ErrorActionPreference = 'Stop'

$ProjectRoot = 'C:\dev\news-for-me'
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "프로젝트 폴더를 찾을 수 없습니다: $ProjectRoot"
}
Set-Location $ProjectRoot

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $ProjectRoot ".local-backups\topic-crud-$stamp"

function Write-ProjectFile {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $destination = Join-Path $ProjectRoot $RelativePath
    $parent = Split-Path -Parent $destination

    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        $backupPath = Join-Path $backupRoot $RelativePath
        $backupParent = Split-Path -Parent $backupPath
        if (-not (Test-Path -LiteralPath $backupParent)) {
            New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
        }
        Copy-Item -LiteralPath $destination -Destination $backupPath -Force
        Write-Host "[BACKUP] $RelativePath" -ForegroundColor Yellow
    }

    Set-Content -LiteralPath $destination -Value $Content -Encoding utf8
    Write-Host "[WRITE]  $RelativePath" -ForegroundColor Green
}

# Ensure local development identity is not committed or deployed.
$devVarsPath = Join-Path $ProjectRoot 'apps\worker\.dev.vars'
if (-not (Test-Path -LiteralPath $devVarsPath)) {
    Write-ProjectFile 'apps/worker/.dev.vars' @'
DEV_USER_ID="local-dev-user"
DEV_USER_EMAIL="developer@localhost.invalid"
'@
} else {
    # Preserve any existing API keys and append only missing local identity settings.
    $existingVars = Get-Content -LiteralPath $devVarsPath -Raw
    $missingVars = @()
    if ($existingVars -notmatch '(?m)^\s*DEV_USER_ID\s*=') {
        $missingVars += 'DEV_USER_ID="local-dev-user"'
    }
    if ($existingVars -notmatch '(?m)^\s*DEV_USER_EMAIL\s*=') {
        $missingVars += 'DEV_USER_EMAIL="developer@localhost.invalid"'
    }
    if ($missingVars.Count -gt 0) {
        Add-Content -LiteralPath $devVarsPath -Value ("`r`n" + ($missingVars -join "`r`n")) -Encoding utf8
        Write-Host '[UPDATE] Added missing local development identity settings to .dev.vars' -ForegroundColor Green
    } else {
        Write-Host '[KEEP]   Existing local development identity settings preserved.' -ForegroundColor Cyan
    }
}

Write-ProjectFile 'apps/worker/.dev.vars.example' @'
# Local-only development identity. Never use this as production authentication.
DEV_USER_ID="local-dev-user"
DEV_USER_EMAIL="developer@localhost.invalid"
'@

Write-ProjectFile 'apps/worker/migrations/0002_topics_name_unique_nocase.sql' @'
-- Enforce case-insensitive topic names per user (e.g. OpenAI == openai).
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_user_name_nocase
ON topics(user_id, name COLLATE NOCASE);
'@

Write-ProjectFile 'packages/shared/src/index.ts' @'
export interface ApiHealthResponse {
  ok: boolean;
  service: "news-for-me-api";
  timestamp: string;
  database: "connected";
}

export interface Topic {
  id: string;
  name: string;
  description: string | null;
  includeKeywords: string[];
  excludeKeywords: string[];
  isActive: boolean;
  lastCollectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TopicInput {
  name: string;
  description?: string | null;
  includeKeywords?: string[];
  excludeKeywords?: string[];
}

export interface TopicListResponse {
  data: Topic[];
}

export interface TopicResponse {
  data: Topic;
}

export interface ApiErrorResponse {
  error: string;
  details?: string[];
}
'@

Write-ProjectFile 'apps/worker/src/db/repositories/topics.ts' @'
import type { Topic, TopicInput } from "@news-for-me/shared";

interface TopicRow {
  id: string;
  name: string;
  description: string | null;
  include_keywords_json: string;
  exclude_keywords_json: string;
  is_active: number;
  last_collected_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    includeKeywords: parseStringArray(row.include_keywords_json),
    excludeKeywords: parseStringArray(row.exclude_keywords_json),
    isActive: row.is_active === 1,
    lastCollectedAt: row.last_collected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const SELECT_COLUMNS = `
  id, name, description, include_keywords_json,
  exclude_keywords_json, is_active, last_collected_at,
  created_at, updated_at
`;

export async function listTopics(
  db: D1Database,
  userId: string
): Promise<Topic[]> {
  const result = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM topics WHERE user_id = ? ORDER BY created_at DESC`)
    .bind(userId)
    .all<TopicRow>();

  return result.results.map(toTopic);
}

export async function getTopic(
  db: D1Database,
  userId: string,
  topicId: string
): Promise<Topic | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM topics WHERE user_id = ? AND id = ? LIMIT 1`)
    .bind(userId, topicId)
    .first<TopicRow>();

  return row ? toTopic(row) : null;
}

export async function createTopic(
  db: D1Database,
  userId: string,
  input: Required<TopicInput>
): Promise<Topic> {
  const id = crypto.randomUUID();

  await db.prepare(`
    INSERT INTO topics (
      id, user_id, name, description,
      include_keywords_json, exclude_keywords_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    userId,
    input.name,
    input.description,
    JSON.stringify(input.includeKeywords),
    JSON.stringify(input.excludeKeywords)
  ).run();

  const topic = await getTopic(db, userId, id);
  if (!topic) throw new Error("Created topic could not be loaded");
  return topic;
}

export async function updateTopic(
  db: D1Database,
  userId: string,
  topicId: string,
  input: Partial<TopicInput>
): Promise<Topic | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    assignments.push("name = ?");
    values.push(input.name);
  }
  if (input.description !== undefined) {
    assignments.push("description = ?");
    values.push(input.description);
  }
  if (input.includeKeywords !== undefined) {
    assignments.push("include_keywords_json = ?");
    values.push(JSON.stringify(input.includeKeywords));
  }
  if (input.excludeKeywords !== undefined) {
    assignments.push("exclude_keywords_json = ?");
    values.push(JSON.stringify(input.excludeKeywords));
  }

  if (assignments.length === 0) return getTopic(db, userId, topicId);

  assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  values.push(userId, topicId);

  await db.prepare(`
    UPDATE topics
    SET ${assignments.join(", ")}
    WHERE user_id = ? AND id = ?
  `).bind(...values).run();

  return getTopic(db, userId, topicId);
}

export async function deleteTopic(
  db: D1Database,
  userId: string,
  topicId: string
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM topics WHERE user_id = ? AND id = ?")
    .bind(userId, topicId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}
'@

Write-ProjectFile 'apps/worker/src/routes/topics.ts' @'
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
'@

Write-ProjectFile 'apps/worker/src/lib/http.ts' @'
export function jsonResponse(
  body: unknown,
  status: number,
  allowedOrigin: string
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin"
    }
  });
}
'@

Write-ProjectFile 'apps/worker/src/lib/dev-user.ts' @'
interface DevelopmentUserConfig {
  DEV_USER_ID?: string;
  DEV_USER_EMAIL?: string;
}

export async function ensureDevelopmentUser(
  db: D1Database,
  env: DevelopmentUserConfig
): Promise<string | null> {
  const userId = env.DEV_USER_ID?.trim();
  const email = env.DEV_USER_EMAIL?.trim().toLowerCase();

  // These values are loaded from apps/worker/.dev.vars locally.
  // Do not configure them in production; replace this with real authentication.
  if (!userId || !email) return null;

  await db.prepare(`
    INSERT OR IGNORE INTO users (id, email, display_name)
    VALUES (?, ?, 'Local Developer')
  `).bind(userId, email).run();

  const existing = await db
    .prepare("SELECT id FROM users WHERE id = ? AND email = ? LIMIT 1")
    .bind(userId, email)
    .first<{ id: string }>();

  return existing?.id ?? null;
}
'@

Write-ProjectFile 'apps/worker/src/index.ts' @'
import type { ApiHealthResponse } from "@news-for-me/shared";
import { handleTopicsRequest } from "./routes/topics";
import { ensureDevelopmentUser } from "./lib/dev-user";
import { jsonResponse } from "./lib/http";

interface Env {
  DB: D1Database;
  ALLOWED_ORIGIN?: string;
  DEV_USER_ID?: string;
  DEV_USER_EMAIL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigin = env.ALLOWED_ORIGIN ?? "http://127.0.0.1:5173";
    const origin = request.headers.get("Origin");

    if (origin && origin !== allowedOrigin) {
      return new Response("Origin not allowed", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      try {
        const result = await env.DB
          .prepare("SELECT 1 AS ok")
          .first<{ ok: number }>();

        if (result?.ok !== 1) throw new Error("D1 health check failed");

        const response: ApiHealthResponse = {
          ok: true,
          service: "news-for-me-api",
          timestamp: new Date().toISOString(),
          database: "connected"
        };
        return jsonResponse(response, 200, allowedOrigin);
      } catch {
        return jsonResponse(
          { ok: false, service: "news-for-me-api", database: "unavailable", error: "Database connection failed" },
          503,
          allowedOrigin
        );
      }
    }

    if (url.pathname === "/api/topics" || url.pathname.startsWith("/api/topics/")) {
      let userId: string | null;
      try {
        userId = await ensureDevelopmentUser(env.DB, env);
      } catch {
        return jsonResponse({ error: "Could not initialize the local development user." }, 503, allowedOrigin);
      }

      if (!userId) {
        return jsonResponse(
          { error: "Authentication is not configured. Set DEV_USER_ID and DEV_USER_EMAIL in apps/worker/.dev.vars for local development. Production authentication must be implemented before public deployment." },
          503,
          allowedOrigin
        );
      }

      try {
        return await handleTopicsRequest(request, env.DB, userId, allowedOrigin);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown database error";
        console.error("Topics API error:", message);
        return jsonResponse({ error: "An internal error occurred while processing topics." }, 500, allowedOrigin);
      }
    }

    return jsonResponse({ error: "Not Found" }, 404, allowedOrigin);
  }
};
'@

Write-ProjectFile 'apps/web/src/lib/api.ts' @'
import type {
  ApiHealthResponse,
  Topic,
  TopicInput,
  TopicListResponse,
  TopicResponse
} from "@news-for-me/shared";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

interface ErrorPayload {
  error?: string;
  details?: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorPayload = payload as ErrorPayload | null;
    const detail = errorPayload?.details?.join(" ");
    throw new Error([errorPayload?.error ?? `Request failed (${response.status})`, detail]
      .filter(Boolean)
      .join(" "));
  }

  return payload as T;
}

export async function getApiHealth(): Promise<ApiHealthResponse> {
  return request<ApiHealthResponse>("/api/health");
}

export async function listTopics(): Promise<Topic[]> {
  const response = await request<TopicListResponse>("/api/topics");
  return response.data;
}

export async function createTopic(input: TopicInput): Promise<Topic> {
  const response = await request<TopicResponse>("/api/topics", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return response.data;
}

export async function updateTopic(id: string, input: Partial<TopicInput>): Promise<Topic> {
  const response = await request<TopicResponse>(`/api/topics/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
  return response.data;
}

export async function deleteTopic(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/topics/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}
'@

Write-ProjectFile 'apps/web/src/App.tsx' @'
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApiHealthResponse, Topic, TopicInput } from "@news-for-me/shared";
import {
  createTopic,
  deleteTopic,
  getApiHealth,
  listTopics,
  updateTopic
} from "./lib/api";

type ApiStatus = "checking" | "online" | "offline";

interface TopicFormState {
  name: string;
  description: string;
  includeKeywords: string;
  excludeKeywords: string;
}

const EMPTY_FORM: TopicFormState = {
  name: "",
  description: "",
  includeKeywords: "",
  excludeKeywords: ""
};

function splitKeywords(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
}

function toInput(form: TopicFormState): TopicInput {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    includeKeywords: splitKeywords(form.includeKeywords),
    excludeKeywords: splitKeywords(form.excludeKeywords)
  };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

export default function App() {
  const [status, setStatus] = useState<ApiStatus>("checking");
  const [health, setHealth] = useState<ApiHealthResponse | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<TopicFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const [apiHealth, topicList] = await Promise.all([getApiHealth(), listTopics()]);
      setHealth(apiHealth);
      setStatus("online");
      setTopics(topicList);
    } catch (err) {
      setStatus("offline");
      setHealth(null);
      setError(err instanceof Error ? err.message : "데이터를 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
  }

  function startEdit(topic: Topic) {
    setEditingId(topic.id);
    setForm({
      name: topic.name,
      description: topic.description ?? "",
      includeKeywords: topic.includeKeywords.join(", "),
      excludeKeywords: topic.excludeKeywords.join(", ")
    });
    setNotice("");
    setError("");
    document.getElementById("topic-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError("");
    setNotice("");

    try {
      const input = toInput(form);
      if (editingId) {
        await updateTopic(editingId, input);
        setNotice("관심 항목을 수정했어요.");
      } else {
        await createTopic(input);
        setNotice("새 관심 항목을 등록했어요.");
      }
      resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(topic: Topic) {
    const confirmed = window.confirm(`'${topic.name}' 관심 항목을 삭제할까요?`);
    if (!confirmed) return;

    setError("");
    setNotice("");
    try {
      await deleteTopic(topic.id);
      if (editingId === topic.id) resetForm();
      setTopics((current) => current.filter((item) => item.id !== topic.id));
      setNotice(`'${topic.name}' 항목을 삭제했어요.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제에 실패했습니다.");
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="News for Me 홈">
          <span className="brand-mark">N</span>
          <span>News for Me</span>
        </a>
        <div className={`connection-status ${status}`}>
          <span className="status-light" />
          {status === "checking" ? "연결 확인 중" : status === "online" ? "로컬 API 연결됨" : "API 연결 확인 필요"}
        </div>
      </header>

      <section className="intro-section">
        <div className="eyebrow">PERSONAL NEWS WORKSPACE</div>
        <h1>관심 있는 소식만,<br /><span>놓치지 않도록.</span></h1>
        <p className="intro-copy">관심 주제를 등록하세요. News for Me가 주제에 맞는 최신 뉴스를 모아 전달할 준비를 합니다.</p>
        <div className="intro-meta">
          <span className="meta-icon">✳</span>
          <span>D1 데이터베이스에 자동 저장됩니다.</span>
          {health && <span className="meta-time">API 확인 {new Date(health.timestamp).toLocaleTimeString("ko-KR")}</span>}
        </div>
      </section>

      {(error || notice) && (
        <div className={`feedback ${error ? "feedback-error" : "feedback-success"}`} role="status">
          <span>{error || notice}</span>
          <button type="button" className="feedback-close" onClick={() => { setError(""); setNotice(""); }} aria-label="알림 닫기">×</button>
        </div>
      )}

      <section className="workspace-grid">
        <section className="topics-section">
          <div className="section-heading">
            <div>
              <div className="section-kicker">YOUR TOPICS</div>
              <h2>관심 항목</h2>
            </div>
            <span className="count-badge">{topics.length}개</span>
          </div>

          {isLoading ? (
            <div className="empty-state"><div className="loading-spinner" /><p>관심 항목을 불러오는 중입니다.</p></div>
          ) : topics.length === 0 ? (
            <div className="empty-state">
              <div className="empty-symbol">✳</div>
              <h3>아직 등록된 관심 항목이 없어요.</h3>
              <p>오른쪽에서 첫 번째 관심 주제를 추가해 보세요.</p>
            </div>
          ) : (
            <div className="topic-list">
              {topics.map((topic) => (
                <article className="topic-card" key={topic.id}>
                  <div className="topic-card-main">
                    <div className="topic-card-title-row">
                      <h3>{topic.name}</h3>
                      <span className="topic-date">{formatDate(topic.createdAt)}</span>
                    </div>
                    {topic.description && <p className="topic-description">{topic.description}</p>}
                    <div className="keyword-groups">
                      {topic.includeKeywords.length > 0 && (
                        <div className="keyword-row"><span className="keyword-label">포함</span>{topic.includeKeywords.map((keyword) => <span className="keyword-chip" key={`in-${keyword}`}>{keyword}</span>)}</div>
                      )}
                      {topic.excludeKeywords.length > 0 && (
                        <div className="keyword-row"><span className="keyword-label excluded">제외</span>{topic.excludeKeywords.map((keyword) => <span className="keyword-chip keyword-chip-muted" key={`out-${keyword}`}>{keyword}</span>)}</div>
                      )}
                      {topic.includeKeywords.length === 0 && topic.excludeKeywords.length === 0 && <span className="keyword-hint">키워드 조건 없음</span>}
                    </div>
                  </div>
                  <div className="topic-actions">
                    <button type="button" className="icon-button" onClick={() => startEdit(topic)} aria-label={`${topic.name} 수정`}>수정</button>
                    <button type="button" className="icon-button danger" onClick={() => void handleDelete(topic)} aria-label={`${topic.name} 삭제`}>삭제</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="form-section" id="topic-form">
          <div className="section-heading form-heading">
            <div>
              <div className="section-kicker">{editingId ? "EDIT TOPIC" : "NEW TOPIC"}</div>
              <h2>{editingId ? "항목 수정" : "새 항목 추가"}</h2>
            </div>
            {editingId && <button type="button" className="text-button" onClick={resetForm}>취소</button>}
          </div>

          <form onSubmit={(event) => void handleSubmit(event)} className="topic-form">
            <label className="field-label" htmlFor="topic-name">관심 주제 <span>*</span></label>
            <input
              id="topic-name"
              className="text-input"
              type="text"
              maxLength={80}
              placeholder="예: OpenAI, NVIDIA, 게임 산업"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
            />

            <label className="field-label" htmlFor="topic-description">설명 <span className="optional">선택</span></label>
            <textarea
              id="topic-description"
              className="text-input textarea"
              maxLength={500}
              rows={3}
              placeholder="어떤 소식에 관심이 있는지 적어주세요."
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />

            <label className="field-label" htmlFor="include-keywords">포함 키워드 <span className="optional">선택 · 쉼표로 구분</span></label>
            <input
              id="include-keywords"
              className="text-input"
              type="text"
              placeholder="신제품, 실적, AI 모델"
              value={form.includeKeywords}
              onChange={(event) => setForm({ ...form, includeKeywords: event.target.value })}
            />

            <label className="field-label" htmlFor="exclude-keywords">제외 키워드 <span className="optional">선택 · 쉼표로 구분</span></label>
            <input
              id="exclude-keywords"
              className="text-input"
              type="text"
              placeholder="주가 전망, 광고"
              value={form.excludeKeywords}
              onChange={(event) => setForm({ ...form, excludeKeywords: event.target.value })}
            />
            <p className="field-help">키워드는 각각 최대 20개까지 등록할 수 있어요.</p>

            <button className="submit-button" type="submit" disabled={isSaving || status !== "online"}>
              {isSaving ? "저장 중..." : editingId ? "변경사항 저장" : "관심 항목 등록"}
              <span aria-hidden="true">→</span>
            </button>
          </form>
          <div className="privacy-note"><span>⌑</span> 현재는 로컬 개발용 사용자 데이터로 저장됩니다.</div>
        </aside>
      </section>

      <footer className="footer">
        <span>News for Me</span>
        <span>YOUR PERSONAL AI NEWS BRIEFING</span>
      </footer>
    </main>
  );
}
'@

Write-ProjectFile 'apps/web/src/styles/index.css' @'
@import url("https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Noto+Sans+KR:wght@400;500;600;700;800&display=swap");

:root {
  font-family: "DM Sans", "Noto Sans KR", sans-serif;
  color: #20283a;
  background: #f7f8fa;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  --ink: #20283a;
  --muted: #818b9a;
  --line: #e9ecf1;
  --blue: #365ee9;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
button, input, textarea { font: inherit; }
button { -webkit-tap-highlight-color: transparent; }
.page-shell { width: min(1120px, calc(100% - 56px)); margin: 0 auto; }
.topbar { height: 82px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); }
.brand { display: inline-flex; align-items: center; gap: 11px; color: var(--ink); font-weight: 800; font-size: 18px; text-decoration: none; letter-spacing: -.4px; }
.brand-mark { display: grid; place-items: center; width: 35px; height: 35px; border-radius: 11px; color: white; background: var(--blue); font-size: 17px; }
.connection-status { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; font-weight: 600; }
.status-light { width: 7px; height: 7px; border-radius: 50%; background: #e3a53d; }
.connection-status.online .status-light { background: #24a66a; box-shadow: 0 0 0 3px #e4f5ec; }
.connection-status.offline .status-light { background: #d65b5b; }
.intro-section { padding: 67px 0 42px; }
.eyebrow, .section-kicker { color: var(--blue); font-size: 10px; font-weight: 800; letter-spacing: 1.65px; }
.intro-section h1 { margin: 17px 0 13px; font-size: clamp(39px, 6vw, 58px); line-height: 1.19; letter-spacing: -3px; font-weight: 800; }
.intro-section h1 span { color: var(--blue); }
.intro-copy { max-width: 580px; margin: 0; color: #758092; font-size: 14px; line-height: 1.9; }
.intro-meta { display: flex; align-items: center; gap: 8px; margin-top: 21px; color: #8791a0; font-size: 11px; }
.meta-icon { color: var(--blue); font-size: 17px; }
.meta-time { margin-left: 8px; padding-left: 12px; border-left: 1px solid #dfe3e9; }
.feedback { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 22px; padding: 12px 15px; border-radius: 10px; font-size: 12px; line-height: 1.6; }
.feedback-error { color: #a33f3f; background: #fff0ef; border: 1px solid #f8d9d6; }
.feedback-success { color: #23744d; background: #eaf7f0; border: 1px solid #d5eddf; }
.feedback-close { border: 0; padding: 0 4px; background: transparent; color: inherit; font-size: 20px; cursor: pointer; }
.workspace-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, .85fr); align-items: start; gap: 25px; padding-bottom: 74px; }
.topics-section, .form-section { min-width: 0; }
.section-heading { display: flex; align-items: center; justify-content: space-between; min-height: 54px; margin-bottom: 17px; }
.section-heading h2 { margin: 5px 0 0; font-size: 21px; letter-spacing: -.7px; }
.count-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 34px; height: 27px; padding: 0 9px; border-radius: 20px; color: #52627e; background: #edf1fa; font-size: 11px; font-weight: 700; }
.empty-state { display: flex; min-height: 245px; flex-direction: column; align-items: center; justify-content: center; padding: 30px 18px; border: 1px dashed #dce1e9; border-radius: 15px; background: rgb(255 255 255 / 55%); text-align: center; }
.empty-symbol { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 14px; color: var(--blue); background: #edf1ff; font-size: 22px; }
.empty-state h3 { margin: 16px 0 5px; font-size: 14px; }
.empty-state p { margin: 0; color: var(--muted); font-size: 12px; }
.loading-spinner { width: 24px; height: 24px; border: 2px solid #e7ebf3; border-top-color: var(--blue); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.topic-list { display: grid; gap: 11px; }
.topic-card { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 18px 18px 16px; border: 1px solid var(--line); border-radius: 13px; background: white; box-shadow: 0 5px 18px rgb(31 45 71 / 2%); }
.topic-card-main { min-width: 0; flex: 1; }
.topic-card-title-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 9px; }
.topic-card h3 { margin: 0; font-size: 16px; letter-spacing: -.35px; }
.topic-date { color: #a0a8b4; font-size: 10px; }
.topic-description { margin: 7px 0 0; color: #788395; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.keyword-groups { display: grid; gap: 7px; margin-top: 13px; }
.keyword-row { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.keyword-label { margin-right: 3px; color: #6e80b0; font-size: 10px; font-weight: 700; }
.keyword-label.excluded { color: #a28a8a; }
.keyword-chip { padding: 4px 8px; border-radius: 6px; color: #53658c; background: #f0f3fb; font-size: 10px; }
.keyword-chip-muted { color: #8e8585; background: #f5f2f2; }
.keyword-hint { color: #a3aab5; font-size: 10px; }
.topic-actions { display: flex; gap: 4px; flex-shrink: 0; }
.icon-button { border: 0; padding: 5px 6px; color: #7b8798; background: transparent; font-size: 11px; cursor: pointer; }
.icon-button:hover { color: var(--blue); }
.icon-button.danger:hover { color: #c44b4b; }
.form-section { padding: 21px; border: 1px solid #e7eaf0; border-radius: 15px; background: white; box-shadow: 0 8px 28px rgb(31 45 71 / 3%); }
.form-heading { margin-bottom: 21px; }
.text-button { border: 0; color: #788395; background: transparent; font-size: 11px; cursor: pointer; }
.topic-form { display: grid; }
.field-label { display: flex; align-items: baseline; gap: 7px; margin: 14px 0 7px; color: #354056; font-size: 11px; font-weight: 700; }
.field-label:first-child { margin-top: 0; }
.field-label > span:first-child:not(.optional) { color: #e05c5c; }
.field-label .optional { color: #a0a8b4; font-size: 10px; font-weight: 500; }
.text-input { width: 100%; min-width: 0; padding: 11px 12px; border: 1px solid #e4e8ef; border-radius: 8px; outline: none; color: var(--ink); background: #fcfcfd; font-size: 12px; transition: border-color .15s, box-shadow .15s; }
.text-input::placeholder { color: #b0b7c2; }
.text-input:focus { border-color: #829af1; box-shadow: 0 0 0 3px rgb(54 94 233 / 9%); background: white; }
.textarea { resize: vertical; min-height: 76px; line-height: 1.6; }
.field-help { margin: 8px 0 0; color: #9aa2ae; font-size: 10px; }
.submit-button { display: flex; align-items: center; justify-content: space-between; width: 100%; margin-top: 22px; padding: 13px 15px; border: 0; border-radius: 9px; color: white; background: var(--blue); font-size: 12px; font-weight: 700; cursor: pointer; transition: background .15s, transform .15s; }
.submit-button:hover:not(:disabled) { background: #274bc9; transform: translateY(-1px); }
.submit-button:disabled { opacity: .55; cursor: not-allowed; }
.submit-button span { font-size: 17px; }
.privacy-note { display: flex; align-items: center; gap: 7px; margin-top: 16px; color: #9aa2ae; font-size: 10px; line-height: 1.5; }
.privacy-note span { color: #6b83dc; font-size: 15px; }
.footer { display: flex; justify-content: space-between; gap: 12px; padding: 21px 0 27px; border-top: 1px solid var(--line); color: #9aa2ae; font-size: 10px; }
.footer span:last-child { letter-spacing: 1.2px; font-size: 9px; }

@media (max-width: 820px) {
  .workspace-grid { grid-template-columns: 1fr; }
  .form-section { grid-row: 1; }
}
@media (max-width: 560px) {
  .page-shell { width: calc(100% - 32px); }
  .topbar { height: 70px; }
  .brand { font-size: 16px; }
  .connection-status { font-size: 10px; }
  .intro-section { padding: 49px 0 32px; }
  .intro-section h1 { letter-spacing: -2px; }
  .intro-copy { font-size: 12px; }
  .workspace-grid { gap: 28px; }
  .form-section { padding: 17px; }
  .topic-card { padding: 15px; }
  .topic-card-title-row { gap: 5px; }
  .topic-actions { flex-direction: column; }
  .footer { font-size: 9px; }
}
'@

# Add local backups directory to gitignore without replacing the existing file.
$gitignorePath = Join-Path $ProjectRoot '.gitignore'
if (Test-Path -LiteralPath $gitignorePath) {
    $gitignore = Get-Content -LiteralPath $gitignorePath -Raw
    if ($gitignore -notmatch '(?m)^\.local-backups/$') {
        Add-Content -LiteralPath $gitignorePath -Value "`r`n# Local implementation backups`r`n.local-backups/" -Encoding utf8
        Write-Host '[UPDATE] .gitignore' -ForegroundColor Green
    }
}

Write-Host ''
Write-Host 'Topic CRUD files have been written.' -ForegroundColor Green
Write-Host "Backups (if any): $backupRoot" -ForegroundColor Yellow
Write-Host ''
Write-Host 'Next commands:' -ForegroundColor Cyan
Write-Host '  Set-Location C:\dev\news-for-me\apps\worker'
Write-Host '  npx wrangler d1 migrations apply news-for-me-db --local'
Write-Host '  Set-Location C:\dev\news-for-me'
Write-Host '  npm run typecheck:api'
Write-Host '  npm run typecheck:web'
Write-Host '  npm run build'
