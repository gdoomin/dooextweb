"use client";

import Image from "next/image";
import {
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Feature, FeatureCollection, Geometry } from "geojson";

import { AdSenseSlot } from "@/components/AdSenseSlot";
import { HimawariRailPanel } from "@/components/HimawariRailPanel";
import { LoginForm } from "@/components/LoginForm";
import { NotamMiniMap } from "@/components/NotamMiniMap";
import {
  API_BASE_URL,
  type BillingStatusResponse,
  type ClientConvertRequestBody,
  type ConvertResponse,
  type HomeSyncStatePayload,
  type LineResult,
  type MapPayload,
  type PolygonResult,
  type ServerHistoryItem,
  type SharedConvertPackage,
  type UserBookmarkItem,
  deleteAllHistoryItems,
  deleteUserBookmark,
  deleteHistoryItem,
  cancelBillingSubscription,
  downloadSharedConvertPackageFile,
  fetchBillingStatus,
  fetchHomeSyncState,
  fetchViewerStateSnapshot,
  fetchUserBookmark,
  fetchUserHistory,
  loadLastConvert,
  parseSharedConvertPackageFile,
  persistConvertedJob,
  redeemBillingPromoCode,
  reopenHistoryItem,
  saveLastConvert,
  saveHomeSyncState,
  saveUserBookmark,
  startBillingSubscription,
} from "@/lib/convert";
import { convertKmlFileInBrowser } from "@/lib/kml-client-convert";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";

const modeLabel: Record<ConvertResponse["mode"], string> = {
  linestring: "LineString 모드 | Flight Line 좌표 추출",
  polygon: "Polygon 모드 | 폴리곤(도형) 파일입니다. 시작점/끝점 추출 대상이 아닙니다.",
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
const BOTTOM_AD_SLOT = process.env.NEXT_PUBLIC_ADSENSE_BOTTOM_SLOT ?? "";
const SHARED_FILE_EXTENSION = ".dooex";
const DEFAULT_FILE_ACCEPT = `.kml,.kmz,.gpx,.geojson,.json,.csv,.txt,${SHARED_FILE_EXTENSION}`;
const APP_VERSION = "4.1.5";
const HISTORY_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const LOADING_STATUS_KEYWORDS = /(불러오는 중|추가하는 중|변환하는 중|저장하는 중)/;
const HOME_SYNC_VERSION = 1;
const VIEWER_LAUNCH_VERSION = 10;
const HOME_SYNC_POLL_MS = 15000;
const HOME_SYNC_SAVE_DEBOUNCE_MS = 3000;
const HOME_SYNC_DEVICE_STORAGE_KEY = "doo-home-sync-device-id";

function isIOSLikeDevice(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const userAgent = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const maxTouchPoints = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return /iPad|iPhone|iPod/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

function createHomeSyncDeviceId(): string {
  if (typeof window === "undefined") {
    return `device-${Date.now()}`;
  }
  const existing = window.localStorage.getItem(HOME_SYNC_DEVICE_STORAGE_KEY);
  if (existing) {
    return existing;
  }
  const generated = typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(HOME_SYNC_DEVICE_STORAGE_KEY, generated);
  return generated;
}

function normalizeHomeSyncJobIds(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  values.forEach((value) => {
    const jobId = String(value || "").trim();
    if (!jobId || seen.has(jobId)) {
      return;
    }
    seen.add(jobId);
    unique.push(jobId);
  });
  return unique;
}

function getHomeSyncUpdatedAt(payload: HomeSyncStatePayload | null): number {
  if (!payload || typeof payload !== "object") {
    return 0;
  }
  const direct = Number(payload.savedAt);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  const fromSync = Number(payload.__sync?.updated_at);
  if (Number.isFinite(fromSync) && fromSync > 0) {
    return fromSync;
  }
  return 0;
}

function getHomeSyncRev(payload: HomeSyncStatePayload | null): number {
  if (!payload || typeof payload !== "object") {
    return 0;
  }
  const rev = Number(payload.__sync?.rev);
  if (Number.isFinite(rev) && rev > 0) {
    return Math.floor(rev);
  }
  return 0;
}

function buildComparableHomeSyncState(payload: HomeSyncStatePayload | null): {
  active_job_id: string;
  stack_job_ids: string[];
} {
  if (!payload || typeof payload !== "object") {
    return {
      active_job_id: "",
      stack_job_ids: [],
    };
  }
  return {
    active_job_id: String(payload.active_job_id || "").trim(),
    stack_job_ids: normalizeHomeSyncJobIds(payload.stack_job_ids),
  };
}

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

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result) {
        reject(new Error("이미지를 읽지 못했습니다."));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

async function loadImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("이미지 크기를 확인하지 못했습니다."));
    image.src = dataUrl;
  });
}

function describeBookmarkHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "") || parsed.hostname;
  } catch {
    return "링크 열기";
  }
}

function buildBookmarkIconCandidates(url: string): string[] {
  try {
    const parsed = new URL(url);
    return [`${parsed.origin}/apple-touch-icon.png`, `${parsed.origin}/favicon.ico`];
  } catch {
    return [];
  }
}

function buildBookmarkTextLabel(url: string): string {
  const host = describeBookmarkHost(url);
  const base = host.split(".")[0] || host;
  return base.slice(0, 8).toUpperCase();
}

type BookmarkVisualProps = {
  bookmark: UserBookmarkItem;
  alt: string;
  imageClassName: string;
  textClassName: string;
};

type BookmarkAutoIconProps = {
  bookmarkUrl: string;
  iconCandidates: string[];
  alt: string;
  imageClassName: string;
  textClassName: string;
};

function BookmarkAutoIcon({
  bookmarkUrl,
  iconCandidates,
  alt,
  imageClassName,
  textClassName,
}: BookmarkAutoIconProps) {
  const [iconIndex, setIconIndex] = useState(0);

  const iconSrc = iconCandidates[iconIndex] || "";
  if (iconSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={iconSrc}
        alt={alt}
        width={92}
        height={92}
        className={imageClassName}
        loading="lazy"
        onError={() => setIconIndex((current) => current + 1)}
      />
    );
  }

  return <div className={textClassName}>{buildBookmarkTextLabel(bookmarkUrl)}</div>;
}

function BookmarkVisual({ bookmark, alt, imageClassName, textClassName }: BookmarkVisualProps) {
  const customImage = String(bookmark.image_data_url || "").trim();
  const iconCandidates = useMemo(
    () => (customImage ? [] : buildBookmarkIconCandidates(bookmark.bookmark_url)),
    [customImage, bookmark.bookmark_url],
  );

  if (customImage) {
    return <Image src={customImage} alt={alt} width={92} height={92} className={imageClassName} unoptimized />;
  }

  return (
    <BookmarkAutoIcon
      key={`${bookmark.id}:${bookmark.bookmark_url}`}
      bookmarkUrl={bookmark.bookmark_url}
      iconCandidates={iconCandidates}
      alt={alt}
      imageClassName={imageClassName}
      textClassName={textClassName}
    />
  );
}

type StackEntry = {
  id: string;
  response: ConvertResponse;
  lineCount: number;
  polygonCount: number;
};

type ViewerTitleFileLabel = {
  order: number;
  primary: string;
  secondary?: string;
};

type Identity = {
  id: string;
  email: string;
  token: string;
};

function toFiniteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLineResult(row: unknown): LineResult | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const record = row as Record<string, unknown>;
  const sLat = toFiniteNumber(record.s_lat);
  const sLon = toFiniteNumber(record.s_lon);
  const eLat = toFiniteNumber(record.e_lat);
  const eLon = toFiniteNumber(record.e_lon);
  if (sLat === null || sLon === null || eLat === null || eLon === null) {
    return null;
  }
  const num = typeof record.num === "string" ? record.num : String(record.num ?? "").trim();
  return {
    num,
    s_lat: sLat,
    s_lon: sLon,
    e_lat: eLat,
    e_lon: eLon,
  };
}

function extractLineResults(response: ConvertResponse): LineResult[] {
  const mapResults = Array.isArray(response.map_payload?.results) ? response.map_payload.results : [];
  const rawRows = mapResults.length > 0 ? mapResults : Array.isArray(response.results) ? response.results : [];
  return rawRows.map((row) => normalizeLineResult(row)).filter((row): row is LineResult => Boolean(row));
}

function normalizePolygonResult(row: unknown, index: number): PolygonResult | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const record = row as Record<string, unknown>;
  const rawPoints = Array.isArray(record.points) ? record.points : [];
  const points: [number, number][] = [];
  rawPoints.forEach((point) => {
    if (!Array.isArray(point) || point.length < 2) {
      return;
    }
    const lat = toFiniteNumber(point[0]);
    const lon = toFiniteNumber(point[1]);
    if (lat === null || lon === null) {
      return;
    }
    points.push([lat, lon]);
  });
  if (points.length < 3) {
    return null;
  }
  const num = typeof record.num === "string" ? record.num : String(record.num ?? "").trim();
  const labelRaw = typeof record.label === "string" ? record.label.trim() : "";
  return {
    num,
    label: labelRaw || num || `Polygon ${index + 1}`,
    points,
  };
}

function extractPolygonResults(response: ConvertResponse): PolygonResult[] {
  const rows = Array.isArray(response.map_payload?.polygons) ? response.map_payload.polygons : [];
  return rows.map((row, index) => normalizePolygonResult(row, index)).filter((row): row is PolygonResult => Boolean(row));
}

function extractGeoJsonFeatures(response: ConvertResponse): Array<Feature<Geometry | null>> {
  const geojson = response.map_payload?.geojson;
  if (!geojson || geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return [];
  }
  return geojson.features.filter(
    (feature): feature is Feature<Geometry | null> => Boolean(feature) && typeof feature === "object",
  );
}

