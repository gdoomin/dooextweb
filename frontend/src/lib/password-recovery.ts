import type { SupabaseClient } from "@supabase/supabase-js";

export const EXPIRED_RECOVERY_MESSAGE = "재설정 링크가 만료되었거나 이미 사용되었습니다. 아래에서 메일을 다시 요청한 뒤 가장 최근 메일의 링크를 열어 주세요.";

export function getRecoveryLinkError(url: URL): string | null {
  const hash = new URLSearchParams(url.hash.slice(1));
  const code = url.searchParams.get("error_code") || hash.get("error_code");
  const error = url.searchParams.get("error") || hash.get("error");
  if (code === "otp_expired") return EXPIRED_RECOVERY_MESSAGE;
  if (code || error) return "재설정 링크를 확인할 수 없습니다. 메일을 다시 요청해 주세요.";
  return null;
}

export function getRecoveryRedirect(url: URL): string | null {
  if (url.pathname !== "/") return null;
  const hash = new URLSearchParams(url.hash.slice(1));
  if (hash.get("type") !== "recovery" && url.searchParams.get("type") !== "recovery" && !getRecoveryLinkError(url)) return null;
  return `/reset-password${url.search}${url.hash}`;
}

export function cleanRecoveryUrl(url: URL): string {
  const clean = new URL(url);
  for (const key of ["code", "token_hash", "type", "error", "error_code", "error_description"]) clean.searchParams.delete(key);
  clean.hash = "";
  return `${clean.pathname}${clean.search}`;
}

export async function initializePasswordRecovery(supabase: SupabaseClient, url: URL): Promise<boolean> {
  const linkError = getRecoveryLinkError(url);
  if (linkError) throw new Error(linkError);
  const hash = new URLSearchParams(url.hash.slice(1));
  const tokenHash = url.searchParams.get("token_hash");
  if (url.searchParams.get("type") === "recovery" && tokenHash) {
    const { error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
    if (error) throw error;
  } else if (hash.get("type") === "recovery" && hash.get("access_token") && hash.get("refresh_token")) {
    // Older emails were sent by the backend using the implicit flow.
    const { error } = await supabase.auth.setSession({ access_token: hash.get("access_token")!, refresh_token: hash.get("refresh_token")! });
    if (error) throw error;
  }
  // createBrowserClient automatically exchanges PKCE codes. Exchanging here
  // again would consume the same one-time code twice.
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!session?.user && (url.searchParams.has("code") || tokenHash || hash.get("type") === "recovery")) {
    throw new Error("재설정 세션을 확인할 수 없습니다. 메일을 요청한 브라우저에서 최신 링크를 열거나 메일을 다시 요청해 주세요.");
  }
  return Boolean(session?.user);
}
