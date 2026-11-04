import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  ApiHealthResponse, CollectionRun, NewsArticle, SavedNewsArticle,
  SavedNewsTag, Topic, TopicInput
} from "@news-for-me/shared";
import {
  collectTopic, createTopic, deleteTopic, getApiHealth, getCollectionRun, getCurrentUser,
  listTopicArticles, listScraps, listTags, listTopics, updateTopic,
  saveArticle, unsaveArticle, updateScrapNote, replaceScrapTags,
  createTag, deleteTag, updateTag
} from "./lib/api";
import { signInWithGoogle, signOutFromNewsForMe } from "./lib/auth-client";
import Settings from "./features/settings/Settings";
import Newsletter from "./features/newsletter/Newsletter";

type ApiStatus = "checking" | "online" | "offline";
type AuthStatus = "checking" | "signed-in" | "signed-out" | "unavailable";
interface TopicFormState {
  name: string;
  description: string;
  includeKeywords: string;
  excludeKeywords: string;
}
const EMPTY_FORM: TopicFormState = { name: "", description: "", includeKeywords: "", excludeKeywords: "" };

function splitKeywords(value: string): string[] {
  return [...new Set(value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))];
}
function toInput(form: TopicFormState): TopicInput {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    includeKeywords: splitKeywords(form.includeKeywords),
    excludeKeywords: splitKeywords(form.excludeKeywords)
  };
}
function formatDate(value: string | null): string {
  if (!value) return "날짜 정보 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "날짜 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(date);
}
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export default function App() {
  const [status, setStatus] = useState<ApiStatus>("checking");
  const [health, setHealth] = useState<ApiHealthResponse | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [authUser, setAuthUser] = useState<{ id: string; email: string; name: string; isDevelopment: boolean } | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [articlesByTopic, setArticlesByTopic] = useState<Record<string, NewsArticle[]>>({});
  const [scraps, setScraps] = useState<SavedNewsArticle[]>([]);
  const [tags, setTags] = useState<SavedNewsTag[]>([]);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [tagDrafts, setTagDrafts] = useState<Record<string, string[]>>({});
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveTagFilter, setArchiveTagFilter] = useState("all");
  const [isArchiveExpanded, setIsArchiveExpanded] = useState(true);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#64748b");
  const [busyArchiveId, setBusyArchiveId] = useState<string | null>(null);
  const [expandedTopicId, setExpandedTopicId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [collectingTopicId, setCollectingTopicId] = useState<string | null>(null);
  const [collectionLimit, setCollectionLimit] = useState(10);
  const [collectionRuns, setCollectionRuns] = useState<Record<string, CollectionRun>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<TopicFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const identity = await getCurrentUser();
      if (!identity.authenticated || !identity.user) {
        setAuthUser(null);
        setAuthStatus("signed-out");
        setStatus("online");
        setHealth(null);
        setTopics([]);
        setScraps([]);
        setTags([]);
        return;
      }

      setAuthUser({ ...identity.user, isDevelopment: identity.isDevelopment });
      setAuthStatus("signed-in");

      const [apiHealth, topicList, savedArticles, userTags] = await Promise.all([
        getApiHealth(), listTopics(), listScraps(), listTags()
      ]);
      setHealth(apiHealth);
      setStatus("online");
      setTopics(topicList);
      setScraps(savedArticles);
      setTags(userTags);
    } catch (err) {
      setAuthStatus("unavailable");
      setStatus("offline");
      setHealth(null);
      setError(err instanceof Error ? err.message : "데이터를 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function handleGoogleSignIn() {
    setIsSigningIn(true);
    setError("");
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google 로그인에 실패했습니다.");
      setIsSigningIn(false);
    }
  }

  async function handleSignOut() {
    setError("");
    try {
      await signOutFromNewsForMe();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그아웃에 실패했습니다.");
    }
  }

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
    if (!window.confirm(`'${topic.name}' 관심 항목을 삭제할까요?`)) return;
    setError(""); setNotice("");
    try {
      await deleteTopic(topic.id);
      if (editingId === topic.id) resetForm();
      setTopics((current) => current.filter((item) => item.id !== topic.id));
      setArticlesByTopic((current) => {
        const next = { ...current }; delete next[topic.id]; return next;
      });
      setNotice(`'${topic.name}' 항목을 삭제했어요.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제에 실패했습니다.");
    }
  }
  async function loadArticles(topicId: string) {
    if (expandedTopicId === topicId) {
      setExpandedTopicId(null);
      return;
    }

    setExpandedTopicId(topicId);
    try {
      const articles = await listTopicArticles(topicId);
      setArticlesByTopic((current) => ({ ...current, [topicId]: articles }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "뉴스 목록을 불러오지 못했습니다.");
    }
  }
  async function reloadScraps() {
    const saved = await listScraps();
    setScraps(saved);
    return saved;
  }
  async function handleToggleScrap(topicId: string, article: NewsArticle) {
    setError(""); setNotice("");
    const alreadySaved = scraps.some((item) => item.id === article.id);
    try {
      if (alreadySaved) {
        await unsaveArticle(article.id);
        setNotice("스크랩을 해제했어요. 다음 주간 정리 대상이 됩니다.");
      } else {
        await saveArticle(topicId, article.id);
        setNotice("뉴스를 스크랩 보관함에 저장했어요.");
      }
      await reloadScraps();
    } catch (err) {
      setError(err instanceof Error ? err.message : "스크랩 처리에 실패했습니다.");
    }
  }
  async function handleRemoveScrap(articleId: string) {
    setError(""); setNotice("");
    try {
      await unsaveArticle(articleId);
      await reloadScraps();
      setNotice("스크랩을 해제했어요. 다음 주간 정리 대상이 됩니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "스크랩 해제에 실패했습니다.");
    }
  }
  async function handleSaveNote(articleId: string) {
    setBusyArchiveId(articleId); setError(""); setNotice("");
    try {
      await updateScrapNote(articleId, noteDrafts[articleId] ?? "");
      await reloadScraps();
      setNotice("개인 메모를 저장했어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "메모 저장에 실패했습니다.");
    } finally {
      setBusyArchiveId(null);
    }
  }
  async function handleApplyTags(articleId: string, currentTags: SavedNewsTag[]) {
    setBusyArchiveId(articleId); setError(""); setNotice("");
    try {
      const selected = tagDrafts[articleId] ?? currentTags.map((tag) => tag.id);
      await replaceScrapTags(articleId, selected);
      await reloadScraps();
      setNotice("뉴스 태그를 저장했어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "태그 저장에 실패했습니다.");
    } finally {
      setBusyArchiveId(null);
    }
  }
  async function handleCreateTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setNotice("");
    try {
      await createTag(newTagName.trim(), newTagColor);
      setTags(await listTags());
      setNewTagName("");
      setNotice("새 태그를 만들었어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "태그 생성에 실패했습니다.");
    }
  }
  async function handleRenameTag(tag: SavedNewsTag) {
    const nextName = window.prompt("새 태그 이름을 입력하세요.", tag.name);
    if (nextName === null || !nextName.trim() || nextName.trim() === tag.name) return;
    try {
      await updateTag(tag.id, { name: nextName.trim() });
      setTags(await listTags());
      await reloadScraps();
      setNotice("태그 이름을 변경했어요.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "태그 이름 변경에 실패했습니다.");
    }
  }
  async function handleDeleteTag(tag: SavedNewsTag) {
    if (!window.confirm(`'${tag.name}' 태그를 삭제할까요? 연결된 뉴스의 태그 지정도 해제됩니다.`)) return;
    try {
      await deleteTag(tag.id);
      setTags(await listTags());
      await reloadScraps();
      setTagDrafts((current) => Object.fromEntries(
        Object.entries(current).map(([articleId, ids]) => [articleId, ids.filter((id) => id !== tag.id)])
      ));
      setNotice(`'${tag.name}' 태그를 삭제했어요.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "태그 삭제에 실패했습니다.");
    }
  }
  async function handleCollect(topic: Topic) {
    setCollectingTopicId(topic.id); setError(""); setNotice("");
    let runId: string | null = null;
    let lastRun: CollectionRun | null = null;
    let lastLoggedState = "";

    try {
      runId = await collectTopic(topic.id, collectionLimit);
      console.info("[NewsForMe][Collection] queued", {
        runId,
        topicId: topic.id,
        topicName: topic.name,
        maxArticles: collectionLimit,
        queuedAt: new Date().toISOString()
      });
      setNotice(`'${topic.name}' 뉴스 수집 작업을 ${collectionLimit}개 한도로 대기열에 등록했어요.`);

      // Queue retries can take longer than the previous 30-second UI polling window.
      // Keep observing for up to five minutes and log each meaningful state change.
      for (let attempt = 1; attempt <= 150; attempt += 1) {
        await wait(2000);
        const run = await getCollectionRun(topic.id, runId);
        lastRun = run;
        setCollectionRuns((current) => ({ ...current, [topic.id]: run }));

        const signature = [run.status, run.errorMessage ?? "", run.articlesFound].join("|");
        if (signature !== lastLoggedState) {
          lastLoggedState = signature;
          const diagnostic = {
            runId,
            topicId: topic.id,
            topicName: topic.name,
            status: run.status,
            articlesFound: run.articlesFound,
            errorMessage: run.errorMessage,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            pollAttempt: attempt,
            observedAt: new Date().toISOString()
          };
          if (run.status === "failed") {
            console.error("[NewsForMe][Collection] failed", diagnostic);
          } else if (run.errorMessage) {
            console.warn("[NewsForMe][Collection] retry/status detail", diagnostic);
          } else {
            console.info("[NewsForMe][Collection] status changed", diagnostic);
          }
        }

        if (run.status === "completed") {
          const articles = await listTopicArticles(topic.id);
          setArticlesByTopic((current) => ({ ...current, [topic.id]: articles }));
          setExpandedTopicId(topic.id);
          setTopics(await listTopics());
          if (run.articlesFound === 0) {
            console.warn("[NewsForMe][Collection] completed with zero articles", {
              runId, topicId: topic.id, topicName: topic.name
            });
          }
          setNotice(`'${topic.name}' 수집 완료: ${run.articlesFound}개 기사를 확인했어요.`);
          return;
        }

        if (run.status === "failed") {
          throw new Error(run.errorMessage ?? "뉴스 수집에 실패했습니다.");
        }
      }

      console.warn("[NewsForMe][Collection] polling timed out", {
        runId,
        topicId: topic.id,
        topicName: topic.name,
        lastStatus: lastRun?.status ?? "unknown",
        lastError: lastRun?.errorMessage ?? null,
        lastObservedAt: new Date().toISOString()
      });
      setNotice(`'${topic.name}' 수집 결과 확인 시간이 초과됐어요. 개발자 콘솔에서 [NewsForMe][Collection] 로그를 확인해 주세요.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "뉴스 수집 요청에 실패했습니다.";
      console.error("[NewsForMe][Collection] request/poll error", {
        runId,
        topicId: topic.id,
        topicName: topic.name,
        error: message,
        lastStatus: lastRun?.status ?? null,
        lastError: lastRun?.errorMessage ?? null,
        observedAt: new Date().toISOString()
      });
      setError(message);
    } finally {
      setCollectingTopicId(null);
    }
  }

  const filteredScraps = useMemo(() => {
    const query = archiveQuery.trim().toLocaleLowerCase();
    return scraps.filter((article) => {
      const matchesQuery = !query || [
        article.title, article.sourceName ?? "", article.contentExcerpt ?? "", article.note ?? "",
        ...article.tags.map((tag) => tag.name)
      ].some((value) => value.toLocaleLowerCase().includes(query));
      const matchesTag = archiveTagFilter === "all" || article.tags.some((tag) => tag.id === archiveTagFilter);
      return matchesQuery && matchesTag;
    });
  }, [scraps, archiveQuery, archiveTagFilter]);

  if (authStatus !== "signed-in") {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-labelledby="auth-title">
          <a className="auth-brand" href="/" aria-label="News for Me 홈">
            <span className="auth-brand-mark">n.</span>
            <span>News for Me</span>
          </a>
          <div className="auth-eyebrow">YOUR PERSONAL NEWSROOM</div>
          <h1 id="auth-title">나만의 뉴스룸에<br /><span>로그인하세요.</span></h1>
          <p>Google 계정으로 로그인하면 관심 주제와 스크랩, 개인 메모를 안전하게 불러옵니다.</p>
          {authStatus === "checking" && (
            <p className="auth-loading" role="status">로그인 상태를 확인하고 있습니다.</p>
          )}
          {authStatus === "unavailable" && (
            <div className="auth-error" role="alert">
              연결 또는 인증 설정을 확인할 수 없습니다. 다시 시도하거나 관리자 설정을 확인하세요.
            </div>
          )}
          {error && <div className="auth-error" role="alert">{error}</div>}
          {(authStatus === "signed-out" || authStatus === "unavailable") && (
            <button className="google-signin-button" type="button" onClick={() => void handleGoogleSignIn()} disabled={isSigningIn}>
              <span className="google-g" aria-hidden="true">G</span>
              {isSigningIn ? "Google로 이동 중…" : "Google 계정으로 계속하기"}
              <span className="google-arrow" aria-hidden="true">↗</span>
            </button>
          )}
          {authStatus === "unavailable" && (
            <button className="auth-retry-button" type="button" onClick={() => void refresh()}>다시 연결 확인</button>
          )}
          <div className="auth-footnote">로그인한 계정에 연결된 뉴스와 보관함만 표시됩니다.</div>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="News for Me 홈">
          <span className="brand-mark" aria-hidden="true">n.</span>
          <span className="brand-wordmark">News for Me<span>YOUR PERSONAL NEWSROOM</span></span>
        </a>
        <nav className="top-nav" aria-label="주요 메뉴">
          <a href="#topics">뉴스룸</a>
          <a href="#archive">보관함</a>
          <a href="#newsletter">메일 브리핑</a>
          <a href="#settings">연동 설정</a>
          <a className="top-nav-cta" href="#topic-form">주제 추가 <span aria-hidden="true">↗</span></a>
        </nav>
        {authUser && !authUser.isDevelopment && (
          <div className="account-control">
            <span className="account-email" title={authUser.email}>{authUser.email}</span>
            <button type="button" className="sign-out-button" onClick={() => void handleSignOut()}>로그아웃</button>
          </div>
        )}
        <div className={`connection-status ${status}`} aria-live="polite">
          <span className="status-light" />
          {status === "checking" ? "연결 확인 중" : status === "online" ? "API 연결됨" : "연결 확인 필요"}
        </div>
      </header>

      <section className="intro-section" aria-labelledby="hero-title">
        <div className="intro-main">
          <div className="eyebrow"><span className="eyebrow-mark" /> YOUR PERSONAL NEWSROOM · VOL. 01</div>
          <h1 id="hero-title">관심 뉴스를 모으고,<br /><span>중요한 흐름에 집중하세요.</span></h1>
          <p className="intro-copy">관심 주제를 등록하고 뉴스 수집을 실행하면, 나에게 필요한 최신 소식을 한곳에서 확인할 수 있습니다.</p>
          <div className="intro-meta">
            <span className="meta-icon" aria-hidden="true">✳</span>
            <span>D1에 저장되는 나만의 뉴스 아카이브</span>
            {health && <span className="meta-time">마지막 연결 {new Date(health.timestamp).toLocaleTimeString("ko-KR")}</span>}
          </div>
          <div className="hero-actions">
            <a className="hero-primary-link" href="#topics">뉴스룸 바로가기 <span aria-hidden="true">↘</span></a>
            <a className="hero-secondary-link" href="#topic-form">새 관심 주제 추가 <span aria-hidden="true">＋</span></a>
          </div>
        </div>

        <aside className="hero-panel" aria-label="내 뉴스룸 현황">
          <div className="hero-panel-core">
            <div className="hero-panel-header">
              <span>MY NEWSROOM</span>
              <span className={`hero-sync ${status}`}><i />{status === "online" ? "SYNCED" : status === "checking" ? "CONNECTING" : "OFFLINE"}</span>
            </div>
            <div className="hero-panel-copy">
              <span>YOUR INTERESTS, EDITED FOR YOU</span>
              <h2>관심사에 맞춘 뉴스 흐름을<br />한눈에 관리하세요.</h2>
            </div>
            <div className="hero-stats">
              <div><strong>{topics.length.toString().padStart(2, "0")}</strong><span>관심 주제</span></div>
              <div><strong>{scraps.length.toString().padStart(2, "0")}</strong><span>저장한 기사</span></div>
              <div><strong>{tags.length.toString().padStart(2, "0")}</strong><span>나만의 태그</span></div>
            </div>
          </div>
        </aside>
      </section>

      {(error || notice) && (
        <div className={`feedback ${error ? "feedback-error" : "feedback-success"}`} role="status">
          <span>{error || notice}</span>
          <button type="button" className="feedback-close" onClick={() => { setError(""); setNotice(""); }} aria-label="알림 닫기">×</button>
        </div>
      )}

      <section className="workspace-grid">
        <section className="topics-section" id="topics" aria-labelledby="topics-title">
          <div className="section-heading topics-heading">
            <div><div className="section-kicker">YOUR TOPICS</div><h2 id="topics-title">관심 주제와 최신 뉴스</h2></div>
            <div className="section-heading-actions">
              <span className="count-badge">{topics.length}개 주제</span>
              <a className="section-action-link" href="#topic-form">주제 추가 <span aria-hidden="true">＋</span></a>
            </div>
          </div>

          {isLoading ? (
            <div className="empty-state"><div className="loading-spinner" /><p>관심 항목을 불러오는 중입니다.</p></div>
          ) : topics.length === 0 ? (
            <div className="empty-state"><div className="empty-symbol">✳</div><h3>아직 등록된 관심 항목이 없어요.</h3><p>오른쪽에서 첫 번째 관심 주제를 추가해 보세요.</p></div>
          ) : (
            <div className="topic-list">
              {topics.map((topic) => {
                const run = collectionRuns[topic.id];
                const articles = articlesByTopic[topic.id];
                return (
                  <article className="topic-card" key={topic.id}>
                    <div className="topic-card-main">
                      <div className="topic-card-title-row"><h3>{topic.name}</h3><span className="topic-date">{formatDate(topic.createdAt)}</span></div>
                      {topic.description && <p className="topic-description">{topic.description}</p>}
                      <div className="keyword-groups">
                        {topic.includeKeywords.length > 0 && <div className="keyword-row"><span className="keyword-label">포함</span>{topic.includeKeywords.map((keyword) => <span className="keyword-chip" key={`in-${keyword}`}>{keyword}</span>)}</div>}
                        {topic.excludeKeywords.length > 0 && <div className="keyword-row"><span className="keyword-label excluded">제외</span>{topic.excludeKeywords.map((keyword) => <span className="keyword-chip keyword-chip-muted" key={`out-${keyword}`}>{keyword}</span>)}</div>}
                        {topic.includeKeywords.length === 0 && topic.excludeKeywords.length === 0 && <span className="keyword-hint">키워드 조건 없음</span>}
                      </div>
                      {run && (
                        <div className="collection-status" aria-live="polite">
                          <div>최근 수집 작업: {run.status} · {run.articlesFound}건</div>
                          {run.errorMessage && (
                            <div className="collection-error" role="status">
                              수집 진단: {run.errorMessage}
                            </div>
                          )}
                        </div>
                      )}
                      {expandedTopicId === topic.id && (
                        <div className="article-list" id={`articles-${topic.id}`}>
                          <div className="article-list-heading">최근 수집 기사</div>
                          {!articles || articles.length === 0 ? <p className="article-empty">저장된 기사가 없습니다. 뉴스 수집을 실행해 보세요.</p> : articles.map((article) => {
                            const isScrapped = scraps.some((saved) => saved.id === article.id);
                            return (
                              <div className="article-item article-item-with-action" key={article.id}>
                                <div className="article-item-content">
                                  <a href={article.canonicalUrl} target="_blank" rel="noreferrer">{article.title}</a>
                                  <div className="article-meta">{article.sourceName ?? "출처 미상"} · {formatDate(article.publishedAt)}</div>
                                  {article.contentExcerpt && <p>{article.contentExcerpt}</p>}
                                </div>
                                <button type="button" className={`scrap-button ${isScrapped ? "is-scrapped" : ""}`} onClick={() => void handleToggleScrap(topic.id, article)}>
                                  {isScrapped ? "★ 스크랩 해제" : "☆ 스크랩"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div className="topic-actions topic-actions-column">
                      <label className="collection-limit-control">
                        수집 개수
                        <select value={collectionLimit} onChange={(event) => setCollectionLimit(Number(event.target.value))} aria-label="수집할 뉴스 개수" disabled={collectingTopicId !== null}>
                          {[5, 10, 15, 20, 30].map((count) => <option key={count} value={count}>{count}개</option>)}
                        </select>
                      </label>
                      <button type="button" className="icon-button collect-button" onClick={() => void handleCollect(topic)} disabled={collectingTopicId !== null || status !== "online"}>{collectingTopicId === topic.id ? "수집 중…" : "뉴스 수집"}</button>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => void loadArticles(topic.id)}
                        aria-expanded={expandedTopicId === topic.id}
                        aria-controls={`articles-${topic.id}`}
                      >
                        {expandedTopicId === topic.id ? "기사 접기" : "기사 보기"}
                      </button>
                      <button type="button" className="icon-button" onClick={() => startEdit(topic)}>수정</button>
                      <button type="button" className="icon-button danger" onClick={() => void handleDelete(topic)}>삭제</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="form-section" id="topic-form">
          <div className="section-heading form-heading">
            <div><div className="section-kicker">{editingId ? "EDIT TOPIC" : "NEW TOPIC"}</div><h2>{editingId ? "항목 수정" : "새 항목 추가"}</h2></div>
            {editingId && <button type="button" className="text-button" onClick={resetForm}>취소</button>}
          </div>
          <form onSubmit={(event) => void handleSubmit(event)} className="topic-form">
            <label className="field-label" htmlFor="topic-name">관심 주제 <span>*</span></label>
            <input id="topic-name" className="text-input" type="text" maxLength={80} placeholder="예: OpenAI, NVIDIA, 게임 산업" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            <label className="field-label" htmlFor="topic-description">설명 <span className="optional">선택</span></label>
            <textarea id="topic-description" className="text-input textarea" maxLength={500} rows={3} placeholder="어떤 소식에 관심이 있는지 적어주세요." value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            <label className="field-label" htmlFor="include-keywords">포함 키워드 <span className="optional">선택 · 쉼표로 구분</span></label>
            <input id="include-keywords" className="text-input" type="text" placeholder="신제품, 실적, AI 모델" value={form.includeKeywords} onChange={(event) => setForm({ ...form, includeKeywords: event.target.value })} />
            <label className="field-label" htmlFor="exclude-keywords">제외 키워드 <span className="optional">선택 · 쉼표로 구분</span></label>
            <input id="exclude-keywords" className="text-input" type="text" placeholder="주가 전망, 광고" value={form.excludeKeywords} onChange={(event) => setForm({ ...form, excludeKeywords: event.target.value })} />
            <p className="field-help">키워드는 각각 최대 20개까지 등록할 수 있어요.</p>
            <button className="submit-button" type="submit" disabled={isSaving || status !== "online"}>{isSaving ? "저장 중…" : editingId ? "변경사항 저장" : "관심 항목 등록"}<span aria-hidden="true">→</span></button>
          </form>
          <div className="privacy-note"><span>⌑</span> 로그인한 계정별로 설정과 데이터가 분리되어 저장됩니다.</div>
        </aside>
      </section>

      <section className="scraps-section" id="archive" aria-labelledby="archive-title">
        <div className="section-heading archive-heading">
          <div><div className="section-kicker">PERSONAL ARCHIVE</div><h2 id="archive-title">스크랩 보관함 <span className="count-badge">{scraps.length}개</span></h2></div>
          <button
            type="button"
            className="archive-toggle-button"
            aria-expanded={isArchiveExpanded}
            aria-controls="archive-content"
            onClick={() => setIsArchiveExpanded((current) => !current)}
          >
            {isArchiveExpanded ? "접기 −" : "펼치기 ＋"}
          </button>
          <form className="archive-create-tag" onSubmit={(event) => void handleCreateTag(event)}>
            <input aria-label="새 태그 이름" value={newTagName} onChange={(event) => setNewTagName(event.target.value)} maxLength={30} placeholder="새 태그 이름" required />
            <input aria-label="태그 색상" type="color" value={newTagColor} onChange={(event) => setNewTagColor(event.target.value)} />
            <button type="submit" disabled={!newTagName.trim()}>태그 추가</button>
          </form>
        </div>

        <div id="archive-content" hidden={!isArchiveExpanded}>
        <div className="archive-tools">
          <input className="archive-search" value={archiveQuery} onChange={(event) => setArchiveQuery(event.target.value)} placeholder="제목, 출처, 메모, 태그 검색" aria-label="스크랩 뉴스 검색" />
          <select value={archiveTagFilter} onChange={(event) => setArchiveTagFilter(event.target.value)} aria-label="태그 필터">
            <option value="all">모든 태그</option>
            {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
        </div>

        {tags.length > 0 && (
          <div className="archive-tag-manager">
            <span className="archive-tool-label">내 태그</span>
            {tags.map((tag) => (
              <span className="archive-managed-tag" key={tag.id}>
                <span className="archive-tag-dot" style={{ backgroundColor: tag.color }} />{tag.name}
                <button type="button" onClick={() => void handleRenameTag(tag)} aria-label={`${tag.name} 태그 이름 변경`}>✎</button>
                <button type="button" onClick={() => void handleDeleteTag(tag)} aria-label={`${tag.name} 태그 삭제`}>×</button>
              </span>
            ))}
          </div>
        )}

        {scraps.length === 0 ? (
          <div className="scraps-empty">아직 스크랩한 뉴스가 없어요. 보관하고 싶은 기사에서 ☆ 스크랩을 눌러주세요.</div>
        ) : filteredScraps.length === 0 ? (
          <div className="scraps-empty">검색 조건에 맞는 뉴스가 없습니다.</div>
        ) : (
          <div className="scraps-list">
            {filteredScraps.map((article) => {
              const selectedTagIds = tagDrafts[article.id] ?? article.tags.map((tag) => tag.id);
              return (
                <article className="scrap-card archive-card" key={article.id}>
                  <div className="scrap-card-content">
                    <a href={article.canonicalUrl} target="_blank" rel="noreferrer">{article.title}</a>
                    <div className="article-meta">{article.sourceName ?? "출처 미상"} · 발행 {formatDate(article.publishedAt)} · 스크랩 {formatDate(article.savedAt)}</div>
                    {article.contentExcerpt && <p>{article.contentExcerpt}</p>}
                  </div>

                  <div className="archive-editor">
                    <label className="archive-tool-label" htmlFor={`note-${article.id}`}>개인 메모</label>
                    <textarea
                      id={`note-${article.id}`}
                      className="archive-note"
                      rows={3}
                      maxLength={5000}
                      placeholder="이 뉴스에서 기억할 점이나 나중에 확인할 내용을 기록하세요."
                      value={noteDrafts[article.id] ?? article.note ?? ""}
                      onChange={(event) => setNoteDrafts((current) => ({ ...current, [article.id]: event.target.value }))}
                    />
                    <div className="archive-editor-actions">
                      <span className="archive-char-count">{(noteDrafts[article.id] ?? article.note ?? "").length}/5000</span>
                      <button type="button" className="archive-save-button" disabled={busyArchiveId === article.id} onClick={() => void handleSaveNote(article.id)}>
                        메모 저장
                      </button>
                    </div>

                    <div className="archive-tool-label">태그</div>
                    {tags.length === 0 ? (
                      <p className="archive-hint">위에서 태그를 먼저 만들어 주세요.</p>
                    ) : (
                      <div className="archive-tag-choices">
                        {tags.map((tag) => (
                          <label className="archive-tag-choice" key={tag.id}>
                            <input
                              type="checkbox"
                              checked={selectedTagIds.includes(tag.id)}
                              onChange={(event) => setTagDrafts((current) => {
                                const base = current[article.id] ?? article.tags.map((item) => item.id);
                                const next = event.target.checked
                                  ? [...base, tag.id]
                                  : base.filter((id) => id !== tag.id);
                                return { ...current, [article.id]: next };
                              })}
                            />
                            <span className="archive-tag-dot" style={{ backgroundColor: tag.color }} />{tag.name}
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="archive-editor-actions">
                      <span className="archive-hint">현재 {article.tags.length}개 태그</span>
                      <button type="button" className="archive-save-button" disabled={busyArchiveId === article.id} onClick={() => void handleApplyTags(article.id, article.tags)}>
                        태그 저장
                      </button>
                    </div>
                    {article.tags.length > 0 && (
                      <div className="archive-current-tags">
                        {article.tags.map((tag) => <span className="archive-tag-pill" key={tag.id} style={{ borderColor: tag.color, color: tag.color }}>{tag.name}</span>)}
                      </div>
                    )}
                  </div>

                  <button type="button" className="scrap-button is-scrapped" onClick={() => void handleRemoveScrap(article.id)}>
                    ★ 스크랩 해제
                  </button>
                </article>
              );
            })}
          </div>
        )}
        </div>
      </section>

      <Newsletter userEmail={authUser?.email ?? ""} />
      <Settings />

      <footer className="footer"><span>News for Me</span><span>YOUR PERSONAL AI NEWS BRIEFING</span></footer>
    </main>
  );
}