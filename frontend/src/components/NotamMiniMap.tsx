"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayerGroup, LeafletMouseEvent, Map as LeafletMap } from "leaflet";

import { API_BASE_URL } from "@/lib/convert";

type LeafletModule = typeof import("leaflet");

type NotamApiItem = {
  id?: string | number | null;
  notam_id?: string;
  series?: string;
  lat?: number;
  lng?: number;
  start_date?: string;
  end_date?: string;
  airport?: string;
  content?: string;
};

type NotamApiResponse = {
  items?: NotamApiItem[];
  detail?: string;
};

type LayerFeature = {
  type?: string;
  name?: string;
  points?: unknown;
};

type LayerPayload = {
  layers?: Array<{
    key?: string;
    features?: LayerFeature[];
  }>;
};

type NotamGroupKey = "de" | "acgz";
type NotamFilter = "ALL" | NotamGroupKey;
type NotamMiniMapMode = "rail" | "beforeFlight";
type NotamSeriesFilterValue = "ALL" | "A" | "C" | "D" | "E" | "G" | "Z" | "SNOWTAM";

type NotamMiniMapProps = {
  mode?: NotamMiniMapMode;
};

type PlanningPointKey = "departure" | "mission" | "arrival";

type PlanningPoint = {
  key: PlanningPointKey;
  label: string;
  latitude: number;
  longitude: number;
  altitudeFt: number;
};

type CoordPoint = {
  latitude: number;
  longitude: number;
};

type RestrictFeature = {
  code: string;
  name: string;
  featureType: "polygon" | "line";
  coords: CoordPoint[];
};

type ParsedNotamItem = {
  raw: NotamApiItem;
  content: string;
  notamId: string;
  series: string;
  groupKey: NotamGroupKey;
  areaLabel: string;
  altitudeLabel: string;
  validityLabel: string;
  lat: number;
  lng: number;
  radiusMeters: number | null;
  qCircleLat: number | null;
  qCircleLng: number | null;
  qCircleRadiusMeters: number | null;
  restrictedAreaFeatures: RestrictFeature[];
  polygonCoords: CoordPoint[] | null;
  polylineCoords: CoordPoint[] | null;
  corridorCenterlineCoords: CoordPoint[] | null;
  corridorPolygonCoords: CoordPoint[] | null;
};

const INITIAL_CENTER: [number, number] = [36.5, 127.8];
const INITIAL_ZOOM = 6;
const NOTAM_LIMIT = 1200;
const FILTER_OPTIONS: Array<{ value: NotamFilter; label: string }> = [
  { value: "ALL", label: "전체" },
  { value: "de", label: "NOTAM D,E" },
  { value: "acgz", label: "NOTAM A,C,G,Z" },
];
const BEFORE_FLIGHT_SERIES_OPTIONS: Array<{ value: NotamSeriesFilterValue; label: string }> = [
  { value: "ALL", label: "전체" },
  { value: "A", label: "A" },
  { value: "C", label: "C" },
  { value: "D", label: "D" },
  { value: "E", label: "E" },
  { value: "G", label: "G" },
  { value: "Z", label: "Z" },
  { value: "SNOWTAM", label: "SNOWTAM" },
];
const NOTAM_SERIES_DE = new Set(["D", "E"]);
const NOTAM_SERIES_ACGZ = new Set(["A", "C", "G", "Z"]);
const NOTAM_SERIES_SNOWTAM = new Set(["S"]);
const NOTAM_GROUP_COLORS: Record<NotamGroupKey, string> = {
  de: "#ff7e67",
  acgz: "#4bc6ff",
};
const Q_CIRCLE_COLOR = "#000080";
const NOTAM_CIRCLE_MAX_NM = 60;
const NOTAM_CIRCLE_MAX_METERS = NOTAM_CIRCLE_MAX_NM * 1852;
const PLANNING_REGION_BUFFER_METERS = 10 * 1852;
const PLANNING_ALTITUDE_BUFFER_FT = 2000;
const BEFORE_FLIGHT_LABEL_MAX_COUNT = 24;

const PLANNING_POINT_LABELS: Record<PlanningPointKey, string> = {
  departure: "출발지",
  mission: "임무지역",
  arrival: "도착지",
};

