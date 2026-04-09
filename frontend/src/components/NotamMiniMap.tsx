"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";

import { API_BASE_URL } from "@/lib/convert";

type LeafletModule = typeof import("leaflet");

type NotamApiItem = {
  id?: string | number | null;
  notam_id?: string;
  series?: string;
  group?: string;
  lat?: number;
  lng?: number;
  start_date?: string;
  end_date?: string;
  created_at?: string;
  airport?: string;
  content?: string;
};

type NotamApiResponse = {
  ok?: boolean;
  total?: number;
  items?: NotamApiItem[];
  source?: string;
  fetched_at?: string;
};

type NotamMarkerType = "D" | "R" | "E" | "M";
type NotamFilter = "ALL" | NotamMarkerType;

type NotamMapItem = {
  id: string;
  notamId: string;
  lat: number;
  lng: number;
  type: NotamMarkerType;
  airport: string;
  areaLabel: string;
  altitudeLabel: string;
  validityLabel: string;
  content: string;
};

const INITIAL_CENTER: [number, number] = [36.5, 127.8];
const INITIAL_ZOOM = 6;
const NOTAM_LIMIT = 1200;
const FILTER_OPTIONS: Array<{ value: NotamFilter; label: string }> = [
  { value: "ALL", label: "전체" },
  { value: "D", label: "D" },
  { value: "R", label: "R" },
  { value: "E", label: "E" },
  { value: "M", label: "M" },
];
const NOTAM_COLORS: Record<NotamMarkerType, string> = {
  D: "#E24B4A",
  R: "#BA7517",
  E: "#3B6D11",
  M: "#7F77DD",
};

function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function collapseWhitespace(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractAirportCode(content: string, fallback = "") {
  const match = String(content || "").toUpperCase().match(/\bA\)\s*([A-Z0-9]{4})\b/);
  return match?.[1] || fallback;
}

function extractSectionValue(content: string, section: string) {
  const expression = new RegExp(`\\b${section}\\)\\s*([\\s\\S]*?)(?=\\s+[A-Z]\\)|$)`, "i");
  const match = String(content || "").match(expression);
  return collapseWhitespace(match?.[1] || "");
}

function normalizeDateLabel(value: string) {
  const raw = collapseWhitespace(value);
  if (!raw) {
    return "";
  }
  return raw.replace(/UTC/gi, "").trim();
}

function resolveNotamType(item: Pick<NotamApiItem, "notam_id" | "series" | "content">): NotamMarkerType {
  const notamId = String(item.notam_id || "").trim().toUpperCase();
  const series = String(item.series || "").trim().toUpperCase() || notamId.slice(0, 1);
  const content = String(item.content || "").toUpperCase();

  if (content.includes("RESTRICTED AREA") || content.includes("/QRTCA")) {
    return "R";
  }
  if (content.includes("DANGER AREA") || content.includes("/QRDCA")) {
    return "D";
  }
  if (series === "E") {
    return "E";
  }
  return "M";
}

function resolveAreaLabel(item: Pick<NotamApiItem, "airport" | "content">, type: NotamMarkerType) {
  const airport = extractAirportCode(item.content || "", String(item.airport || "").trim().toUpperCase());
  const typeLabel =
    type === "D" ? "위험구역" : type === "R" ? "제한구역" : type === "E" ? "항행경보" : "기타 NOTAM";
  if (airport) {
    return `${airport} · ${typeLabel}`;
  }
  return typeLabel;
}

function resolveAltitudeLabel(item: Pick<NotamApiItem, "content">) {
  const content = String(item.content || "");
  const lower = extractSectionValue(content, "F");
  const upper = extractSectionValue(content, "G");
  if (lower && upper) {
    return `${lower} ~ ${upper}`;
  }
  const qMatch = content.toUpperCase().match(/Q\)[^/]*\/[^/]*\/[^/]*\/[^/]*\/(\d{3})\/(\d{3})\//);
  if (qMatch) {
    return `${qMatch[1]} ~ ${qMatch[2]}`;
  }
  return "정보 없음";
}

function resolveValidityLabel(item: Pick<NotamApiItem, "content" | "start_date" | "end_date">) {
  const start = normalizeDateLabel(String(item.start_date || "")) || extractSectionValue(item.content || "", "B");
  const end = normalizeDateLabel(String(item.end_date || "")) || extractSectionValue(item.content || "", "C");
  if (start && end) {
    return `${start} ~ ${end}`;
  }
  return start || end || "정보 없음";
}

function buildPopupHtml(item: NotamMapItem) {
  return `
    <div class="doo-notam-popup">
      <div class="doo-notam-popup-title">${escapeHtml(item.notamId)}</div>
      <div class="doo-notam-popup-row"><strong>구역</strong><span>${escapeHtml(item.areaLabel)}</span></div>
      <div class="doo-notam-popup-row"><strong>고도</strong><span>${escapeHtml(item.altitudeLabel)}</span></div>
      <div class="doo-notam-popup-row"><strong>유효기간</strong><span>${escapeHtml(item.validityLabel)}</span></div>
      <div class="doo-notam-popup-content">${escapeHtml(item.content)}</div>
    </div>
  `;
}

function buildPinIcon(leaflet: LeafletModule, color: string) {
  const svg = `
    <svg viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M15 40C15 40 28 25.18 28 15.4C28 7.45 22.18 2 15 2S2 7.45 2 15.4C2 25.18 15 40 15 40Z" fill="${color}" stroke="#08131f" stroke-width="1.8"/>
      <circle cx="15" cy="15" r="5.2" fill="rgba(255,255,255,0.92)"/>
    </svg>
  `;
  return leaflet.divIcon({
    className: "doo-notam-pin-icon",
    html: svg,
    iconSize: [30, 42],
    iconAnchor: [15, 39],
    popupAnchor: [0, -34],
  });
}

