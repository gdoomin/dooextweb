import { API_BASE_URL } from "@/lib/convert";

export type PilotJobListItem = {
  id: string;
  slug?: string;
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
  status?: string;
  role_family?: string;
  license_tags?: string[];
  aircraft_category?: string;
  aircraft_types?: string[];
  experience_level?: string;
  summary?: string;
  posted_at?: string;
  deadline_at?: string;
};

export type PilotRecruitmentResponse = {
  updated_at?: string;
  last_successful_at?: string;
  last_attempted_at?: string;
  source_label?: string;
  cache_status?: "fresh" | "stale" | "error" | "";
  cache_warning?: string;
  items: PilotJobListItem[];
};

export type JobsFilterOption = {
  value: string;
  label: string;
  count: number;
};

export type PilotJobsListResponse = {
  updated_at?: string;
  last_successful_at?: string;
  last_attempted_at?: string;
  source_label?: string;
  cache_status?: "fresh" | "stale" | "error" | "";
  cache_warning?: string;
  total_count: number;
  limit: number;
  offset: number;
  page?: number;
  has_more?: boolean;
  filters: {
    role_families: JobsFilterOption[];
    locations: JobsFilterOption[];
    employment_types: JobsFilterOption[];
    statuses: JobsFilterOption[];
    license_tags: JobsFilterOption[];
  };
  items: PilotJobListItem[];
};

type JobsQueryParams = {
  q?: string;
  role_family?: string;
  location?: string;
  employment_type?: string;
  status?: string;
  limit?: number;
  page?: number;
};

async function parseJsonResponse(response: Response): Promise<{ body: unknown; rawText: string }> {
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

function getErrorMessage(body: unknown, rawText: string, fallback: string) {
  if (body && typeof body === "object") {
    const detail = "detail" in body ? String((body as Record<string, unknown>).detail || "").trim() : "";
    const message = "message" in body ? String((body as Record<string, unknown>).message || "").trim() : "";
    if (detail) {
      return detail;
    }
    if (message) {
      return message;
    }
  }
  return rawText.trim() || fallback;
}

function normalizeJobItem(item: unknown): PilotJobListItem | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const row = item as Record<string, unknown>;
  const normalized: PilotJobListItem = {
    id: typeof row.id === "string" ? row.id : "",
    slug: typeof row.slug === "string" ? row.slug : "",
    job_no: typeof row.job_no === "string" ? row.job_no : "",
    title: typeof row.title === "string" ? row.title : "",
    company: typeof row.company === "string" ? row.company : "",
    location: typeof row.location === "string" ? row.location : "",
    employment_type: typeof row.employment_type === "string" ? row.employment_type : "",
    experience: typeof row.experience === "string" ? row.experience : "",
    deadline_text: typeof row.deadline_text === "string" ? row.deadline_text : "",
    deadline_date: typeof row.deadline_date === "string" ? row.deadline_date : "",
    period_text: typeof row.period_text === "string" ? row.period_text : "",
    d_day: typeof row.d_day === "string" ? row.d_day : "",
    matched_keywords: Array.isArray(row.matched_keywords)
      ? row.matched_keywords.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    source: typeof row.source === "string" ? row.source : "",
    url: typeof row.url === "string" ? row.url : "",
    status: typeof row.status === "string" ? row.status : "open",
    role_family: typeof row.role_family === "string" ? row.role_family : "",
    license_tags: Array.isArray(row.license_tags)
      ? row.license_tags.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    aircraft_category: typeof row.aircraft_category === "string" ? row.aircraft_category : "",
    aircraft_types: Array.isArray(row.aircraft_types)
      ? row.aircraft_types.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    experience_level: typeof row.experience_level === "string" ? row.experience_level : "",
    summary: typeof row.summary === "string" ? row.summary : "",
    posted_at: typeof row.posted_at === "string" ? row.posted_at : "",
    deadline_at: typeof row.deadline_at === "string" ? row.deadline_at : "",
  };
  if (!normalized.id || !normalized.title || !normalized.url) {
    return null;
  }
  return normalized;
}

function normalizeFilterOption(item: unknown): JobsFilterOption | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const row = item as Record<string, unknown>;
  const value = typeof row.value === "string" ? row.value : "";
  const label = typeof row.label === "string" ? row.label : value;
  const count = typeof row.count === "number" && Number.isFinite(row.count) ? row.count : 0;
  if (!value) {
    return null;
  }
  return { value, label, count };
}

function normalizePilotPanelPayload(body: unknown): PilotRecruitmentResponse {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    updated_at: typeof payload.updated_at === "string" ? payload.updated_at : "",
    last_successful_at: typeof payload.last_successful_at === "string" ? payload.last_successful_at : "",
    last_attempted_at: typeof payload.last_attempted_at === "string" ? payload.last_attempted_at : "",
    source_label: typeof payload.source_label === "string" ? payload.source_label : "",
    cache_status:
      payload.cache_status === "fresh" || payload.cache_status === "stale" || payload.cache_status === "error"
        ? payload.cache_status
        : "",
    cache_warning: typeof payload.cache_warning === "string" ? payload.cache_warning : "",
    items: Array.isArray(payload.items)
      ? payload.items.map((item) => normalizeJobItem(item)).filter((item): item is PilotJobListItem => Boolean(item))
      : [],
  };
}

