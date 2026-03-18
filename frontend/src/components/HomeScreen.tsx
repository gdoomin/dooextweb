"use client";

import Image from "next/image";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import { LoginForm } from "@/components/LoginForm";
import {
  API_BASE_URL,
  type ConvertResponse,
  type ServerHistoryItem,
  buildUserHeaders,
  fetchUserHistory,
  loadLastConvert,
  reopenHistoryItem,
  saveLastConvert,
} from "@/lib/convert";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";

const modeLabel: Record<ConvertResponse["mode"], string> = {
  linestring: "LineString 모드 | Flight Line 좌표 추출",
  polygon: "Polygon 모드 | 시작점과 끝점이 없는 폴리곤 파일",
};

const modeBadgeLabel: Record<ConvertResponse["mode"], string> = {
  linestring: "라인",
  polygon: "폴리곤",
};

type HomeScreenProps = {
  initialUserEmail?: string;
  initialUserId?: string;
  authAvailable?: boolean;
};

export function HomeScreen({
  initialUserEmail = "",
  initialUserId = "",
  authAvailable = true,
}: HomeScreenProps) {
  const restored = loadLastConvert();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [response, setResponse] = useState<ConvertResponse | null>(restored);
  const [historyItems, setHistoryItems] = useState<ServerHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [statusMessage, setStatusMessage] = useState(
    restored ? "이전 변환 결과를 복원했습니다." : "KML 파일을 불러와 주세요.",
  );
  const [statusTone, setStatusTone] = useState<"idle" | "loading" | "success" | "error">(restored ? "success" : "idle");
  const [isLoading, setIsLoading] = useState(false);
  const [historyOpeningId, setHistoryOpeningId] = useState("");
  const [userEmail, setUserEmail] = useState(initialUserEmail);
  const [userId, setUserId] = useState(initialUserId);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMessage, setAuthMessage] = useState("전체 기능을 사용하려면 회원가입이 필요합니다.");

  const isAuthenticated = Boolean(userId);
  const pathLabel = useMemo(() => response?.filename || "", [response]);
  const modeText = response ? modeLabel[response.mode] : "KML을 업로드하면 변환 결과가 표시됩니다.";

  async function resolveCurrentIdentity() {
    if (!authAvailable) {
      return { id: "", email: "" };
    }

    const supabase = createSupabaseClient();
    if (!supabase) {
      return { id: userId, email: userEmail };
    }

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const resolvedId = user?.id || "";
      const resolvedEmail = user?.email || "";

      if (resolvedId !== userId) {
        setUserId(resolvedId);
      }
      if (resolvedEmail !== userEmail) {
        setUserEmail(resolvedEmail);
      }

      return { id: resolvedId, email: resolvedEmail };
    } catch {
      return { id: userId, email: userEmail };
    }
  }

  useEffect(() => {
    if (!authAvailable) {
      setUserId("");
      setUserEmail("");
      return;
    }

    let mounted = true;
    let unsubscribe: (() => void) | undefined;

    try {
      const supabase = createSupabaseClient();
      if (!supabase) {
        setUserId("");
        setUserEmail("");
        return;
      }

      supabase.auth.getUser().then(({ data }) => {
        if (!mounted) {
          return;
        }
        setUserId(data.user?.id || "");
        setUserEmail(data.user?.email || "");
      });

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!mounted) {
          return;
        }
        setUserId(session?.user?.id || "");
        setUserEmail(session?.user?.email || "");
      });

      unsubscribe = () => subscription.unsubscribe();
    } catch {
      setUserId("");
      setUserEmail("");
    }

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [authAvailable]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!userId) {
        setHistoryItems([]);
        setHistoryError("");
        return;
      }

      setHistoryLoading(true);
      setHistoryError("");
      try {
        const items = await fetchUserHistory(userId, userEmail);
        if (!cancelled) {
          setHistoryItems(items);
        }
      } catch (error) {
        if (!cancelled) {
          setHistoryError(error instanceof Error ? error.message : "히스토리를 불러오지 못했습니다.");
        }
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [userId, userEmail]);

  function openAuthModal(message: string) {
    setAuthMessage(message);
    setShowAuthModal(true);
  }

  function requireAuth(message: string) {
    if (isAuthenticated) {
      return true;
    }

    if (!authAvailable) {
      setStatusTone("error");
      setStatusMessage("Supabase 인증 설정이 필요합니다. frontend/.env.local의 URL과 anon key를 확인해 주세요.");
      openAuthModal("Supabase 인증 설정이 필요합니다. 실제 URL과 anon key를 넣고 다시 시도해 주세요.");
      return false;
    }

    setStatusTone("idle");
    setStatusMessage("좌표 결과 미리보기는 사용할 수 있지만, 저장과 다시열기는 로그인 후 사용할 수 있습니다.");
    openAuthModal(message);
    return false;
  }

  function formatHistorySavedAt(savedAt: string) {
    const date = new Date(savedAt);
    if (Number.isNaN(date.getTime())) {
      return savedAt;
    }

    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  async function refreshHistory(nextUserId = userId, nextUserEmail = userEmail) {
    if (!nextUserId) {
      setHistoryItems([]);
      setHistoryError("");
      return;
    }

    setHistoryLoading(true);
    setHistoryError("");
    try {
      const items = await fetchUserHistory(nextUserId, nextUserEmail);
      setHistoryItems(items);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "히스토리를 불러오지 못했습니다.");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function handleFilePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    setIsLoading(true);
    setStatusTone("loading");
    setStatusMessage("파일을 변환하고 있습니다...");

    try {
      const identity = await resolveCurrentIdentity();
      const uploadAuthenticated = Boolean(identity.id);
      const responseHeaders = uploadAuthenticated ? buildUserHeaders(identity.id, identity.email) : undefined;
      const res = await fetch(`${API_BASE_URL}/api/convert`, {
        method: "POST",
        body: formData,
        headers: responseHeaders,
      });

      const payload = (await res.json()) as ConvertResponse | { detail?: string };
      if (!res.ok) {
        const detail = "detail" in payload ? payload.detail || "변환에 실패했습니다." : "변환에 실패했습니다.";
        throw new Error(detail);
      }

      const converted = payload as ConvertResponse;
      setResponse(converted);
      saveLastConvert(converted);

      if (uploadAuthenticated) {
        await refreshHistory(identity.id, identity.email);
      }

      setStatusTone("success");
      setStatusMessage(
        uploadAuthenticated
          ? `${converted.result_count}개 결과를 변환했고, 내 히스토리에 저장했습니다.`
          : `${converted.result_count}개 결과를 불러왔습니다. 로그인하면 개인 히스토리와 다시열기를 사용할 수 있습니다.`,
      );
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(error instanceof Error ? error.message : "변환에 실패했습니다.");
    } finally {
      setIsLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function openFileDialog() {
    fileInputRef.current?.click();
  }

  async function handleHistoryOpen(item: ServerHistoryItem) {
    if (!requireAuth("개인 히스토리를 다시 열려면 로그인해 주세요.")) {
      return;
    }

    setHistoryOpeningId(item.job_id);
    setStatusTone("loading");
    setStatusMessage(`${item.project_name || item.filename} 결과를 다시 불러오는 중입니다...`);

    try {
      const reopened = await reopenHistoryItem(item.job_id, userId, userEmail);
      setResponse(reopened);
      saveLastConvert(reopened);
      setStatusTone("success");
      setStatusMessage(`${reopened.project_name || reopened.filename} 결과를 다시 열었습니다.`);
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(error instanceof Error ? error.message : "히스토리 항목을 다시 열지 못했습니다.");
    } finally {
      setHistoryOpeningId("");
    }
  }

  async function copyClipboard() {
    if (!response?.text_output) {
      setStatusTone("error");
      setStatusMessage("먼저 KML 파일을 불러와 주세요.");
      return;
    }
    if (!requireAuth("클립보드 복사는 로그인 후 사용할 수 있습니다.")) {
      return;
    }

    try {
      await navigator.clipboard.writeText(response.text_output);
      setStatusTone("success");
      setStatusMessage("클립보드에 복사했습니다.");
    } catch {
      setStatusTone("error");
      setStatusMessage("클립보드 복사에 실패했습니다.");
    }
  }

  function openViewer() {
    if (!response?.viewer_url) {
      setStatusTone("error");
      setStatusMessage("먼저 KML 파일을 불러와 주세요.");
      return;
    }

    if (!isAuthenticated) {
      const signupUrl = `${window.location.origin}/login?next=/`;
      const gatedViewerUrl = `${response.viewer_url}?preview_gate=1&signup_url=${encodeURIComponent(signupUrl)}`;
      window.open(gatedViewerUrl, "_blank", "noopener,noreferrer");
      setStatusTone("idle");
      setStatusMessage("비회원은 미리보기만 사용할 수 있습니다. 전체 기능은 로그인 후 열립니다.");
      return;
    }

    window.open(response.viewer_url, "_blank", "noopener,noreferrer");
  }

  function downloadText() {
    if (!response?.txt_download_url) {
      setStatusTone("error");
      setStatusMessage("먼저 KML 파일을 불러와 주세요.");
      return;
    }
    if (!requireAuth("텍스트 다운로드는 로그인 후 사용할 수 있습니다.")) {
      return;
    }

    window.open(response.txt_download_url, "_blank", "noopener,noreferrer");
    setStatusTone("success");
    setStatusMessage("텍스트 파일 다운로드를 시작했습니다.");
  }

  function downloadExcel() {
    if (!response?.xlsx_download_url) {
      setStatusTone("error");
      setStatusMessage("먼저 KML 파일을 불러와 주세요.");
      return;
    }
    if (response.mode === "polygon") {
      setStatusTone("error");
      setStatusMessage("폴리곤 파일은 아직 Excel 다운로드를 지원하지 않습니다.");
      return;
    }
    if (!requireAuth("엑셀 다운로드는 로그인 후 사용할 수 있습니다.")) {
      return;
    }

    window.open(response.xlsx_download_url, "_blank", "noopener,noreferrer");
    setStatusTone("success");
    setStatusMessage("엑셀 파일 다운로드를 시작했습니다.");
  }

  async function handleAuthButton() {
    if (!authAvailable) {
      openAuthModal("Supabase 인증 설정이 필요합니다. frontend/.env.local의 URL과 anon key를 확인해 주세요.");
      return;
    }

    if (!isAuthenticated) {
      openAuthModal("내 히스토리와 다시열기를 사용하려면 로그인해 주세요.");
      return;
    }

    try {
      const supabase = createSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase 인증 설정이 필요합니다.");
      }
      await supabase.auth.signOut();
      setUserId("");
      setUserEmail("");
      setHistoryItems([]);
      setHistoryError("");
      setStatusTone("idle");
      setStatusMessage("로그아웃했습니다.");
    } catch {
      setStatusTone("error");
      setStatusMessage("로그아웃에 실패했습니다.");
    }
  }

  return (
    <>
      <main className="doo-shell">
        <div className="doo-layout">
          <aside className="doo-sidebar">
            <div className="doo-title-block">
              <button
                type="button"
                className="doo-info-button"
                title="메뉴"
                onClick={() =>
                  window.alert("DOO Extractor\n\n버전: 3.0 web ver\n개발자: DOOHEE. JANG\n연락처: gdoomin@gmail.com")
                }
              >
                ☰
              </button>
              <div>
                <h1>DOO Extractor</h1>
                <p>KML to DMS 좌표 변환기</p>
              </div>
            </div>

            <div className="doo-sidebar-card">
              <div className="doo-sidebar-badge">Desktop Style Web</div>
              <div className="doo-sidebar-image-wrap">
                <Image
                  src="/banner.png"
                  alt="DOO Extractor banner"
                  width={300}
                  height={180}
                  className="doo-sidebar-image"
                  priority
                />
              </div>
            </div>

            <div className="doo-sidebar-footer">
              <div className="doo-sidebar-note">
                <div className="doo-note-head">
                  <span className="doo-note-label">{isAuthenticated ? "로그인 계정" : "사용 상태"}</span>
                  {isAuthenticated ? <div className="doo-auth-state">로그인됨</div> : null}
                </div>
                <code>{isAuthenticated ? userEmail : "비회원 미리보기 모드"}</code>
                <button type="button" className="doo-auth-button" onClick={handleAuthButton}>
                  {isAuthenticated ? "로그아웃" : "회원가입 / 로그인"}
                </button>
              </div>
            </div>
          </aside>

          <section className="doo-main">
            <div className="doo-top-panel">
              <label className="doo-top-label">KML 파일</label>
              <div className="doo-path-row">
                <input className="doo-path-input" value={pathLabel} readOnly placeholder="선택된 파일이 없습니다." />
                <button type="button" className="doo-open-button" onClick={openFileDialog} disabled={isLoading}>
                  {isLoading ? "불러오는 중..." : "파일 열기"}
                </button>
                <input ref={fileInputRef} type="file" accept=".kml" className="doo-hidden-input" onChange={handleFilePicked} />
              </div>
            </div>

            <div className="doo-mode-bar">
              <span className={response ? "doo-mode-active" : "doo-mode-idle"}>{modeText}</span>
              {response ? <span className="doo-mode-chip">{modeBadgeLabel[response.mode]}</span> : null}
            </div>

            {!isAuthenticated && response ? (
              <div className="doo-gate-banner" role="status">
                지금은 결과 미리보기 상태입니다. 로그인하면 업로드 이력이 개인별로 저장되고, 히스토리에서 다시열기를 사용할 수 있습니다.
              </div>
            ) : null}

            <div className="doo-result-grid">
              <section className="doo-result-column">
                <div className="doo-panel-head">
                  <div>
                    <div className="doo-panel-title">변환 결과</div>
                    <div className="doo-panel-subtitle">{response ? `${response.result_count}개 결과를 표시 중입니다.` : "KML 업로드를 기다리고 있습니다."}</div>
                  </div>
                </div>
                <div className="doo-text-panel">
                  <pre className="doo-text-viewer">{response?.text_output || ""}</pre>
                </div>
              </section>

              <aside className="doo-history-panel">
                <div className="doo-panel-head">
                  <div>
                    <div className="doo-panel-title">히스토리</div>
                  </div>
                  {isAuthenticated ? <span className="doo-panel-count">{historyItems.length}건</span> : null}
                </div>

                {!isAuthenticated ? (
                  <p className="doo-history-empty">로그인하면 업로드 시점이 서버에 저장되고, 이곳에서 다시열기로 현재 결과를 덮어쓸 수 있습니다.</p>
                ) : historyLoading ? (
                  <p className="doo-history-empty">히스토리를 불러오는 중입니다...</p>
                ) : historyError ? (
                  <p className="doo-history-empty">{historyError}</p>
                ) : historyItems.length ? (
                  <div className="doo-history-list doo-history-list-main">
                    {historyItems.map((item) => {
                      const isCurrent = response?.job_id === item.job_id;
                      const isOpening = historyOpeningId === item.job_id;
                      return (
                        <article key={item.job_id} className={`doo-history-row${isCurrent ? " is-current" : ""}`}>
                          <div className="doo-history-body">
                            <strong>{item.project_name || item.filename}</strong>
                            <span>{item.filename}</span>
                            <span>
                              {item.mode === "linestring" ? "라인" : "폴리곤"} · {item.result_count}개 · {formatHistorySavedAt(item.uploaded_at)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="doo-history-open"
                            onClick={() => handleHistoryOpen(item)}
                            disabled={isOpening}
                          >
                            {isOpening ? "불러오는 중..." : isCurrent ? "열림" : "다시열기"}
                          </button>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="doo-history-empty">아직 저장된 KML 업로드 기록이 없습니다. 로그인한 상태에서 파일을 열면 여기에 쌓입니다.</p>
                )}
              </aside>
            </div>

            <div className="doo-bottom-bar">
              <div className={`doo-status doo-status-${statusTone}`}>{statusMessage}</div>
              <div className="doo-actions">
                <button type="button" className="doo-action doo-action-copy" onClick={copyClipboard}>
                  클립보드 복사
                </button>
                <button type="button" className="doo-action doo-action-xlsx" onClick={downloadExcel}>
                  엑셀 저장
                </button>
                <button type="button" className="doo-action doo-action-txt" onClick={downloadText}>
                  텍스트 저장
                </button>
                <button type="button" className="doo-action doo-action-map" onClick={openViewer}>
                  도식화 보기
                </button>
              </div>
            </div>
          </section>
        </div>
      </main>

      {showAuthModal ? (
        <div className="auth-modal-backdrop" onClick={() => setShowAuthModal(false)}>
          <section className="auth-modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="auth-modal-copy">
              <span className="auth-badge">Membership</span>
              <h2>{authMessage}</h2>
              <p>좌표 추출은 바로 확인할 수 있지만, 개인 히스토리 저장과 다시열기 같은 기능은 로그인 후 사용할 수 있습니다.</p>
            </div>
            <LoginForm
              nextPath="/"
              authAvailable={authAvailable}
              onSuccess={() => {
                setShowAuthModal(false);
                setStatusTone("success");
                setStatusMessage("로그인되었습니다.");
              }}
            />
            <button type="button" className="auth-modal-close" onClick={() => setShowAuthModal(false)}>
              닫기
            </button>
          </section>
        </div>
      ) : null}
    </>
  );
}
