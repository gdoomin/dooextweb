"use client";

import Image from "next/image";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import { AdSenseSlot } from "@/components/AdSenseSlot";
import { LoginForm } from "@/components/LoginForm";
import {
  API_BASE_URL,
  type BillingStatusResponse,
  type ConvertResponse,
  type ServerHistoryItem,
  cancelBillingSubscription,
  fetchBillingStatus,
  fetchUserHistory,
  loadLastConvert,
  persistConvertedJob,
  reopenHistoryItem,
  saveLastConvert,
  startBillingSubscription,
} from "@/lib/convert";
import { convertKmlFileInBrowser } from "@/lib/kml-client-convert";
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

type PopupNoticeResponse = {
  enabled?: unknown;
  message?: string;
};

const DOOGPX_APPSTORE_URL =
  "https://apps.apple.com/kr/app/doo-gpx-%EB%B9%84%ED%96%89%EC%A7%80%EB%8F%84/id6759362581";
const RIGHT_AD_SLOT = process.env.NEXT_PUBLIC_ADSENSE_RIGHT_SLOT ?? "";
const BOTTOM_AD_SLOT = process.env.NEXT_PUBLIC_ADSENSE_BOTTOM_SLOT ?? "";

function describeUnknownError(error: unknown, fallback: string): string {
  const isObjectObjectText = (value: string) => value.trim() === "[object Object]";

  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message && !isObjectObjectText(message)) {
      return message;
    }

    const cause = (error as Error & { cause?: unknown }).cause;
    const causeText = describeUnknownError(cause, "");
    if (causeText) {
      return causeText;
    }

    try {
      const own: Record<string, unknown> = {};
      const errorRecord = error as unknown as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(error)) {
        own[key] = errorRecord[key];
      }
      const ownText = describeUnknownError(own, "");
      if (ownText) {
        return ownText;
      }
    } catch {
      // Ignore and fallback below.
    }

    return fallback;
  }
  if (typeof error === "string") {
    const message = error.trim();
    if (!message || isObjectObjectText(message)) {
      return fallback;
    }
    return message;
  }
  if (error && typeof error === "object") {
    const payload = error as Record<string, unknown>;
    const nested =
      describeUnknownError(payload.detail, "") ||
      describeUnknownError(payload.message, "") ||
      describeUnknownError(payload.error, "");
    if (nested) {
      return nested;
    }
    try {
      const serialized = JSON.stringify(payload);
      return serialized || fallback;
    } catch {
      return fallback;
    }
  }
  if (typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }
  return fallback;
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