function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function collapseWhitespace(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sanitizeNotamContent(raw: string) {
  if (!raw) {
    return "";
  }
  return String(raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/h\d>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractNotamSectionValue(content: string, section: string) {
  const text = sanitizeNotamContent(content);
  const tokenRe = /\b([A-Z])\)\s*/gi;
  const marks: Array<{ sec: string; idx: number; end: number }> = [];
  let match: RegExpExecArray | null = null;
  while ((match = tokenRe.exec(text)) !== null) {
    marks.push({ sec: String(match[1] || "").toUpperCase(), idx: match.index, end: tokenRe.lastIndex });
  }
  const upperSection = String(section || "").trim().toUpperCase();
  const startMark = marks.find((mark) => mark.sec === upperSection);
  if (!startMark) {
    return "";
  }
  const nextMark = marks.find((mark) => mark.idx > startMark.idx);
  return text.slice(startMark.end, nextMark ? nextMark.idx : text.length).trim();
}

function extractNotamESection(content: string) {
  return extractNotamSectionValue(content, "E");
}

function parseAngleToken(token: string, isLat: boolean) {
  const raw = String(token || "").trim().toUpperCase();
  const hemi = raw.slice(-1);
  const numeric = raw.slice(0, -1);
  if (!numeric || !/[NSEW]/.test(hemi)) {
    return null;
  }
  const segments = numeric.split(".");
  const intPart = String(segments[0] || "");
  const fracPart = String(segments[1] || "");
  const digits = intPart.replace(/\D/g, "");
  let deg = 0;
  let min = 0;
  let sec = 0;
  if (isLat) {
    if (digits.length <= 4) {
      deg = Number(digits.slice(0, 2));
      min = Number(`${digits.slice(2)}${fracPart ? `.${fracPart}` : ""}`);
    } else {
      deg = Number(digits.slice(0, 2));
      min = Number(digits.slice(2, 4));
      sec = Number(`${digits.slice(4)}${fracPart ? `.${fracPart}` : ""}`);
    }
  } else if (digits.length <= 5) {
    deg = Number(digits.slice(0, 3));
    min = Number(`${digits.slice(3)}${fracPart ? `.${fracPart}` : ""}`);
  } else {
    deg = Number(digits.slice(0, 3));
    min = Number(digits.slice(3, 5));
    sec = Number(`${digits.slice(5)}${fracPart ? `.${fracPart}` : ""}`);
  }
  const value = deg + min / 60 + sec / 3600;
  return Number.isFinite(value) ? (hemi === "S" || hemi === "W" ? -value : value) : null;
}

function parseCoordPair(latToken: string, lonToken: string) {
  const lat = parseAngleToken(latToken, true);
  const lon = parseAngleToken(lonToken, false);
  if (typeof lat !== "number" || typeof lon !== "number") {
    return null;
  }
  return { latitude: lat, longitude: lon };
}

function extractNotamCoordPairsFromText(text: string) {
  const compact = String(text || "").replace(/[–—−]/g, "-").replace(/\s+/g, "");
  const out: CoordPoint[] = [];
  const pairRe = /(\d{4,6}(?:\.\d+)?[NS])[\s,/-]*(\d{5,7}(?:\.\d+)?[EW])/gi;
  let match: RegExpExecArray | null = null;
  while ((match = pairRe.exec(compact)) !== null) {
    const parsed = parseCoordPair(match[1], match[2]);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}
function removeClosingPointIfNeeded(points: CoordPoint[]) {
  if (!Array.isArray(points) || points.length < 2) {
    return Array.isArray(points) ? points.slice() : [];
  }
  const out = points.slice();
  const first = out[0];
  const last = out[out.length - 1];
  if (
    first &&
    last &&
    Math.abs(first.latitude - last.latitude) < 0.0000001 &&
    Math.abs(first.longitude - last.longitude) < 0.0000001
  ) {
    out.pop();
  }
  return out;
}

function isClosedCoordPath(points: CoordPoint[]) {
  if (!Array.isArray(points) || points.length < 4) {
    return false;
  }
  const first = points[0];
  const last = points[points.length - 1];
  return !!first && !!last && first.latitude === last.latitude && first.longitude === last.longitude;
}

function extractNotamCorridorHalfWidthNm(content: string) {
  const eSection = extractNotamESection(content);
  const normalized = String(eSection || "").replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim();
  const halfWidthPatterns = [
    /(\d+(?:\.\d+)?)\s*NM\s*(?:ON\s+)?(?:EITHER|EACH)\s+SIDE(?:\s+OF\s+(?:THE\s+)?)?(?:LINE|CENTER\s*LINE)?/i,
    /(?:ON\s+)?(?:EITHER|EACH)\s+SIDE(?:\s+OF\s+(?:THE\s+)?)?(?:LINE|CENTER\s*LINE)?\s*(\d+(?:\.\d+)?)\s*NM/i,
    /HALF[-\s]?WIDTH\s*(\d+(?:\.\d+)?)\s*NM/i,
  ];
  for (const pattern of halfWidthPatterns) {
    const match = normalized.match(pattern);
    const value = match ? Number(match[1]) : NaN;
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  const fullWidthPatterns = [/(\d+(?:\.\d+)?)\s*NM\s*WIDE/i, /WIDTH\s*(\d+(?:\.\d+)?)\s*NM/i];
  for (const pattern of fullWidthPatterns) {
    const match = normalized.match(pattern);
    const value = match ? Number(match[1]) : NaN;
    if (Number.isFinite(value) && value > 0) {
      return value / 2;
    }
  }
  return null;
}

function extractNotamCorridorCenterline(content: string) {
  const eSection = extractNotamESection(content);
  const normalized = String(eSection || "").replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim();
  const lineMatch = normalized.match(/\b(?:CENTER\s*)?LINE\b([\s\S]*)$/i);
  const primaryPoints = removeClosingPointIfNeeded(extractNotamCoordPairsFromText(lineMatch?.[1] ? lineMatch[1] : normalized));
  if (primaryPoints.length >= 2) {
    return primaryPoints;
  }
  const fallbackPoints = removeClosingPointIfNeeded(extractNotamCoordPairsFromText(normalized));
  return fallbackPoints.length >= 2 ? fallbackPoints : null;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function bearingDeg(a: CoordPoint, b: CoordPoint) {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return 0;
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function offsetCoordByMeters(base: CoordPoint, headingDeg: number, meters: number) {
  const radius = 6378137;
  const bearing = toRadians(headingDeg);
  const lat1 = toRadians(base.latitude);
  const lon1 = toRadians(base.longitude);
  const distance = meters / radius;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distance) + Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing),
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1),
    Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2),
  );
  return { latitude: (lat2 * 180) / Math.PI, longitude: (lon2 * 180) / Math.PI };
}

function blendBearing(a: number, b: number) {
  const ar = toRadians(a);
  const br = toRadians(b);
  const x = Math.cos(ar) + Math.cos(br);
  const y = Math.sin(ar) + Math.sin(br);
  if (Math.abs(x) < 0.000001 && Math.abs(y) < 0.000001) {
    return a;
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function buildNotamCorridorPolygon(centerline: CoordPoint[], halfWidthMeters: number) {
  if (!Array.isArray(centerline) || centerline.length < 2 || !Number.isFinite(halfWidthMeters) || halfWidthMeters <= 0) {
    return null;
  }
  const left: CoordPoint[] = [];
  const right: CoordPoint[] = [];
  for (let index = 0; index < centerline.length; index += 1) {
    const curr = centerline[index];
    const prev = centerline[Math.max(0, index - 1)];
    const next = centerline[Math.min(centerline.length - 1, index + 1)];
    const prevBearing = bearingDeg(prev, curr);
    const nextBearing = bearingDeg(curr, next);
    const bearing = index === 0 ? nextBearing : index === centerline.length - 1 ? prevBearing : blendBearing(prevBearing, nextBearing);
    left.push(offsetCoordByMeters(curr, bearing - 90, halfWidthMeters));
    right.push(offsetCoordByMeters(curr, bearing + 90, halfWidthMeters));
  }
  const polygon = left.concat(right.reverse());
  return polygon.length >= 4 ? polygon : null;
}

function extractNotamPolygon(content: string) {
  const points = extractNotamCoordPairsFromText(extractNotamESection(content));
  if (!isClosedCoordPath(points)) {
    return null;
  }
  const polygonPoints = removeClosingPointIfNeeded(points);
  return polygonPoints.length >= 3 ? polygonPoints : null;
}

function extractNotamOpenPolyline(content: string) {
  const points = extractNotamCoordPairsFromText(extractNotamESection(content));
  if (isClosedCoordPath(points)) {
    return null;
  }
  const polylinePoints = removeClosingPointIfNeeded(points);
  return polylinePoints.length >= 2 ? polylinePoints : null;
}

function centroid(coords: CoordPoint[]) {
  if (!Array.isArray(coords) || !coords.length) {
    return null;
  }
  const sum = coords.reduce(
    (acc, point) => ({ latitude: acc.latitude + point.latitude, longitude: acc.longitude + point.longitude }),
    { latitude: 0, longitude: 0 },
  );
  return { latitude: sum.latitude / coords.length, longitude: sum.longitude / coords.length };
}

function normalizeNotamRestrictedAreaCode(value: string) {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = compact.match(/^RKR(\d{1,4}[A-Z]?)$/);
  return match ? `RKR${match[1]}` : "";
}

function extractNotamRestrictedAreaCodes(content: string) {
  const eSection = extractNotamESection(content);
  if (!eSection || !/\bRESTRICT(?:ED)?\s+AREA\b/i.test(eSection)) {
    return [];
  }
  const out = new Set<string>();
  (eSection.match(/\bRK\s*R\s*\d{1,4}[A-Z]?\b/gi) || []).forEach((token) => {
    const code = normalizeNotamRestrictedAreaCode(token);
    if (code) {
      out.add(code);
    }
  });
  if (!out.size && /\bRK\b/i.test(eSection)) {
    (eSection.match(/\bR\s*\d{1,4}[A-Z]?\b/gi) || []).forEach((token) => {
      const code = normalizeNotamRestrictedAreaCode(`RK ${token}`);
      if (code) {
        out.add(code);
      }
    });
  }
  return Array.from(out);
}
function mapLayerPointsToNotamCoords(points: unknown): CoordPoint[] {
  if (!Array.isArray(points)) {
    return [];
  }
  return points
    .map((point) => {
      if (!Array.isArray(point) || point.length < 2) {
        return null;
      }
      const lat = Number(point[0]);
      const lng = Number(point[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }
      return { latitude: lat, longitude: lng };
    })
    .filter((point): point is CoordPoint => !!point);
}

function buildRestrictLookup(payload: LayerPayload | null | undefined) {
  const lookup = new Map<string, RestrictFeature[]>();
  const layer = payload?.layers?.find((entry) => String(entry?.key || "").toLowerCase() === "restrict");
  (layer?.features || []).forEach((feature) => {
    const featureName = String(feature?.name || "").trim();
    const code = normalizeNotamRestrictedAreaCode(featureName);
    if (!code) {
      return;
    }
    const featureType = String(feature?.type || "").toLowerCase() === "line" ? "line" : "polygon";
    const coords = mapLayerPointsToNotamCoords(feature?.points);
    if ((featureType === "polygon" && coords.length < 3) || (featureType === "line" && coords.length < 2)) {
      return;
    }
    const existing = lookup.get(code) || [];
    existing.push({ code, name: featureName, featureType, coords });
    lookup.set(code, existing);
  });
  return lookup;
}

function resolveNotamRestrictedAreaFeatures(content: string, lookup: Map<string, RestrictFeature[]>) {
  const codes = extractNotamRestrictedAreaCodes(content);
  const matched: RestrictFeature[] = [];
  codes.forEach((code) => {
    const features = lookup.get(code) || [];
    features.forEach((feature) => matched.push(feature));
  });
  return matched;
}

function extractNotamQRadiusNm(content: string) {
  const qSection = extractNotamSectionValue(content, "Q");
  const match = qSection.match(/\b(\d{3})\b(?!.*\b\d{3}\b)/);
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(value) || value <= 0 || value >= 999 || value >= 60) {
    return null;
  }
  return value;
}

function extractNotamRadiusNm(content: string) {
  const qRadius = extractNotamQRadiusNm(content);
  if (Number.isFinite(qRadius ?? NaN) && (qRadius ?? 0) > 0) {
    return qRadius;
  }
  const eSection = extractNotamESection(content);
  const match = eSection.match(/\bRADIUS\s*(\d+(?:\.\d+)?)\s*NM\b/i);
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(value) || value <= 0 || value >= 60) {
    return null;
  }
  return value;
}

function extractNotamQCenterCoord(content: string) {
  const qSection = extractNotamSectionValue(content, "Q");
  const match = qSection.match(/(\d{4,6}(?:\.\d+)?[NS])\s*(\d{5,7}(?:\.\d+)?[EW])/i);
  if (!match) {
    return null;
  }
  return parseCoordPair(match[1], match[2]);
}

function extractAirportCode(value: string) {
  const match = String(value || "").match(/\bRK[A-Z]{2}\b/i);
  return match ? match[0].toUpperCase() : "";
}

function normalizeNotamSeries(seriesValue: string | undefined | null, notamIdValue = "") {
  const raw = String(seriesValue || "")
    .trim()
    .toUpperCase();
  if (raw) {
    return raw.charAt(0);
  }
  const fallback = String(notamIdValue || "")
    .trim()
    .toUpperCase();
  return fallback ? fallback.charAt(0) : "";
}

function resolveNotamGroupKey(seriesValue: string | undefined | null, notamIdValue = ""): NotamGroupKey | "" {
  const series = normalizeNotamSeries(seriesValue, notamIdValue);
  if (NOTAM_SERIES_DE.has(series)) {
    return "de";
  }
  if (NOTAM_SERIES_ACGZ.has(series)) {
    return "acgz";
  }
  if (NOTAM_SERIES_SNOWTAM.has(series)) {
    return "acgz";
  }
  return "";
}

function getNotamSeriesLabel(notamIdValue: string, seriesValue = "") {
  const normalized = normalizeNotamSeries(seriesValue, notamIdValue);
  return normalized || "N";
}

function resolveSeriesFilterToken(item: ParsedNotamItem): NotamSeriesFilterValue {
  const label = getNotamSeriesLabel(item.notamId, item.series);
  if (label === "S" || /\bSNOWTAM\b/i.test(item.notamId) || /\bSNOWTAM\b/i.test(item.content)) {
    return "SNOWTAM";
  }
  if (label === "A" || label === "C" || label === "D" || label === "E" || label === "G" || label === "Z") {
    return label;
  }
  return "ALL";
}

function parseNotamDateMs(value: string | undefined | null) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const normalized = raw.replace(/\./g, "-").replace(/\//g, "-").replace(/\s+/g, " ").trim();
  const retried = Date.parse(normalized);
  if (Number.isFinite(retried)) {
    return retried;
  }
  return null;
}

function haversineMeters(a: CoordPoint, b: CoordPoint) {
  const r = 6371000;
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return r * c;
}

function pointInPolygon(point: CoordPoint, polygon: CoordPoint[]) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return false;
  }
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].longitude;
    const yi = polygon[i].latitude;
    const xj = polygon[j].longitude;
    const yj = polygon[j].latitude;
    const intersects =
      yi > point.latitude !== yj > point.latitude &&
      point.longitude < ((xj - xi) * (point.latitude - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function distancePointToSegmentMeters(point: CoordPoint, a: CoordPoint, b: CoordPoint) {
  const latScale = 111320;
  const lonScale = Math.cos(toRadians((a.latitude + b.latitude + point.latitude) / 3)) * 111320;
  const px = point.longitude * lonScale;
  const py = point.latitude * latScale;
  const ax = a.longitude * lonScale;
  const ay = a.latitude * latScale;
  const bx = b.longitude * lonScale;
  const by = b.latitude * latScale;
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;
  if (lengthSq <= Number.EPSILON) {
    const dx = px - ax;
    const dy = py - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lengthSq));
  const projX = ax + t * abx;
  const projY = ay + t * aby;
  const dx = px - projX;
  const dy = py - projY;
  return Math.sqrt(dx * dx + dy * dy);
}

function distanceToPolylineMeters(point: CoordPoint, polyline: CoordPoint[]) {
  if (!Array.isArray(polyline) || polyline.length < 2) {
    return Number.POSITIVE_INFINITY;
  }
  let minDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polyline.length - 1; index += 1) {
    const distance = distancePointToSegmentMeters(point, polyline[index], polyline[index + 1]);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }
  return minDistance;
}

