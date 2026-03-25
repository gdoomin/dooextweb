"use client";

import { FormEvent, useMemo, useState } from "react";

import { API_BASE_URL } from "@/lib/convert";

type NoticePayload = {
  enabled?: unknown;
  message?: string;
  updated_at?: string;
};

type AdminUsageRow = {
  user_id: string;
  user_email: string;
  plan_code: string;
  subscription_status: string;
  monthly_kml_used: number;
  total_kml_used: number;
  total_jobs: number;
  last_accessed_at: string;
  last_access_path: string;
  last_uploaded_at: string;
  last_filename: string;
};

type PromoCodeRow = {
  code: string;
  plan_code: "lite" | "pro";
  duration_days: number;
  max_uses: number;
  used_count: number;
  enabled: boolean;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const text = (error.message || "").trim();
    return text || fallback;
  }
  if (typeof error === "string") {
    const text = error.trim();
    return text || fallback;
  }
  if (error && typeof error === "object") {
    try {
      const serialized = JSON.stringify(error);
      return serialized || fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    const payload = JSON.parse(text);
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseLooseBoolean(value: unknown, defaultValue = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["", "0", "false", "off", "no", "n", "disabled"].includes(normalized)) {
      return false;
    }
    if (["1", "true", "on", "yes", "y", "enabled"].includes(normalized)) {
      return true;
    }
    return defaultValue;
  }
  return defaultValue;
}

function parseNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDate(value: string): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("ko-KR");
}

