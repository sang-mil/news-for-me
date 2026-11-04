export function describeGoogleOAuthRefreshFailure(
  status: number,
  errorCode: string | undefined,
  description: string | undefined
): string {
  const code = errorCode?.trim() || "unknown_error";
  const detail = description?.trim();
  const suffix = detail && detail !== code ? `: ${detail}` : "";

  let action: string;
  switch (code) {
    case "invalid_client":
      action = "Worker의 GOOGLE_CLIENT_ID와 GOOGLE_CLIENT_SECRET이 Google Cloud Console의 동일한 OAuth 클라이언트에서 발급된 한 쌍인지 확인하세요. Secret을 재생성했다면 Worker Secret도 새 값으로 갱신해야 합니다.";
      break;
    case "invalid_grant":
      action = "GOOGLE_REFRESH_TOKEN이 현재 GOOGLE_CLIENT_ID로 발급된 토큰인지 확인하세요. 다른 OAuth 클라이언트로 발급했거나 토큰이 폐기·만료됐다면, 현재 Worker에 설정된 동일한 Client ID/Secret을 사용해 Gmail 권한으로 다시 발급해야 합니다.";
      break;
    case "unauthorized_client":
      action = "현재 OAuth 클라이언트가 refresh_token grant를 사용할 수 있는지, 올바른 OAuth 클라이언트 유형과 Gmail 권한으로 발급했는지 확인하세요.";
      break;
    default:
      action = "Cloudflare Worker의 GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN 설정과 Google Cloud OAuth 클라이언트 상태를 확인하세요.";
      break;
  }

  return `Google OAuth 토큰 갱신 실패 (HTTP ${status}, ${code})${suffix}. ${action}`;
}
