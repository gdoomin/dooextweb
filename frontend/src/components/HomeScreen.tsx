"use client";

import Image from "next/image";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import { LoginForm } from "@/components/LoginForm";
import { type ConvertResponse, loadLastConvert, saveLastConvert } from "@/lib/convert";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://127.0.0.1:8000";

const modeLabel: Record<ConvertResponse["mode"], string> = {
  linestring: "LineString 모드 | Flight Line 좌표 추출",
  polygon: "Polygon 모드 | 시작점과 끝점이 없는 도형 파일",
};

const modeBadgeLabel: Record<ConvertResponse["mode"], string> = {
  linestring: "라인",
  polygon: "폴리곤",
};

type HomeScreenProps = {
  initialUserEmail?: string;
};

export function HomeScreen({ initialUserEmail = "" }: HomeScreenProps) {
  const restored = loadLastConvert();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [response, setResponse] = useState<ConvertResponse | null>(restored);
  const [statusMessage, setStatusMessage] = useState(
    restored ? "이전 작업 결과를 복원했습니다." : "KML 파일을 불러와 주세요.",
  );
  const [statusTone, setStatusTone] = useState<"idle" | "loading" | "success" | "error">(restored ? "success" : "idle");
  const [isLoading, setIsLoading] = useState(false);
  const [userEmail, setUserEmail] = useState(initialUserEmail);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMessage, setAuthMessage] = useState("전체 기능을 사용하려면 회원가입하세요.");

  const isAuthenticated = Boolean(userEmail);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;

    try {
      const supabase = createSupabaseClient();

      supabase.auth.getUser().then(({ data }) => {
        if (!mounted) {
          return;
        }
        setUserEmail(data.user?.email || "");
      });

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!mounted) {
          return;
        }
        setUserEmail(session?.user?.email || "");
      });

      unsubscribe = () => subscription.unsubscribe();
    } catch {
      setUserEmail("");
    }

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    setShowAuthModal(false);
    setStatusTone("success");
    setStatusMessage("로그인되었습니다. 전체 기능을 사용할 수 있습니다.");
  }, [isAuthenticated]);

  useEffect(() => {
    if (!response || isAuthenticated) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY <= 0) {
        return;
      }
      event.preventDefault();
      setAuthMessage("전체 기능을 사용하려면 회원가입하세요.");
      setShowAuthModal(true);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!["PageDown", "ArrowDown", "Space"].includes(event.code)) {
        return;
      }
      event.preventDefault();
      setAuthMessage("전체 기능을 사용하려면 회원가입하세요.");
      setShowAuthModal(true);
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [response, isAuthenticated]);

  const pathLabel = useMemo(() => response?.filename || "", [response]);
  const modeText = response ? modeLabel[response.mode] : "";

  function openAuthModal(message: string) {
    setAuthMessage(message);
    setShowAuthModal(true);
  }

  function requireAuth(message: string) {
    if (isAuthenticated) {
      return true;
    }

    openAuthModal(message);
    setStatusTone("idle");
    setStatusMessage("좌표 미리보기는 무료입니다. 저장과 도식화 같은 전체 기능은 회원가입 후 사용할 수 있습니다.");
    return false;
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
    setStatusMessage("파일 처리 중..");

    try {
      const res = await fetch(`${API_BASE_URL}/api/convert`, {
        method: "POST",
        body: formData,
      });

      const payload = (await res.json()) as ConvertResponse | { detail?: string };
      if (!res.ok) {
        const detail = "detail" in payload ? payload.detail || "변환에 실패했습니다." : "변환에 실패했습니다.";
        throw new Error(detail);
      }

      const converted = payload as ConvertResponse;
      setResponse(converted);
      saveLastConvert(converted);
      setStatusTone("success");
      setStatusMessage(
        isAuthenticated
          ? `${converted.result_count}개 결과를 불러왔습니다.`
          : `${converted.result_count}개 좌표를 먼저 보여줍니다. 저장과 도식화는 회원가입 후 사용할 수 있습니다.`,
      );
    } catch (caught) {
      setStatusTone("error");
      setStatusMessage(caught instanceof Error ? caught.message : "변환에 실패했습니다.");
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

  async function copyClipboard() {
    if (!response?.text_output) {
      setStatusTone("error");
      setStatusMessage("먼저 KML 파일을 불러와 주세요.");
      return;
    }
    if (!requireAuth("클립보드 복사와 전체 기능을 사용하려면 회원가입하세요.")) {
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
      setStatusMessage("도식화 보기는 실제 화면으로 열고, 비회원은 화면 위에서 회원가입 안내를 표시합니다.");
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
    if (!requireAuth("텍스트 저장과 전체 기능을 사용하려면 회원가입하세요.")) {
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
      setStatusMessage("시작점과 끝점이 없는 도형 파일은 엑셀 저장을 지원하지 않습니다.");
      return;
    }
    if (!requireAuth("엑셀 저장과 전체 기능을 사용하려면 회원가입하세요.")) {
      return;
    }

    window.open(response.xlsx_download_url, "_blank", "noopener,noreferrer");
    setStatusTone("success");
    setStatusMessage("엑셀 파일 다운로드를 시작했습니다.");
  }

  async function handleAuthButton() {
    if (!isAuthenticated) {
      openAuthModal("전체 기능을 사용하려면 회원가입하세요.");
      return;
    }

    try {
      const supabase = createSupabaseClient();
      await supabase.auth.signOut();
      setStatusTone("idle");
      setStatusMessage("로그아웃되었습니다.");
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
                title="앱 정보"
                onClick={() =>
                  window.alert("DOO Extractor\n\n버전: 2.3 Web MVP\n개발자: DOOHEE. JANG\n연락처: gdoomin@gmail.com")
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
              {!isAuthenticated ? (
                <div className="doo-sidebar-copy">
                  <strong>좌표 추출은 바로 체험</strong>
                  <span>파일을 열면 좌표 추출 결과까지 바로 볼 수 있습니다. 저장과 도식화 보기 같은 전체 기능은 회원가입 후 사용할 수 있습니다.</span>
                </div>
              ) : null}
            </div>

            <div className="doo-sidebar-footer">
              <div className="doo-sidebar-note">
                <span className="doo-note-label">{isAuthenticated ? "로그인 계정" : "사용 상태"}</span>
                <code>{isAuthenticated ? userEmail : "비회원 미리보기 모드"}</code>
                {isAuthenticated ? <div className="doo-auth-state">로그인됨</div> : null}
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
                  {isLoading ? "불러오는 중.." : "파일 열기"}
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
                좌표는 먼저 확인할 수 있습니다. 아래로 더 내리거나 저장, 도식화 보기 등 전체 기능을 사용하려면 회원가입하세요.
              </div>
            ) : null}

            <div className="doo-result-label">변환 결과</div>

            <div className="doo-text-panel">
              <pre className="doo-text-viewer">{response?.text_output || ""}</pre>
            </div>

            <div className="doo-main-meta">
              <div className="doo-connection-card">
                <span className="doo-note-label">현재 연결</span>
                <code>{API_BASE_URL}</code>
              </div>
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
              <p>좌표 추출 결과는 먼저 보여주고, 저장과 도식화 보기 같은 전체 기능은 회원가입 후 이어서 사용할 수 있게 구성했습니다.</p>
            </div>
            <LoginForm nextPath="/" />
            <button type="button" className="auth-modal-close" onClick={() => setShowAuthModal(false)}>
              나중에 하기
            </button>
          </section>
        </div>
      ) : null}
    </>
  );
}
