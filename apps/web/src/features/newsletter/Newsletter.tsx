import { useState } from "react";
import {
  getNewsletterPreview,
  sendNewsletterNow,
  type NewsletterPreview
} from "../../lib/api";

interface NewsletterProps {
  userEmail: string;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시간 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export default function Newsletter({ userEmail }: NewsletterProps) {
  const [preview, setPreview] = useState<NewsletterPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function handlePreview() {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      setPreview(await getNewsletterPreview());
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : "뉴스레터 미리보기를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    if (!preview || sending) return;
    const confirmed = window.confirm(
      `최근 ${preview.periodDays}일의 AI 요약 뉴스 ${preview.articleCount}개를 아래 주소로 지금 발송합니다.\n\n수신: ${userEmail}\n\n계속할까요?`
    );
    if (!confirmed) return;

    setSending(true);
    setError("");
    setNotice("");
    try {
      const result = await sendNewsletterNow();
      setNotice(`뉴스 브리핑 ${result.articleCount}개를 ${result.recipient} 주소로 발송했습니다.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "메일 발송에 실패했습니다.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="newsletter-section" id="newsletter" aria-labelledby="newsletter-title">
      <div className="newsletter-heading">
        <div>
          <div className="section-kicker">PERSONAL EMAIL BRIEFING</div>
          <h2 id="newsletter-title">메일 브리핑</h2>
          <p>최근 7일간 수집된 AI 요약 뉴스를 내 이메일로 받아보세요.</p>
        </div>
        <div className="newsletter-recipient">
          <span>받는 사람</span>
          <strong>{userEmail || "로그인 이메일 확인 중"}</strong>
        </div>
      </div>

      <div className="newsletter-security-note">
        현재는 로그인한 본인에게만 발송합니다. 발신 주소(`GMAIL_SENDER`)와 로그인 이메일이 같아야 하며,
        다른 사용자를 수신자로 지정할 수 없습니다.
      </div>

      {(error || notice) && (
        <div className={"newsletter-feedback " + (error ? "is-error" : "is-success")} role="status">
          {error || notice}
        </div>
      )}

      <div className="newsletter-toolbar">
        <div className="newsletter-description">
          <strong>AI 뉴스레터 미리보기</strong>
          <span>미리보기에서 제목과 기사 구성을 확인한 후 실제 메일을 발송합니다.</span>
        </div>
        <div className="newsletter-actions">
          <button type="button" className="newsletter-preview-button" onClick={() => void handlePreview()} disabled={loading || sending}>
            {loading ? "불러오는 중…" : preview ? "미리보기 새로고침" : "미리보기 불러오기"}
          </button>
          <button type="button" className="newsletter-send-button" onClick={() => void handleSend()} disabled={!preview || preview.articleCount === 0 || sending || loading}>
            {sending ? "발송 중…" : "내 이메일로 지금 보내기"}
          </button>
        </div>
      </div>

      {preview ? (
        <div className="newsletter-preview">
          <div className="newsletter-preview-meta">
            <div>
              <span className="newsletter-meta-label">메일 제목</span>
              <strong>{preview.subject}</strong>
            </div>
            <div className="newsletter-preview-stats">
              <span>{preview.articleCount}개 기사</span>
              <span>최근 {preview.periodDays}일</span>
              <span>생성 {formatDate(preview.generatedAt)}</span>
            </div>
          </div>
          <iframe
            className="newsletter-preview-frame"
            title="News for Me 이메일 미리보기"
            srcDoc={preview.html}
            sandbox=""
            referrerPolicy="no-referrer"
          />
        </div>
      ) : (
        <div className="newsletter-empty">
          미리보기를 불러오면 최근 7일 뉴스 브리핑의 실제 이메일 구성을 여기에서 확인할 수 있습니다.
        </div>
      )}
    </section>
  );
}
