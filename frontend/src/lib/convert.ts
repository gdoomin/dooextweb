import type { FeatureCollection, Geometry } from "geojson";

export type LineResult = {
  num?: string;
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
  source_format?: "kml" | "kmz";
  kmz_visual?: KmzVisualPayload;
  simplify_tolerance?: number;
  coordinate_count?: number;
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
  legacy_full_access: boolean;
  is_new_pricing_user: boolean;
  subscription_status: string;
  subscription_active: boolean;
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
};

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
    throw new Error(extractErrorMessage(body, rawText, "변환 결과 저장에 실패했습니다."));
  }
  if (!body || typeof body !== "object") {
    throw new Error("서버가 올바른 변환 응답을 반환하지 않았습니다.");
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
    throw new Error(extractErrorMessage(body, rawText, "히스토리를 불러오지 못했습니다."));
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
    throw new Error(extractErrorMessage(body, rawText, "히스토리 항목을 다시 열지 못했습니다."));
  }
  if (!body || typeof body !== "object") {
    throw new Error("히스토리 응답 형식이 올바르지 않습니다.");
  }
  return body as ConvertResponse;
}

export async function deleteHistoryItem(jobId: string, userId: string, userEmail = "", accessToken = ""): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/history/${jobId}`, {
    method: "DELETE",
    headers: buildUserHeaders(userId, userEmail, accessToken),
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "히스토리 항목을 삭제하지 못했습니다."));
  }
}

export async function fetchBillingStatus(userId: string, userEmail = "", accessToken = ""): Promise<BillingStatusResponse> {
  const response = await fetch(`${API_BASE_URL}/api/billing/status`, {
    headers: buildUserHeaders(userId, userEmail, accessToken),
    cache: "no-store",
  });
  const { body, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, rawText, "결제 상태를 확인하지 못했습니다."));
  }
  if (!body || typeof body !== "object") {
    throw new Error("결제 상태 응답 형식이 올바르지 않습니다.");
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
    throw new Error(extractErrorMessage(body, rawText, "구독 결제를 시작하지 못했습니다."));
  }
  if (!body || typeof body !== "object") {
    throw new Error("구독 시작 응답 형식이 올바르지 않습니다.");
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
    throw new Error(extractErrorMessage(body, rawText, "구독 해지에 실패했습니다."));
  }
}
