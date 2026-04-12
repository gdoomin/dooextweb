import type { FeatureCollection, Geometry } from "geojson";

export type LineResult = {
  num?: string;
  s_num?: string;
  e_num?: string;
  force_label?: string;
  force_order?: number;
  s_lat?: number;
  s_lon?: number;
  e_lat?: number;
  e_lon?: number;
  s_text?: string;
  e_text?: string;
};

export type PolygonResult = {
  num?: string;
  label?: string;
  points: [number, number][];
};

export type KmzGroundOverlay = {
  id: string;
  name?: string;
  image_href: string;
  bounds: [[number, number], [number, number]];
  opacity?: number;
  rotation?: number;
  draw_order?: number;
};

export type KmzPointMarker = {
  id: string;
  name?: string;
  description?: string;
  lat: number;
  lng: number;
  icon_href?: string;
  icon_scale?: number;
};

export type KmzVisualPayload = {
  ground_overlays?: KmzGroundOverlay[];
  point_markers?: KmzPointMarker[];
};

export type MapPayload = {
  project_name: string;
  mode: "linestring" | "polygon";
  results: LineResult[];
  polygons: PolygonResult[];
  has_kml_num?: boolean;
  default_force_num?: boolean;
  default_show_num?: boolean;
  has_layers?: boolean;
  layer_catalog?: Array<Record<string, unknown>>;
  default_gray_map?: boolean;
  meta_text?: string;
  geojson?: FeatureCollection<Geometry | null>;
  source_format?: "kml" | "kmz" | "gpx" | "geojson" | "csv" | "txt";
  kmz_visual?: KmzVisualPayload;
  simplify_tolerance?: number;
  coordinate_count?: number;
  title_file_labels?: Array<{
    order?: number;
    primary?: string;
    secondary?: string;
  }>;
};

export type ConvertResponse = {
  ok: boolean;
  filename: string;
  project_name: string;
  mode: "linestring" | "polygon";
  result_count: number;
  text_output: string;
  map_payload: MapPayload;
  results: Array<Record<string, unknown>>;
  job_id: string;
  source_hash?: string;
  viewer_url: string;
  txt_download_url: string;
  xlsx_download_url: string;
};

export type ServerHistoryItem = {
  job_id: string;
  filename: string;
  project_name: string;
  mode: "linestring" | "polygon";
  result_count: number;
  uploaded_at: string;
};

export type HistoryDeleteResponse = {
  ok: boolean;
  deleted: boolean;
  job_id: string;
  deleted_count: number;
  deleted_job_ids: string[];
  source_hash?: string;
};

export type HistoryDeleteAllResponse = {
  ok: boolean;
  deleted_count: number;
  deleted_job_ids: string[];
};

export type BillingPlan = {
  plan_code: "free" | "lite" | "pro";
  name: string;
  price_krw_monthly: number;
};

export type BillingFeatures = {
  history?: boolean;
  viewer_state?: boolean;
  text_download?: boolean;
  excel_download?: boolean;
  weather_metar_taf?: boolean;
  weather_satellite?: boolean;
  notam_detail?: boolean;
};

export type BillingStatusResponse = {
  billing_enabled: boolean;
  user_id: string;
  user_email: string;
  plan_code: "free" | "lite" | "pro" | "legacy";
  base_plan_code?: "free" | "lite" | "pro" | "legacy";
  legacy_full_access: boolean;
  is_new_pricing_user: boolean;
  subscription_status: string;
  subscription_active: boolean;
  promo_active?: boolean;
  promo_code?: string;
  promo_plan_code?: "lite" | "pro" | "";
  promo_applied_at?: string;
  promo_expires_at?: string;
  promo_remaining_days?: number;
  monthly_kml_limit: number;
  monthly_kml_used: number;
  monthly_kml_remaining: number;
  file_size_limit_mb: number;
  history_days: number;
  history_limit: number;
  features: BillingFeatures;
  plans?: BillingPlan[];
};

export type BillingStartResponse = {
  ok: boolean;
  order_id: string;
  plan_code: "lite" | "pro";
  price_krw: number;
  payurl: string;
  rebill_no: string;
};

export type BillingPromoRedeemResponse = {
  ok: boolean;
  message: string;
  billing_status: BillingStatusResponse;
};