function distanceToPolygonMeters(point: CoordPoint, polygon: CoordPoint[]) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return Number.POSITIVE_INFINITY;
  }
  if (pointInPolygon(point, polygon)) {
    return 0;
  }
  const closed = polygon.concat([polygon[0]]);
  return distanceToPolylineMeters(point, closed);
}

function parseAltitudeRangeFeet(item: ParsedNotamItem) {
  const match = String(item.altitudeLabel || "").match(/(\d{3})\s*-\s*(\d{3})/);
  if (!match) {
    return null;
  }
  const lowFt = Number(match[1]) * 100;
  const highFt = Number(match[2]) * 100;
  if (!Number.isFinite(lowFt) || !Number.isFinite(highFt)) {
    return null;
  }
  return {
    lowFt: Math.min(lowFt, highFt),
    highFt: Math.max(lowFt, highFt),
  };
}

function resolveItemDistanceMeters(item: ParsedNotamItem, target: CoordPoint) {
  const candidates: number[] = [];
  if (Array.isArray(item.restrictedAreaFeatures) && item.restrictedAreaFeatures.length) {
    item.restrictedAreaFeatures.forEach((feature) => {
      if (feature.featureType === "polygon") {
        candidates.push(distanceToPolygonMeters(target, feature.coords));
      } else if (feature.featureType === "line") {
        candidates.push(distanceToPolylineMeters(target, feature.coords));
      }
    });
  }
  if (Array.isArray(item.corridorPolygonCoords) && item.corridorPolygonCoords.length >= 3) {
    candidates.push(distanceToPolygonMeters(target, item.corridorPolygonCoords));
  }
  if (Array.isArray(item.polygonCoords) && item.polygonCoords.length >= 3) {
    candidates.push(distanceToPolygonMeters(target, item.polygonCoords));
  }
  if (Array.isArray(item.polylineCoords) && item.polylineCoords.length >= 2) {
    candidates.push(distanceToPolylineMeters(target, item.polylineCoords));
  }
  if (
    Number.isFinite(item.qCircleLat ?? NaN) &&
    Number.isFinite(item.qCircleLng ?? NaN) &&
    Number.isFinite(item.qCircleRadiusMeters ?? NaN) &&
    (item.qCircleRadiusMeters ?? 0) > 0
  ) {
    const center = { latitude: item.qCircleLat as number, longitude: item.qCircleLng as number };
    const distanceFromCenter = haversineMeters(target, center);
    candidates.push(Math.max(0, distanceFromCenter - (item.qCircleRadiusMeters as number)));
  }
  if (Number.isFinite(item.lat) && Number.isFinite(item.lng)) {
    candidates.push(haversineMeters(target, { latitude: item.lat, longitude: item.lng }));
  }
  return candidates.length ? Math.min(...candidates) : Number.POSITIVE_INFINITY;
}