async function fetchPilotPanelFromUrl(url: string): Promise<PilotRecruitmentResponse> {
  const response = await fetch(url, { cache: "no-store" });
  const { body, rawText } = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(getErrorMessage(body, rawText, "채용정보를 불러오지 못했습니다."));
  }
  return normalizePilotPanelPayload(body);
}

export async function fetchPilotJobsPanel(limit = 12): Promise<PilotRecruitmentResponse> {
  const safeLimit = Math.max(Number(limit) || 12, 1);
  const candidates = [
    `${API_BASE_URL}/api/jobs/pilot?limit=${encodeURIComponent(String(safeLimit))}`,
    `${API_BASE_URL}/api/jobs?limit=${encodeURIComponent(String(safeLimit))}&page=1`,
    "/data/pilot-jobs.json",
  ];
  let lastError: Error | null = null;
  for (const url of candidates) {
    try {
      return await fetchPilotPanelFromUrl(url);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error || ""));
    }
  }
  throw (lastError || new Error("채용정보를 불러오지 못했습니다."));
}

export async function fetchPilotJobsIndex(params: JobsQueryParams = {}): Promise<PilotJobsListResponse> {
  const searchParams = new URLSearchParams();
  if (params.q) {
    searchParams.set("q", params.q);
  }
  if (params.role_family) {
    searchParams.set("role_family", params.role_family);
  }
  if (params.location) {
    searchParams.set("location", params.location);
  }
  if (params.employment_type) {
    searchParams.set("employment_type", params.employment_type);
  }
  if (params.status) {
    searchParams.set("status", params.status);
  }
  searchParams.set("limit", String(params.limit ?? 24));
  searchParams.set("page", String(params.page ?? 1));

  const response = await fetch(`${API_BASE_URL}/api/jobs?${searchParams.toString()}`, {
    cache: "no-store",
  });
  const { body, rawText } = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(getErrorMessage(body, rawText, "梨꾩슜 紐⑸줉??遺덈윭?ㅼ? 紐삵뻽?듬땲??"));
  }
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const filters = payload.filters && typeof payload.filters === "object" ? (payload.filters as Record<string, unknown>) : {};

  return {
    updated_at: typeof payload.updated_at === "string" ? payload.updated_at : "",
    last_successful_at: typeof payload.last_successful_at === "string" ? payload.last_successful_at : "",
    last_attempted_at: typeof payload.last_attempted_at === "string" ? payload.last_attempted_at : "",
    source_label: typeof payload.source_label === "string" ? payload.source_label : "",
    cache_status:
      payload.cache_status === "fresh" || payload.cache_status === "stale" || payload.cache_status === "error"
        ? payload.cache_status
        : "",
    cache_warning: typeof payload.cache_warning === "string" ? payload.cache_warning : "",
    total_count: typeof payload.total_count === "number" && Number.isFinite(payload.total_count) ? payload.total_count : 0,
    limit: typeof payload.limit === "number" && Number.isFinite(payload.limit) ? payload.limit : params.limit ?? 24,
    offset: typeof payload.offset === "number" && Number.isFinite(payload.offset) ? payload.offset : 0,
    page: typeof payload.page === "number" && Number.isFinite(payload.page) ? payload.page : params.page ?? 1,
    has_more: Boolean(payload.has_more),
    filters: {
      role_families: Array.isArray(filters.role_families)
        ? filters.role_families.map((item) => normalizeFilterOption(item)).filter((item): item is JobsFilterOption => Boolean(item))
        : [],
      locations: Array.isArray(filters.locations)
        ? filters.locations.map((item) => normalizeFilterOption(item)).filter((item): item is JobsFilterOption => Boolean(item))
        : [],
      employment_types: Array.isArray(filters.employment_types)
        ? filters.employment_types.map((item) => normalizeFilterOption(item)).filter((item): item is JobsFilterOption => Boolean(item))
        : [],
      statuses: Array.isArray(filters.statuses)
        ? filters.statuses.map((item) => normalizeFilterOption(item)).filter((item): item is JobsFilterOption => Boolean(item))
        : [],
      license_tags: Array.isArray(filters.license_tags)
        ? filters.license_tags.map((item) => normalizeFilterOption(item)).filter((item): item is JobsFilterOption => Boolean(item))
        : [],
    },
    items: Array.isArray(payload.items)
      ? payload.items.map((item) => normalizeJobItem(item)).filter((item): item is PilotJobListItem => Boolean(item))
      : [],
  };
}