export type ClientConvertRequestBody = {
  filename: string;
  project_name: string;
  mode: "linestring" | "polygon";
  result_count: number;
  text_output: string;
  map_payload: MapPayload;
  results: Array<Record<string, unknown>>;
  source_file_bytes?: number;
  source_hash?: string;
  shared_viewer_state?: Record<string, unknown>;
};

export type SharedConvertPackage = {
  format: "dooextractor-share";
  version: 1;
  exported_at: string;
  entry: {
    job_id?: string;
    filename: string;
    project_name: string;
    mode: "linestring" | "polygon";
    result_count: number;
    source_hash?: string;
  };
  convert_payload: ClientConvertRequestBody;
  viewer_state: Record<string, unknown>;
};

export type HomeSyncStatePayload = {
  version?: number;
  active_job_id?: string;
  stack_job_ids?: string[];
  savedAt?: number;
  __sync?: {
    rev?: number;
    updated_at?: number;
    device_id?: string;
  };
};

export type UserBookmarkItem = {
  id: string;
  bookmark_url: string;
  image_data_url?: string;
  mime_type?: string;
  updated_at?: string;
};

export type UserBookmarkPayload = {
  items: UserBookmarkItem[];
  max_items: number;
  item?: UserBookmarkItem;
};

export type PilotRecruitJobItem = {
  id: string;
  job_no?: string;
  title: string;
  company: string;
  location?: string;
  employment_type?: string;
  experience?: string;
  deadline_text?: string;
  deadline_date?: string;
  period_text?: string;
  d_day?: string;
  matched_keywords?: string[];
  source?: string;
  url: string;
};

export type PilotRecruitmentResponse = {
  updated_at?: string;
  last_successful_at?: string;
  last_attempted_at?: string;
  source_label?: string;
  cache_status?: "fresh" | "stale" | "error" | "";
  cache_warning?: string;
  items: PilotRecruitJobItem[];
};

const DEFAULT_BOOKMARK_MAX_ITEMS = 20;

const STORAGE_KEY = "doo-extractor-last-convert";
const LOCAL_API_BASE_URL = "http://127.0.0.1:8000";
const PROD_API_BASE_URL = "https://dooext-api.dooheetv.com";

function isLocalHost(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function normalizeApiBaseUrl(rawValue: string | undefined): string | null {
  const value = rawValue?.trim();
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function resolveApiBaseUrl(): string {
  const configured = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL);

  if (configured) {
    const configuredHost = new URL(configured).hostname;
    const configuredOnLocalHost = isLocalHost(configuredHost);

    // In production builds, never expose localhost API endpoints.
    if (configuredOnLocalHost && process.env.NODE_ENV === "production") {
      return PROD_API_BASE_URL;
    }

    if (typeof window !== "undefined") {
      const runningOnLocalHost = isLocalHost(window.location.hostname);
      if (!runningOnLocalHost && configuredOnLocalHost) {
        return PROD_API_BASE_URL;
      }
    }
    return configured;
  }

  if (process.env.NODE_ENV === "production") {
    return PROD_API_BASE_URL;
  }

  if (typeof window !== "undefined" && !isLocalHost(window.location.hostname)) {
    return PROD_API_BASE_URL;
  }

  return LOCAL_API_BASE_URL;
}

export const API_BASE_URL = resolveApiBaseUrl();

type ErrorLike = {
  detail?: unknown;
  message?: unknown;
  error?: unknown;
};

type HistoryListResponse = {
  items?: ServerHistoryItem[];
};

function isHistoryListResponse(payload: HistoryListResponse | ErrorLike): payload is HistoryListResponse {
  return typeof payload === "object" && payload !== null && "items" in payload;
}

function stringifyUnknown(value: unknown): string {
  const isObjectObjectText = (text: string) => text.trim() === "[object Object]";

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isObjectObjectText(trimmed)) {
      return "";
    }
    return trimmed || "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => stringifyUnknown(item))
      .filter(Boolean)
      .join(" | ");
    return joined;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const preferred = stringifyUnknown(obj.detail ?? obj.message ?? obj.msg ?? obj.error);
    if (preferred) {
      return preferred;
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return "";
    }
  }
  return "";
}