async function fetchNotamItems(signal?: AbortSignal): Promise<NotamMapItem[]> {
  const response = await fetch(`${API_BASE_URL}/api/notam?limit=${NOTAM_LIMIT}`, {
    cache: "no-store",
    signal,
  });
  let payload: NotamApiResponse | null = null;
  try {
    payload = (await response.json()) as NotamApiResponse;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload && "detail" in payload && typeof (payload as { detail?: unknown }).detail === "string"
        ? String((payload as { detail?: string }).detail)
        : "NOTAM 정보를 불러오지 못했습니다.";
    throw new Error(message);
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items
    .map((item) => {
      const lat = Number(item.lat);
      const lng = Number(item.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }
      const content = collapseWhitespace(String(item.content || ""));
      const notamId = String(item.notam_id || "").trim();
      const type = resolveNotamType(item);
      return {
        id: String(item.id || notamId || `${lat}:${lng}`),
        notamId: notamId || "NOTAM",
        lat,
        lng,
        type,
        airport: extractAirportCode(content, String(item.airport || "")),
        areaLabel: resolveAreaLabel(item, type),
        altitudeLabel: resolveAltitudeLabel(item),
        validityLabel: resolveValidityLabel(item),
        content,
      } satisfies NotamMapItem;
    })
    .filter((item): item is NotamMapItem => Boolean(item));
}

export function NotamMiniMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<LeafletModule | null>(null);
  const markerLayerRef = useRef<LayerGroup | null>(null);
  const [items, setItems] = useState<NotamMapItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeFilter, setActiveFilter] = useState<NotamFilter>("ALL");

  const filteredItems = useMemo(
    () => (activeFilter === "ALL" ? items : items.filter((item) => item.type === activeFilter)),
    [activeFilter, items],
  );

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextItems = await fetchNotamItems();
      setItems(nextItems);
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : "NOTAM 정보를 불러오지 못했습니다.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  useEffect(() => {
    let isDisposed = false;
    let resizeObserver: ResizeObserver | null = null;

    void import("leaflet").then((leaflet) => {
      if (isDisposed || !containerRef.current || mapRef.current) {
        return;
      }
      leafletRef.current = leaflet;
      const map = leaflet.map(containerRef.current, {
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
        scrollWheelZoom: true,
        zoomControl: true,
        attributionControl: true,
      });
      leaflet
        .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "&copy; OpenStreetMap",
        })
        .addTo(map);
      markerLayerRef.current = leaflet.layerGroup().addTo(map);
      mapRef.current = map;

      resizeObserver = new ResizeObserver(() => {
        window.requestAnimationFrame(() => {
          map.invalidateSize();
        });
      });
      resizeObserver.observe(containerRef.current);
      window.setTimeout(() => map.invalidateSize(), 0);
    });

    return () => {
      isDisposed = true;
      resizeObserver?.disconnect();
      markerLayerRef.current?.clearLayers();
      markerLayerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      leafletRef.current = null;
    };
  }, []);

  useEffect(() => {
    const leaflet = leafletRef.current;
    const layerGroup = markerLayerRef.current;
    const map = mapRef.current;
    if (!leaflet || !layerGroup || !map) {
      return;
    }

    layerGroup.clearLayers();

    filteredItems.forEach((item) => {
      const marker = leaflet.marker([item.lat, item.lng], {
        icon: buildPinIcon(leaflet, NOTAM_COLORS[item.type]),
        title: item.notamId,
      });
      marker.bindPopup(buildPopupHtml(item), {
        maxWidth: 320,
        className: "doo-notam-leaflet-popup",
      });
      marker.addTo(layerGroup);
    });

    window.requestAnimationFrame(() => {
      map.invalidateSize();
    });
  }, [filteredItems]);

  return (
    <section className="doo-rail-card doo-rail-card-notam" aria-label="NOTAM 현황">
      <div className="doo-rail-card-head">
        <div className="doo-rail-card-copy">
          <strong>NOTAM 현황</strong>
          <span>총 {items.length}건</span>
        </div>
        <button type="button" className="doo-rail-refresh" onClick={() => void loadItems()} disabled={loading}>
          {loading ? "..." : "새로고침"}
        </button>
      </div>

      <div className="doo-notam-toolbar" role="tablist" aria-label="NOTAM 타입 필터">
        {FILTER_OPTIONS.map((filterOption) => {
          const isActive = activeFilter === filterOption.value;
          return (
            <button
              key={filterOption.value}
              type="button"
              className={`doo-notam-filter${isActive ? " is-active" : ""}`}
              onClick={() => setActiveFilter(filterOption.value)}
            >
              {filterOption.label}
            </button>
          );
        })}
      </div>

      <div className="doo-notam-map-shell">
        <div ref={containerRef} className="doo-notam-map-canvas" />
        {loading ? (
          <div className="doo-notam-map-overlay doo-notam-map-overlay-loading">NOTAM 불러오는 중...</div>
        ) : null}
        {!loading && error ? <div className="doo-notam-map-overlay doo-notam-map-overlay-error">{error}</div> : null}
        {!loading && !error && !filteredItems.length ? (
          <div className="doo-notam-map-overlay">
            {activeFilter === "ALL" ? "표시할 좌표형 NOTAM이 없습니다." : `${activeFilter} 타입으로 표시할 NOTAM이 없습니다.`}
          </div>
        ) : null}
      </div>
    </section>
  );
}
