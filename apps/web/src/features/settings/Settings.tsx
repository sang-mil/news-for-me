import { useCallback, useEffect, useState } from "react";
import {
  listIntegrations,
  removeIntegration,
  saveIntegration,
  testIntegration,
  getGeminiModels,
  type GeminiModelOption,
  type IntegrationConfig,
  type IntegrationProvider,
  type IntegrationStatus
} from "../../lib/api";

interface ProviderDefinition {
  id: IntegrationProvider;
  title: string;
  category: "AI 모델" | "콘텐츠 수집";
  description: string;
  credentialLabel: string;
  placeholder: string;
  helper: string;
}
const PROVIDERS: ProviderDefinition[] = [
  {
    id: "gemini",
    title: "Google Gemini",
    category: "AI 모델",
    description: "뉴스 요약과 분석에 사용할 Gemini API를 연결합니다.",
    credentialLabel: "Gemini API Key",
    placeholder: "AIza...",
    helper: "Google AI Studio에서 발급한 API 키를 입력하세요."
  },
  {
    id: "openrouter",
    title: "OpenRouter",
    category: "AI 모델",
    description: "여러 모델을 하나의 API로 사용하고 Gemini의 대체 제공자로 지정합니다.",
    credentialLabel: "OpenRouter API Key",
    placeholder: "sk-or-...",
    helper: "모델 ID를 지정할 수 있습니다. 유료 모델은 별도 허용 설정이 필요합니다."
  },
  {
    id: "threads",
    title: "Threads",
    category: "콘텐츠 수집",
    description: "Threads 공개 게시물을 관심 키워드로 검색합니다.",
    credentialLabel: "Threads User Access Token",
    placeholder: "Threads access token",
    helper: "threads_basic 및 승인된 threads_keyword_search 권한이 필요합니다."
  },
  {
    id: "x",
    title: "X",
    category: "콘텐츠 수집",
    description: "X 최근 게시물을 관심 키워드로 검색합니다.",
    credentialLabel: "X Bearer Token",
    placeholder: "Bearer token",
    helper: "X API 요금제와 최근 검색 권한이 필요합니다. 연결 테스트는 최대 10개 결과를 조회할 수 있어 사용량이 발생할 수 있습니다."
  },
  {
    id: "youtube",
    title: "YouTube Data API",
    category: "콘텐츠 수집",
    description: "관심 주제와 관련된 공개 YouTube 동영상을 검색합니다.",
    credentialLabel: "YouTube API Key",
    placeholder: "AIza...",
    helper: "YouTube Data API v3가 활성화된 Google Cloud 프로젝트의 API 키를 입력하세요. 연결 테스트는 소량의 quota를 사용합니다."
  }
];

type ConfigDrafts = Record<IntegrationProvider, IntegrationConfig>;
type SecretDrafts = Record<IntegrationProvider, string>;

const EMPTY_CONFIGS: ConfigDrafts = {
  gemini: { enabled: true, modelPrimary: "gemini-3.8-flash", allowPaidGemini: false },
  openrouter: { enabled: true, model: "openrouter/free", allowPaid: false },
  threads: { enabled: true },
  x: { enabled: true },
  youtube: { enabled: true }
};
const EMPTY_SECRETS: SecretDrafts = {
  gemini: "", openrouter: "", threads: "", x: "", youtube: ""
};