function parseFastApiDetail(detail: unknown): string {
  if (!Array.isArray(detail)) {
    return stringifyUnknown(detail);
  }
  const parsed = detail
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return stringifyUnknown(entry);
      }
      const row = entry as Record<string, unknown>;
      const msg = stringifyUnknown(row.msg);
      const loc = Array.isArray(row.loc) ? row.loc.map((x) => stringifyUnknown(x)).filter(Boolean).join(".") : "";
      if (msg && loc) {
        return `${loc}: ${msg}`;
      }
      return msg || stringifyUnknown(row);
    })
    .filter(Boolean);
  return parsed.join(" | ");
}

async function parseResponseBody(response: Response): Promise<{ body: unknown; rawText: string }> {
  const rawText = await response.text();
  if (!rawText) {
    return { body: null, rawText: "" };
  }

  try {
    return { body: JSON.parse(rawText), rawText };
  } catch {
    return { body: null, rawText };
  }
}

function extractErrorMessage(body: unknown, rawText: string, fallback: string): string {
  if (body && typeof body === "object") {
    const payload = body as ErrorLike;
    const fromDetail = parseFastApiDetail(payload.detail);
    if (fromDetail) {
      return fromDetail;
    }
    const fromMessage = stringifyUnknown(payload.message ?? payload.error);
    if (fromMessage) {
      return fromMessage;
    }
    const fallbackFromBody = stringifyUnknown(body);
    if (fallbackFromBody) {
      return fallbackFromBody;
    }
  }

  const fromText = stringifyUnknown(rawText);
  return fromText || fallback;
}

export function saveLastConvert(payload: ConvertResponse) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function loadLastConvert(): ConvertResponse | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as ConvertResponse;
  } catch {
    return null;
  }
}

export function buildUserHeaders(userId: string, userEmail = "", accessToken = ""): HeadersInit {
  const headers: Record<string, string> = {
    "X-DOO-USER-ID": userId,
    "X-DOO-USER-EMAIL": userEmail,
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

export async function persistConvertedJob(
  payload: ClientConvertRequestBody,
  userId = "",
  userEmail = "",
  accessToken = "",
): Promise<ConvertResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (userId) {
    headers["X-DOO-USER-ID"] = userId;
    headers["X-DOO-USER-EMAIL"] = userEmail;
  }
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${API_BASE_URL}/api/convert`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "癰궰??野껉퀗?????關肉???쎈솭??됰뮸??덈뼄."));
  }
  if (!body || typeof body !== "object") {
    throw new Error("??뺤쒔揶쎛 ??而?몴?癰궰???臾먮뼗??獄쏆꼹???? ??녿릭??щ빍??");
  }
  return body as ConvertResponse;
}

export async function fetchUserHistory(userId: string, userEmail = "", accessToken = ""): Promise<ServerHistoryItem[]> {
  const response = await fetch(`${API_BASE_URL}/api/history`, {
    headers: buildUserHeaders(userId, userEmail, accessToken),
    cache: "no-store",
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "??됰뮞?醫듼봺???븍뜄???? 筌륁궢六??щ빍??"));
  }
  if (!body || typeof body !== "object") {
    return [];
  }
  const payload = body as HistoryListResponse | ErrorLike;
  return isHistoryListResponse(payload) && Array.isArray(payload.items) ? payload.items : [];
}

export async function reopenHistoryItem(jobId: string, userId: string, userEmail = "", accessToken = ""): Promise<ConvertResponse> {
  const response = await fetch(`${API_BASE_URL}/api/history/${jobId}`, {
    headers: buildUserHeaders(userId, userEmail, accessToken),
    cache: "no-store",
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "??됰뮞?醫듼봺 ???????쇰뻻 ??? 筌륁궢六??щ빍??"));
  }
  if (!body || typeof body !== "object") {
    throw new Error("??됰뮞?醫듼봺 ?臾먮뼗 ?類ㅻ뻼????而?몴?? ??녿뮸??덈뼄.");
  }
  return body as ConvertResponse;
}

export async function fetchViewerStateSnapshot(
  jobId: string,
  userId = "",
  userEmail = "",
  accessToken = "",
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE_URL}/api/viewer/${jobId}/viewer-state?export=1`, {
    headers: buildUserHeaders(userId, userEmail, accessToken),
    cache: "no-store",
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "도식화 설정을 불러오지 못했습니다."));
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}

