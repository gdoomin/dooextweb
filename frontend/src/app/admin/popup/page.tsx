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
    } catch (error) {
      setStatus(readErrorMessage(error, "비밀번호 확인에 실패했습니다."));
      setStatusTone("error");
    } finally {
      setIsLoading(false);
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
          </>
        )}

        {updatedAt ? <p className="popup-admin-updated">최근 수정: {new Date(updatedAt).toLocaleString("ko-KR")}</p> : null}
        <p className={`popup-admin-status popup-admin-status-${statusTone}`}>{status || " "}</p>
      </section>
    </main>
  );
}
