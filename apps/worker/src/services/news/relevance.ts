import type { NewsSearchInput } from "./types";

function splitTerms(value: string): string[] {
  return value.split(/[,，;；|]+/)
    .map((term) => term.normalize("NFKC").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function containsTerm(text: string, rawTerm: string): boolean {
  const term = rawTerm.normalize("NFKC").toLocaleLowerCase().trim();
  if (!term) return false;
  if (/^[a-z0-9][a-z0-9.+#-]*$/i.test(term)) {
    const escaped = term.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|[^a-z0-9])" + escaped + "($|[^a-z0-9])", "i").test(text);
  }
  return text.includes(term);
}

/** Require at least one explicit topic/include term in the actual result text. */
export function matchesTopicRelevance(input: NewsSearchInput, candidate: string): boolean {
  const text = candidate.normalize("NFKC").toLocaleLowerCase();
  const terms = [...new Set([
    ...splitTerms(input.topicName),
    ...input.includeKeywords.flatMap(splitTerms)
  ])];
  return terms.some((rawTerm) => {
    const term = rawTerm.toLocaleLowerCase();
    if (containsTerm(text, term)) return true;
    const words = term.split(/\s+/).filter((word) => word.length > 1);
    return words.length > 1 && words.every((word) => containsTerm(text, word));
  });
}

const SOFTWARE_AND_TECH_TERMS = [
  "인공지능", "머신러닝", "딥러닝", "생성형 ai", "프로그래밍", "개발자",
  "소프트웨어", "오픈소스", "코딩", "개발", "컴퓨터", "프레임워크",
  "라이브러리", "데이터베이스", "클라우드", "보안", "웹 개발", "앱 개발",
  "react", "next.js", "typescript", "javascript", "python", "golang",
  "rust", "java", "docker", "kubernetes", "linux", "github", "git",
  "devops", "api", "llm", "ai", "tech", "software", "programming"
];

/** GitHub and V2EX are specialist sources; don't query them for unrelated topics. */
export function isSoftwareOrTechTopic(input: NewsSearchInput): boolean {
  const text = [input.topicName, ...input.includeKeywords].join(" ")
    .normalize("NFKC").toLocaleLowerCase();
  return SOFTWARE_AND_TECH_TERMS.some((term) => containsTerm(text, term));
}