export function downloadSharedConvertPackageFile(pkg: SharedConvertPackage, preferredName: string) {
  if (typeof window === "undefined") {
    return;
  }
  const safeBase =
    String(preferredName || "dooextractor-share")
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
      .replace(/\s+/g, " ")
      .replace(/\.+$/g, "")
      .slice(0, 120) || "dooextractor-share";
  const filename = safeBase.toLowerCase().endsWith(".dooex") ? safeBase : `${safeBase}.dooex`;
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json;charset=utf-8" });
  const downloadUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(downloadUrl);
}

export async function parseSharedConvertPackageFile(file: File): Promise<SharedConvertPackage> {
  const rawText = await file.text();
  let body: unknown = null;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error("공유 파일 형식이 올바르지 않습니다.");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("공유 파일 형식이 올바르지 않습니다.");
  }

  const payload = body as Partial<SharedConvertPackage> & { convert_payload?: ClientConvertRequestBody };
  const convertPayload = payload.convert_payload;
  const viewerState = payload.viewer_state;

  if (
    payload.format !== "dooextractor-share" ||
    payload.version !== 1 ||
    !convertPayload ||
    typeof convertPayload !== "object" ||
    !convertPayload.filename ||
    !convertPayload.project_name ||
    (convertPayload.mode !== "linestring" && convertPayload.mode !== "polygon") ||
    !convertPayload.map_payload ||
    !Array.isArray(convertPayload.results)
  ) {
    throw new Error("DOO Extractor 공유 파일이 아닙니다.");
  }

  return {
    format: "dooextractor-share",
    version: 1,
    exported_at: typeof payload.exported_at === "string" ? payload.exported_at : "",
    entry: {
      job_id: typeof payload.entry?.job_id === "string" ? payload.entry.job_id : "",
      filename: typeof payload.entry?.filename === "string" ? payload.entry.filename : String(convertPayload.filename || ""),
      project_name:
        typeof payload.entry?.project_name === "string"
          ? payload.entry.project_name
          : String(convertPayload.project_name || ""),
      mode: convertPayload.mode,
      result_count:
        typeof payload.entry?.result_count === "number" && Number.isFinite(payload.entry.result_count)
          ? payload.entry.result_count
          : Number(convertPayload.result_count || 0),
      source_hash:
        typeof payload.entry?.source_hash === "string"
          ? payload.entry.source_hash
          : typeof convertPayload.source_hash === "string"
            ? convertPayload.source_hash
            : "",
    },
    convert_payload: {
      filename: String(convertPayload.filename || ""),
      project_name: String(convertPayload.project_name || ""),
      mode: convertPayload.mode,
      result_count: Number(convertPayload.result_count || 0),
      text_output: String(convertPayload.text_output || ""),
      map_payload:
        convertPayload.map_payload && typeof convertPayload.map_payload === "object" && !Array.isArray(convertPayload.map_payload)
          ? convertPayload.map_payload
          : ({} as MapPayload),
      results: Array.isArray(convertPayload.results) ? convertPayload.results : [],
      source_file_bytes:
        typeof convertPayload.source_file_bytes === "number" && Number.isFinite(convertPayload.source_file_bytes)
          ? convertPayload.source_file_bytes
          : 0,
      source_hash: typeof convertPayload.source_hash === "string" ? convertPayload.source_hash : "",
    },
    viewer_state:
      viewerState && typeof viewerState === "object" && !Array.isArray(viewerState)
        ? (viewerState as Record<string, unknown>)
        : {},
  };
}