function parseDateMs(value: string): number {
  if (!value) {
    return 0;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export default function PopupAdminPage() {
  const [password, setPassword] = useState("");
  const [verified, setVerified] = useState(false);
  const [message, setMessage] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"idle" | "success" | "error">("idle");
  const [isLoading, setIsLoading] = useState(false);

  const [usageMonthKey, setUsageMonthKey] = useState("");
  const [usageRows, setUsageRows] = useState<AdminUsageRow[]>([]);
  const [usageError, setUsageError] = useState("");
  const [isUsageLoading, setIsUsageLoading] = useState(false);
  const [usageTab, setUsageTab] = useState<"usage" | "recent">("usage");
  const [promoRows, setPromoRows] = useState<PromoCodeRow[]>([]);
  const [promoCode, setPromoCode] = useState("");
  const [promoPlanCode, setPromoPlanCode] = useState<"lite" | "pro">("pro");
  const [promoDurationDays, setPromoDurationDays] = useState(30);
  const [promoMaxUses, setPromoMaxUses] = useState(1);
  const [promoStatus, setPromoStatus] = useState("");
  const [promoStatusTone, setPromoStatusTone] = useState<"idle" | "success" | "error">("idle");
  const [isPromoLoading, setIsPromoLoading] = useState(false);
  const [promoToggleCode, setPromoToggleCode] = useState("");

  const displayedUsageRows = useMemo(() => {
    const nextRows = [...usageRows];
    if (usageTab === "recent") {
      nextRows.sort((a, b) => {
        const recentDelta = parseDateMs(b.last_accessed_at || b.last_uploaded_at) - parseDateMs(a.last_accessed_at || a.last_uploaded_at);
        if (recentDelta !== 0) {
          return recentDelta;
        }
        const jobsDelta = b.total_jobs - a.total_jobs;
        if (jobsDelta !== 0) {
          return jobsDelta;
        }
        return (b.user_email || "").localeCompare(a.user_email || "");
      });
      return nextRows;
    }

    nextRows.sort((a, b) => {
      const monthDelta = b.monthly_kml_used - a.monthly_kml_used;
      if (monthDelta !== 0) {
        return monthDelta;
      }
      const totalDelta = b.total_kml_used - a.total_kml_used;
      if (totalDelta !== 0) {
        return totalDelta;
      }
      const jobsDelta = b.total_jobs - a.total_jobs;
      if (jobsDelta !== 0) {
        return jobsDelta;
      }
      return parseDateMs(b.last_uploaded_at) - parseDateMs(a.last_uploaded_at);
    });
    return nextRows;
  }, [usageRows, usageTab]);

  async function loadUsage(nextPassword: string) {
    setIsUsageLoading(true);
    setUsageError("");

    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/popup-notice/usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: nextPassword }),
      });
      const payload = await parseJson(response);
      if (!response.ok) {
        throw new Error(String(payload.detail || "사용량 조회에 실패했습니다."));
      }

      const monthKey = typeof payload.month_key === "string" ? payload.month_key : "";
      const users = Array.isArray(payload.users) ? payload.users : [];
      const rows: AdminUsageRow[] = users
        .filter((item) => item && typeof item === "object")
        .map((item) => {
          const row = item as Record<string, unknown>;
          return {
            user_id: String(row.user_id || ""),
            user_email: String(row.user_email || ""),
            plan_code: String(row.plan_code || ""),
            subscription_status: String(row.subscription_status || ""),
            monthly_kml_used: parseNumber(row.monthly_kml_used),
            total_kml_used: parseNumber(row.total_kml_used),
            total_jobs: parseNumber(row.total_jobs),
            last_accessed_at: String(row.last_accessed_at || ""),
            last_access_path: String(row.last_access_path || ""),
            last_uploaded_at: String(row.last_uploaded_at || ""),
            last_filename: String(row.last_filename || ""),
          };
        });

      setUsageMonthKey(monthKey);
      setUsageRows(rows);
    } catch (error) {
      setUsageError(readErrorMessage(error, "사용량 조회에 실패했습니다."));
    } finally {
      setIsUsageLoading(false);
    }
  }

  async function loadPromoCodes(nextPassword: string) {
    setIsPromoLoading(true);
    setPromoStatus("");
    setPromoStatusTone("idle");

    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/promo-codes/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: nextPassword }),
      });
      const payload = await parseJson(response);
      if (!response.ok) {
        throw new Error(String(payload.detail || "프로모션 코드 조회에 실패했습니다."));
      }

      const codes = Array.isArray(payload.codes) ? payload.codes : [];
      const rows: PromoCodeRow[] = codes
        .filter((item) => item && typeof item === "object")
        .map((item) => {
          const row = item as Record<string, unknown>;
          return {
            code: String(row.code || ""),
            plan_code: String(row.plan_code || "pro") === "lite" ? "lite" : "pro",
            duration_days: parseNumber(row.duration_days),
            max_uses: parseNumber(row.max_uses),
            used_count: parseNumber(row.used_count),
            enabled: parseLooseBoolean(row.enabled, true),
            expires_at: String(row.expires_at || ""),
            created_at: String(row.created_at || ""),
            updated_at: String(row.updated_at || ""),
          };
        });
      setPromoRows(rows);
    } catch (error) {
      setPromoStatus(readErrorMessage(error, "프로모션 코드 조회에 실패했습니다."));
      setPromoStatusTone("error");
    } finally {
      setIsPromoLoading(false);
    }
  }

  async function verifyPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setStatus("");
    setStatusTone("idle");

    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/popup-notice/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = await parseJson(response);
      if (!response.ok) {
        throw new Error(String(payload.detail || "비밀번호 확인에 실패했습니다."));
      }

      const notice = ((payload.notice as NoticePayload) || {}) as NoticePayload;
      setVerified(true);
      setMessage(typeof notice.message === "string" ? notice.message : "");
      setEnabled(parseLooseBoolean(notice.enabled, false));
      setUpdatedAt(typeof notice.updated_at === "string" ? notice.updated_at : "");
      setStatus("비밀번호 확인 완료. 팝업 문구를 수정할 수 있습니다.");
      setStatusTone("success");
      await loadUsage(password);
      await loadPromoCodes(password);
    } catch (error) {
      setStatus(readErrorMessage(error, "비밀번호 확인에 실패했습니다."));
      setStatusTone("error");
    } finally {
      setIsLoading(false);
    }
  }

  async function createPromoCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsPromoLoading(true);
    setPromoStatus("");
    setPromoStatusTone("idle");

    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/promo-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password,
          code: promoCode,
          plan_code: promoPlanCode,
          duration_days: promoDurationDays,
          max_uses: promoMaxUses,
        }),
      });
      const payload = await parseJson(response);
      if (!response.ok) {
        throw new Error(String(payload.detail || "프로모션 코드 생성에 실패했습니다."));
      }

      const codes = Array.isArray(payload.codes) ? payload.codes : [];
      setPromoRows(
        codes
          .filter((item) => item && typeof item === "object")
          .map((item) => {
            const row = item as Record<string, unknown>;
            return {
              code: String(row.code || ""),
              plan_code: String(row.plan_code || "pro") === "lite" ? "lite" : "pro",
              duration_days: parseNumber(row.duration_days),
              max_uses: parseNumber(row.max_uses),
              used_count: parseNumber(row.used_count),
              enabled: parseLooseBoolean(row.enabled, true),
              expires_at: String(row.expires_at || ""),
              created_at: String(row.created_at || ""),
              updated_at: String(row.updated_at || ""),
            };
          }),
      );
      setPromoCode("");
      setPromoDurationDays(30);
      setPromoMaxUses(1);
      setPromoStatus("프로모션 코드가 생성되었습니다.");
      setPromoStatusTone("success");
    } catch (error) {
      setPromoStatus(readErrorMessage(error, "프로모션 코드 생성에 실패했습니다."));
      setPromoStatusTone("error");
    } finally {
      setIsPromoLoading(false);
    }
  }

  async function togglePromoCode(code: string, nextEnabled: boolean) {
    setPromoToggleCode(code);
    setPromoStatus("");
    setPromoStatusTone("idle");

    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/promo-codes/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, code, enabled: nextEnabled }),
      });
      const payload = await parseJson(response);
      if (!response.ok) {
        throw new Error(String(payload.detail || "프로모션 코드 상태 변경에 실패했습니다."));
      }
      const codes = Array.isArray(payload.codes) ? payload.codes : [];
      setPromoRows(
        codes
          .filter((item) => item && typeof item === "object")
          .map((item) => {
            const row = item as Record<string, unknown>;
            return {
              code: String(row.code || ""),
              plan_code: String(row.plan_code || "pro") === "lite" ? "lite" : "pro",
              duration_days: parseNumber(row.duration_days),
              max_uses: parseNumber(row.max_uses),
              used_count: parseNumber(row.used_count),
              enabled: parseLooseBoolean(row.enabled, true),
              expires_at: String(row.expires_at || ""),
              created_at: String(row.created_at || ""),
              updated_at: String(row.updated_at || ""),
            };
          }),
      );
      setPromoStatus(nextEnabled ? "프로모션 코드가 활성화되었습니다." : "프로모션 코드가 비활성화되었습니다.");
      setPromoStatusTone("success");
    } catch (error) {
      setPromoStatus(readErrorMessage(error, "프로모션 코드 상태 변경에 실패했습니다."));
      setPromoStatusTone("error");
    } finally {
      setPromoToggleCode("");
    }
  }

  async function saveNotice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setStatus("");
    setStatusTone("idle");

    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/popup-notice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, message, enabled }),
      });
      const payload = await parseJson(response);
      if (!response.ok) {
        throw new Error(String(payload.detail || "저장에 실패했습니다."));
      }

      const notice = ((payload.notice as NoticePayload) || {}) as NoticePayload;
      setMessage(typeof notice.message === "string" ? notice.message : message);
      setEnabled(parseLooseBoolean(notice.enabled, false));
      setUpdatedAt(typeof notice.updated_at === "string" ? notice.updated_at : "");
      setStatus("저장되었습니다. 메인 화면 새로고침 시 반영됩니다.");
      setStatusTone("success");
    } catch (error) {
      setStatus(readErrorMessage(error, "저장에 실패했습니다."));
      setStatusTone("error");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="popup-admin-shell">
      <section className="popup-admin-card">
        <h1>팝업 문구 관리자</h1>
        <p>이 페이지에서 메인 화면 공지 팝업 문구를 수정할 수 있습니다.</p>

        {!verified ? (
          <form className="popup-admin-form" onSubmit={verifyPassword}>
            <label htmlFor="popup-admin-password">비밀번호</label>
            <input
              id="popup-admin-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="관리자 비밀번호 입력"
              autoComplete="current-password"
              required
            />
            <button type="submit" disabled={isLoading}>
              {isLoading ? "확인 중..." : "입장"}
            </button>
          </form>
        ) : (
          <>
            <form className="popup-admin-form" onSubmit={saveNotice}>
              <label htmlFor="popup-admin-message">팝업 문구</label>
              <textarea
                id="popup-admin-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={6}
                maxLength={500}
                placeholder="팝업에 표시할 문구를 입력하세요."
                required
              />
              <label className="popup-admin-checkbox">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                팝업 표시 사용
              </label>
              <button type="submit" disabled={isLoading}>
                {isLoading ? "저장 중..." : "저장"}
              </button>
            </form>

            <section className="popup-admin-usage">
              <div className="popup-admin-usage-head">
                <h2>사용자 이메일 / 사용량</h2>
                <button
                  type="button"
                  className="popup-admin-usage-refresh"
                  onClick={() => loadUsage(password)}
                  disabled={isUsageLoading}
                >
                  {isUsageLoading ? "갱신 중..." : "새로고침"}
                </button>
              </div>
              <p className="popup-admin-usage-meta">
                기준 월: <strong>{usageMonthKey || "-"}</strong>
              </p>
              <div className="popup-admin-usage-tabs" role="tablist" aria-label="사용자 사용량 정렬 탭">
                <button
                  type="button"
                  role="tab"
                  className={`popup-admin-usage-tab ${usageTab === "usage" ? "is-active" : ""}`}
                  aria-selected={usageTab === "usage"}
                  onClick={() => setUsageTab("usage")}
                >
                  사용량 순
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`popup-admin-usage-tab ${usageTab === "recent" ? "is-active" : ""}`}
                  aria-selected={usageTab === "recent"}
                  onClick={() => setUsageTab("recent")}
                >
                  최근 접속 순
                </button>
              </div>
              {usageError ? <p className="popup-admin-usage-error">{usageError}</p> : null}
              <div className="popup-admin-usage-table-wrap">
                <table className="popup-admin-usage-table">
                  <thead>
                    <tr>
                      <th>이메일</th>
                      <th>아이디</th>
                      <th>이번 달</th>
                      <th>누적</th>
                      <th>작업 수</th>
                      <th>요금제</th>
                      <th>최근 접속</th>
                      <th>접속 위치</th>
                      <th>최근 파일</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedUsageRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="popup-admin-usage-empty">
                          표시할 사용량 데이터가 없습니다.
                        </td>
                      </tr>
                    ) : (
                      displayedUsageRows.map((row) => (
                        <tr key={`${row.user_id || "unknown"}-${row.user_email || "no-email"}`}>
                          <td>{row.user_email || "-"}</td>
                          <td>{row.user_id || "-"}</td>
                          <td>{row.monthly_kml_used}</td>
                          <td>{row.total_kml_used}</td>
                          <td>{row.total_jobs}</td>
                          <td>{row.plan_code || "-"}</td>
                          <td>{formatDate(row.last_accessed_at || row.last_uploaded_at)}</td>
                          <td>{row.last_access_path || "-"}</td>
                          <td>{row.last_filename || "-"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="popup-admin-usage">
              <div className="popup-admin-usage-head">
                <h2>프로모션 코드</h2>
                <button
                  type="button"
                  className="popup-admin-usage-refresh"
                  onClick={() => loadPromoCodes(password)}
                  disabled={isPromoLoading}
                >
                  {isPromoLoading ? "불러오는 중..." : "새로고침"}
                </button>
              </div>
              <form className="popup-admin-form" onSubmit={createPromoCode}>
                <label htmlFor="popup-admin-promo-code">코드명 (비워두면 자동생성)</label>
                <input
                  id="popup-admin-promo-code"
                  type="text"
                  value={promoCode}
                  onChange={(event) => setPromoCode(event.target.value.toUpperCase())}
                  placeholder="예: DOO-PRO30"
                  autoCapitalize="characters"
                />
                <div className="popup-admin-inline-grid">
                  <label htmlFor="popup-admin-promo-plan">
                    대상 플랜
                    <select
                      id="popup-admin-promo-plan"
                      value={promoPlanCode}
                      onChange={(event) => setPromoPlanCode(event.target.value === "lite" ? "lite" : "pro")}
                    >
                      <option value="lite">Lite</option>
                      <option value="pro">Pro</option>
                    </select>
                  </label>
                  <label htmlFor="popup-admin-promo-days">
                    사용 기간(일)
                    <input
                      id="popup-admin-promo-days"
                      type="number"
                      min={1}
                      max={365}
                      value={promoDurationDays}
                      onChange={(event) => setPromoDurationDays(parseNumber(event.target.value) || 30)}
                    />
                  </label>
                  <label htmlFor="popup-admin-promo-max">
                    최대 사용 횟수
                    <input
                      id="popup-admin-promo-max"
                      type="number"
                      min={1}
                      max={100000}
                      value={promoMaxUses}
                      onChange={(event) => setPromoMaxUses(parseNumber(event.target.value) || 1)}
                    />
                  </label>
                </div>
                <button type="submit" disabled={isPromoLoading}>
                  {isPromoLoading ? "생성 중..." : "코드 생성"}
                </button>
              </form>
              <p className={`popup-admin-promo-status ${promoStatusTone === "success" ? "is-success" : promoStatusTone === "error" ? "is-error" : ""}`}>
                {promoStatus || " "}
              </p>
              <div className="popup-admin-usage-table-wrap">
                <table className="popup-admin-usage-table">
                  <thead>
                    <tr>
                      <th>코드</th>
                      <th>플랜</th>
                      <th>기간</th>
                      <th>사용</th>
                      <th>상태</th>
                      <th>코드 만료</th>
                      <th>생성일</th>
                      <th>관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {promoRows.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="popup-admin-usage-empty">
                          생성된 프로모션 코드가 없습니다.
                        </td>
                      </tr>
                    ) : (
                      promoRows.map((row) => (
                        <tr key={row.code}>
                          <td>{row.code}</td>
                          <td>{row.plan_code.toUpperCase()}</td>
                          <td>{row.duration_days}일</td>
                          <td>
                            {row.used_count} / {row.max_uses}
                          </td>
                          <td>{row.enabled ? "활성" : "비활성"}</td>
                          <td>{row.expires_at ? formatDate(row.expires_at) : "-"}</td>
                          <td>{formatDate(row.created_at)}</td>
                          <td>
                            <div className="popup-admin-promo-actions">
                              <button
                                type="button"
                                className={`popup-admin-promo-toggle ${row.enabled ? "is-disabled" : ""}`}
                                onClick={() => togglePromoCode(row.code, !row.enabled)}
                                disabled={promoToggleCode === row.code}
                              >
                                {promoToggleCode === row.code ? "처리 중..." : row.enabled ? "비활성화" : "활성화"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {updatedAt ? <p className="popup-admin-updated">최근 수정: {new Date(updatedAt).toLocaleString("ko-KR")}</p> : null}
        <p className={`popup-admin-status popup-admin-status-${statusTone}`}>{status || " "}</p>
      </section>
    </main>
  );
}
