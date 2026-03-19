"use client";

import { FormEvent, useState } from "react";

import { API_BASE_URL } from "@/lib/convert";

type NoticePayload = {
  enabled?: unknown;
  message?: string;
  updated_at?: string;
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

export default function PopupAdminPage() {
  const [password, setPassword] = useState("");
  const [verified, setVerified] = useState(false);
  const [message, setMessage] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"idle" | "success" | "error">("idle");
  const [isLoading, setIsLoading] = useState(false);

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
        )}

        {updatedAt ? <p className="popup-admin-updated">최근 수정: {new Date(updatedAt).toLocaleString("ko-KR")}</p> : null}
        <p className={`popup-admin-status popup-admin-status-${statusTone}`}>{status || " "}</p>
      </section>
    </main>
  );
}