export async function deleteHistoryItem(
  jobId: string,
  userId: string,
  userEmail = "",
  accessToken = "",
): Promise<HistoryDeleteResponse> {
  const response = await fetch(`${API_BASE_URL}/api/history/${jobId}`, {
    method: "DELETE",
    headers: buildUserHeaders(userId, userEmail, accessToken),
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "?????????????????????? ????????????"));
  }
  if (!body || typeof body !== "object") {
    throw new Error("???? ?? ??? ???? ?????.");
  }
  const payload = body as Partial<HistoryDeleteResponse>;
  return {
    ok: Boolean(payload.ok),
    deleted: Boolean(payload.deleted),
    job_id: String(payload.job_id || jobId),
    deleted_count: Number(payload.deleted_count || 0),
    deleted_job_ids: Array.isArray(payload.deleted_job_ids)
      ? payload.deleted_job_ids.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    source_hash: typeof payload.source_hash === "string" ? payload.source_hash : "",
  };
}

export async function deleteAllHistoryItems(
  userId: string,
  userEmail = "",
  accessToken = "",
): Promise<HistoryDeleteAllResponse> {
  const response = await fetch(`${API_BASE_URL}/api/history`, {
    method: "DELETE",
    headers: buildUserHeaders(userId, userEmail, accessToken),
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "????????????????????????????????????."));
  }
  if (!body || typeof body !== "object") {
    throw new Error("???? ???? ??? ???? ?????.");
  }
  const payload = body as Partial<HistoryDeleteAllResponse>;
  return {
    ok: Boolean(payload.ok),
    deleted_count: Number(payload.deleted_count || 0),
    deleted_job_ids: Array.isArray(payload.deleted_job_ids)
      ? payload.deleted_job_ids.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
  };
}

export async function fetchBillingStatus(userId: string, userEmail = "", accessToken = ""): Promise<BillingStatusResponse> {
  const response = await fetch(`${API_BASE_URL}/api/billing/status`, {
    headers: buildUserHeaders(userId, userEmail, accessToken),
    cache: "no-store",
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "野껉퀣???怨밴묶???類ㅼ뵥??? 筌륁궢六??щ빍??"));
  }
  if (!body || typeof body !== "object") {
    throw new Error("野껉퀣???怨밴묶 ?臾먮뼗 ?類ㅻ뻼????而?몴?? ??녿뮸??덈뼄.");
  }
  return body as BillingStatusResponse;
}

export async function startBillingSubscription(
  planCode: "lite" | "pro",
  buyerPhone: string,
  userId: string,
  userEmail = "",
  accessToken = "",
): Promise<BillingStartResponse> {
  const response = await fetch(`${API_BASE_URL}/api/billing/payapp/start`, {
    method: "POST",
    headers: {
      ...buildUserHeaders(userId, userEmail, accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      plan_code: planCode,
      buyer_phone: buyerPhone,
    }),
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "?닌됰즴 野껉퀣?ｇ몴???뽰삂??? 筌륁궢六??щ빍??"));
  }
  if (!body || typeof body !== "object") {
    throw new Error("?닌됰즴 ??뽰삂 ?臾먮뼗 ?類ㅻ뻼????而?몴?? ??녿뮸??덈뼄.");
  }
  return body as BillingStartResponse;
}

export async function cancelBillingSubscription(
  userId: string,
  userEmail = "",
  accessToken = "",
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/billing/subscription/cancel`, {
    method: "POST",
    headers: {
      ...buildUserHeaders(userId, userEmail, accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reason: "user_requested" }),
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "?닌됰즴 ???????쎈솭??됰뮸??덈뼄."));
  }
}

export async function redeemBillingPromoCode(
  code: string,
  userId: string,
  userEmail = "",
  accessToken = "",
): Promise<BillingPromoRedeemResponse> {
  const response = await fetch(`${API_BASE_URL}/api/billing/promo-code/redeem`, {
    method: "POST",
    headers: {
      ...buildUserHeaders(userId, userEmail, accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "프로모션 코드 적용에 실패했습니다."));
  }
  if (!body || typeof body !== "object") {
    throw new Error("프로모션 코드 응답을 확인하지 못했습니다.");
  }
  return body as BillingPromoRedeemResponse;
}

export async function fetchHomeSyncState(
  userId: string,
  userEmail = "",
  accessToken = "",
): Promise<HomeSyncStatePayload | null> {
  const response = await fetch(`${API_BASE_URL}/api/home-state`, {
    headers: buildUserHeaders(userId, userEmail, accessToken),
    cache: "no-store",
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "홈 동기화 상태를 불러오지 못했습니다."));
  }
  if (!body || typeof body !== "object") {
    return null;
  }
  return body as HomeSyncStatePayload;
}

export async function saveHomeSyncState(
  payload: HomeSyncStatePayload,
  userId: string,
  userEmail = "",
  accessToken = "",
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/home-state`, {
    method: "POST",
    headers: {
      ...buildUserHeaders(userId, userEmail, accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "홈 동기화 상태 저장에 실패했습니다."));
  }
}

