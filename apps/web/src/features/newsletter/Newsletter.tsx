import { useEffect, useState } from "react";
import "./Newsletter.css";
import {
  getNewsletterPreview,
  sendNewsletterNow,
  type NewsletterPreview
} from "../../lib/api";

interface NewsletterProps {
  userEmail: string;
}

const EMAIL_RE = /^[^\\s@,;]+@[^\\s@,;]+\\.[^\\s@,;]+$/;

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
  const [recipientEmail, setRecipientEmail] = useState(userEmail);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const normalizedRecipient = recipientEmail.trim().toLowerCase();
  const isRecipientValid = normalizedRecipient.length <= 254 && EMAIL_RE.test(normalizedRecipient);

  useEffect(() => {
    setRecipientEmail(userEmail);
  }, [userEmail]);

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
      const result = await sendNewsletterNow(normalizedRecipient);
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
        <label className="newsletter-recipient" htmlFor="newsletter-recipient-email">
          <span>받는 사람 이메일</span>
          <input
            id="newsletter-recipient-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            maxLength={254}
            value={recipientEmail}
            onChange={(event) => setRecipientEmail(event.target.value)}
            placeholder="recipient@example.com"
            aria-invalid={recipientEmail.length > 0 && !isRecipientValid}
          />
          {recipientEmail.length > 0 && !isRecipientValid && (
            <small>올바른 이메일 주소를 입력하세요.</small>
          )}
        </label>
      </div>

      <div className="newsletter-security-note">
        발신 주소는 서버에 설정된 Gmail 계정이며, 받는 사람은 위에서 자유롭게 지정할 수 있습니다.
        발송 버튼을 누르면 최종 수신 주소를 다시 확인합니다.
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
          <button type="button" className="newsletter-send-button" onClick={() => void handleSend()} disabled={!preview || preview.articleCount === 0 || sending || loading || !isRecipientValid}>
            {sending ? "발송 중…" : "뉴스레터 보내기"}
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
