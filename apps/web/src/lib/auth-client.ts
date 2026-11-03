import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: window.location.origin
});

export async function signInWithGoogle(): Promise<void> {
  const result = await authClient.signIn.social({
    provider: "google",
    callbackURL: "/"
  });

  if (result.error) {
    throw new Error(result.error.message || "Google 로그인에 실패했습니다.");
  }
}

export async function signOutFromNewsForMe(): Promise<void> {
  const result = await authClient.signOut();
  if (result.error) {
    throw new Error(result.error.message || "로그아웃에 실패했습니다.");
  }
}