export async function fetchUserBookmark(
  userId: string,
  userEmail = "",
  accessToken = "",
): Promise<UserBookmarkPayload> {
  const response = await fetch(`${API_BASE_URL}/api/bookmark`, {
    headers: buildUserHeaders(userId, userEmail, accessToken),
    cache: "no-store",
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "?? ???? ???? ?????."));
  }
  if (!body || typeof body !== "object") {
    return { items: [], max_items: DEFAULT_BOOKMARK_MAX_ITEMS };
  }
  const payload = body as Partial<UserBookmarkPayload>;
  return {
    items: Array.isArray(payload.items)
      ? payload.items
          .filter((item): item is UserBookmarkItem => Boolean(item && typeof item === "object"))
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : "",
            bookmark_url: typeof item.bookmark_url === "string" ? item.bookmark_url : "",
            image_data_url: typeof item.image_data_url === "string" ? item.image_data_url : "",
            mime_type: typeof item.mime_type === "string" ? item.mime_type : "",
            updated_at: typeof item.updated_at === "string" ? item.updated_at : "",
          }))
          .filter((item) => Boolean(item.id) && Boolean(item.bookmark_url))
      : [],
    max_items:
      typeof payload.max_items === "number" && Number.isFinite(payload.max_items)
        ? payload.max_items
        : DEFAULT_BOOKMARK_MAX_ITEMS,
    item:
      payload.item && typeof payload.item === "object" && typeof payload.item.id === "string" && typeof payload.item.bookmark_url === "string"
        ? {
            id: payload.item.id,
            bookmark_url: payload.item.bookmark_url,
            image_data_url: typeof payload.item.image_data_url === "string" ? payload.item.image_data_url : "",
            mime_type: typeof payload.item.mime_type === "string" ? payload.item.mime_type : "",
            updated_at: typeof payload.item.updated_at === "string" ? payload.item.updated_at : "",
          }
        : undefined,
  };
}

export async function saveUserBookmark(
  bookmarkId: string,
  bookmarkUrl: string,
  imageDataUrl: string,
  userId: string,
  userEmail = "",
  accessToken = "",
): Promise<UserBookmarkPayload> {
  const response = await fetch(`${API_BASE_URL}/api/bookmark`, {
    method: "POST",
    headers: {
      ...buildUserHeaders(userId, userEmail, accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: bookmarkId,
      bookmark_url: bookmarkUrl,
      image_data_url: imageDataUrl,
    }),
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "?? ???? ???? ?????."));
  }
  if (!body || typeof body !== "object") {
    throw new Error("?? ??? ?? ??? ???? ?????.");
  }
  const payload = body as Partial<UserBookmarkPayload>;
  if (!Array.isArray(payload.items)) {
    throw new Error("?? ??? ?? ??? ???? ????.");
  }
  return {
    items: payload.items
      .filter((item): item is UserBookmarkItem => Boolean(item && typeof item === "object"))
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : "",
        bookmark_url: typeof item.bookmark_url === "string" ? item.bookmark_url : "",
        image_data_url: typeof item.image_data_url === "string" ? item.image_data_url : "",
        mime_type: typeof item.mime_type === "string" ? item.mime_type : "",
        updated_at: typeof item.updated_at === "string" ? item.updated_at : "",
      }))
      .filter((item) => Boolean(item.id) && Boolean(item.bookmark_url)),
    max_items:
      typeof payload.max_items === "number" && Number.isFinite(payload.max_items)
        ? payload.max_items
        : DEFAULT_BOOKMARK_MAX_ITEMS,
    item:
      payload.item && typeof payload.item === "object" && typeof payload.item.id === "string" && typeof payload.item.bookmark_url === "string"
        ? {
            id: payload.item.id,
            bookmark_url: payload.item.bookmark_url,
            image_data_url: typeof payload.item.image_data_url === "string" ? payload.item.image_data_url : "",
            mime_type: typeof payload.item.mime_type === "string" ? payload.item.mime_type : "",
            updated_at: typeof payload.item.updated_at === "string" ? payload.item.updated_at : "",
          }
        : undefined,
  };
}