function stackEntryId(response: ConvertResponse): string {
  const source = String(response.source_hash || "").trim();
  if (source) {
    return `source:${source}`;
  }
  const job = String(response.job_id || "").trim();
  if (job) {
    return `job:${job}`;
  }
  const filename = String(response.filename || response.project_name || "file").trim();
  return `local:${filename}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function createStackEntry(response: ConvertResponse): StackEntry {
  const lineCount = extractLineResults(response).length;
  const polygonCount = extractPolygonResults(response).length;
  return {
    id: stackEntryId(response),
    response,
    lineCount,
    polygonCount,
  };
}

function isSameSourceFile(left: ConvertResponse, right: ConvertResponse): boolean {
  const leftHash = String(left.source_hash || "").trim().toLowerCase();
  const rightHash = String(right.source_hash || "").trim().toLowerCase();
  if (leftHash && rightHash) {
    return leftHash === rightHash;
  }

  const leftJob = String(left.job_id || "").trim();
  const rightJob = String(right.job_id || "").trim();
  if (leftJob && rightJob) {
    return leftJob === rightJob;
  }

  return false;
}

function waitForNextPaint(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function buildStackTextOutput(projectName: string, stack: StackEntry[], lineResults: LineResult[], polygons: PolygonResult[]): string {
  const lines: string[] = [];
  lines.push(`프로젝트: ${projectName}`);
  lines.push("=".repeat(70));
  lines.push(`중첩 파일 수: ${stack.length}개`);
  lines.push(`라인: ${lineResults.length}개 · 폴리곤: ${polygons.length}개`);
  lines.push("-".repeat(70));
  stack.forEach((entry, index) => {
    lines.push(`${String(index + 1).padStart(2, "0")}. ${entry.response.filename}`);
  });
  return lines.join("\n");
}

function buildStackProjectName(stack: StackEntry[]): string {
  if (stack.length === 1) {
    return stack[0].response.project_name || stack[0].response.filename || "DOO_STACK";
  }
  const first = stack[0]?.response?.project_name || stack[0]?.response?.filename || "DOO";
  const safeFirst = String(first).trim() || "DOO";
  return `${safeFirst}_STACK_${stack.length}`;
}

const STACK_AIRCRAFT_SPEED_KNOTS = 130;
const STACK_KNOT_TO_KMH = 1.852;
const STACK_TURN_MINUTES_PER_LINE = 3;
const STACK_EARTH_RADIUS_KM = 6371.0088;
const DISPLAY_EXTENSION_PATTERN = /\.(kml|kmz|gpx|geojson|json|csv|txt)$/i;
const REGION_KO_LABELS: Array<{ key: string; label: string }> = [
  { key: "gyeongbuk", label: "경북" },
  { key: "gangwon", label: "강원" },
  { key: "ansan", label: "안산" },
];

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = degreesToRadians(lat2 - lat1);
  const dLon = degreesToRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(degreesToRadians(lat1)) *
      Math.cos(degreesToRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * STACK_EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildStackMetaText(stackCount: number, lineResults: LineResult[], polygons: PolygonResult[]): string {
  if (!lineResults.length) {
    return `${stackCount}개 파일 중첩 · 라인 0개 · 폴리곤 ${polygons.length}개`;
  }
  const totalLengthKm = lineResults.reduce((sum, row) => {
    const sLat = Number(row.s_lat);
    const sLon = Number(row.s_lon);
    const eLat = Number(row.e_lat);
    const eLon = Number(row.e_lon);
    if (![sLat, sLon, eLat, eLon].every((value) => Number.isFinite(value))) {
      return sum;
    }
    return sum + haversineKm(sLat, sLon, eLat, eLon);
  }, 0);
  const flightHours = totalLengthKm / (STACK_AIRCRAFT_SPEED_KNOTS * STACK_KNOT_TO_KMH);
  const totalCaptureHours = flightHours + ((lineResults.length * STACK_TURN_MINUTES_PER_LINE) / 60);
  return `${stackCount}개 파일 중첩 · 라인 ${lineResults.length}개 · 폴리곤 ${polygons.length}개 · 총길이 ${totalLengthKm.toFixed(1)}km · 총촬영시간: 대략 ${totalCaptureHours.toFixed(1)}시간`;
}

function stripDisplayExtensions(filename: string): string {
  let text = String(filename || "").trim();
  while (DISPLAY_EXTENSION_PATTERN.test(text)) {
    text = text.replace(DISPLAY_EXTENSION_PATTERN, "").trim();
  }
  return text;
}

function resolveKoreanRegionLabel(filenameWithoutExt: string): string {
  const normalized = String(filenameWithoutExt || "").toLowerCase();
  if (!normalized) {
    return "";
  }
  const matched = REGION_KO_LABELS.find((item) => normalized.includes(item.key));
  return matched ? matched.label : "";
}

function resolveCmUnitText(filenameWithoutExt: string): string {
  const match = String(filenameWithoutExt || "").match(/(\d+(?:\.\d+)?)\s*cm/i);
  if (!match) {
    return "";
  }
  return `${match[1]}cm`;
}

function buildLocalizedFileDisplay(filename: string): { primary: string; secondary: string } {
  const stripped = stripDisplayExtensions(filename);
  const primary = stripped || String(filename || "").trim();
  if (!primary) {
    return { primary: "", secondary: "" };
  }

  const regionKo = resolveKoreanRegionLabel(primary);
  const unitText = resolveCmUnitText(primary);
  if (!regionKo || !unitText) {
    return { primary, secondary: "" };
  }
  return { primary, secondary: `(${regionKo} ${unitText})` };
}

function isSharedConvertFilename(filename: string): boolean {
  return String(filename || "").trim().toLowerCase().endsWith(SHARED_FILE_EXTENSION);
}

function sanitizeSharedViewerStateForExport(viewerState: Record<string, unknown>): Record<string, unknown> {
  if (!viewerState || typeof viewerState !== "object") {
    return {};
  }
  const sanitized = { ...viewerState };
  delete sanitized.weather;
  delete sanitized.weatherOverlay;
  delete sanitized.notam;
  return sanitized;
}

function buildSharedConvertPayload(response: ConvertResponse): ClientConvertRequestBody {
  return {
    filename: response.filename,
    project_name: response.project_name,
    mode: response.mode,
    result_count: response.result_count,
    text_output: response.text_output,
    map_payload: response.map_payload,
    results: response.results,
    source_hash: response.source_hash,
  };
}

function buildSharedConvertPackage(
  response: ConvertResponse,
  viewerState: Record<string, unknown>,
): SharedConvertPackage {
  return {
    format: "dooextractor-share",
    version: 1,
    exported_at: new Date().toISOString(),
    entry: {
      job_id: response.job_id,
      filename: response.filename,
      project_name: response.project_name,
      mode: response.mode,
      result_count: response.result_count,
      source_hash: response.source_hash,
    },
    convert_payload: buildSharedConvertPayload(response),
    viewer_state: sanitizeSharedViewerStateForExport(viewerState),
  };
}

function buildSharedDownloadName(item: ServerHistoryItem, response: ConvertResponse): string {
  const baseName = stripDisplayExtensions(
    item.filename || response.filename || item.project_name || response.project_name || "dooextractor-share",
  );
  return baseName || "dooextractor-share";
}

function canUseLocalizedViewerTitle(response: ConvertResponse): boolean {
  const mode = String(response.mode || "").trim().toLowerCase();
  const sourceFormat = String(response.map_payload?.source_format || "").trim().toLowerCase();
  if (mode !== "linestring") {
    return false;
  }
  if (sourceFormat === "kml" || sourceFormat === "kmz") {
    return true;
  }
  if (!sourceFormat) {
    const filename = String(response.filename || "").trim().toLowerCase();
    const segments = filename.split(".").map((item) => item.trim()).filter(Boolean);
    return segments.includes("kml") || segments.includes("kmz");
  }
  return false;
}

function buildViewerTitleFileLabel(response: ConvertResponse, order: number): ViewerTitleFileLabel | null {
  if (!canUseLocalizedViewerTitle(response)) {
    return null;
  }
  const sourceName = String(response.filename || response.project_name || "").trim();
  const localized = buildLocalizedFileDisplay(sourceName);
  if (!localized.primary) {
    return null;
  }
  return {
    order,
    primary: localized.primary,
    secondary: localized.secondary || undefined,
  };
}

function attachViewerTitleLabelToPayload(payload: ClientConvertRequestBody): ClientConvertRequestBody {
  const mode = String(payload.mode || "").trim().toLowerCase();
  const sourceFormat = String(payload.map_payload?.source_format || "").trim().toLowerCase();
  const sourceName = String(payload.filename || payload.project_name || "").trim();
  const localized = buildLocalizedFileDisplay(sourceName);
  const isEligible = mode === "linestring" && (sourceFormat === "kml" || sourceFormat === "kmz");
  const titleFileLabels = isEligible && localized.primary
    ? [
        {
          order: 1,
          primary: localized.primary,
          secondary: localized.secondary || undefined,
        },
      ]
    : [];

  return {
    ...payload,
    map_payload: {
      ...(payload.map_payload || {}),
      title_file_labels: titleFileLabels,
    },
  };
}

function attachViewerTitleLabelToResponse(response: ConvertResponse): ConvertResponse {
  const label = buildViewerTitleFileLabel(response, 1);
  return {
    ...response,
    map_payload: {
      ...(response.map_payload || {}),
      title_file_labels: label ? [label] : [],
    },
  };
}

function buildStackPayload(stack: StackEntry[]): ClientConvertRequestBody {
  const lineResults = stack.flatMap((entry) => extractLineResults(entry.response));
  const polygons = stack.flatMap((entry) => extractPolygonResults(entry.response));
  const hasLines = lineResults.length > 0;
  const mode: ConvertResponse["mode"] = hasLines ? "linestring" : "polygon";
  const projectName = buildStackProjectName(stack);
  const fileLabel =
    stack.length === 1
      ? stack[0].response.filename
      : `${projectName}.kml`;
  const allFeatures = stack.flatMap((entry) => extractGeoJsonFeatures(entry.response));
  const titleFileLabels = stack
    .map((entry, index) => buildViewerTitleFileLabel(entry.response, index + 1))
    .filter((item): item is ViewerTitleFileLabel => Boolean(item));
  const mapPayload: MapPayload = {
    project_name: projectName,
    mode,
    results: hasLines ? lineResults : [],
    polygons,
    has_kml_num: hasLines ? lineResults.every((row) => Boolean(String(row.num || "").trim())) : false,
    default_force_num: hasLines ? !lineResults.every((row) => Boolean(String(row.num || "").trim())) : false,
    default_show_num: hasLines ? lineResults.every((row) => Boolean(String(row.num || "").trim())) : false,
    has_layers: false,
    layer_catalog: [],
    default_gray_map: false,
    meta_text: buildStackMetaText(stack.length, lineResults, polygons),
    geojson:
      allFeatures.length > 0
        ? ({
            type: "FeatureCollection",
            features: allFeatures,
          } as FeatureCollection<Geometry | null>)
        : undefined,
    source_format: "kml",
    title_file_labels: titleFileLabels,
  };

  return {
    filename: fileLabel,
    project_name: projectName,
    mode,
    result_count: mode === "linestring" ? lineResults.length : polygons.length,
    text_output: buildStackTextOutput(projectName, stack, lineResults, polygons),
    map_payload: mapPayload,
    results:
      mode === "linestring"
        ? lineResults.map((row) => ({
            num: row.num || "",
            s_num: row.s_num || "",
            e_num: row.e_num || "",
            s_lat: row.s_lat,
            s_lon: row.s_lon,
            e_lat: row.e_lat,
            e_lon: row.e_lon,
          }))
        : [],
  };
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
  const [stackItems, setStackItems] = useState<StackEntry[]>(() => (restored ? [createStackEntry(restored)] : []));
  const [filePickMode, setFilePickMode] = useState<"replace" | "append">("replace");
  const [historyItems, setHistoryItems] = useState<ServerHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [statusMessage, setStatusMessage] = useState(
    restored ? "이전 변환 결과를 복원했습니다." : "지원 파일을 불러와 주세요.",
  );
  const [fileAccept, setFileAccept] = useState(DEFAULT_FILE_ACCEPT);
  const [statusTone, setStatusTone] = useState<"idle" | "loading" | "success" | "error">(restored ? "success" : "idle");
  const [isLoading, setIsLoading] = useState(false);
  const [historyOpeningId, setHistoryOpeningId] = useState("");
  const [historyAppendingId, setHistoryAppendingId] = useState("");
  const [historySharingId, setHistorySharingId] = useState("");
  const [historyDeletingId, setHistoryDeletingId] = useState("");
  const [historyDeletingAll, setHistoryDeletingAll] = useState(false);
  const [userEmail, setUserEmail] = useState(initialUserEmail);
  const [userId, setUserId] = useState(initialUserId);
  const [accessToken, setAccessToken] = useState("");
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMessage, setAuthMessage] = useState("전체 기능을 사용하려면 회원가입이 필요합니다.");
  const [billingStatus, setBillingStatus] = useState<BillingStatusResponse | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingActionLoading, setBillingActionLoading] = useState(false);
  const [buyerPhone, setBuyerPhone] = useState("");
  const [promoCodeInput, setPromoCodeInput] = useState("");
  const [showPlanGuide, setShowPlanGuide] = useState(false);
  const [bookmarks, setBookmarks] = useState<UserBookmarkItem[]>([]);
  const [bookmarkMaxItems, setBookmarkMaxItems] = useState(20);
  const [bookmarkLoading, setBookmarkLoading] = useState(false);
  const [bookmarkSaving, setBookmarkSaving] = useState(false);
  const [showBookmarkModal, setShowBookmarkModal] = useState(false);
  const [selectedBookmarkId, setSelectedBookmarkId] = useState("");
  const [bookmarkUrlInput, setBookmarkUrlInput] = useState("");
  const [bookmarkImageDataUrl, setBookmarkImageDataUrl] = useState("");
  const [bookmarkError, setBookmarkError] = useState("");
  const [bookmarkBoardDragging, setBookmarkBoardDragging] = useState(false);
  const [homeSyncPendingRemote, setHomeSyncPendingRemote] = useState<HomeSyncStatePayload | null>(null);
  const homeSyncSaveTimerRef = useRef<number | null>(null);
  const homeSyncLastSavedComparableRef = useRef("");
  const homeSyncLastSeenRemoteUpdatedAtRef = useRef(0);
  const homeSyncLastDismissedRemoteUpdatedAtRef = useRef(0);
  const homeSyncRevRef = useRef(0);
  const homeSyncFetchInFlightRef = useRef(false);
  const homeSyncApplyingRef = useRef(false);
  const homeSyncSuppressSaveRef = useRef(false);
  const homeSyncDeviceIdRef = useRef("");
  const bookmarkBoardRef = useRef<HTMLDivElement | null>(null);
  const bookmarkBoardDragRef = useRef({
    active: false,
    startX: 0,
    startScrollLeft: 0,
    moved: false,
    pendingUrl: "",
  });

  const isAuthenticated = Boolean(userId);
  const fileDisplay = useMemo(() => {
    if (!stackItems.length) {
      return { primary: "" };
    }
    if (stackItems.length === 1) {
      const filename = stackItems[0].response.filename || stackItems[0].response.project_name || "";
      return { primary: stripDisplayExtensions(filename) || filename };
    }
    return {
      primary: `${stackItems.length}개 파일 중첩: ${stackItems.map((entry) => entry.response.filename).join(", ")}`,
    };
  }, [stackItems]);

  const stackSummary = useMemo(() => {
    if (!stackItems.length) {
      return "파일 스택이 비어 있습니다.";
    }
    const lineCount = stackItems.reduce((sum, entry) => sum + entry.lineCount, 0);
    const polygonCount = stackItems.reduce((sum, entry) => sum + entry.polygonCount, 0);
    return `${stackItems.length}개 파일 중첩 · 라인 ${lineCount}개 · 폴리곤 ${polygonCount}개`;
  }, [stackItems]);

  const modeText = useMemo(() => {
    if (!response) {
      return "지원 파일을 업로드하면 변환 결과가 표시됩니다.";
    }
    if (stackItems.length > 1) {
      return "파일 중첩 모드 | 도식화 보기에서 중첩 레이어를 표시합니다.";
    }
    const sourceFormat = String(response.map_payload?.source_format || "").trim().toLowerCase();
    if (sourceFormat && sourceFormat !== "kml" && sourceFormat !== "kmz") {
      return `${sourceFormat.toUpperCase()} 파일 변환 결과`;
    }
    return modeLabel[response.mode];
  }, [response, stackItems.length]);

  const modeChipLabel = stackItems.length > 1 ? "중첩" : response ? modeBadgeLabel[response.mode] : "";
  const canUseHistory = isAuthenticated;
  const isViewerBusy = isLoading || Boolean(historyOpeningId) || Boolean(historyAppendingId) || historyDeletingAll;
  const canOpenViewer = Boolean(response?.job_id) && !isViewerBusy;
  const showLoadingBadge = statusTone === "loading" && (isViewerBusy || LOADING_STATUS_KEYWORDS.test(statusMessage));
  const canDownloadText = !billingStatus?.billing_enabled || Boolean(billingStatus.features?.text_download);
  const canDownloadExcel = !billingStatus?.billing_enabled || Boolean(billingStatus.features?.excel_download);
  const canUseViewerStateSync = isAuthenticated && (billingStatus?.billing_enabled ? Boolean(billingStatus?.features?.viewer_state) : true);
  const shouldShowPricing =
    Boolean(billingStatus?.billing_enabled) &&
    isAuthenticated &&
    Boolean(billingStatus?.is_new_pricing_user);
  const selectedBookmark = useMemo(
    () => bookmarks.find((item) => item.id === selectedBookmarkId) || null,
    [bookmarks, selectedBookmarkId],
  );

  const historyRows = useMemo(
    () =>
      historyItems.map((item) => ({
        ...item,
        savedAtText: formatHistorySavedAt(item.uploaded_at),
      })),
    [historyItems],
  );

  const localHomeComparable = useMemo(() => {
    const activeJobId = String(response?.job_id || "").trim();
    const stackJobIds = normalizeHomeSyncJobIds(stackItems.map((entry) => entry.response.job_id));
    return {
      active_job_id: activeJobId,
      stack_job_ids: stackJobIds,
    };
  }, [response?.job_id, stackItems]);

  const localHomeComparableSerialized = useMemo(
    () => JSON.stringify(localHomeComparable),
    [localHomeComparable],
  );

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
    if (isIOSLikeDevice()) {
      // iOS Files picker can disable KML/KMZ entries when accept is strict.
      // Keep picker broad on iOS and validate actual file type in parser flow.
      setFileAccept("*/*");
    }
  }, []);

  useEffect(() => {
    homeSyncDeviceIdRef.current = createHomeSyncDeviceId();
  }, []);

  useEffect(() => {
    return () => {
      if (homeSyncSaveTimerRef.current) {
        window.clearTimeout(homeSyncSaveTimerRef.current);
      }
    };
  }, []);

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

    async function run() {
      if (!userId) {
        setBookmarks([]);
        setBookmarkMaxItems(20);
        setBookmarkLoading(false);
        return;
      }
      setBookmarkLoading(true);
      try {
        const nextBookmark = await fetchUserBookmark(userId, userEmail, accessToken);
        if (!cancelled) {
          setBookmarks(nextBookmark.items);
          setBookmarkMaxItems(nextBookmark.max_items || 20);
        }
      } catch {
        if (!cancelled) {
          setBookmarks([]);
          setBookmarkMaxItems(20);
        }
      } finally {
        if (!cancelled) {
          setBookmarkLoading(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [userId, userEmail, accessToken]);

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

  useEffect(() => {
    if (!canUseViewerStateSync || !userId) {
      setHomeSyncPendingRemote(null);
      return;
    }
    if (homeSyncSuppressSaveRef.current || homeSyncApplyingRef.current) {
      return;
    }
    if (homeSyncLastSavedComparableRef.current === localHomeComparableSerialized) {
      return;
    }

    if (homeSyncSaveTimerRef.current) {
      window.clearTimeout(homeSyncSaveTimerRef.current);
    }
    homeSyncSaveTimerRef.current = window.setTimeout(async () => {
      const identity: Identity = { id: userId, email: userEmail, token: accessToken };
      const now = Date.now();
      const nextRev = Math.max(homeSyncRevRef.current, 0) + 1;
      const payload: HomeSyncStatePayload = {
        version: HOME_SYNC_VERSION,
        active_job_id: localHomeComparable.active_job_id,
        stack_job_ids: localHomeComparable.stack_job_ids,
        savedAt: now,
        __sync: {
          rev: nextRev,
          updated_at: now,
          device_id: homeSyncDeviceIdRef.current || createHomeSyncDeviceId(),
        },
      };

      try {
        await saveHomeSyncState(payload, identity.id, identity.email, identity.token);
        homeSyncRevRef.current = nextRev;
        homeSyncLastSavedComparableRef.current = localHomeComparableSerialized;
        homeSyncLastSeenRemoteUpdatedAtRef.current = Math.max(homeSyncLastSeenRemoteUpdatedAtRef.current, now);
      } catch {
        // Keep UX smooth: sync save retries on next local change/poll cycle.
      }
    }, HOME_SYNC_SAVE_DEBOUNCE_MS);

    return () => {
      if (homeSyncSaveTimerRef.current) {
        window.clearTimeout(homeSyncSaveTimerRef.current);
        homeSyncSaveTimerRef.current = null;
      }
    };
  }, [canUseViewerStateSync, userId, userEmail, accessToken, localHomeComparable, localHomeComparableSerialized]);

  useEffect(() => {
    if (!canUseViewerStateSync || !userId) {
      return;
    }
    let cancelled = false;

    const pollRemoteState = async () => {
      if (cancelled || homeSyncFetchInFlightRef.current || homeSyncApplyingRef.current) {
        return;
      }
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      homeSyncFetchInFlightRef.current = true;
      try {
        const remote = await fetchHomeSyncState(userId, userEmail, accessToken);
        if (cancelled || !remote) {
          return;
        }
        const remoteComparable = buildComparableHomeSyncState(remote);
        const remoteComparableSerialized = JSON.stringify(remoteComparable);
        const remoteUpdatedAt = getHomeSyncUpdatedAt(remote);
        const remoteRev = getHomeSyncRev(remote);
        if (remoteRev > homeSyncRevRef.current) {
          homeSyncRevRef.current = remoteRev;
        }

        if (remoteComparableSerialized === localHomeComparableSerialized) {
          homeSyncLastSavedComparableRef.current = localHomeComparableSerialized;
          homeSyncLastSeenRemoteUpdatedAtRef.current = Math.max(homeSyncLastSeenRemoteUpdatedAtRef.current, remoteUpdatedAt);
          setHomeSyncPendingRemote(null);
          return;
        }

        if (remoteUpdatedAt <= homeSyncLastSeenRemoteUpdatedAtRef.current) {
          return;
        }
        if (remoteUpdatedAt <= homeSyncLastDismissedRemoteUpdatedAtRef.current) {
          return;
        }

        homeSyncLastSeenRemoteUpdatedAtRef.current = remoteUpdatedAt;
        setHomeSyncPendingRemote(remote);
      } catch {
        // Ignore transient remote sync read failures.
      } finally {
        homeSyncFetchInFlightRef.current = false;
      }
    };

    void pollRemoteState();
    const timer = window.setInterval(() => {
      void pollRemoteState();
    }, HOME_SYNC_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [canUseViewerStateSync, userId, userEmail, accessToken, localHomeComparableSerialized]);

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

    return HISTORY_DATE_TIME_FORMATTER.format(date);
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

  async function refreshAccountState(identity: Identity) {
    if (!identity.id) {
      return;
    }
    const [historyResult, billingResult, bookmarkResult] = await Promise.allSettled([
      fetchUserHistory(identity.id, identity.email, identity.token),
      fetchBillingStatus(identity.id, identity.email, identity.token),
      fetchUserBookmark(identity.id, identity.email, identity.token),
    ]);

    if (historyResult.status === "fulfilled") {
      setHistoryItems(historyResult.value);
      setHistoryError("");
    } else {
      setHistoryError(describeUnknownError(historyResult.reason, "히스토리를 불러오지 못했습니다."));
    }

    if (billingResult.status === "fulfilled") {
      setBillingStatus(billingResult.value);
    }

    if (bookmarkResult.status === "fulfilled") {
      setBookmarks(bookmarkResult.value.items);
      setBookmarkMaxItems(bookmarkResult.value.max_items || 20);
    }
  }

  async function materializeStackResponse(nextStack: StackEntry[], identity: Identity): Promise<ConvertResponse | null> {
    if (!nextStack.length) {
      return null;
    }
    if (nextStack.length === 1) {
      return nextStack[0].response;
    }
    const stackPayload = buildStackPayload(nextStack);
    return persistConvertedJob(stackPayload, identity.id, identity.email, identity.token);
  }

  async function applyStack(nextStack: StackEntry[], identity: Identity): Promise<ConvertResponse | null> {
    const merged = await materializeStackResponse(nextStack, identity);
    setStackItems(nextStack);
    setResponse(merged);
    if (merged) {
      saveLastConvert(merged);
    } else if (typeof window !== "undefined") {
      window.localStorage.removeItem("doo-extractor-last-convert");
    }
    return merged;
  }

  async function applyHomeSyncRemoteState(remotePayload: HomeSyncStatePayload) {
    if (!remotePayload || homeSyncApplyingRef.current) {
      return;
    }
    const identity = await resolveCurrentIdentity();
    if (!identity.id) {
      return;
    }

    const remoteComparable = buildComparableHomeSyncState(remotePayload);
    const remoteStackIds = remoteComparable.stack_job_ids;
    const remoteActiveJobId = remoteComparable.active_job_id;
    const remoteComparableSerialized = JSON.stringify(remoteComparable);
    const remoteUpdatedAt = getHomeSyncUpdatedAt(remotePayload);
    const remoteRev = getHomeSyncRev(remotePayload);

    homeSyncApplyingRef.current = true;
    homeSyncSuppressSaveRef.current = true;
    if (homeSyncSaveTimerRef.current) {
      window.clearTimeout(homeSyncSaveTimerRef.current);
      homeSyncSaveTimerRef.current = null;
    }

    setStatusTone("loading");
    setStatusMessage("다른 기기의 작업 상태를 적용하는 중입니다...");
    await waitForNextPaint();

    try {
      const reopenByJobId = async (jobId: string): Promise<ConvertResponse | null> => {
        try {
          const reopened = await reopenHistoryItem(jobId, identity.id, identity.email, identity.token);
          return attachViewerTitleLabelToResponse(reopened);
        } catch {
          return null;
        }
      };

      if (remoteStackIds.length > 0) {
        const reopenedEntries: StackEntry[] = [];
        for (const jobId of remoteStackIds) {
          const reopened = await reopenByJobId(jobId);
          if (!reopened) {
            continue;
          }
          reopenedEntries.push(createStackEntry(reopened));
        }

        if (reopenedEntries.length > 0) {
          await applyStack(reopenedEntries, identity);
          setStatusTone("success");
          setStatusMessage(`${reopenedEntries.length}개 파일 동기화 상태를 적용했습니다.`);
        } else if (remoteActiveJobId) {
          const reopened = await reopenByJobId(remoteActiveJobId);
          if (!reopened) {
            throw new Error("동기화할 파일을 찾지 못했습니다. 다시열기 후 다시 시도해 주세요.");
          }
          await applyStack([createStackEntry(reopened)], identity);
          setStatusTone("success");
          setStatusMessage("다른 기기의 단일 파일 작업 상태를 적용했습니다.");
        } else {
          await applyStack([], identity);
          setStatusTone("success");
          setStatusMessage("동기화 상태를 적용해 파일 스택을 비웠습니다.");
        }
      } else if (remoteActiveJobId) {
        const reopened = await reopenByJobId(remoteActiveJobId);
        if (!reopened) {
          throw new Error("동기화할 파일을 찾지 못했습니다. 다시열기 후 다시 시도해 주세요.");
        }
        await applyStack([createStackEntry(reopened)], identity);
        setStatusTone("success");
        setStatusMessage("다른 기기의 작업 상태를 적용했습니다.");
      } else {
        await applyStack([], identity);
        setStatusTone("success");
        setStatusMessage("동기화 상태를 적용해 파일 스택을 비웠습니다.");
      }

      homeSyncLastSavedComparableRef.current = remoteComparableSerialized;
      homeSyncLastSeenRemoteUpdatedAtRef.current = Math.max(homeSyncLastSeenRemoteUpdatedAtRef.current, remoteUpdatedAt);
      homeSyncLastDismissedRemoteUpdatedAtRef.current = 0;
      if (remoteRev > homeSyncRevRef.current) {
        homeSyncRevRef.current = remoteRev;
      }
      setHomeSyncPendingRemote(null);
      void refreshAccountState(identity);
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "동기화 상태 적용에 실패했습니다."));
    } finally {
      homeSyncApplyingRef.current = false;
      window.setTimeout(() => {
        homeSyncSuppressSaveRef.current = false;
      }, 0);
    }
  }

  async function handleApplyPendingHomeSync() {
    if (!homeSyncPendingRemote) {
      return;
    }
    await applyHomeSyncRemoteState(homeSyncPendingRemote);
  }

  function handleDismissPendingHomeSync() {
    if (homeSyncPendingRemote) {
      const updatedAt = getHomeSyncUpdatedAt(homeSyncPendingRemote);
      homeSyncLastDismissedRemoteUpdatedAtRef.current = Math.max(homeSyncLastDismissedRemoteUpdatedAtRef.current, updatedAt);
    }
    setHomeSyncPendingRemote(null);
  }

  async function handleFilePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const isSharedFile = isSharedConvertFilename(file.name);

    setIsLoading(true);
    setStatusTone("loading");
    setStatusMessage(isSharedFile ? "공유 파일을 불러오는 중입니다..." : "브라우저에서 파일을 변환하는 중입니다...");
    await waitForNextPaint();

    try {
      const identity = await resolveCurrentIdentity();
      const uploadAuthenticated = Boolean(identity.id);
      let converted: ConvertResponse;

      if (isSharedFile) {
        const sharedPackage = await parseSharedConvertPackageFile(file);
        setStatusMessage("공유 파일을 복원해 서버에 저장하는 중입니다...");
        converted = await persistConvertedJob(
          {
            ...sharedPackage.convert_payload,
            source_file_bytes:
              typeof sharedPackage.convert_payload.source_file_bytes === "number" &&
              Number.isFinite(sharedPackage.convert_payload.source_file_bytes)
                ? sharedPackage.convert_payload.source_file_bytes
                : file.size,
            shared_viewer_state: sanitizeSharedViewerStateForExport(sharedPackage.viewer_state),
          },
          identity.id,
          identity.email,
          identity.token,
        );
      } else {
        const convertedForUpload = attachViewerTitleLabelToPayload(await convertKmlFileInBrowser(file));
        setStatusMessage("변환이 완료되어 서버에 저장하는 중입니다...");
        converted = await persistConvertedJob(
          {
            ...convertedForUpload,
            source_file_bytes: file.size,
          },
          identity.id,
          identity.email,
          identity.token,
        );
      }

      const nextStack = filePickMode === "append" && stackItems.length > 0
        ? [...stackItems, createStackEntry(converted)]
        : [createStackEntry(converted)];
      const stackedResponse = await applyStack(nextStack, identity);

      setStatusTone("success");
      setStatusMessage(
        isSharedFile
          ? uploadAuthenticated
            ? filePickMode === "append" && nextStack.length > 1
              ? `${nextStack.length}개 파일을 중첩했고 공유 설정까지 복원했습니다.`
              : "공유 파일과 도식화 설정을 복원했습니다."
            : filePickMode === "append" && nextStack.length > 1
              ? `${nextStack.length}개 파일을 중첩했고 공유 설정까지 복원했습니다.`
              : "공유 파일과 도식화 설정을 복원했습니다."
          : uploadAuthenticated
            ? filePickMode === "append" && nextStack.length > 1
              ? `${nextStack.length}개 파일을 중첩했고 합본 결과를 히스토리에 저장했습니다.`
              : `${stackedResponse?.result_count ?? converted.result_count}개 결과를 변환했고 히스토리에 저장했습니다.`
            : filePickMode === "append" && nextStack.length > 1
              ? `${nextStack.length}개 파일을 중첩했습니다. 로그인하면 히스토리와 다시열기를 사용할 수 있습니다.`
              : `${stackedResponse?.result_count ?? converted.result_count}개 결과를 변환했습니다. 로그인하면 히스토리와 다시열기를 사용할 수 있습니다.`,
      );

      if (uploadAuthenticated) {
        void refreshAccountState(identity);
      }
    } catch (error) {
      console.error("[KML convert] failed", error);
      setStatusTone("error");
      setStatusMessage(
        describeUnknownError(
          error,
          isSharedFile
            ? "공유 파일을 열지 못했습니다. 파일 형식과 내용을 다시 확인해 주세요."
            : "파일 변환에 실패했습니다. 형식과 내용을 다시 확인해 주세요.",
        ),
      );
    } finally {
      setIsLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function openFileDialog(mode: "replace" | "append" = "replace") {
    setFilePickMode(mode);
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
    await waitForNextPaint();

    try {
      const reopened = await reopenHistoryItem(item.job_id, userId, userEmail, accessToken);
      const normalized = attachViewerTitleLabelToResponse(reopened);
      setStackItems([createStackEntry(normalized)]);
      setResponse(normalized);
      saveLastConvert(normalized);
      setStatusTone("success");
      setStatusMessage(`${normalized.project_name || normalized.filename} 결과를 다시 열었습니다.`);
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "히스토리 항목을 다시 열지 못했습니다."));
    } finally {
      setHistoryOpeningId("");
    }
  }

  async function handleHistoryAppend(item: ServerHistoryItem) {
    if (!canUseHistory) {
      setStatusTone("error");
      setStatusMessage("현재 플랜에서는 히스토리 다시열기를 사용할 수 없습니다.");
      return;
    }
    if (!requireAuth("히스토리 항목을 스택에 추가하려면 로그인해 주세요.")) {
      return;
    }

    setHistoryAppendingId(item.job_id);
    setStatusTone("loading");
    setStatusMessage(`${item.project_name || item.filename} 파일을 스택에 추가하는 중입니다...`);
    await waitForNextPaint();

    try {
      const reopened = await reopenHistoryItem(item.job_id, userId, userEmail, accessToken);
      const normalized = attachViewerTitleLabelToResponse(reopened);
      const duplicateExists = stackItems.some((entry) => isSameSourceFile(entry.response, normalized));
      if (duplicateExists) {
        setStatusTone("error");
        setStatusMessage("같은 파일입니다. 스택에 추가하지 않았습니다.");
        return;
      }
      const nextStack = [...stackItems, createStackEntry(normalized)];
      const identity: Identity = { id: userId, email: userEmail, token: accessToken };
      await applyStack(nextStack, identity);
      setStatusTone("success");
      setStatusMessage(`${nextStack.length}개 파일 중첩이 완료되었습니다.`);
      void refreshAccountState(identity);
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "히스토리 항목을 스택에 추가하지 못했습니다."));
    } finally {
      setHistoryAppendingId("");
    }
  }

  async function handleHistoryShare(item: ServerHistoryItem) {
    if (!canUseHistory) {
      setStatusTone("error");
      setStatusMessage("현재 플랜에서는 공유 파일 저장을 사용할 수 없습니다.");
      return;
    }
    if (!requireAuth("히스토리 항목을 공유하려면 로그인해 주세요.")) {
      return;
    }

    setHistorySharingId(item.job_id);
    setStatusTone("loading");
    setStatusMessage(`${item.project_name || item.filename} 공유 파일을 만드는 중입니다...`);
    await waitForNextPaint();

    try {
      const reopened = attachViewerTitleLabelToResponse(
        await reopenHistoryItem(item.job_id, userId, userEmail, accessToken),
      );
      const viewerState = await fetchViewerStateSnapshot(item.job_id, userId, userEmail, accessToken);
      const sharedPackage = buildSharedConvertPackage(reopened, viewerState);
      downloadSharedConvertPackageFile(sharedPackage, buildSharedDownloadName(item, reopened));
      setStatusTone("success");
      setStatusMessage("공유 파일을 저장했습니다. 받은 사람도 파일 열기로 같은 도식화 결과를 열 수 있습니다.");
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "공유 파일을 만들지 못했습니다."));
    } finally {
      setHistorySharingId("");
    }
  }

  async function removeStackEntry(entryId: string) {
    const nextStack = stackItems.filter((entry) => entry.id !== entryId);
    const identity = await resolveCurrentIdentity();
    try {
      setStatusTone("loading");
      setStatusMessage("중첩 스택을 갱신하는 중입니다...");
      await waitForNextPaint();
      await applyStack(nextStack, identity);
      if (identity.id) {
        void refreshAccountState(identity);
      }
      if (!nextStack.length) {
        setStatusTone("idle");
        setStatusMessage("스택을 비웠습니다. 파일을 열어 주세요.");
      } else {
        setStatusTone("success");
        setStatusMessage(`${nextStack.length}개 파일 중첩 상태로 갱신했습니다.`);
      }
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "스택 항목을 제거하지 못했습니다."));
    }
  }

  async function clearStack() {
    if (!stackItems.length) {
      return;
    }
    const confirmed = window.confirm("파일 스택을 모두 비울까요?");
    if (!confirmed) {
      return;
    }
    const identity = await resolveCurrentIdentity();
    try {
      setStatusTone("loading");
      setStatusMessage("파일 스택을 비우는 중입니다...");
      await waitForNextPaint();
      await applyStack([], identity);
      if (identity.id) {
        void refreshAccountState(identity);
      }
      setStatusTone("idle");
      setStatusMessage("파일 스택을 비웠습니다.");
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "파일 스택을 비우지 못했습니다."));
    }
  }

  async function removeDeletedJobsFromCurrentState(deletedJobIds: string[]) {
    const deletedSet = new Set(deletedJobIds.map((item) => String(item || "").trim()).filter(Boolean));
    if (!deletedSet.size) {
      return;
    }

    const identity = await resolveCurrentIdentity();
    const currentResponseJobId = String(response?.job_id || "").trim();
    if (currentResponseJobId && deletedSet.has(currentResponseJobId)) {
      await applyStack([], identity);
      return;
    }

    if (stackItems.length <= 1) {
      const currentStackJobId = String(stackItems[0]?.response?.job_id || "").trim();
      if (currentStackJobId && deletedSet.has(currentStackJobId)) {
        await applyStack([], identity);
      }
    }
  }

  async function handleHistoryDelete(item: ServerHistoryItem) {
    if (!canUseHistory) {
      setStatusTone("error");
      setStatusMessage("현재 플랜에서는 히스토리 삭제를 사용할 수 없습니다.");
      return;
    }
    if (!requireAuth("개인 히스토리를 삭제하려면 로그인해 주세요.")) {
      return;
    }

    const targetName = item.project_name || item.filename || item.job_id;
    const confirmed = window.confirm(`히스토리에서 \"${targetName}\" 항목을 삭제할까요?`);
    if (!confirmed) {
      return;
    }

    setHistoryDeletingId(item.job_id);
    setStatusTone("loading");
    setStatusMessage(`${targetName} 항목을 삭제하는 중입니다...`);
    await waitForNextPaint();

    try {
      const deleteResult = await deleteHistoryItem(item.job_id, userId, userEmail, accessToken);
      await removeDeletedJobsFromCurrentState(deleteResult.deleted_job_ids.length ? deleteResult.deleted_job_ids : [item.job_id]);
      await refreshHistory();
      setStatusTone("success");
      setStatusMessage(`${targetName} 항목을 삭제했습니다.`);
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "히스토리 항목을 삭제하지 못했습니다."));
    } finally {
      setHistoryDeletingId("");
    }
  }

  async function handleHistoryDeleteAll() {
    if (!canUseHistory) {
      setStatusTone("error");
      setStatusMessage("현재 플랜에서는 히스토리 삭제를 사용할 수 없습니다.");
      return;
    }
    if (!requireAuth("개인 히스토리를 삭제하려면 로그인해 주세요.")) {
      return;
    }
    if (!historyItems.length) {
      setStatusTone("idle");
      setStatusMessage("삭제할 히스토리가 없습니다.");
      return;
    }
    const confirmed = window.confirm("모든 파일이 삭제됩니다");
    if (!confirmed) {
      return;
    }

    setHistoryDeletingAll(true);
    setStatusTone("loading");
    setStatusMessage("히스토리를 전체삭제하는 중입니다...");
    await waitForNextPaint();

    try {
      const identity = await resolveCurrentIdentity();
      await deleteAllHistoryItems(userId, userEmail, accessToken);
      await applyStack([], identity);
      await refreshHistory();
      setStatusTone("success");
      setStatusMessage("히스토리를 전체삭제했습니다.");
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "히스토리 전체삭제에 실패했습니다."));
    } finally {
      setHistoryDeletingAll(false);
    }
  }

  async function copyClipboard() {
    if (!response?.text_output) {
      setStatusTone("error");
      setStatusMessage("먼저 지원 파일을 불러와 주세요.");
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
    if (isViewerBusy) {
      setStatusTone("loading");
      setStatusMessage("파일을 불러오는 중입니다. 완료 후 도식화 보기를 눌러 주세요.");
      return;
    }
    if (!response?.job_id) {
      setStatusTone("error");
      setStatusMessage("실제 변환이 완료된 파일만 도식화 보기로 열 수 있습니다.");
      return;
    }
    const viewerPath = `${API_BASE_URL}/api/viewer/${response.job_id}`;
    const viewerParams = new URLSearchParams({
      v: `viewer-${VIEWER_LAUNCH_VERSION}`,
    });
    let viewerUrl = `${viewerPath}?${viewerParams.toString()}`;
    const tokenForViewer = accessToken.trim();
    if (tokenForViewer) {
      viewerUrl = `${viewerUrl}#doo_access_token=${encodeURIComponent(tokenForViewer)}`;
    }

    const sourceHash = String(response.source_hash || "").trim().toLowerCase();
    const viewerTarget = sourceHash ? `doo-viewer-${sourceHash.slice(0, 24)}-v${VIEWER_LAUNCH_VERSION}` : "_blank";
    const opened = window.open(viewerUrl, viewerTarget);
    if (!opened) {
      window.location.assign(viewerUrl);
    }
    setStatusTone("success");
    setStatusMessage("도식화 Viewer를 열었습니다.");
  }

  function downloadText() {
    if (!response?.txt_download_url) {
      setStatusTone("error");
      setStatusMessage("먼저 지원 파일을 불러와 주세요.");
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
      setStatusMessage("먼저 지원 파일을 불러와 주세요.");
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
      setBookmarks([]);
      setBookmarkMaxItems(20);
      setShowBookmarkModal(false);
      setSelectedBookmarkId("");
      setBookmarkUrlInput("");
      setBookmarkImageDataUrl("");
      setBookmarkError("");
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

  async function handleRedeemPromoCode() {
    const identity = await resolveCurrentIdentity();
    if (!identity.id) {
      openAuthModal("프로모션 코드를 적용하려면 로그인해 주세요.");
      return;
    }
    if (!identity.token) {
      setStatusTone("error");
      setStatusMessage("보안을 위해 다시 로그인 후 프로모션 코드를 적용해 주세요.");
      return;
    }

    const normalizedCode = promoCodeInput.trim().toUpperCase();
    if (!normalizedCode) {
      setStatusTone("error");
      setStatusMessage("프로모션 코드를 먼저 입력해 주세요.");
      return;
    }

    setBillingActionLoading(true);
    setStatusTone("loading");
    setStatusMessage("프로모션 코드를 적용하고 있습니다...");
    try {
      const result = await redeemBillingPromoCode(normalizedCode, identity.id, identity.email, identity.token);
      setBillingStatus(result.billing_status);
      setPromoCodeInput("");
      setStatusTone("success");
      setStatusMessage(result.message || "프로모션 코드가 적용되었습니다.");
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(describeUnknownError(error, "프로모션 코드 적용에 실패했습니다."));
    } finally {
      setBillingActionLoading(false);
    }
  }

  function selectBookmarkForEdit(bookmarkId = "") {
    const target = bookmarks.find((item) => item.id === bookmarkId) || null;
    setSelectedBookmarkId(target?.id || "");
    setBookmarkUrlInput(target?.bookmark_url || "");
    setBookmarkImageDataUrl(target?.image_data_url || "");
    setBookmarkError("");
  }

  function openBookmarkSettings(bookmarkId = "") {
    if (!requireAuth("개인 북마크를 설정하려면 로그인해 주세요.")) {
      return;
    }
    selectBookmarkForEdit(bookmarkId || bookmarks[0]?.id || "");
    setShowBookmarkModal(true);
  }

  function startAddBookmark() {
    if (!requireAuth("개인 북마크를 설정하려면 로그인해 주세요.")) {
      return;
    }
    if (bookmarks.length >= bookmarkMaxItems) {
      setStatusTone("error");
      setStatusMessage(`북마크는 최대 ${bookmarkMaxItems}개까지 저장할 수 있습니다.`);
      return;
    }
    selectBookmarkForEdit("");
    setShowBookmarkModal(true);
  }

  async function handleBookmarkImagePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setBookmarkError("PNG, JPG, WEBP 이미지만 업로드할 수 있습니다.");
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const dimensions = await loadImageDimensions(dataUrl);
      if (dimensions.width !== 92 || dimensions.height !== 92) {
        setBookmarkError("가로 92px, 세로 92px 정사각형 이미지만 업로드할 수 있습니다.");
        return;
      }
      setBookmarkImageDataUrl(dataUrl);
      setBookmarkError("");
    } catch (error) {
      setBookmarkError(describeUnknownError(error, "이미지를 확인하지 못했습니다."));
    }
  }

  async function handleSaveBookmark() {
    const identity = await resolveCurrentIdentity();
    if (!identity.id) {
      openAuthModal("개인 북마크를 저장하려면 로그인해 주세요.");
      return;
    }
    const normalizedUrl = bookmarkUrlInput.trim();
    if (!normalizedUrl) {
      setBookmarkError("북마크 링크를 입력해 주세요.");
      return;
    }
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      setBookmarkError("링크 주소는 http:// 또는 https:// 로 시작해야 합니다.");
      return;
    }
    setBookmarkSaving(true);
    setBookmarkError("");
    try {
      const savedBookmark = await saveUserBookmark(
        selectedBookmarkId,
        normalizedUrl,
        bookmarkImageDataUrl,
        identity.id,
        identity.email,
        identity.token,
      );
      setBookmarks(savedBookmark.items);
      setBookmarkMaxItems(savedBookmark.max_items || 20);
      setSelectedBookmarkId(savedBookmark.item?.id || selectedBookmarkId);
      setShowBookmarkModal(false);
      setStatusTone("success");
      setStatusMessage(selectedBookmarkId ? "개인 북마크를 수정했습니다." : "개인 북마크를 추가했습니다.");
    } catch (error) {
      const message = describeUnknownError(error, "개인 북마크를 저장하지 못했습니다.");
      setBookmarkError(message);
      setStatusTone("error");
      setStatusMessage(message);
    } finally {
      setBookmarkSaving(false);
    }
  }

  async function handleDeleteBookmark() {
    const identity = await resolveCurrentIdentity();
    if (!identity.id || !selectedBookmarkId) {
      return;
    }
    const confirmed = window.confirm("개인 북마크를 삭제할까요?");
    if (!confirmed) {
      return;
    }
    setBookmarkSaving(true);
    setBookmarkError("");
    try {
      const nextBookmark = await deleteUserBookmark(selectedBookmarkId, identity.id, identity.email, identity.token);
      setBookmarks(nextBookmark.items);
      setBookmarkMaxItems(nextBookmark.max_items || 20);
      const nextSelectedId = nextBookmark.items[0]?.id || "";
      setSelectedBookmarkId(nextSelectedId);
      if (nextSelectedId) {
        const nextSelectedItem = nextBookmark.items[0];
        setBookmarkUrlInput(nextSelectedItem.bookmark_url);
        setBookmarkImageDataUrl(nextSelectedItem.image_data_url || "");
        setShowBookmarkModal(true);
      } else {
        setBookmarkUrlInput("");
        setBookmarkImageDataUrl("");
        setShowBookmarkModal(false);
      }
      setStatusTone("success");
      setStatusMessage("개인 북마크를 삭제했습니다.");
    } catch (error) {
      const message = describeUnknownError(error, "개인 북마크를 삭제하지 못했습니다.");
      setBookmarkError(message);
      setStatusTone("error");
      setStatusMessage(message);
    } finally {
      setBookmarkSaving(false);
    }
  }

  function handleBookmarkBoardPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    const board = bookmarkBoardRef.current;
    if (!board) {
      return;
    }
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") as HTMLAnchorElement | null : null;
    bookmarkBoardDragRef.current = {
      active: true,
      startX: event.clientX,
      startScrollLeft: board.scrollLeft,
      moved: false,
      pendingUrl: anchor?.href || "",
    };
    setBookmarkBoardDragging(true);
    board.setPointerCapture?.(event.pointerId);
  }

  function handleBookmarkBoardPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const board = bookmarkBoardRef.current;
    const drag = bookmarkBoardDragRef.current;
    if (!board || !drag.active) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    if (Math.abs(deltaX) > 6) {
      drag.moved = true;
    }
    board.scrollLeft = drag.startScrollLeft - deltaX;
    if (drag.moved) {
      event.preventDefault();
    }
  }

  function completeBookmarkBoardPointer(event?: ReactPointerEvent<HTMLDivElement>) {
    const board = bookmarkBoardRef.current;
    const drag = bookmarkBoardDragRef.current;
    const shouldOpen = !drag.moved && Boolean(drag.pendingUrl);
    bookmarkBoardDragRef.current.active = false;
    setBookmarkBoardDragging(false);
    if (board && event) {
      board.releasePointerCapture?.(event.pointerId);
    }
    if (shouldOpen) {
      window.open(drag.pendingUrl, "_blank", "noopener,noreferrer");
    }
    bookmarkBoardDragRef.current.moved = false;
    bookmarkBoardDragRef.current.pendingUrl = "";
  }

  function cancelBookmarkBoardPointer(event?: ReactPointerEvent<HTMLDivElement>) {
    const board = bookmarkBoardRef.current;
    bookmarkBoardDragRef.current.active = false;
    bookmarkBoardDragRef.current.moved = false;
    bookmarkBoardDragRef.current.pendingUrl = "";
    setBookmarkBoardDragging(false);
    if (board && event) {
      board.releasePointerCapture?.(event.pointerId);
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
                  window.alert(`DOO Extractor\n\n버전: ${APP_VERSION} WEB Version\n개발자: DOOHEE. JANG\n연락처: gdoomin@gmail.com`)
                }
              >
                ?
              </button>
              <div>
                <h1>DOO Extractor</h1>
                <p>KML to DMS 좌표 변환기</p>
                <div className="doo-version-badge" title="현재 배포 버전">
                  WEB {APP_VERSION}
                </div>
                <button
                  type="button"
                  className="doo-flight-prep-button"
                  onClick={() => window.open("/before-flight", "_blank", "noopener,noreferrer")}
                >
                  비행준비
                </button>
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
                {!isAuthenticated ? (
                  <button
                    type="button"
                    className="doo-auth-button doo-auth-button-login"
                    onClick={handleAuthButton}
                  >
                    회원가입 / 로그인
                  </button>
                ) : null}
              </div>

              {isAuthenticated ? (
                <div className="doo-billing-card">
                  <div className="doo-billing-head">
                    <button type="button" className="doo-billing-status-button" disabled>
                      구독 상태 {billingLoading ? "확인 중..." : (billingStatus?.plan_code || "free").toUpperCase()}
                    </button>
                  </div>

                  {billingStatus?.billing_enabled ? (
                    <>
                      <p className="doo-billing-meta">
                        월 변환: {billingStatus.monthly_kml_used}
                        {billingStatus.monthly_kml_limit > 0 ? ` / ${billingStatus.monthly_kml_limit}` : " / 무제한"}
                      </p>
                      <p className="doo-billing-meta">파일 최대 용량: {billingStatus.file_size_limit_mb}MB</p>
                      {billingStatus.promo_active ? (
                        <p className="doo-billing-help doo-billing-promo-active">
                          프로모션 적용 중: {(billingStatus.promo_plan_code || billingStatus.plan_code || "free").toUpperCase()}
                          {billingStatus.promo_expires_at
                            ? ` · ${new Date(billingStatus.promo_expires_at).toLocaleDateString("ko-KR")}까지`
                            : ""}
                        </p>
                      ) : null}

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
                          <div className="doo-billing-promo-row">
                            <label className="doo-billing-phone">
                              <span>프로모션 코드</span>
                              <input
                                type="text"
                                value={promoCodeInput}
                                onChange={(event) => setPromoCodeInput(event.target.value.toUpperCase())}
                                placeholder="비워두지 말고 코드 입력"
                                autoCapitalize="characters"
                                disabled={billingActionLoading || Boolean(billingStatus.promo_active)}
                              />
                            </label>
                            <button
                              type="button"
                              className="doo-auth-button doo-plan-button-lite"
                              onClick={handleRedeemPromoCode}
                              disabled={billingActionLoading || Boolean(billingStatus.promo_active)}
                            >
                              코드 적용
                            </button>
                          </div>
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

              {isAuthenticated ? (
                <button
                  type="button"
                  className="doo-auth-button doo-auth-button-settings"
                  onClick={() => openBookmarkSettings()}
                >
                  개인 설정
                </button>
              ) : null}

              {isAuthenticated ? (
                <button
                  type="button"
                  className="doo-auth-button doo-auth-button-logout"
                  onClick={handleAuthButton}
                >
                  로그아웃
                </button>
              ) : null}
            </div>
          </aside>

          <section className="doo-main">
            <div className="doo-top-panel">
              <label className="doo-top-label">KML / KMZ / GPX / GEOJSON 파일</label>
              <div className="doo-stack-row">
                {stackItems.length ? (
                  <div className="doo-stack-chips">
                    {stackItems.map((entry, index) => {
                      const chipDisplay = buildLocalizedFileDisplay(entry.response.filename || "");
                      return (
                        <div key={entry.id} className="doo-stack-chip">
                          <span className="doo-stack-chip-index">{index + 1}</span>
                          <span
                            className={`doo-stack-chip-name${chipDisplay.secondary ? " has-secondary" : ""}`}
                            title={entry.response.filename}
                          >
                            <span className="doo-stack-chip-name-primary">
                              {chipDisplay.primary || entry.response.filename}
                            </span>
                            {chipDisplay.secondary ? (
                              <span className="doo-stack-chip-name-secondary">
                                {chipDisplay.secondary}
                              </span>
                            ) : null}
                          </span>
                          <button
                            type="button"
                            className="doo-stack-chip-remove"
                            onClick={() => void removeStackEntry(entry.id)}
                            aria-label={`${entry.response.filename} 제거`}
                            title="스택에서 제거"
                            disabled={isLoading}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="doo-stack-empty">중첩된 파일이 없습니다. 파일 열기 또는 파일 추가를 사용해 주세요.</div>
                )}
              </div>
              <div className="doo-path-row">
                <div className="doo-path-display" aria-live="polite">
                  <span className="doo-path-primary">{fileDisplay.primary || "선택된 파일이 없습니다."}</span>
                </div>
                <button
                  type="button"
                  className={`doo-open-button${isLoading ? " is-loading" : ""}`}
                  onClick={() => openFileDialog("replace")}
                  disabled={isLoading}
                >
                  {isLoading ? "불러오는 중..." : "파일 열기"}
                </button>
                <button
                  type="button"
                  className="doo-open-button doo-open-button-secondary"
                  onClick={() => openFileDialog("append")}
                  disabled={isLoading}
                >
                  파일 추가
                </button>
                <button
                  type="button"
                  className="doo-open-button doo-open-button-clear"
                  onClick={() => void clearStack()}
                  disabled={isLoading || !stackItems.length}
                >
                  스택 비우기
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={fileAccept}
                  className="doo-hidden-input"
                  onChange={handleFilePicked}
                />
              </div>
              <div className="doo-stack-summary">{stackSummary}</div>
            </div>

            <div className="doo-mode-bar">
              <span className={response ? "doo-mode-active" : "doo-mode-idle"}>{modeText}</span>
              {response ? <span className="doo-mode-chip">{modeChipLabel}</span> : null}
            </div>

            {!isAuthenticated && response ? (
              <div className="doo-gate-banner" role="status">
                지금은 결과 미리보기 상태입니다. 로그인하면 업로드 이력이 개인별로 저장되고, 히스토리에서 다시열기를 사용할 수 있습니다.
              </div>
            ) : null}

            {canUseViewerStateSync && homeSyncPendingRemote ? (
              <div className="doo-sync-banner" role="status">
                <span className="doo-sync-banner-text">다른 기기에서 최근 작업 상태가 감지되었습니다.</span>
                <div className="doo-sync-banner-actions">
                  <button type="button" className="doo-sync-banner-apply" onClick={() => void handleApplyPendingHomeSync()}>
                    동기화 적용
                  </button>
                  <button type="button" className="doo-sync-banner-dismiss" onClick={handleDismissPendingHomeSync}>
                    나중에
                  </button>
                </div>
              </div>
            ) : null}

            <div className="doo-result-grid">
              <section className="doo-result-column">
                <div className="doo-panel-head">
                  <div>
                    <div className="doo-panel-title">변환 결과</div>
                    <div className="doo-panel-subtitle">{response ? `${response.result_count}개 결과를 표시 중입니다.` : "파일 업로드를 기다리고 있습니다."}</div>
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
                  {isAuthenticated && canUseHistory ? (
                    <div className="doo-panel-head-actions">
                      <span className="doo-panel-count">{historyItems.length}건</span>
                      <button
                        type="button"
                        className="doo-history-delete-all"
                        onClick={() => void handleHistoryDeleteAll()}
                        disabled={historyLoading || historyDeletingAll || !historyItems.length || Boolean(historyOpeningId) || Boolean(historyAppendingId) || Boolean(historyDeletingId)}
                      >
                        {historyDeletingAll ? "삭제 중..." : "전체삭제"}
                      </button>
                    </div>
                  ) : null}
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
                    {historyRows.map((item) => {
                      const isCurrent = response?.job_id === item.job_id;
                      const isOpening = historyOpeningId === item.job_id;
                      const isAppending = historyAppendingId === item.job_id;
                      const isSharing = historySharingId === item.job_id;
                      const isDeleting = historyDeletingId === item.job_id;
                      return (
                        <article key={item.job_id} className={`doo-history-row${isCurrent ? " is-current" : ""}`}>
                          <div className="doo-history-body">
                            <div className="doo-history-title-row">
                              <strong>{item.filename || item.project_name}</strong>
                              <span className="doo-history-count-inline">
                                {item.mode === "linestring" ? "라인" : "폴리곤"} {item.result_count}개
                              </span>
                            </div>
                            <span className="doo-history-meta">
                              <span className="doo-history-date">{item.savedAtText}</span>
                            </span>
                          </div>
                          <div className="doo-history-actions">
                            <button
                              type="button"
                              className="doo-history-open"
                              onClick={() => handleHistoryOpen(item)}
                              disabled={isOpening || isAppending || isSharing || isDeleting || historyDeletingAll}
                            >
                              {isOpening ? "불러오는 중..." : isCurrent ? "열림" : "다시열기"}
                            </button>
                            <button
                              type="button"
                              className="doo-history-append"
                              onClick={() => void handleHistoryAppend(item)}
                              disabled={isOpening || isAppending || isSharing || isDeleting || historyDeletingAll}
                            >
                              {isAppending ? "추가 중..." : "스택추가"}
                            </button>
                            <button
                              type="button"
                              className="doo-history-share"
                              onClick={() => void handleHistoryShare(item)}
                              disabled={isOpening || isAppending || isSharing || isDeleting || historyDeletingAll}
                            >
                              {isSharing ? "공유 중..." : "공유"}
                            </button>
                            <button
                              type="button"
                              className="doo-history-delete"
                              title="히스토리 삭제"
                              aria-label="히스토리 삭제"
                              onClick={() => handleHistoryDelete(item)}
                              disabled={isOpening || isAppending || isSharing || isDeleting || historyDeletingAll}
                            >
                              {isDeleting ? "..." : "??"}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="doo-history-empty">아직 저장된 업로드 기록이 없습니다. 로그인한 상태에서 파일을 열면 여기에 쌓입니다.</p>
                )}
              </aside>
            </div>

            <div className="doo-bottom-bar">
              <div className={`doo-status doo-status-${statusTone}${showLoadingBadge ? " is-loading-highlight" : ""}`}>
                {showLoadingBadge ? (
                  <span className="doo-status-loading-badge" aria-live="polite">
                    <span className="doo-status-loading-spinner" aria-hidden="true" />
                    불러오는 중
                  </span>
                ) : null}
                <span className="doo-status-text">{statusMessage}</span>
              </div>
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
                <button
                  type="button"
                  className="doo-action doo-action-map"
                  onClick={openViewer}
                  disabled={!canOpenViewer}
                  title={isViewerBusy ? "파일 불러오기 중에는 도식화 보기를 열 수 없습니다." : undefined}
                >
                  {stackItems.length > 1 ? `도식화 보기 (${stackItems.length})` : "도식화 보기"}
                </button>
              </div>
            </div>

            <div className="doo-bottom-ad-wrap">
              {isAuthenticated ? (
                <div
                  ref={bookmarkBoardRef}
                  className={`doo-bookmark-board${bookmarkBoardDragging ? " is-dragging" : ""}`}
                  aria-busy={bookmarkLoading}
                  onPointerDown={handleBookmarkBoardPointerDown}
                  onPointerMove={handleBookmarkBoardPointerMove}
                  onPointerUp={completeBookmarkBoardPointer}
                  onPointerCancel={cancelBookmarkBoardPointer}
                  onPointerLeave={cancelBookmarkBoardPointer}
                >
                  {bookmarks.map((item) => (
                    <a
                      key={item.id}
                      href={item.bookmark_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="doo-bookmark-card"
                      title={item.bookmark_url}
                      onClick={(event) => event.preventDefault()}
                    >
                      <BookmarkVisual
                        bookmark={item}
                        alt="개인 북마크"
                        imageClassName="doo-bookmark-card-image"
                        textClassName="doo-bookmark-card-fallback"
                      />
                      <span className="doo-bookmark-card-host">{describeBookmarkHost(item.bookmark_url)}</span>
                    </a>
                  ))}
                  {bookmarks.length < bookmarkMaxItems ? (
                    <button
                      type="button"
                      className="doo-bookmark-card doo-bookmark-card-add"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={startAddBookmark}
                    >
                      <span className="doo-bookmark-card-plus">+</span>
                    </button>
                  ) : null}
                </div>
              ) : (
                <AdSenseSlot slot={BOTTOM_AD_SLOT} className="doo-ad-unit doo-ad-unit-bottom" minHeight={120} />
              )}
            </div>
          </section>

          <aside className="doo-ad-rail" aria-label="실시간 정보">
            <div className="doo-ad-rail-inner">
              <div className="doo-rail-stack">
                <div className="doo-rail-slot doo-rail-slot-top">
                  <HimawariRailPanel />
                </div>
                <div className="doo-rail-slot doo-rail-slot-bottom">
                  <NotamMiniMap />
                </div>
              </div>
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

      {showBookmarkModal ? (
        <div className="auth-modal-backdrop" onClick={() => setShowBookmarkModal(false)}>
          <section className="auth-modal-card doo-bookmark-modal" onClick={(event) => event.stopPropagation()}>
            <div className="auth-modal-copy">
              <span className="auth-badge">Bookmark</span>
              <h2>개인 설정</h2>
              <p>어떤 컴퓨터에서 로그인하더라도 같은 북마크가 보입니다. 이미지는 92x92 정사각형만 사용할 수 있습니다.</p>
            </div>

            <div className="doo-bookmark-form">
              <div className="doo-bookmark-selector-grid">
                {bookmarks.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`doo-bookmark-selector${selectedBookmarkId === item.id ? " is-active" : ""}`}
                    onClick={() => selectBookmarkForEdit(item.id)}
                    disabled={bookmarkSaving}
                  >
                    <BookmarkVisual
                      bookmark={item}
                      alt="저장된 북마크"
                      imageClassName="doo-bookmark-selector-image"
                      textClassName="doo-bookmark-selector-fallback"
                    />
                    <span className="doo-bookmark-selector-host">{describeBookmarkHost(item.bookmark_url)}</span>
                  </button>
                ))}
                {bookmarks.length < bookmarkMaxItems ? (
                  <button
                    type="button"
                    className={`doo-bookmark-selector doo-bookmark-selector-add${!selectedBookmarkId ? " is-active" : ""}`}
                    onClick={() => selectBookmarkForEdit("")}
                    disabled={bookmarkSaving}
                  >
                    <span className="doo-bookmark-selector-plus">+</span>
                    <span className="doo-bookmark-selector-host">새 북마크</span>
                  </button>
                ) : null}
              </div>

              <label className="doo-billing-phone">
                <span>북마크 링크</span>
                <input
                  type="url"
                  value={bookmarkUrlInput}
                  onChange={(event) => setBookmarkUrlInput(event.target.value)}
                  placeholder="https://example.com"
                  disabled={bookmarkSaving}
                />
              </label>

              <label className="doo-billing-phone">
                <span>북마크 이미지 (선택사항, 92x92)</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => void handleBookmarkImagePicked(event)}
                  disabled={bookmarkSaving}
                />
              </label>

              <div className="doo-bookmark-preview-card">
                {bookmarkImageDataUrl ? (
                  <BookmarkVisual
                    bookmark={{
                      id: selectedBookmarkId || "preview",
                      bookmark_url: bookmarkUrlInput.trim() || "https://example.com",
                      image_data_url: bookmarkImageDataUrl,
                    }}
                    alt="북마크 미리보기"
                    imageClassName="doo-bookmark-preview-image"
                    textClassName="doo-bookmark-preview-empty"
                  />
                ) : (
                  <BookmarkVisual
                    bookmark={{
                      id: selectedBookmarkId || "preview",
                      bookmark_url: bookmarkUrlInput.trim() || "https://example.com",
                      image_data_url: "",
                    }}
                    alt="북마크 미리보기"
                    imageClassName="doo-bookmark-preview-image"
                    textClassName="doo-bookmark-preview-empty"
                  />
                )}
                <div className="doo-bookmark-preview-copy">
                  <strong>{bookmarkUrlInput.trim() ? describeBookmarkHost(bookmarkUrlInput.trim()) : "미리보기"}</strong>
                  <span>{bookmarkUrlInput.trim() || "링크만 입력해도 파비콘을 시도하고, 없으면 사이트명이 표시됩니다."}</span>
                </div>
              </div>

              {bookmarkError ? <p className="auth-message-error doo-bookmark-error">{bookmarkError}</p> : null}
            </div>

            <div className="doo-bookmark-modal-actions">
              {selectedBookmark ? (
                <button
                  type="button"
                  className="auth-modal-close doo-bookmark-delete"
                  onClick={() => void handleDeleteBookmark()}
                  disabled={bookmarkSaving}
                >
                  삭제
                </button>
              ) : null}
              <button
                type="button"
                className="auth-modal-close doo-bookmark-save"
                onClick={() => void handleSaveBookmark()}
                disabled={bookmarkSaving}
              >
                {bookmarkSaving ? "저장 중..." : "저장"}
              </button>
              <button type="button" className="auth-modal-close" onClick={() => setShowBookmarkModal(false)} disabled={bookmarkSaving}>
                닫기
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showPlanGuide ? (
        <div className="auth-modal-backdrop doo-pricing-backdrop" onClick={() => setShowPlanGuide(false)}>
          <section className="doo-pricing-modal" onClick={(event) => event.stopPropagation()}>
            <div className="doo-pricing-header">
              <div className="doo-pricing-tag">PLAN GUIDE</div>
              <h2>DOO Extractor 요금제</h2>
              <p>기존 가입자 혜택 계정은 기존 기능을 유지하며, 새 이메일로 가입하면 신규 정책이 적용됩니다. legacy유저 : 히스토리 보관 기한 90일</p>
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
                      <li>히스토리 무기한 / 사실상 무제한 (구독종료시 15일뒤 히스토리 삭제)</li>
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

