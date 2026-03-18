"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { createClient as createSupabaseClient } from "@/lib/supabase/client";

type ResetPasswordFormProps = {
  nextPath: string;
  authAvailable?: boolean;
};

function normalizeNextPath(nextPath: string) {
  return nextPath.startsWith("/") ? nextPath : "/";
}

export function ResetPasswordForm({ nextPath, authAvailable = true }: ResetPasswordFormProps) {
  const router = useRouter();
  const safeNextPath = useMemo(() => normalizeNextPath(nextPath), [nextPath]);

  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("가입한 이메일 주소를 입력하면 비밀번호 재설정 링크를 보내드립니다.");
  const [tone, setTone] = useState<"idle" | "success" | "error">("idle");
  const [isInitializing, setIsInitializing] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [canUpdatePassword, setCanUpdatePassword] = useState(false);

  const loginHref = useMemo(
    () => `/login?next=${encodeURIComponent(safeNextPath)}`,
    [safeNextPath],
  );

  useEffect(() => {
    let isMounted = true;
    if (!authAvailable) {
      setIsInitializing(false);
      return;
    }

    const supabaseClient = createSupabaseClient();
    if (!supabaseClient) {
      setTone("error");
      setMessage("Supabase 인증 설정이 필요합니다.");
      setIsInitializing(false);
      return;
    }
    const supabase = supabaseClient;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!isMounted) {
        return;
      }

      if ((event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") && session?.user) {
        setCanUpdatePassword(true);
        setTone("success");
        setMessage("새 비밀번호를 입력해 저장해 주세요.");
      }
    });

    async function initializeRecoverySession() {
      try {
        const currentUrl = new URL(window.location.href);
        const code = currentUrl.searchParams.get("code");
        const tokenHash = currentUrl.searchParams.get("token_hash");
        const type = currentUrl.searchParams.get("type");

        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            throw error;
          }
        } else if (type === "recovery" && tokenHash) {
          const { error } = await supabase.auth.verifyOtp({
            type: "recovery",
            token_hash: tokenHash,
          });
          if (error) {
            throw error;
          }
        }

        if (code || tokenHash || type) {
          currentUrl.searchParams.delete("code");
          currentUrl.searchParams.delete("token_hash");
          currentUrl.searchParams.delete("type");
          window.history.replaceState({}, "", `${currentUrl.pathname}${currentUrl.search}`);
        }

        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();
        if (sessionError) {
          throw sessionError;
        }

        if (!isMounted) {
          return;
        }

        if (session?.user) {
          setCanUpdatePassword(true);
          setTone("success");
          setMessage("새 비밀번호를 입력해 저장해 주세요.");
        } else {
          setCanUpdatePassword(false);
        }
      } catch (caught) {
        if (!isMounted) {
          return;
        }

        setTone("error");
        setMessage(caught instanceof Error ? caught.message : "비밀번호 재설정 준비에 실패했습니다.");
      } finally {
        if (isMounted) {
          setIsInitializing(false);
        }
      }
    }

    void initializeRecoverySession();

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [authAvailable]);

  async function handleSendResetEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSending(true);
    setTone("idle");
    setMessage("비밀번호 재설정 메일을 보내는 중입니다.");

    try {
      const supabase = createSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase 인증 설정이 필요합니다.");
      }

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo:
          typeof window !== "undefined"
            ? `${window.location.origin}/reset-password?next=${encodeURIComponent(safeNextPath)}`
            : undefined,
      });
      if (error) {
        throw error;
      }

      setTone("success");
      setMessage("재설정 메일을 보냈습니다. 받은 링크를 열어 새 비밀번호를 설정해 주세요.");
    } catch (caught) {
      setTone("error");
      setMessage(caught instanceof Error ? caught.message : "비밀번호 재설정 메일 발송에 실패했습니다.");
    } finally {
      setIsSending(false);
    }
  }

  async function handleUpdatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsUpdating(true);
    setTone("idle");
    setMessage("새 비밀번호를 저장하는 중입니다.");

    try {
      if (newPassword.length < 8) {
        throw new Error("새 비밀번호는 8자 이상으로 입력해 주세요.");
      }

      if (newPassword !== confirmPassword) {
        throw new Error("새 비밀번호와 비밀번호 확인이 일치하지 않습니다.");
      }

      const supabase = createSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase 인증 설정이 필요합니다.");
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        throw error;
      }

      setTone("success");
      setMessage("비밀번호가 변경되었습니다. 다시 로그인해 주세요.");
      setNewPassword("");
      setConfirmPassword("");
      await supabase.auth.signOut();
      router.replace(loginHref);
      router.refresh();
    } catch (caught) {
      setTone("error");
      setMessage(caught instanceof Error ? caught.message : "비밀번호 변경에 실패했습니다.");
    } finally {
      setIsUpdating(false);
    }
  }

  if (!authAvailable) {
    return (
      <div className="auth-form">
        <div className="auth-message auth-message-error">
          Supabase 인증을 사용하려면 `frontend/.env.local`에 실제 URL과 anon key를 입력해 주세요.
        </div>
        <div className="auth-link-row">
          <Link className="auth-link" href={loginHref}>
            로그인으로 돌아가기
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-form">
      <form className="auth-form" onSubmit={handleSendResetEmail}>
        <label className="auth-field">
          <span>이메일</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <button type="submit" className="auth-submit" disabled={isInitializing || isSending}>
          {isSending ? "메일 발송 중.." : "재설정 메일 보내기"}
        </button>
      </form>

      {canUpdatePassword ? (
        <form className="auth-form auth-section" onSubmit={handleUpdatePassword}>
          <p className="auth-helper">재설정 링크로 접속되었으니 새 비밀번호를 바로 저장할 수 있습니다.</p>
          <label className="auth-field">
            <span>새 비밀번호</span>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              minLength={8}
            />
          </label>
          <label className="auth-field">
            <span>새 비밀번호 확인</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              minLength={8}
            />
          </label>
          <button type="submit" className="auth-submit" disabled={isInitializing || isUpdating}>
            {isUpdating ? "변경 중.." : "비밀번호 변경"}
          </button>
        </form>
      ) : (
        <p className="auth-helper">메일에서 받은 재설정 링크를 열면 새 비밀번호 입력 칸이 여기에 표시됩니다.</p>
      )}

      <div className={`auth-message auth-message-${tone}`}>{message}</div>

      <div className="auth-link-row">
        <Link className="auth-link" href={loginHref}>
          로그인으로 돌아가기
        </Link>
      </div>
    </div>
  );
}