export async function deleteUserBookmark(
  bookmarkId: string,
  userId: string,
  userEmail = "",
  accessToken = "",
): Promise<UserBookmarkPayload> {
  const response = await fetch(`${API_BASE_URL}/api/bookmark/${encodeURIComponent(bookmarkId)}`, {
    method: "DELETE",
    headers: buildUserHeaders(userId, userEmail, accessToken),
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "?? ???? ???? ?????."));
  }
  if (!body || typeof body !== "object") {
    return { items: [], max_items: DEFAULT_BOOKMARK_MAX_ITEMS };
  }
  const payload = body as Partial<UserBookmarkPayload>;
  return {
    items: Array.isArray(payload.items)
      ? payload.items
          .filter((item): item is UserBookmarkItem => Boolean(item && typeof item === "object"))
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : "",
            bookmark_url: typeof item.bookmark_url === "string" ? item.bookmark_url : "",
            image_data_url: typeof item.image_data_url === "string" ? item.image_data_url : "",
            mime_type: typeof item.mime_type === "string" ? item.mime_type : "",
            updated_at: typeof item.updated_at === "string" ? item.updated_at : "",
          }))
          .filter((item) => Boolean(item.id) && Boolean(item.bookmark_url))
      : [],
    max_items:
      typeof payload.max_items === "number" && Number.isFinite(payload.max_items)
        ? payload.max_items
        : DEFAULT_BOOKMARK_MAX_ITEMS,
  };
}

export async function fetchPilotRecruitment(): Promise<PilotRecruitmentResponse> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/pilot?limit=12`, {
    cache: "no-store",
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "채용정보를 불러오지 못했습니다."));
  }
  if (!body || typeof body !== "object") {
    return { items: [], source_label: "Airportal 항공일자리", updated_at: "" };
  }
  const payload = body as Partial<PilotRecruitmentResponse>;
  return {
    updated_at: typeof payload.updated_at === "string" ? payload.updated_at : "",
    last_successful_at:
      typeof payload.last_successful_at === "string"
        ? payload.last_successful_at
        : (typeof payload.updated_at === "string" ? payload.updated_at : ""),
    last_attempted_at: typeof payload.last_attempted_at === "string" ? payload.last_attempted_at : "",
    source_label: typeof payload.source_label === "string" ? payload.source_label : "Airportal 항공일자리",
    cache_status:
      payload.cache_status === "fresh" || payload.cache_status === "stale" || payload.cache_status === "error"
        ? payload.cache_status
        : "",
    cache_warning: typeof payload.cache_warning === "string" ? payload.cache_warning : "",
    items: Array.isArray(payload.items)
      ? payload.items
          .filter((item): item is PilotRecruitJobItem => Boolean(item && typeof item === "object"))
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : "",
            job_no: typeof item.job_no === "string" ? item.job_no : "",
            title: typeof item.title === "string" ? item.title : "",
            company: typeof item.company === "string" ? item.company : "",
            location: typeof item.location === "string" ? item.location : "",
            employment_type: typeof item.employment_type === "string" ? item.employment_type : "",
            experience: typeof item.experience === "string" ? item.experience : "",
            deadline_text: typeof item.deadline_text === "string" ? item.deadline_text : "",
            deadline_date: typeof item.deadline_date === "string" ? item.deadline_date : "",
            period_text: typeof item.period_text === "string" ? item.period_text : "",
            d_day: typeof item.d_day === "string" ? item.d_day : "",
            matched_keywords: Array.isArray(item.matched_keywords)
              ? item.matched_keywords.map((keyword) => String(keyword || "").trim()).filter(Boolean)
              : [],
            source: typeof item.source === "string" ? item.source : "",
            url: typeof item.url === "string" ? item.url : "",
          }))
          .filter((item) => Boolean(item.id) && Boolean(item.title) && Boolean(item.url))
      : [],
  };
}
