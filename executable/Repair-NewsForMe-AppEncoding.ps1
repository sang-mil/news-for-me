$ErrorActionPreference = 'Stop'
$ProjectRoot = 'C:\dev\news-for-me'
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "프로젝트 폴더를 찾을 수 없습니다: $ProjectRoot"
}
Set-Location $ProjectRoot

$relativePath = 'apps/web/src/App.tsx'
$target = Join-Path $ProjectRoot $relativePath
$backupDir = Join-Path $ProjectRoot ('.local-backups\app-tsx-encoding-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$backupTarget = Join-Path $backupDir $relativePath

if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw "대상 파일이 없습니다: $target"
}

New-Item -ItemType Directory -Path (Split-Path -Parent $backupTarget) -Force | Out-Null
Copy-Item -LiteralPath $target -Destination $backupTarget -Force
Write-Host "[BACKUP] $backupTarget" -ForegroundColor Yellow

$appSource = @'
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

Set-Content -LiteralPath $target -Value $appSource -Encoding utf8
Write-Host '[REPAIR] apps/web/src/App.tsx written as UTF-8.' -ForegroundColor Green
Write-Host 'Next: npm run typecheck:web' -ForegroundColor Cyan
