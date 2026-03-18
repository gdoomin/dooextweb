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
    if (typeof window !== "undefined") {
      const runningOnLocalHost = isLocalHost(window.location.hostname);
      const configuredHost = new URL(configured).hostname;
      const configuredOnLocalHost = isLocalHost(configuredHost);
      if (!runningOnLocalHost && configuredOnLocalHost) {
        return PROD_API_BASE_URL;
      }
    }
    return configured;
  }

  if (typeof window !== "undefined" && !isLocalHost(window.location.hostname)) {
    return PROD_API_BASE_URL;
  }

  return LOCAL_API_BASE_URL;
}

export const API_BASE_URL = resolveApiBaseUrl();

type ErrorLike = {
  detail?: string;
};

type HistoryListResponse = {
  items?: ServerHistoryItem[];
};

function isHistoryListResponse(payload: HistoryListResponse | ErrorLike): payload is HistoryListResponse {
  return typeof payload === "object" && payload !== null && "items" in payload;
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

export function buildUserHeaders(userId: string, userEmail = ""): HeadersInit {
  return {
    "X-DOO-USER-ID": userId,
    "X-DOO-USER-EMAIL": userEmail,
  };
}

export async function fetchUserHistory(userId: string, userEmail = ""): Promise<ServerHistoryItem[]> {
  const response = await fetch(`${API_BASE_URL}/api/history`, {
    headers: buildUserHeaders(userId, userEmail),
    cache: "no-store",
  });
  const payload = (await response.json()) as HistoryListResponse | ErrorLike;
  if (!response.ok) {
    throw new Error("detail" in payload ? payload.detail || "히스토리를 불러오지 못했습니다." : "히스토리를 불러오지 못했습니다.");
  }
  return isHistoryListResponse(payload) && Array.isArray(payload.items) ? payload.items : [];
}

export async function reopenHistoryItem(jobId: string, userId: string, userEmail = ""): Promise<ConvertResponse> {
  const response = await fetch(`${API_BASE_URL}/api/history/${jobId}`, {
    headers: buildUserHeaders(userId, userEmail),
    cache: "no-store",
  });
  const payload = (await response.json()) as ConvertResponse | ErrorLike;
  if (!response.ok) {
    throw new Error("detail" in payload ? payload.detail || "히스토리 항목을 다시 열지 못했습니다." : "히스토리 항목을 다시 열지 못했습니다.");
  }
  return payload as ConvertResponse;
}