function resolvePlanningAnchor(item: ParsedNotamItem): CoordPoint {
  const polygonCenter =
    centroid(item.corridorPolygonCoords || []) ||
    centroid(item.polygonCoords || []) ||
    centroid(item.restrictedAreaFeatures.flatMap((feature) => feature.coords)) ||
    null;
  if (polygonCenter) {
    return polygonCenter;
  }
  if (Number.isFinite(item.qCircleLat ?? NaN) && Number.isFinite(item.qCircleLng ?? NaN)) {
    return { latitude: item.qCircleLat as number, longitude: item.qCircleLng as number };
  }
  return { latitude: item.lat, longitude: item.lng };
}

function matchesPlanningPoint(item: ParsedNotamItem, planningPoint: PlanningPoint) {
  const altitudeRange = parseAltitudeRangeFeet(item);
  if (altitudeRange) {
    const low = planningPoint.altitudeFt - PLANNING_ALTITUDE_BUFFER_FT;
    const high = planningPoint.altitudeFt + PLANNING_ALTITUDE_BUFFER_FT;
    const overlaps = altitudeRange.highFt >= low && altitudeRange.lowFt <= high;
    if (!overlaps) {
      return false;
    }
  }
  const distanceMeters = resolveItemDistanceMeters(item, planningPoint);
  return Number.isFinite(distanceMeters) && distanceMeters <= PLANNING_REGION_BUFFER_METERS;
}

function isNotamQrpca(content: string) {
  return /\bQRPCA\b/i.test(String(content || ""));
}

function getNotamCoordKey(latitude: number, longitude: number) {
  return `${Number(latitude).toFixed(6)}|${Number(longitude).toFixed(6)}`;
}

function notamCoordsKey(coords: CoordPoint[]) {
  return coords.map((point) => `${point.latitude.toFixed(6)}:${point.longitude.toFixed(6)}`).join("|");
}

function resolveAreaLabel(raw: NotamApiItem, content: string) {
  const airport = collapseWhitespace(String(raw.airport || ""));
  if (airport) {
    return airport;
  }
  const restrictedCodes = extractNotamRestrictedAreaCodes(content);
  if (restrictedCodes.length) {
    return restrictedCodes.join(", ");
  }
  const airportCode = extractAirportCode(content);
  if (airportCode) {
    return airportCode;
  }
  return "구역 정보 없음";
}

