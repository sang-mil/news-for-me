import { useEffect, useState } from "react";
import "./Newsletter.css";
import {
  cancelNewsletterSchedule,
  getNewsletterPreview,
  listNewsletterSchedules,
  scheduleNewsletter,
  sendNewsletterNow,
  type NewsletterPreview,
  type NewsletterSchedule
} from "../../lib/api";

interface NewsletterProps {
  userEmail: string;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

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

function toSeoulDateTimeInput(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function defaultScheduleValue(): string {
  const date = new Date(Date.now() + 30 * 60 * 1000);
  date.setSeconds(0, 0);
  return toSeoulDateTimeInput(date);
}

function scheduleStatusLabel(status: NewsletterSchedule["status"]): string {
  switch (status) {
    case "scheduled": return "발송 대기";
    case "sending": return "발송 처리 중";
    case "sent": return "발송 완료";
    case "failed": return "발송 실패";
    case "cancelled": return "취소됨";
  }
}

export default function Newsletter({ userEmail }: NewsletterProps) {
  const [preview, setPreview] = useState<NewsletterPreview | null>(null);
  const [recipientEmail, setRecipientEmail] = useState(userEmail);
  const [scheduleLocalDateTime, setScheduleLocalDateTime] = useState(defaultScheduleValue);
  const [schedules, setSchedules] = useState<NewsletterSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleListLoading, setScheduleListLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const normalizedRecipient = recipientEmail.trim().toLowerCase();
  const isRecipientValid = normalizedRecipient.length <= 254 && EMAIL_RE.test(normalizedRecipient);
  const minimumScheduleTime = Math.ceil((Date.now() + 5 * 60 * 1000) / 60000) * 60000;
  const minimumScheduleValue = toSeoulDateTimeInput(new Date(minimumScheduleTime));
  const maximumScheduleValue = toSeoulDateTimeInput(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

  useEffect(() => {
    setRecipientEmail(userEmail);
  }, [userEmail]);

  useEffect(() => {
    void refreshSchedules();
  }, []);

  async function refreshSchedules() {
    setScheduleListLoading(true);
    try {
      setSchedules(await listNewsletterSchedules());
    } catch (err) {
      setError(err instanceof Error ? err.message : "예약 목록을 불러오지 못했습니다.");
    } finally {
      setScheduleListLoading(false);
    }
  }

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
    if (!isRecipientValid) {
      setError("받는 사람 이메일 주소를 올바르게 입력하세요.");
      return;
    }
    const confirmed = window.confirm(
      `최근 ${preview.periodDays}일의 AI 요약 뉴스 ${preview.articleCount}개를 아래 주소로 지금 발송합니다.\n\n수신: ${normalizedRecipient}\n\n계속할까요?`
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

  async function handleSchedule() {
    if (!preview || scheduling) return;
    if (!isRecipientValid) {
      setError("받는 사람 이메일 주소를 올바르게 입력하세요.");
      return;
    }

    const scheduledDate = new Date(`${scheduleLocalDateTime}:00+09:00`);
    if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() < Date.now() + 5 * 60 * 1000) {
      setError("예약 발송은 현재 시각보다 최소 5분 이후로 설정하세요.");
      return;
    }
    if (scheduledDate.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000) {
      setError("예약 발송은 최대 30일 이내로 설정할 수 있습니다.");
      return;
    }

    const when = formatDate(scheduledDate.toISOString());
    const confirmed = window.confirm(
      `뉴스 브리핑 ${preview.articleCount}개를 다음 시간에 발송 예약합니다.\n\n수신: ${normalizedRecipient}\n발송: ${when} (한국 시간)\n\n예약하시겠습니까?`
    );
    if (!confirmed) return;

    setScheduling(true);
    setError("");
    setNotice("");
    try {
      const result = await scheduleNewsletter(normalizedRecipient, scheduledDate.toISOString());
      setNotice(`${formatDate(result.scheduledAt)} 발송으로 예약했습니다.`);
      await refreshSchedules();
    } catch (err) {
      setError(err instanceof Error ? err.message : "뉴스레터 예약에 실패했습니다.");
    } finally {
      setScheduling(false);
    }
  }

  async function handleCancelSchedule(schedule: NewsletterSchedule) {
    const confirmed = window.confirm(
      `${formatDate(schedule.scheduledAt)} 예약을 취소할까요?\n\n수신: ${schedule.recipientEmail}`
    );
    if (!confirmed) return;
    setError("");
    setNotice("");
    try {
      await cancelNewsletterSchedule(schedule.id);
      setNotice("뉴스레터 예약을 취소했습니다.");
      await refreshSchedules();
    } catch (err) {
      setError(err instanceof Error ? err.message : "예약을 취소하지 못했습니다.");
      await refreshSchedules();
    }
  }

  return (
    <section className="newsletter-section" id="newsletter" aria-labelledby="newsletter-title">
      <div className="newsletter-heading">
        <div>
          <div className="section-kicker">PERSONAL EMAIL BRIEFING</div>
          <h2 id="newsletter-title">메일 브리핑</h2>
          <p>최근 7일간 수집된 AI 요약 뉴스를 지정한 이메일 주소로 받아보세요.</p>
        </div>
        <label className="newsletter-recipient" htmlFor="newsletter-recipient-email">
          <span>받는 사람 이메일</span>
          <input
            id="newsletter-recipient-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            maxLength={254}
            required
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
        발송 버튼 또는 예약 버튼을 누르면 최종 수신 주소와 발송 시각을 다시 확인합니다.
      </div>

      {(error || notice) && (
        <div className={"newsletter-feedback " + (error ? "is-error" : "is-success")} role="status">
          {error || notice}
        </div>
      )}

      <div className="newsletter-toolbar">
        <div className="newsletter-description">
          <strong>AI 뉴스레터 미리보기</strong>
          <span>미리보기에서 제목과 기사 구성을 확인한 후 즉시 발송하거나 예약할 수 있습니다.</span>
        </div>
        <div className="newsletter-actions">
          <button type="button" className="newsletter-preview-button" onClick={() => void handlePreview()} disabled={loading || sending || scheduling}>
            {loading ? "불러오는 중…" : preview ? "미리보기 새로고침" : "미리보기 불러오기"}
          </button>
          <button type="button" className="newsletter-send-button" onClick={() => void handleSend()} disabled={!preview || preview.articleCount === 0 || sending || scheduling || loading || !isRecipientValid}>
            {sending ? "발송 중…" : "지금 보내기"}
          </button>
        </div>
      </div>

      <div className="newsletter-schedule-panel">
        <div className="newsletter-schedule-heading">
          <div>
            <strong>예약 발송</strong>
            <span>한국 시간 기준으로 한 번 발송할 날짜와 시간을 지정합니다.</span>
          </div>
          <button type="button" className="newsletter-schedule-refresh" onClick={() => void refreshSchedules()} disabled={scheduleListLoading}>
            {scheduleListLoading ? "새로고침 중…" : "예약 목록 새로고침"}
          </button>
        </div>
        <div className="newsletter-schedule-form">
          <label htmlFor="newsletter-scheduled-at">
            <span>발송 날짜 및 시간 (KST)</span>
            <input
              id="newsletter-scheduled-at"
              type="datetime-local"
              value={scheduleLocalDateTime}
              min={minimumScheduleValue}
              max={maximumScheduleValue}
              onChange={(event) => setScheduleLocalDateTime(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="newsletter-schedule-button"
            onClick={() => void handleSchedule()}
            disabled={!preview || preview.articleCount === 0 || !isRecipientValid || scheduling || sending || loading}
          >
            {scheduling ? "예약 중…" : "이 시간에 예약"}
          </button>
        </div>
        <p className="newsletter-schedule-hint">최소 5분 이후부터 30일 이내까지 예약할 수 있습니다. 실제 실행은 예약 시각 이후 1분 이내에 시작됩니다.</p>

        {schedules.length > 0 ? (
          <div className="newsletter-schedule-list">
            {schedules.map((schedule) => (
              <div className="newsletter-schedule-item" key={schedule.id}>
                <div className="newsletter-schedule-info">
                  <strong>{formatDate(schedule.scheduledAt)}</strong>
                  <span>{schedule.recipientEmail}</span>
                  <span className={"newsletter-schedule-status is-" + schedule.status}>{scheduleStatusLabel(schedule.status)}</span>
                  {schedule.errorMessage && <small>{schedule.errorMessage}</small>}
                </div>
                {schedule.status === "scheduled" && (
                  <button type="button" className="newsletter-schedule-cancel" onClick={() => void handleCancelSchedule(schedule)}>
                    예약 취소
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="newsletter-schedule-empty">
            {scheduleListLoading ? "예약 목록을 불러오는 중입니다." : "등록된 예약이 없습니다."}
          </div>
        )}
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
