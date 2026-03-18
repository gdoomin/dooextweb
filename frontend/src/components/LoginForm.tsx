"use client";

import { type FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { createClient as createSupabaseClient } from "@/lib/supabase/client";

type LoginFormProps = {
  nextPath: string;
  authAvailable?: boolean;
  onSuccess?: () => void;
};

export function LoginForm({ nextPath, authAvailable = true, onSuccess }: LoginFormProps) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("Supabase 계정으로 로그인합니다.");
  const [tone, setTone] = useState<"idle" | "success" | "error">("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!authAvailable) {
    return (
      <div className="auth-message auth-message-error">
        Supabase 인증을 사용하려면 `frontend/.env.local`에 실제 URL과 anon key를 입력해 주세요.
      </div>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setTone("idle");
    setMessage(mode === "login" ? "로그인 처리 중.." : "회원가입 처리 중..");

    try {
      const supabase = createSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase 인증 설정이 필요합니다.");
      }

      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          throw error;
        }

        setTone("success");
        setMessage("로그인에 성공했습니다.");
        onSuccess?.();
        router.replace(nextPath);
        router.refresh();
        return;
      }

      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo:
            typeof window !== "undefined"
              ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`
              : undefined,
        },
      });
      if (error) {
        throw error;
      }

      setTone("success");
      setMessage("회원가입 요청을 보냈습니다. 이메일 인증을 사용하는 중이면 메일을 확인해 주세요.");
    } catch (caught) {
      setTone("error");
      setMessage(caught instanceof Error ? caught.message : "인증 처리에 실패했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <div className="auth-tabs">
        <button
          type="button"
          className={`auth-tab ${mode === "login" ? "is-active" : ""}`}
          onClick={() => setMode("login")}
        >
          로그인
        </button>
        <button
          type="button"
          className={`auth-tab ${mode === "signup" ? "is-active" : ""}`}
          onClick={() => setMode("signup")}
        >
          회원가입
        </button>
      </div>

      <form className="auth-form" onSubmit={handleSubmit}>
        <label className="auth-field">
          <span>이메일</span>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>

        <label className="auth-field">
          <span>비밀번호</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>

        <button type="submit" className="auth-submit" disabled={isSubmitting}>
          {isSubmitting ? "처리 중.." : mode === "login" ? "로그인" : "회원가입"}
        </button>

        {mode === "login" ? (
          <div className="auth-link-row">
            <Link
              className="auth-link"
              href={`/reset-password?next=${encodeURIComponent(nextPath)}`}
            >
              비밀번호를 잊으셨나요?
            </Link>
          </div>
        ) : null}
      </form>

      <div className={`auth-message auth-message-${tone}`}>{message}</div>
    </>
  );
}