function formatDate(value: string | null): string {
  if (!value) return "테스트 기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "테스트 기록 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

export default function Settings() {
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [geminiModels, setGeminiModels] = useState<GeminiModelOption[]>([]);
  const [geminiModelsError, setGeminiModelsError] = useState("");
  const [configs, setConfigs] = useState<ConfigDrafts>(EMPTY_CONFIGS);
  const [secrets, setSecrets] = useState<SecretDrafts>(EMPTY_SECRETS);
  const [loading, setLoading] = useState(true);
  const [busyProvider, setBusyProvider] = useState<IntegrationProvider | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rows = await listIntegrations();
      setIntegrations(rows);
      setConfigs((current) => {
        const next = { ...current };
        for (const row of rows) next[row.provider] = { ...EMPTY_CONFIGS[row.provider], ...row.config };
        return next;
      });

      const geminiStatus = rows.find((row) => row.provider === "gemini");
      const canLoadGeminiModels = geminiStatus?.configured
        ? geminiStatus.enabled
        : geminiStatus?.platformDefaultAvailable === true;
      if (canLoadGeminiModels) {
        try {
          setGeminiModels(await getGeminiModels());
          setGeminiModelsError("");
        } catch (modelError) {
          setGeminiModels([]);
          setGeminiModelsError(modelError instanceof Error ? modelError.message : "Gemini 모델 목록을 불러오지 못했습니다.");
        }
      } else {
        setGeminiModels([]);
        setGeminiModelsError("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "연동 설정을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  function patchConfig(provider: IntegrationProvider, patch: Partial<IntegrationConfig>) {
    setConfigs((current) => ({
      ...current,
      [provider]: { ...current[provider], ...patch }
    }));
  }

  async function handleSave(provider: IntegrationProvider) {
    setBusyProvider(provider);
    setError("");
    setNotice("");
    try {
      const row = await saveIntegration(provider, secrets[provider], configs[provider]);
      setIntegrations((current) => [
        ...current.filter((item) => item.provider !== provider),
        row
      ]);
      setSecrets((current) => ({ ...current, [provider]: "" }));
      if (provider === "gemini") {
        try {
          setGeminiModels(await getGeminiModels());
          setGeminiModelsError("");
        } catch (modelError) {
          setGeminiModelsError(modelError instanceof Error ? modelError.message : "Gemini 모델 목록을 불러오지 못했습니다.");
        }
      }
      setNotice(PROVIDERS.find((item) => item.id === provider)?.title + " 설정을 저장했습니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "설정을 저장하지 못했습니다.");
    } finally {
      setBusyProvider(null);
    }
  }

  async function handleTest(provider: IntegrationProvider) {
    setBusyProvider(provider);
    setError("");
    setNotice("");
    try {
      await testIntegration(provider);
      setNotice(PROVIDERS.find((item) => item.id === provider)?.title + " 연결이 확인되었습니다.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "연결 테스트에 실패했습니다.");
      await refresh();
    } finally {
      setBusyProvider(null);
    }
  }

  async function handleRemove(provider: IntegrationProvider) {
    if (!window.confirm("이 계정에 저장된 해당 API 키를 삭제할까요?")) return;
    setBusyProvider(provider);
    setError("");
    setNotice("");
    try {
      await removeIntegration(provider);
      setSecrets((current) => ({ ...current, [provider]: "" }));
      setConfigs((current) => ({ ...current, [provider]: EMPTY_CONFIGS[provider] }));
      setNotice(PROVIDERS.find((item) => item.id === provider)?.title + " 사용자 키를 삭제했습니다.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "키를 삭제하지 못했습니다.");
    } finally {
      setBusyProvider(null);
    }
  }

  function findStatus(provider: IntegrationProvider): IntegrationStatus | undefined {
    return integrations.find((item) => item.provider === provider);
  }

  function statusLabel(row: IntegrationStatus | undefined): string {
    if (!row) return "상태 확인 중";
    if (row.configured && !row.enabled) return "사용 안 함";
    if (row.configured && row.status === "connected") return "연결 확인됨";
    if (row.configured && row.status === "error") return "연결 오류";
    if (row.configured) return "키 저장됨";
    if (row.platformDefaultAvailable) return "서버 기본 키 사용 가능";
    return "미연결";
  }

  function statusClass(row: IntegrationStatus | undefined): string {
    if (row?.configured && row.enabled && row.status === "connected") return "is-connected";
    if (row?.configured && row.status === "error") return "has-error";
    return "";
  }

  const selectedGeminiModel = geminiModels.find((model) => model.id === configs.gemini.modelPrimary);

  return (
    <section className="settings-section" id="settings" aria-labelledby="settings-title">
      <div className="section-heading settings-heading">
        <div>
          <div className="section-kicker">PERSONAL INTEGRATIONS</div>
          <h2 id="settings-title">서비스 연동 설정</h2>
          <p>내 API 키를 등록하면 이 계정의 뉴스 수집과 AI 요약에 우선 적용됩니다.</p>
        </div>
        <button type="button" className="archive-toggle-button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "확인 중…" : "새로고침"}
        </button>
      </div>

      <div className="settings-security-note">
        <span aria-hidden="true">⌑</span>
        <p>키 원문은 다시 표시하지 않으며, 서버에서 암호화해 저장합니다. 다른 로그인 사용자의 키와 설정은 분리됩니다.</p>
      </div>
      {(error || notice) && (
        <div className={"settings-feedback " + (error ? "feedback-error" : "feedback-success")} role="status">
          {error || notice}
        </div>
      )}
      {loading && integrations.length === 0 ? (
        <div className="empty-state"><div className="loading-spinner" /><p>연동 설정을 불러오는 중입니다.</p></div>
      ) : (
        <>
          <div className="settings-group">
            <h3>AI 모델 제공자</h3>
            <div className="integration-grid">
              {PROVIDERS.filter((item) => item.category === "AI 모델").map((provider) => {
                const row = findStatus(provider.id);
                const config = configs[provider.id];
                const busy = busyProvider === provider.id;
                return (
                  <article className="integration-card" key={provider.id}>
                    <div className="integration-card-heading">
                      <div><span className="integration-category">AI PROVIDER</span><h4>{provider.title}</h4></div>
                      <span className={"integration-status " + statusClass(row)}>{statusLabel(row)}</span>
                    </div>
                    <p className="integration-description">{provider.description}</p>
                    {row?.platformDefaultAvailable && (
                      <p className="integration-default-note">
                        {row.configured ? (row.enabled ? "내 키가 서버 기본 키보다 우선 사용됩니다." : "이 계정에서 사용 중지되어 서버 기본 키도 사용하지 않습니다.") : "내 키를 등록하지 않으면 서비스 기본 키가 사용될 수 있습니다."}
                      </p>
                    )}
                    <label className="integration-field">
                      <span>{provider.credentialLabel}</span>
                      <input type="password" autoComplete="new-password" spellCheck={false}
                        value={secrets[provider.id]}
                        onChange={(event) => setSecrets((current) => ({ ...current, [provider.id]: event.target.value }))}
                        placeholder={row?.configured ? "저장된 키 유지 — 교체할 때만 입력" : provider.placeholder} />
                      <small>{provider.helper}</small>
                    </label>
                    {provider.id === "gemini" && (
                      <div className="integration-subgrid integration-subgrid-gemini">
                        <label className="integration-field gemini-model-field">
                          <span>최우선 모델</span>
                          <select
                            className="gemini-model-select"
                            value={config.modelPrimary ?? ""}
                            onChange={(event) => patchConfig("gemini", { modelPrimary: event.target.value })}
                          >
                            {config.modelPrimary && !geminiModels.some((model) => model.id === config.modelPrimary) && (
                              <option value={config.modelPrimary}>{config.modelPrimary} · 현재 저장된 모델</option>
                            )}
                            {geminiModels.map((model) => (
                              <option
                                key={model.id}
                                value={model.id}
                                disabled={!model.isFreeTier && config.allowPaidGemini !== true}
                              >
                                {model.displayName} · {model.isFreeTier ? "무료 지원" : "요금제 확인"}
                              </option>
                            ))}
                          </select>
                          <span className="gemini-model-meta" aria-live="polite">
                            <span className="gemini-model-meta-label">선택한 모델 ID</span>
                            <code>{selectedGeminiModel?.id ?? config.modelPrimary ?? "모델을 선택하세요"}</code>
                            <span className={"gemini-model-tier " + (selectedGeminiModel?.isFreeTier ? "is-free" : "is-paid")}>
                              {selectedGeminiModel ? (selectedGeminiModel.isFreeTier ? "무료 등급 지원" : "유료/요금제 확인 필요") : "목록에서 확인되지 않은 모델"}
                            </span>
                          </span>
                          <small>선택한 모델을 먼저 사용합니다. 실패하면 이 API 키에서 사용할 수 있는 무료 등급 지원 모델을 자동으로 시도합니다.</small>
                          <small>무료 등급 지원 모델도 계정의 무료 사용량을 초과하거나 유료 용량으로 전환하면 요금이 발생할 수 있습니다. Google AI Studio에서 사용량과 결제 상태를 확인하세요.</small>
                          {geminiModelsError && <small className="gemini-model-error">{geminiModelsError}</small>}
                        </label>
                        <label className="integration-checkbox gemini-auto-fallback">
                          <input
                            type="checkbox"
                            checked={config.allowPaidGemini === true}
                            onChange={(event) => patchConfig("gemini", { allowPaidGemini: event.target.checked })}
                          />
                          <span>유료 또는 요금제 미확인 모델도 자동 대체 후보에 포함</span>
                        </label>
                        <label className="integration-field gemini-project-slot">
                          <span>Google Cloud 프로젝트 슬롯 <em>(선택)</em></span>
                          <input value={config.projectSlot ?? ""} onChange={(event) => patchConfig("gemini", { projectSlot: event.target.value })} placeholder="예: personal-project" />
                          <small>같은 프로젝트의 키를 여러 개 다른 쿼터로 계산하지 않도록 구분합니다.</small>
                        </label>
                      </div>
                    )}
                    {provider.id === "openrouter" && (
                      <div className="integration-subgrid">
                        <label className="integration-field"><span>모델 ID</span>
                          <input value={config.model ?? ""} onChange={(event) => patchConfig("openrouter", { model: event.target.value })} placeholder="openrouter/free" />
                        </label>
                        <label className="integration-checkbox">
                          <input type="checkbox" checked={config.allowPaid === true} onChange={(event) => patchConfig("openrouter", { allowPaid: event.target.checked })} />
                          <span>유료 모델 사용 허용</span>
                        </label>
                      </div>
                    )}
                    <label className="integration-checkbox">
                      <input type="checkbox" checked={config.enabled !== false} onChange={(event) => patchConfig(provider.id, { enabled: event.target.checked })} />
                      <span>이 계정에서 사용</span>
                    </label>
                    <div className="integration-actions">
                      <button type="button" className="integration-save" onClick={() => void handleSave(provider.id)} disabled={busy || (!row?.configured && !secrets[provider.id].trim())}>
                        {busy ? "처리 중…" : "설정 저장"}
                      </button>
                      <button type="button" className="integration-test" onClick={() => void handleTest(provider.id)} disabled={busy || !row?.configured || !row.enabled}>
                        연결 테스트
                      </button>
                      {row?.configured && <button type="button" className="integration-remove" onClick={() => void handleRemove(provider.id)} disabled={busy}>키 삭제</button>}
                    </div>
                    <div className="integration-last-tested">{formatDate(row?.lastValidatedAt ?? null)}</div>
                  </article>
                );
              })}
            </div>
          </div>

          <div className="settings-group">
            <h3>콘텐츠 수집 연동</h3>
            <div className="integration-grid">
              {PROVIDERS.filter((item) => item.category === "콘텐츠 수집").map((provider) => {
                const row = findStatus(provider.id);
                const config = configs[provider.id];
                const busy = busyProvider === provider.id;
                return (
                  <article className="integration-card" key={provider.id}>
                    <div className="integration-card-heading">
                      <div><span className="integration-category">CONTENT SOURCE</span><h4>{provider.title}</h4></div>
                      <span className={"integration-status " + statusClass(row)}>{statusLabel(row)}</span>
                    </div>
                    <p className="integration-description">{provider.description}</p>
                    {row?.platformDefaultAvailable && (
                      <p className="integration-default-note">
                        {row.configured ? (row.enabled ? "내 키가 서버 기본 키보다 우선 사용됩니다." : "이 계정에서 사용 중지되어 서버 기본 키도 사용하지 않습니다.") : "내 키가 없으면 서비스 기본 키가 사용될 수 있습니다."}
                      </p>
                    )}
                    <label className="integration-field">
                      <span>{provider.credentialLabel}</span>
                      <input type="password" autoComplete="new-password" spellCheck={false}
                        value={secrets[provider.id]}
                        onChange={(event) => setSecrets((current) => ({ ...current, [provider.id]: event.target.value }))}
                        placeholder={row?.configured ? "저장된 키 유지 — 교체할 때만 입력" : provider.placeholder} />
                      <small>{provider.helper}</small>
                    </label>
                    <label className="integration-checkbox">
                      <input type="checkbox" checked={config.enabled !== false} onChange={(event) => patchConfig(provider.id, { enabled: event.target.checked })} />
                      <span>이 계정에서 수집 사용</span>
                    </label>
                    <div className="integration-actions">
                      <button type="button" className="integration-save" onClick={() => void handleSave(provider.id)} disabled={busy || (!row?.configured && !secrets[provider.id].trim())}>
                        {busy ? "처리 중…" : "설정 저장"}
                      </button>
                      <button type="button" className="integration-test" onClick={() => void handleTest(provider.id)} disabled={busy || !row?.configured || !row.enabled}>
                        연결 테스트
                      </button>
                      {row?.configured && <button type="button" className="integration-remove" onClick={() => void handleRemove(provider.id)} disabled={busy}>키 삭제</button>}
                    </div>
                    <div className="integration-last-tested">{formatDate(row?.lastValidatedAt ?? null)}</div>
                  </article>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