export function HomeScreen({
  initialUserEmail = "",
  initialUserId = "",
  authAvailable = true,
}: HomeScreenProps) {
  const [showUpdateNotice, setShowUpdateNotice] = useState(false);
  const [updateNoticeMessage, setUpdateNoticeMessage] = useState("");
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
  const [accessToken, setAccessToken] = useState("");
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMessage, setAuthMessage] = useState("전체 기능을 사용하려면 회원가입이 필요합니다.");
  const [billingStatus, setBillingStatus] = useState<BillingStatusResponse | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingActionLoading, setBillingActionLoading] = useState(false);
  const [buyerPhone, setBuyerPhone] = useState("");
  const [showPlanGuide, setShowPlanGuide] = useState(false);

  const isAuthenticated = Boolean(userId);
  const pathLabel = useMemo(() => response?.filename || "", [response]);
  const modeText = response ? modeLabel[response.mode] : "KML을 업로드하면 변환 결과가 표시됩니다.";
  const canUseHistory = isAuthenticated;
  const canDownloadText = !billingStatus?.billing_enabled || Boolean(billingStatus.features?.text_download);
  const canDownloadExcel = !billingStatus?.billing_enabled || Boolean(billingStatus.features?.excel_download);
  const shouldShowPricing =
    Boolean(billingStatus?.billing_enabled) &&
    isAuthenticated &&
    Boolean(billingStatus?.is_new_pricing_user);

  async function resolveCurrentIdentity() {
    if (!authAvailable) {
      return { id: "", email: "", token: "" };
    }

    const supabase = createSupabaseClient();
    if (!supabase) {
      return { id: userId, email: userEmail, token: accessToken };
    }

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const resolvedId = user?.id || "";
      const resolvedEmail = user?.email || "";
      const resolvedToken = session?.access_token || "";

      if (resolvedId !== userId) {
        setUserId(resolvedId);
      }
      if (resolvedEmail !== userEmail) {
        setUserEmail(resolvedEmail);
      }
      if (resolvedToken !== accessToken) {
        setAccessToken(resolvedToken);
      }

      return { id: resolvedId, email: resolvedEmail, token: resolvedToken };
    } catch {
      return { id: userId, email: userEmail, token: accessToken };
    }
  }

  useEffect(() => {
    if (!authAvailable) {
      setUserId("");
      setUserEmail("");
      setAccessToken("");
      return;
    }

    let mounted = true;
    let unsubscribe: (() => void) | undefined;

    try {
      const supabase = createSupabaseClient();
      if (!supabase) {
        setUserId("");
        setUserEmail("");
        setAccessToken("");
        return;
      }

      supabase.auth.getUser().then(({ data }) => {
        if (!mounted) {
          return;
        }
        setUserId(data.user?.id || "");
        setUserEmail(data.user?.email || "");
      });
      supabase.auth.getSession().then(({ data }) => {
        if (!mounted) {
          return;
        }
        setAccessToken(data.session?.access_token || "");
      });

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!mounted) {
          return;
        }
        setUserId(session?.user?.id || "");
        setUserEmail(session?.user?.email || "");
        setAccessToken(session?.access_token || "");
      });

      unsubscribe = () => subscription.unsubscribe();
    } catch {
      setUserId("");
      setUserEmail("");
      setAccessToken("");
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
        setBillingStatus(null);
        return;
      }

      setBillingLoading(true);
      try {
        const status = await fetchBillingStatus(userId, userEmail, accessToken);
        if (!cancelled) {
          setBillingStatus(status);
        }
      } catch (error) {
        if (!cancelled) {
          setBillingStatus(null);
          setStatusTone("error");
          setStatusMessage(describeUnknownError(error, "구독 상태를 확인하지 못했습니다."));
        }
      } finally {
        if (!cancelled) {
          setBillingLoading(false);
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [userId, userEmail, accessToken]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!userId) {
        setHistoryItems([]);
        setHistoryError("");
        return;
      }
      if (!canUseHistory) {
        setHistoryItems([]);
        setHistoryError("");
        return;
      }

      setHistoryLoading(true);
      setHistoryError("");
      try {
        const items = await fetchUserHistory(userId, userEmail, accessToken);
        if (!cancelled) {
          setHistoryItems(items);
        }
      } catch (error) {
        if (!cancelled) {
          setHistoryError(describeUnknownError(error, "히스토리를 불러오지 못했습니다."));
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
  }, [userId, userEmail, accessToken, canUseHistory]);

  useEffect(() => {
    let cancelled = false;

    async function loadPopupNotice() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/popup-notice`, { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as PopupNoticeResponse;
        const message = typeof payload.message === "string" ? payload.message.trim() : "";
        const enabled = parseLooseBoolean(payload.enabled, false);
        if (!cancelled && enabled && message) {
          setUpdateNoticeMessage(message);
          setShowUpdateNotice(true);
        } else if (!cancelled) {
          setShowUpdateNotice(false);
        }
      } catch {
        // Ignore popup config load failures.
      }
    }

    loadPopupNotice();
    return () => {
      cancelled = true;
    };
  }, []);

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

  async function refreshHistory(nextUserId = userId, nextUserEmail = userEmail, nextAccessToken = accessToken) {
    if (!nextUserId) {
      setHistoryItems([]);
      setHistoryError("");
      return;
    }
    if (!canUseHistory) {
      setHistoryItems([]);
      setHistoryError("");
      return;
    }

    setHistoryLoading(true);
    setHistoryError("");
    try {
      const items = await fetchUserHistory(nextUserId, nextUserEmail, nextAccessToken);
      setHistoryItems(items);
    } catch (error) {
      setHistoryError(describeUnknownError(error, "히스토리를 불러오지 못했습니다."));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function handleFilePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsLoading(true);
    setStatusTone("loading");
    setStatusMessage("Converting KML in your browser...");

    try {
      const convertedForUpload = await convertKmlFileInBrowser(file);
      setStatusMessage("Local conversion complete. Saving to server...");

      const identity = await resolveCurrentIdentity();
      const uploadAuthenticated = Boolean(identity.id);
      const converted = await persistConvertedJob(
        {
          ...convertedForUpload,
          source_file_bytes: file.size,
        },
        identity.id,
        identity.email,
        identity.token,
      );
      setResponse(converted);
      saveLastConvert(converted);

      if (uploadAuthenticated) {
        await refreshHistory(identity.id, identity.email, identity.token);
        const latestBilling = await fetchBillingStatus(identity.id, identity.email, identity.token);
        setBillingStatus(latestBilling);
      }

      setStatusTone("success");
      setStatusMessage(
        uploadAuthenticated
          ? `${converted.result_count} results converted and saved to your history.`
          : `${converted.result_count} results converted. Log in to use history and reopen.`,
      );
    } catch (error) {
      console.error("[KML convert] failed", error);
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "Conversion failed."));
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
    if (!canUseHistory) {
      setStatusTone("error");
      setStatusMessage("현재 플랜에서는 히스토리 다시열기를 사용할 수 없습니다.");
      return;
    }
    if (!requireAuth("개인 히스토리를 다시 열려면 로그인해 주세요.")) {
      return;
    }

    setHistoryOpeningId(item.job_id);
    setStatusTone("loading");
    setStatusMessage(`${item.project_name || item.filename} 결과를 다시 불러오는 중입니다...`);

    try {
      const reopened = await reopenHistoryItem(item.job_id, userId, userEmail, accessToken);
      setResponse(reopened);
      saveLastConvert(reopened);
      setStatusTone("success");
      setStatusMessage(`${reopened.project_name || reopened.filename} 결과를 다시 열었습니다.`);
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "히스토리 항목을 다시 열지 못했습니다."));
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
    const isJobViewer = Boolean(response?.job_id);
    const viewerPath = response?.job_id ? `${API_BASE_URL}/api/viewer/${response.job_id}` : `${API_BASE_URL}/api/viewer/default`;
    let viewerUrl = viewerPath;
    if (!isJobViewer) {
      const query = new URLSearchParams();
      if (userId) {
        query.set("user_id", userId);
      }
      if (userEmail) {
        query.set("user_email", userEmail);
      }
      const queryString = query.toString();
      if (queryString) {
        viewerUrl = `${viewerPath}?${queryString}`;
      }
    }

    const opened = window.open(viewerUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      window.location.assign(viewerUrl);
    }
    setStatusTone("success");
    setStatusMessage(isJobViewer ? "도식화 Viewer를 열었습니다." : "기본 Viewer를 열었습니다.");
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
    if (!canDownloadText) {
      setStatusTone("error");
      setStatusMessage("현재 플랜에서는 텍스트 다운로드를 사용할 수 없습니다.");
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
    if (!canDownloadExcel) {
      setStatusTone("error");
      setStatusMessage("현재 플랜에서는 엑셀 다운로드를 사용할 수 없습니다.");
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
      setAccessToken("");
      setHistoryItems([]);
      setHistoryError("");
      setBillingStatus(null);
      setStatusTone("idle");
      setStatusMessage("로그아웃했습니다.");
    } catch {
      setStatusTone("error");
      setStatusMessage("로그아웃에 실패했습니다.");
    }
  }

  async function handleStartSubscription(planCode: "lite" | "pro") {
    const identity = await resolveCurrentIdentity();
    if (!identity.id) {
      openAuthModal("구독 결제를 시작하려면 로그인해 주세요.");
      return;
    }
    if (!identity.token) {
      setStatusTone("error");
      setStatusMessage("보안을 위해 다시 로그인 후 결제를 진행해 주세요.");
      return;
    }

    const normalizedPhone = buyerPhone.replace(/[^0-9]/g, "");
    if (normalizedPhone.length < 9) {
      setStatusTone("error");
      setStatusMessage("결제용 휴대전화 번호를 먼저 입력해 주세요.");
      return;
    }

    setBillingActionLoading(true);
    setStatusTone("loading");
    setStatusMessage("결제 창을 준비하고 있습니다...");
    try {
      const result = await startBillingSubscription(planCode, normalizedPhone, identity.id, identity.email, identity.token);
      if (!result.payurl) {
        throw new Error("결제 페이지 URL을 받지 못했습니다.");
      }
      window.location.href = result.payurl;
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "구독 결제를 시작하지 못했습니다."));
    } finally {
      setBillingActionLoading(false);
    }
  }

  async function handleCancelSubscription() {
    const identity = await resolveCurrentIdentity();
    if (!identity.id) {
      return;
    }
    if (!identity.token) {
      setStatusTone("error");
      setStatusMessage("보안을 위해 다시 로그인 후 구독 해지를 진행해 주세요.");
      return;
    }
    setBillingActionLoading(true);
    setStatusTone("loading");
    setStatusMessage("구독을 해지하고 있습니다...");
    try {
      await cancelBillingSubscription(identity.id, identity.email, identity.token);
      const latest = await fetchBillingStatus(identity.id, identity.email, identity.token);
      setBillingStatus(latest);
      setStatusTone("success");
      setStatusMessage("구독이 해지되었습니다. 다음 결제일부터 자동결제가 중단됩니다.");
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "구독 해지에 실패했습니다."));
    } finally {
      setBillingActionLoading(false);
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
              <div className="doo-sidebar-image-wrap">
                <a
                  href={DOOGPX_APPSTORE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="doo-sidebar-image-link"
                >
                  <Image
                    src="/banner.png"
                    alt="DOO Extractor banner"
                    width={300}
                    height={180}
                    className="doo-sidebar-image"
                    priority
                  />
                </a>
              </div>
            </div>

            <div className="doo-sidebar-footer">
              <button type="button" className="doo-plan-guide-button" onClick={() => setShowPlanGuide(true)}>
                요금제/기능 안내
              </button>

              <div className="doo-sidebar-note">
                <div className="doo-note-head">
                  <span className="doo-note-label">{isAuthenticated ? "로그인 계정" : "사용 상태"}</span>
                  {isAuthenticated ? <div className="doo-auth-state">로그인됨</div> : null}
                </div>
                <code>{isAuthenticated ? userEmail : "비회원 미리보기 모드"}</code>
                <button
                  type="button"
                  className={`doo-auth-button ${isAuthenticated ? "doo-auth-button-logout" : "doo-auth-button-login"}`}
                  onClick={handleAuthButton}
                >
                  {isAuthenticated ? "로그아웃" : "회원가입 / 로그인"}
                </button>
              </div>

              {isAuthenticated ? (
                <div className="doo-billing-card">
                  <div className="doo-billing-head">
                    <strong>구독 상태</strong>
                    {billingLoading ? <span>확인 중...</span> : <span>{billingStatus?.plan_code || "free"}</span>}
                  </div>

                  {billingStatus?.billing_enabled ? (
                    <>
                      <p className="doo-billing-meta">
                        월 변환: {billingStatus.monthly_kml_used}
                        {billingStatus.monthly_kml_limit > 0 ? ` / ${billingStatus.monthly_kml_limit}` : " / 무제한"}
                      </p>
                      <p className="doo-billing-meta">파일 최대 용량: {billingStatus.file_size_limit_mb}MB</p>

                      {shouldShowPricing ? (
                        <div className="doo-billing-actions">
                          <label className="doo-billing-phone">
                            <span>결제용 휴대전화</span>
                            <input
                              type="tel"
                              value={buyerPhone}
                              onChange={(event) => setBuyerPhone(event.target.value)}
                              placeholder="숫자만 입력"
                              inputMode="numeric"
                            />
                          </label>
                          <div className="doo-billing-buttons">
                            <button
                              type="button"
                              className="doo-auth-button doo-plan-button-lite"
                              onClick={() => handleStartSubscription("lite")}
                              disabled={billingActionLoading}
                            >
                              라이트 3,900원
                            </button>
                            <button
                              type="button"
                              className="doo-auth-button doo-plan-button-pro"
                              onClick={() => handleStartSubscription("pro")}
                              disabled={billingActionLoading}
                            >
                              프로 8,900원
                            </button>
                            {billingStatus.subscription_active ? (
                              <button
                                type="button"
                                className="doo-auth-button"
                                onClick={handleCancelSubscription}
                                disabled={billingActionLoading}
                              >
                                구독 해지
                              </button>
                            ) : null}
                          </div>
                          <p className="doo-billing-help">
                            기존 가입자 혜택은 유지되며, 새 이메일로 신규 가입하면 신규 정책이 적용됩니다.
                          </p>
                        </div>
                      ) : (
                        <p className="doo-billing-help">기존 가입자 혜택 계정은 별도 결제가 필요하지 않습니다.</p>
                      )}
                    </>
                  ) : (
                    <p className="doo-billing-help">결제 기능 준비 중입니다.</p>
                  )}
                </div>
              ) : null}
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
                  {isAuthenticated && canUseHistory ? <span className="doo-panel-count">{historyItems.length}건</span> : null}
                </div>

                {!isAuthenticated ? (
                  <p className="doo-history-empty">로그인하면 업로드 시점이 서버에 저장되고, 이곳에서 다시열기로 현재 결과를 덮어쓸 수 있습니다.</p>
                ) : !canUseHistory ? (
                  <p className="doo-history-empty">현재 플랜에서는 히스토리를 사용할 수 없습니다. 구독 후 이용해 주세요.</p>
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
                <button
                  type="button"
                  className="doo-action doo-action-xlsx"
                  onClick={downloadExcel}
                  disabled={isAuthenticated && !canDownloadExcel}
                >
                  엑셀 저장
                </button>
                <button
                  type="button"
                  className="doo-action doo-action-txt"
                  onClick={downloadText}
                  disabled={isAuthenticated && !canDownloadText}
                >
                  텍스트 저장
                </button>
                <button type="button" className="doo-action doo-action-map" onClick={openViewer}>
                  도식화 보기
                </button>
              </div>
            </div>

            <div className="doo-bottom-ad-wrap">
              <AdSenseSlot slot={BOTTOM_AD_SLOT} className="doo-ad-unit doo-ad-unit-bottom" minHeight={120} />
            </div>
          </section>

          <aside className="doo-ad-rail" aria-label="Google AdSense">
            <div className="doo-ad-rail-inner">
              <AdSenseSlot slot={RIGHT_AD_SLOT} className="doo-ad-unit doo-ad-unit-right" minHeight={600} />
            </div>
          </aside>
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

      {showUpdateNotice ? (
        <div className="auth-modal-backdrop" onClick={() => setShowUpdateNotice(false)}>
          <section className="auth-modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="auth-modal-copy">
              <span className="auth-badge">Notice</span>
              <h2>{updateNoticeMessage}</h2>
            </div>
            <button type="button" className="auth-modal-close" onClick={() => setShowUpdateNotice(false)}>
              확인
            </button>
          </section>
        </div>
      ) : null}

      {showPlanGuide ? (
        <div className="auth-modal-backdrop doo-pricing-backdrop" onClick={() => setShowPlanGuide(false)}>
          <section className="doo-pricing-modal" onClick={(event) => event.stopPropagation()}>
            <div className="doo-pricing-header">
              <div className="doo-pricing-tag">PLAN GUIDE</div>
              <h2>DOO Extractor 요금제</h2>
              <p>기존 가입자 혜택 계정은 기존 기능을 유지하며, 새 이메일로 가입하면 신규 정책이 적용됩니다.</p>
            </div>

            <div className="doo-pricing-scroll">
              <div className="doo-pricing-columns">
                <article className="doo-pricing-column doo-pricing-column-free">
                  <div className="doo-pricing-column-head">
                    <span className="doo-pricing-chip">FREE</span>
                    <h3>무료</h3>
                    <p>필수 기능만 빠르게 체험</p>
                  </div>
                  <div className="doo-pricing-rate doo-pricing-rate-free">
                    <span>월간</span>
                    <strong>0원</strong>
                  </div>
                  <div className="doo-pricing-group">
                    <h4>기본 사용량</h4>
                    <ul className="doo-pricing-list">
                      <li>월 KML 변환 5회</li>
                      <li>1파일 최대 1MB</li>
                      <li className="is-off">히스토리 보관 없음</li>
                      <li className="is-off">Viewer 설정 저장 없음</li>
                    </ul>
                  </div>
                  <div className="doo-pricing-group">
                    <h4>기능 제한</h4>
                    <ul className="doo-pricing-list">
                      <li className="is-off">번호/텍스트/형광펜 편집 불가</li>
                      <li className="is-off">측정 결과 객체화/편집 불가</li>
                      <li>폰트 기본 1종</li>
                      <li>NOTAM 불러오기만</li>
                      <li>내보내기 클립보드</li>
                      <li className="is-off">날씨(METAR/TAF, 위성영상) 미지원</li>
                      <li className="is-off">은둔/출현 불가</li>
                      <li>겹 기능 MOA만</li>
                    </ul>
                  </div>
                </article>

                <article className="doo-pricing-column doo-pricing-column-lite">
                  <div className="doo-pricing-column-head">
                    <span className="doo-pricing-chip">LITE</span>
                    <h3>라이트</h3>
                    <p>자주 쓰는 기능 중심 실속 플랜</p>
                  </div>
                  <div className="doo-pricing-rate doo-pricing-rate-lite">
                    <span>월간</span>
                    <strong>3,900원</strong>
                  </div>
                  <div className="doo-pricing-group">
                    <h4>기본 사용량</h4>
                    <ul className="doo-pricing-list">
                      <li>월 KML 변환 30회</li>
                      <li>1파일 최대 5MB</li>
                      <li>히스토리 30일 / 최대 10건</li>
                      <li>Viewer 마지막 설정 저장</li>
                    </ul>
                  </div>
                  <div className="doo-pricing-group">
                    <h4>주요 기능</h4>
                    <ul className="doo-pricing-list">
                      <li>번호/텍스트/형광펜 편집(색상·굵기 고정)</li>
                      <li>측정 결과 객체화/편집(선 색·굵기 고정)</li>
                      <li>폰트/정렬 옵션 무제한</li>
                      <li>NOTAM 개별 조회 가능</li>
                      <li>내보내기 텍스트/엑셀</li>
                      <li>날씨 METAR/TAF</li>
                      <li>은둔/출현 가능</li>
                      <li>겹 기능 전체</li>
                    </ul>
                  </div>
                </article>

                <article className="doo-pricing-column doo-pricing-column-pro">
                  <div className="doo-pricing-column-head">
                    <span className="doo-pricing-chip">PRO</span>
                    <h3>프로</h3>
                    <p>대용량과 전체 편집을 위한 플랜</p>
                  </div>
                  <div className="doo-pricing-rate doo-pricing-rate-pro">
                    <span>월간</span>
                    <strong>8,900원</strong>
                  </div>
                  <div className="doo-pricing-group">
                    <h4>기본 사용량</h4>
                    <ul className="doo-pricing-list">
                      <li>월 KML 변환 무제한</li>
                      <li>1파일 최대 200MB</li>
                      <li>히스토리 무기한 / 사실상 무제한</li>
                      <li>Viewer 마지막 설정 저장</li>
                    </ul>
                  </div>
                  <div className="doo-pricing-group">
                    <h4>주요 기능</h4>
                    <ul className="doo-pricing-list">
                      <li>번호/텍스트/형광펜 전체 편집 기능</li>
                      <li>측정 결과 객체화/편집 전체 기능</li>
                      <li>폰트/정렬 옵션 무제한</li>
                      <li>NOTAM 개별 조회 가능</li>
                      <li>내보내기 텍스트/엑셀</li>
                      <li>날씨 METAR/TAF + 위성영상</li>
                      <li>은둔/출현 가능</li>
                      <li>겹 기능 전체</li>
                    </ul>
                  </div>
                </article>
              </div>
            </div>

            <div className="doo-pricing-footer">
              <p className="doo-pricing-footer-note">※ 요금제는 월 단위 자동 갱신되며, 언제든지 변경·해지 가능합니다.</p>
              <button type="button" className="doo-pricing-close" onClick={() => setShowPlanGuide(false)}>
                닫기
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

