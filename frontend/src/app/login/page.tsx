import { redirect } from "next/navigation";

import { LoginForm } from "@/components/LoginForm";
import { getUser, isSupabaseConfigured } from "@/lib/supabase/server";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const user = await getUser();

  if (user) {
    redirect("/");
  }

  const resolvedParams = searchParams ? await searchParams : {};
  const nextParam = resolvedParams.next;
  const nextPath = Array.isArray(nextParam) ? nextParam[0] || "/" : nextParam || "/";

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-copy">
          <span className="auth-badge">Supabase Auth</span>
          <h1>DOO Extractor 로그인</h1>
          <p>이메일과 비밀번호 계정으로 로그인한 뒤 KML 변환 기능을 사용할 수 있습니다.</p>
        </div>

        <LoginForm nextPath={nextPath} authAvailable={isSupabaseConfigured()} />
      </section>
    </main>
  );
}