function resolveAltitudeLabel(content: string) {
  const qSection = extractNotamSectionValue(content, "Q");
  const match = qSection.match(/\/(\d{3})\/(\d{3})\//);
  if (match) {
    return `${match[1]}-${match[2]}`;
  }
  return "고도 정보 없음";
}

function resolveValidityLabel(raw: NotamApiItem) {
  const start = collapseWhitespace(String(raw.start_date || ""));
  const end = collapseWhitespace(String(raw.end_date || ""));
  if (start && end) {
    return `${start} ~ ${end}`;
  }
  if (start) {
    return `${start} ~`;
  }
  if (end) {
    return `~ ${end}`;
  }
  return "유효기간 정보 없음";
}

function buildParsedNotamItem(raw: NotamApiItem, restrictLookup: Map<string, RestrictFeature[]>) {
  const content = sanitizeNotamContent(String(raw.content || ""));
  const restrictedAreaFeatures = resolveNotamRestrictedAreaFeatures(content, restrictLookup);
  const corridorHalfWidthNm = extractNotamCorridorHalfWidthNm(content);
  const corridorCenterlineCoords = corridorHalfWidthNm != null ? extractNotamCorridorCenterline(content) : null;
  const corridorPolygonCoords =
    corridorCenterlineCoords && corridorHalfWidthNm
      ? buildNotamCorridorPolygon(corridorCenterlineCoords, corridorHalfWidthNm * 1852)
      : null;
  const polygonCoords = corridorPolygonCoords ? null : extractNotamPolygon(content);
  const polylineCoords = corridorPolygonCoords || polygonCoords ? null : extractNotamOpenPolyline(content);
  const qCenter = extractNotamQCenterCoord(content);
  const qRadiusNm = extractNotamQRadiusNm(content);
  const radiusNm = extractNotamRadiusNm(content);
  const derivedCenter =
    qCenter ||
    centroid(polygonCoords || []) ||
    centroid(corridorPolygonCoords || []) ||
    centroid(polylineCoords || []) ||
    restrictedAreaFeatures.flatMap((feature) => feature.coords)[0] ||
    null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  const fallbackLat = derivedCenter?.latitude ?? INITIAL_CENTER[0];
  const fallbackLng = derivedCenter?.longitude ?? INITIAL_CENTER[1];
  const notamId = collapseWhitespace(String(raw.notam_id || raw.id || "NOTAM"));
  const series = normalizeNotamSeries(raw.series, notamId);
  const groupKey = resolveNotamGroupKey(series, notamId);
  if (!groupKey) {
    return null;
  }
  let qCircleLat = qCenter?.latitude ?? null;
  let qCircleLng = qCenter?.longitude ?? null;
  let qCircleRadiusMeters = qRadiusNm ? qRadiusNm * 1852 : null;
  let radiusMeters = radiusNm ? radiusNm * 1852 : null;
  if (
    (qCircleLat == null || qCircleLng == null || !Number.isFinite(qCircleRadiusMeters ?? NaN) || (qCircleRadiusMeters ?? 0) <= 0) &&
    Number.isFinite(radiusMeters ?? NaN) &&
    (radiusMeters ?? 0) > 0
  ) {
    qCircleLat = Number.isFinite(lat) ? lat : fallbackLat;
    qCircleLng = Number.isFinite(lng) ? lng : fallbackLng;
    qCircleRadiusMeters = radiusMeters;
  }
  if (restrictedAreaFeatures.length > 0) {
    radiusMeters = null;
    qCircleLat = null;
    qCircleLng = null;
    qCircleRadiusMeters = null;
  }
  return {
    raw,
    content,
    notamId,
    series,
    groupKey,
    areaLabel: resolveAreaLabel(raw, content),
    altitudeLabel: resolveAltitudeLabel(content),
    validityLabel: resolveValidityLabel(raw),
    lat: Number.isFinite(lat) ? lat : fallbackLat,
    lng: Number.isFinite(lng) ? lng : fallbackLng,
    radiusMeters,
    qCircleLat,
    qCircleLng,
    qCircleRadiusMeters,
    restrictedAreaFeatures,
    polygonCoords,
    polylineCoords,
    corridorCenterlineCoords,
    corridorPolygonCoords,
  };
}

function buildPopupHtml(item: ParsedNotamItem) {
  return `
    <div class="doo-notam-popup">
      <div class="doo-notam-popup-title">${escapeHtml(item.notamId)}</div>
      <div class="doo-notam-popup-row"><strong>구역</strong><span>${escapeHtml(item.areaLabel)}</span></div>
      <div class="doo-notam-popup-row"><strong>고도</strong><span>${escapeHtml(item.altitudeLabel)}</span></div>
      <div class="doo-notam-popup-row"><strong>유효</strong><span>${escapeHtml(item.validityLabel)}</span></div>
      <div class="doo-notam-popup-content">${escapeHtml(item.content || "내용 없음").replace(/\n/g, "<br />")}</div>
    </div>
  `;
}

function notamPathStyle(groupKey: NotamGroupKey, geometryType = "polygon") {
  const color = NOTAM_GROUP_COLORS[groupKey] || NOTAM_GROUP_COLORS.acgz;
  const isCenterline = geometryType === "corridor-centerline";
  const isLine = isCenterline || geometryType === "polyline";
  const fillOpacity = geometryType === "corridor-polygon" ? 0.1 : 0.12;
  const strokeWeight = isCenterline ? 2.5 : isLine ? 1.8 : 1.5;
  return {
    color,
    weight: strokeWeight,
    opacity: 0.95,
    fillColor: color,
    fillOpacity: isLine ? 0 : fillOpacity,
    lineCap: "round" as const,
    lineJoin: "round" as const,
    dashArray: isCenterline ? "8 6" : undefined,
  };
}

function notamQCircleStyle() {
  return {
    color: Q_CIRCLE_COLOR,
    weight: 1.7,
    opacity: 0.96,
    fillColor: Q_CIRCLE_COLOR,
    fillOpacity: 0.14,
    lineCap: "round" as const,
    lineJoin: "round" as const,
  };
}

function notamLabelIcon(leaflet: LeafletModule, text: string, kind: "single" | "cluster" | "qrpca" = "single") {
  const safeText = escapeHtml(String(text || "").trim() || "N");
  const kindClass = kind === "qrpca" ? " qrpca" : kind === "cluster" ? " cluster" : "";
  return leaflet.divIcon({
    className: "",
    html: `<div class="doo-notam-label-chip${kindClass}">${safeText}</div>`,
    iconSize: [0, 0],
  });
}

function buildBoundsQuery(map: LeafletMap | null) {
  if (!map) {
    return "";
  }
  try {
    const bounds = map.getBounds().pad(0.22);
    return `${bounds.getSouth().toFixed(4)},${bounds.getWest().toFixed(4)},${bounds.getNorth().toFixed(4)},${bounds
      .getEast()
      .toFixed(4)}`;
  } catch {
    return "";
  }
}

function buildGroupPopupHtml(items: ParsedNotamItem[]) {
  if (!Array.isArray(items) || items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return buildPopupHtml(items[0]);
  }
  const lines = items
    .slice(0, 14)
    .map(
      (item) =>
        `<div class="doo-notam-popup-row"><strong>${escapeHtml(item.notamId)}</strong><span>${escapeHtml(item.areaLabel)}</span></div>`,
    )
    .join("");
  return `
    <div class="doo-notam-popup">
      <div class="doo-notam-popup-title">NOTAM ${items.length}건</div>
      ${lines}
      <div class="doo-notam-popup-content">${escapeHtml("상세 내용은 Viewer의 NOTAM에서 확인하세요.")}</div>
    </div>
  `;
}

async function fetchNotamItems(map: LeafletMap | null, signal?: AbortSignal) {
  const bbox = buildBoundsQuery(map);
  const query = bbox ? `?bbox=${encodeURIComponent(bbox)}&limit=${NOTAM_LIMIT}` : `?limit=${NOTAM_LIMIT}`;
  const response = await fetch(`${API_BASE_URL}/api/notam${query}`, { cache: "no-store", signal });
  const payload = (await response.json().catch(() => null)) as NotamApiResponse | null;
  if (!response.ok) {
    throw new Error(payload?.detail || "NOTAM 정보를 불러오지 못했습니다.");
  }
  return Array.isArray(payload?.items) ? payload.items : [];
}

async function fetchRestrictLookup(signal?: AbortSignal) {
  const response = await fetch(`${API_BASE_URL}/api/viewer-default/layers.json`, { cache: "no-store", signal });
  const payload = (await response.json().catch(() => null)) as LayerPayload | null;
  if (!response.ok) {
    throw new Error("공역 레이어를 불러오지 못했습니다.");
  }
  return buildRestrictLookup(payload);
}
export function NotamMiniMap({ mode = "rail" }: NotamMiniMapProps) {
  const isBeforeFlightMode = mode === "beforeFlight";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerGroupRef = useRef<LayerGroup | null>(null);
  const leafletRef = useRef<LeafletModule | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [activeFilter, setActiveFilter] = useState<NotamFilter>("ALL");
  const [seriesFilter, setSeriesFilter] = useState<NotamSeriesFilterValue>("ALL");
  const [effectiveStartDate, setEffectiveStartDate] = useState("");
  const [effectiveEndDate, setEffectiveEndDate] = useState("");
  const [items, setItems] = useState<ParsedNotamItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [selectingPointKey, setSelectingPointKey] = useState<PlanningPointKey | null>(null);
  const [planningPoints, setPlanningPoints] = useState<Partial<Record<PlanningPointKey, PlanningPoint>>>({});
  const [planningConfirmed, setPlanningConfirmed] = useState(false);

  const filteredItems = useMemo(() => {
    if (!isBeforeFlightMode) {
      if (activeFilter === "ALL") {
        return items;
      }
      return items.filter((item) => item.groupKey === activeFilter);
    }

    const startMs = effectiveStartDate ? Date.parse(`${effectiveStartDate}T00:00:00`) : null;
    const endMs = effectiveEndDate ? Date.parse(`${effectiveEndDate}T23:59:59.999`) : null;

    return items.filter((item) => {
      if (seriesFilter !== "ALL") {
        const itemSeries = resolveSeriesFilterToken(item);
        if (itemSeries !== seriesFilter) {
          return false;
        }
      }

      if (!Number.isFinite(startMs ?? NaN) && !Number.isFinite(endMs ?? NaN)) {
        return true;
      }

      const itemStartMs = parseNotamDateMs(item.raw.start_date);
      const itemEndMs = parseNotamDateMs(item.raw.end_date);
      const windowStart = itemStartMs ?? itemEndMs;
      const windowEnd = itemEndMs ?? itemStartMs;

      if (Number.isFinite(startMs ?? NaN) && Number.isFinite(windowEnd ?? NaN) && (windowEnd as number) < (startMs as number)) {
        return false;
      }
      if (Number.isFinite(endMs ?? NaN) && Number.isFinite(windowStart ?? NaN) && (windowStart as number) > (endMs as number)) {
        return false;
      }
      return true;
    });
  }, [activeFilter, effectiveEndDate, effectiveStartDate, isBeforeFlightMode, items, seriesFilter]);

  const planningPointList = useMemo(
    () =>
      (["departure", "mission", "arrival"] as PlanningPointKey[])
        .map((key) => planningPoints[key])
        .filter((point): point is PlanningPoint => !!point),
    [planningPoints],
  );

  const planningReady = !isBeforeFlightMode || planningPointList.length === 3;

  const renderItems = useMemo(() => {
    if (!isBeforeFlightMode) {
      return filteredItems;
    }
    if (!planningConfirmed || !planningPointList.length) {
      return [];
    }
    return filteredItems.filter((item) => planningPointList.some((planningPoint) => matchesPlanningPoint(item, planningPoint)));
  }, [filteredItems, isBeforeFlightMode, planningConfirmed, planningPointList]);

  useEffect(() => {
    let cancelled = false;

    async function setupMap() {
      if (!containerRef.current || mapRef.current) {
        return;
      }
      const leaflet = await import("leaflet");
      if (cancelled || !containerRef.current) {
        return;
      }
      leafletRef.current = leaflet;
      const map = leaflet.map(containerRef.current, {
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
        zoomControl: true,
        scrollWheelZoom: true,
      });
      leaflet.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      const layerGroup = leaflet.layerGroup().addTo(map);
      mapRef.current = map;
      layerGroupRef.current = layerGroup;

      if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(() => {
          requestAnimationFrame(() => {
            map.invalidateSize();
          });
        });
        observer.observe(containerRef.current);
        resizeObserverRef.current = observer;
      }
    }

    setupMap();

    return () => {
      cancelled = true;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      layerGroupRef.current?.clearLayers();
      layerGroupRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!isBeforeFlightMode) {
      return;
    }
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const handleMapClick = (event: LeafletMouseEvent) => {
      if (!selectingPointKey) {
        return;
      }
      const label = PLANNING_POINT_LABELS[selectingPointKey];
      const altitudeRaw = window.prompt(`${label} 고도(ft)를 입력하세요`, "5000");
      if (altitudeRaw == null) {
        return;
      }
      const altitudeFt = Number(String(altitudeRaw).replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(altitudeFt) || altitudeFt <= 0) {
        window.alert("고도(ft)는 1 이상의 숫자로 입력해 주세요.");
        return;
      }
      const nextPoint: PlanningPoint = {
        key: selectingPointKey,
        label,
        latitude: event.latlng.lat,
        longitude: event.latlng.lng,
        altitudeFt: Math.round(altitudeFt),
      };
      setPlanningPoints((prev) => ({ ...prev, [selectingPointKey]: nextPoint }));
      setPlanningConfirmed(false);
      setSelectingPointKey(null);
    };
    map.on("click", handleMapClick);
    return () => {
      map.off("click", handleMapClick);
    };
  }, [isBeforeFlightMode, selectingPointKey]);

  const loadItems = useCallback(async () => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    try {
      const [rawItems, restrictLookup] = await Promise.all([
        fetchNotamItems(mapRef.current, controller.signal),
        fetchRestrictLookup(controller.signal),
      ]);
      const parsed = rawItems
        .map((item) => buildParsedNotamItem(item, restrictLookup))
        .filter((item): item is ParsedNotamItem => !!item);
      setItems(parsed);
      setHasLoaded(true);
      requestAnimationFrame(() => {
        mapRef.current?.invalidateSize();
      });
    } catch (fetchError) {
      setHasLoaded(true);
      setItems([]);
      setError(fetchError instanceof Error ? fetchError.message : "NOTAM 정보를 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const leaflet = leafletRef.current;
    const map = mapRef.current;
    const layerGroup = layerGroupRef.current;
    if (!leaflet || !map || !layerGroup) {
      return;
    }

    layerGroup.clearLayers();

    const allBounds: Array<[number, number]> = [];
    const addCoordsToBounds = (coords: CoordPoint[]) => {
      coords.forEach((coord) => allBounds.push([coord.latitude, coord.longitude]));
    };
    const addInteractive = (layer: any, popupHtml: string, tooltipText: string) => {
      if (!layer) {
        return;
      }
      if (tooltipText && typeof layer.bindTooltip === "function") {
        layer.bindTooltip(tooltipText, {
          className: "doo-tooltip",
          direction: "top",
          offset: [0, -5],
          opacity: 0.97,
        });
      }
      layer.bindPopup(popupHtml, { maxWidth: 340 });
      layer.addTo(layerGroup);
    };

    planningPointList.forEach((planningPoint) => {
      allBounds.push([planningPoint.latitude, planningPoint.longitude]);
      const marker = leaflet.circleMarker([planningPoint.latitude, planningPoint.longitude], {
        radius: 7,
        color: "#d62828",
        weight: 2,
        fillColor: "#ffe066",
        fillOpacity: 0.95,
      });
      marker.bindPopup(
        `<div class="doo-notam-popup"><div class="doo-notam-popup-title">${escapeHtml(planningPoint.label)}</div><div class="doo-notam-popup-row"><strong>고도</strong><span>${escapeHtml(String(planningPoint.altitudeFt))} ft</span></div></div>`,
      );
      marker.addTo(layerGroup);
      const labelMarker = leaflet.marker([planningPoint.latitude, planningPoint.longitude], {
        icon: leaflet.divIcon({
          className: "doo-notam-point-label-icon",
          html: `<span class="doo-notam-point-label">${escapeHtml(planningPoint.label)} · ${escapeHtml(String(planningPoint.altitudeFt))}ft</span>`,
          iconSize: [170, 24],
          iconAnchor: [84, -12],
        }),
        interactive: false,
        keyboard: false,
      });
      labelMarker.addTo(layerGroup);
    });

    if (isBeforeFlightMode && selectingPointKey) {
      const selectingMarker = leaflet.marker(map.getCenter(), {
        icon: leaflet.divIcon({
          className: "doo-notam-selecting-badge-icon",
          html: `<span class="doo-notam-selecting-badge">${escapeHtml(PLANNING_POINT_LABELS[selectingPointKey])} 클릭 대기중</span>`,
          iconSize: [180, 24],
          iconAnchor: [90, -18],
        }),
        interactive: false,
        keyboard: false,
      });
      selectingMarker.addTo(layerGroup);
    }

    if (!hasLoaded || !renderItems.length) {
      if (allBounds.length && isBeforeFlightMode) {
        map.fitBounds(allBounds, {
          padding: [18, 18],
          maxZoom: 10,
        });
      }
      return;
    }

    (["de", "acgz"] as NotamGroupKey[]).forEach((groupKey) => {
      const groupItems = renderItems.filter((item) => item.groupKey === groupKey);
      if (!groupItems.length) {
        return;
      }

      const groupedByCoord = new Map<
        string,
        {
          lat: number;
          lng: number;
          items: ParsedNotamItem[];
        }
      >();
      groupItems.forEach((item) => {
        const coordKey = getNotamCoordKey(item.lat, item.lng);
        if (!groupedByCoord.has(coordKey)) {
          groupedByCoord.set(coordKey, { lat: item.lat, lng: item.lng, items: [] });
        }
        groupedByCoord.get(coordKey)?.items.push(item);
      });

      groupedByCoord.forEach((groupItem) => {
        const uniqueCorridorPolygons: CoordPoint[][] = [];
        const uniqueCorridorCenterlines: CoordPoint[][] = [];
        const uniquePolygons: CoordPoint[][] = [];
        const uniquePolylines: CoordPoint[][] = [];
        const corridorKeys = new Set<string>();
        const polygonKeys = new Set<string>();
        const polylineKeys = new Set<string>();
        const uniqueRadii = new Set<number>();
        const uniqueNavyCircles: Array<{ lat: number; lng: number; radiusMeters: number }> = [];
        const navyCircleKeys = new Set<string>();

        groupItem.items.forEach((item) => {
          if (Array.isArray(item.restrictedAreaFeatures) && item.restrictedAreaFeatures.length) {
            item.restrictedAreaFeatures.forEach((feature) => {
              if (!feature || !Array.isArray(feature.coords)) {
                return;
              }
              if (feature.featureType === "polygon" && feature.coords.length >= 3) {
                const polygonKey = notamCoordsKey(feature.coords);
                if (!polygonKeys.has(polygonKey)) {
                  polygonKeys.add(polygonKey);
                  uniquePolygons.push(feature.coords);
                }
                return;
              }
              if (feature.featureType === "line" && feature.coords.length >= 2) {
                const polylineKey = notamCoordsKey(feature.coords);
                if (!polylineKeys.has(polylineKey)) {
                  polylineKeys.add(polylineKey);
                  uniquePolylines.push(feature.coords);
                }
              }
            });
          }
          if (Array.isArray(item.corridorPolygonCoords) && item.corridorPolygonCoords.length >= 4) {
            const corridorKey = notamCoordsKey(item.corridorPolygonCoords);
            if (!corridorKeys.has(corridorKey)) {
              corridorKeys.add(corridorKey);
              uniqueCorridorPolygons.push(item.corridorPolygonCoords);
              if (Array.isArray(item.corridorCenterlineCoords) && item.corridorCenterlineCoords.length >= 2) {
                uniqueCorridorCenterlines.push(item.corridorCenterlineCoords);
              }
            }
            return;
          }
          if (Array.isArray(item.polygonCoords) && item.polygonCoords.length >= 3) {
            const polygonKey = notamCoordsKey(item.polygonCoords);
            if (!polygonKeys.has(polygonKey)) {
              polygonKeys.add(polygonKey);
              uniquePolygons.push(item.polygonCoords);
            }
            return;
          }
          if (Array.isArray(item.polylineCoords) && item.polylineCoords.length >= 2) {
            const polylineKey = notamCoordsKey(item.polylineCoords);
            if (!polylineKeys.has(polylineKey)) {
              polylineKeys.add(polylineKey);
              uniquePolylines.push(item.polylineCoords);
            }
            return;
          }
          if (
            Number.isFinite(item.radiusMeters) &&
            (item.radiusMeters ?? 0) > 0 &&
            (item.radiusMeters ?? 0) < NOTAM_CIRCLE_MAX_METERS
          ) {
            uniqueRadii.add(Math.round(item.radiusMeters as number));
          }
          const qCircleLat = Number(item.qCircleLat);
          const qCircleLng = Number(item.qCircleLng);
          const qCircleRadiusMeters = Number(item.qCircleRadiusMeters);
          if (
            Number.isFinite(qCircleLat) &&
            Number.isFinite(qCircleLng) &&
            Number.isFinite(qCircleRadiusMeters) &&
            qCircleRadiusMeters > 0 &&
            qCircleRadiusMeters < NOTAM_CIRCLE_MAX_METERS
          ) {
            const navyKey = `${qCircleLat.toFixed(6)}|${qCircleLng.toFixed(6)}|${Math.round(qCircleRadiusMeters)}`;
            if (!navyCircleKeys.has(navyKey)) {
              navyCircleKeys.add(navyKey);
              uniqueNavyCircles.push({
                lat: qCircleLat,
                lng: qCircleLng,
                radiusMeters: qCircleRadiusMeters,
              });
            }
          }
        });

        const tooltipTitle =
          groupItem.items.length === 1 ? groupItem.items[0].notamId || "NOTAM" : `NOTAM ${groupItem.items.length}건`;
        const popupHtml = buildGroupPopupHtml(groupItem.items);

        uniqueCorridorPolygons.forEach((coords) => {
          addCoordsToBounds(coords);
          const layer = leaflet.polygon(
            coords.map((point) => [point.latitude, point.longitude] as [number, number]),
            notamPathStyle(groupKey, "corridor-polygon"),
          );
          addInteractive(layer, popupHtml, tooltipTitle);
        });
        uniqueCorridorCenterlines.forEach((coords) => {
          addCoordsToBounds(coords);
          const layer = leaflet.polyline(
            coords.map((point) => [point.latitude, point.longitude] as [number, number]),
            notamPathStyle(groupKey, "corridor-centerline"),
          );
          addInteractive(layer, popupHtml, tooltipTitle);
        });
        uniquePolygons.forEach((coords) => {
          addCoordsToBounds(coords);
          const layer = leaflet.polygon(
            coords.map((point) => [point.latitude, point.longitude] as [number, number]),
            notamPathStyle(groupKey, "polygon"),
          );
          addInteractive(layer, popupHtml, tooltipTitle);
        });
        uniquePolylines.forEach((coords) => {
          addCoordsToBounds(coords);
          const layer = leaflet.polyline(
            coords.map((point) => [point.latitude, point.longitude] as [number, number]),
            notamPathStyle(groupKey, "polyline"),
          );
          addInteractive(layer, popupHtml, tooltipTitle);
        });
        Array.from(uniqueRadii.values()).forEach((radiusMeters) => {
          allBounds.push([groupItem.lat, groupItem.lng]);
          const layer = leaflet.circle([groupItem.lat, groupItem.lng], {
            ...notamPathStyle(groupKey, "circle"),
            radius: radiusMeters,
          });
          addInteractive(layer, popupHtml, tooltipTitle);
        });
        uniqueNavyCircles.forEach((circle) => {
          allBounds.push([circle.lat, circle.lng]);
          const layer = leaflet.circle([circle.lat, circle.lng], {
            ...notamQCircleStyle(),
            radius: circle.radiusMeters,
          });
          addInteractive(layer, popupHtml, tooltipTitle);
        });

        const labelText =
          groupItem.items.length > 1
            ? String(groupItem.items.length)
            : getNotamSeriesLabel(groupItem.items[0].notamId, groupItem.items[0].series);
        const hasDESeries = groupItem.items.some((item) => {
          const seriesLabel = getNotamSeriesLabel(item.notamId, item.series);
          return seriesLabel === "D" || seriesLabel === "E";
        });
        const hasQrpca = groupItem.items.some((item) => isNotamQrpca(item.content));
        const currentZoom = map.getZoom();
        const shouldShowLabel = currentZoom >= 7 || hasDESeries;
        if (shouldShowLabel) {
          const center = { latitude: groupItem.lat, longitude: groupItem.lng };
          const markerCoord = currentZoom >= 7 ? offsetCoordByMeters(center, 45, 130) : center;
          const labelKind = hasQrpca ? "qrpca" : groupItem.items.length > 1 ? "cluster" : "single";
          const labelMarker = leaflet.marker([markerCoord.latitude, markerCoord.longitude], {
            icon: notamLabelIcon(leaflet, labelText, labelKind),
            interactive: true,
            keyboard: false,
            riseOnHover: true,
          });
          addInteractive(labelMarker, popupHtml, tooltipTitle);
        }
      });
    });

    if (isBeforeFlightMode && planningConfirmed && renderItems.length) {
      const mapSize = map.getSize();
      const visibleItems = renderItems.slice(0, BEFORE_FLIGHT_LABEL_MAX_COUNT);
      const usableHeight = Math.max(120, mapSize.y - 30);
      const gap = Math.max(26, Math.floor(usableHeight / Math.max(1, visibleItems.length)));
      visibleItems.forEach((item, index) => {
        const anchor = resolvePlanningAnchor(item);
        const targetY = Math.min(mapSize.y - 12, 14 + index * gap);
        const targetPoint = leaflet.point(Math.max(20, mapSize.x - 12), targetY);
        const targetLatLng = map.containerPointToLatLng(targetPoint);
        const line = leaflet.polyline(
          [
            [anchor.latitude, anchor.longitude],
            [targetLatLng.lat, targetLatLng.lng],
          ],
          {
            color: "#e03131",
            weight: 1.5,
            opacity: 0.9,
          },
        );
        line.addTo(layerGroup);
        const rawText = String(item.content || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 520);
        const annotation = leaflet.marker([targetLatLng.lat, targetLatLng.lng], {
          icon: leaflet.divIcon({
            className: "doo-notam-raw-label-icon",
            html: `<div class="doo-notam-raw-label"><strong>${escapeHtml(item.notamId)}</strong><div>${escapeHtml(rawText || "내용 없음")}</div></div>`,
            iconSize: [250, 94],
            iconAnchor: [250, 47],
          }),
          interactive: false,
          keyboard: false,
        });
        annotation.addTo(layerGroup);
      });
    }

    if (allBounds.length) {
      map.fitBounds(allBounds, {
        padding: [18, 18],
        maxZoom: 9,
      });
    } else {
      map.setView(INITIAL_CENTER, INITIAL_ZOOM);
    }
  }, [hasLoaded, isBeforeFlightMode, planningConfirmed, planningPointList, renderItems, selectingPointKey]);

  const overlayMessage = useMemo(() => {
    if (isLoading) {
      return { className: "doo-notam-map-overlay doo-notam-map-overlay-loading", text: "NOTAM 불러오는 중..." };
    }
    if (!hasLoaded) {
      return { className: "doo-notam-map-overlay", text: "빈 지도입니다. NOTAM UPDATE를 누르면 표시됩니다." };
    }
    if (error) {
      return { className: "doo-notam-map-overlay doo-notam-map-overlay-error", text: error };
    }
    if (!items.length) {
      return { className: "doo-notam-map-overlay", text: "표시할 NOTAM이 없습니다." };
    }
    if (isBeforeFlightMode && !planningConfirmed) {
      if (!planningReady) {
        return {
          className: "doo-notam-map-overlay",
          text: "출발지·임무지역·도착지를 클릭해 고도를 입력한 뒤 완료를 눌러 주세요.",
        };
      }
      return {
        className: "doo-notam-map-overlay",
        text: "완료를 누르면 해당 구간 NOTAM이 표시됩니다.",
      };
    }
    if (!filteredItems.length) {
      if (isBeforeFlightMode) {
        return {
          className: "doo-notam-map-overlay",
          text: "선택한 발효일자/Series 조건에 맞는 NOTAM이 없습니다.",
        };
      }
      return {
        className: "doo-notam-map-overlay",
        text: `${activeFilter === "de" ? "NOTAM D,E" : "NOTAM A,C,G,Z"} 타입으로 표시할 NOTAM이 없습니다.`,
      };
    }
    if (isBeforeFlightMode && !renderItems.length) {
      return {
        className: "doo-notam-map-overlay",
        text: "선택 위치/고도(±2000ft)에 해당하는 NOTAM이 없습니다.",
      };
    }
    return null;
  }, [
    activeFilter,
    error,
    filteredItems.length,
    hasLoaded,
    isBeforeFlightMode,
    isLoading,
    items.length,
    planningConfirmed,
    planningReady,
    renderItems.length,
  ]);

  const handlePlanningPointSelect = useCallback((key: PlanningPointKey) => {
    setSelectingPointKey(key);
  }, []);

  const handlePlanningComplete = useCallback(() => {
    if (!planningReady) {
      window.alert("출발지, 임무지역, 도착지와 고도를 모두 입력해 주세요.");
      return;
    }
    setPlanningConfirmed(true);
    setSelectingPointKey(null);
  }, [planningReady]);

  const handlePlanningReset = useCallback(() => {
    setPlanningPoints({});
    setPlanningConfirmed(false);
    setSelectingPointKey(null);
  }, []);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const sectionTitle = isBeforeFlightMode ? "NOTAM 확인" : "NOTAM 현황";

  return (
    <section
      className={`doo-rail-card doo-rail-card-notam${isBeforeFlightMode ? " doo-notam-before-flight" : ""}`}
      aria-label={sectionTitle}
    >
      <div className="doo-notam-head">
        <div className="doo-notam-headline">
          <span className="doo-notam-title">{sectionTitle}</span>
        </div>
        <div className="doo-notam-head-actions">
          {isBeforeFlightMode ? (
            <button type="button" className="doo-notam-print-button" onClick={handlePrint}>
              인쇄
            </button>
          ) : null}
          <button
            type="button"
            className="doo-notam-update-button"
            onClick={() => void loadItems()}
            disabled={isLoading}
            aria-label="NOTAM UPDATE"
            title="NOTAM UPDATE"
          >
            {isLoading ? (
              <>
                <span>불러오는</span>
                <span>중...</span>
              </>
            ) : (
              <>
                <span>NOTAM</span>
                <span>UPDATE</span>
              </>
            )}
          </button>
          <span className="doo-notam-total-count">
            총 {hasLoaded ? items.length : 0}건{isBeforeFlightMode ? ` · 표시 ${renderItems.length}건` : ""}
          </span>
        </div>
      </div>

      <div
        className={`doo-notam-toolbar${isBeforeFlightMode ? " is-before-flight" : ""}`}
        role="group"
        aria-label={isBeforeFlightMode ? "NOTAM 발효일자 및 Series 필터" : "NOTAM 타입 필터"}
      >
        {isBeforeFlightMode ? (
          <>
            <label className="doo-notam-field">
              <span className="doo-notam-field-label">발효 시작일자</span>
              <input
                type="date"
                value={effectiveStartDate}
                onChange={(event) => {
                  setEffectiveStartDate(event.target.value);
                  setPlanningConfirmed(false);
                }}
                className="doo-notam-field-input"
              />
            </label>
            <label className="doo-notam-field">
              <span className="doo-notam-field-label">발효 종료일자</span>
              <input
                type="date"
                value={effectiveEndDate}
                onChange={(event) => {
                  setEffectiveEndDate(event.target.value);
                  setPlanningConfirmed(false);
                }}
                className="doo-notam-field-input"
              />
            </label>
            <label className="doo-notam-field">
              <span className="doo-notam-field-label">Series</span>
              <select
                value={seriesFilter}
                onChange={(event) => {
                  setSeriesFilter(event.target.value as NotamSeriesFilterValue);
                  setPlanningConfirmed(false);
                }}
                className="doo-notam-field-input"
              >
                {BEFORE_FLIGHT_SERIES_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="doo-notam-planning-actions">
              {(["departure", "mission", "arrival"] as PlanningPointKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`doo-notam-filter${selectingPointKey === key ? " is-active" : ""}`}
                  onClick={() => handlePlanningPointSelect(key)}
                >
                  {PLANNING_POINT_LABELS[key]}
                </button>
              ))}
              <button type="button" className="doo-notam-filter doo-notam-complete-button" onClick={handlePlanningComplete}>
                완료
              </button>
              <button type="button" className="doo-notam-filter" onClick={handlePlanningReset}>
                초기화
              </button>
            </div>
          </>
        ) : (
          FILTER_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`doo-notam-filter${activeFilter === option.value ? " is-active" : ""}`}
              onClick={() => setActiveFilter(option.value)}
            >
              {option.label}
            </button>
          ))
        )}
      </div>

      <div className="doo-notam-map-shell">
        <div
          ref={containerRef}
          className={`doo-notam-map-canvas${isBeforeFlightMode && selectingPointKey ? " is-selecting-point" : ""}`}
        />
        {overlayMessage ? <div className={overlayMessage.className}>{overlayMessage.text}</div> : null}
      </div>
    </section>
  );
}
