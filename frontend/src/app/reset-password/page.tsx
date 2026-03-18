import { ResetPasswordForm } from "@/components/ResetPasswordForm";
import { isSupabaseConfigured } from "@/lib/supabase/server";

type ResetPasswordPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const resolvedParams = searchParams ? await searchParams : {};
  const nextParam = resolvedParams.next;
  const nextPath = Array.isArray(nextParam) ? nextParam[0] || "/" : nextParam || "/";

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-copy">
          <span className="auth-badge">Supabase Auth</span>
          <h1>비밀번호 재설정</h1>
          <p>이메일로 받은 재설정 링크를 통해 새 비밀번호를 등록할 수 있습니다.</p>
        </div>

        <ResetPasswordForm nextPath={nextPath} authAvailable={isSupabaseConfigured()} />
      </section>
    </main>
  );
}
