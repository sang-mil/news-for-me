export interface ParsedInterestProfile {
  markdown: string;
  searchKeywords: string[];
  excludeKeywords: string[];
}

function parseKeywordList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.normalize("NFKC").trim().slice(0, 60))
    .filter(Boolean))].slice(0, 10);
}

export function parseInterestProfileResponse(raw: string): ParsedInterestProfile {
  let source = raw.trim()
    .replace(/^\x60{3}(?:json)?\s*/i, "")
    .replace(/\s*\x60{3}$/, "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) source = source.slice(start, end + 1);

  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gemini 응답이 JSON 객체가 아닙니다.");
  }
  const row = value as Record<string, unknown>;
  const markdown = typeof row.markdown === "string" ? row.markdown.trim().slice(0, 12000) : "";
  if (!markdown) throw new Error("Gemini가 Markdown 관심사 프로필을 반환하지 않았습니다.");
  return {
    markdown,
    searchKeywords: parseKeywordList(row.searchKeywords),
    excludeKeywords: parseKeywordList(row.excludeKeywords)
  };
}
