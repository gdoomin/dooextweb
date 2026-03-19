"use client";

import { useEffect, useMemo, useRef } from "react";

import type { FeatureCollection, Geometry } from "geojson";

import type { MapPayload } from "@/lib/convert";

type LeafletModule = typeof import("leaflet");

type MapPreviewProps = {
  payload: MapPayload;
};

export function MapPreview({ payload }: MapPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sourceGeoJson = useMemo(() => payload.geojson ?? buildFallbackGeoJson(payload), [payload]);

  useEffect(() => {
    let map: import("leaflet").Map | null = null;
    let cancelled = false;

    async function renderMap() {
      const L: LeafletModule = await import("leaflet");
      if (cancelled || !containerRef.current) {
        return;
      }

      map = L.map(containerRef.current, {
        zoomControl: true,
        preferCanvas: true,
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);

      const labelLayer = L.layerGroup().addTo(map);
      const renderLabels = sourceGeoJson.features.length <= 240;

      const geoLayer = L.geoJSON(sourceGeoJson, {
        style: (feature) => {
          if (feature?.geometry?.type.includes("Polygon")) {
            return {
              color: "#0f766e",
              weight: 2.5,
              fillColor: "#14b8a6",
              fillOpacity: 0.2,
            };
          }
          return {
            color: "#1d4ed8",
            weight: 3,
            opacity: 0.9,
          };
        },
        pointToLayer: (_feature, latlng) =>
          L.circleMarker(latlng, {
            radius: 4,
            color: "#1d4ed8",
            weight: 1,
            fillColor: "#60a5fa",
            fillOpacity: 0.9,
          }),
        onEachFeature: (feature, layer) => {
          const label = resolveFeatureLabel(feature);
          if (!label) {
            return;
          }
          layer.bindTooltip(escapeHtml(label), {
            sticky: true,
          });

          if (!renderLabels) {
            return;
          }

          const center = resolveLayerCenter(layer);
          if (!center) {
            return;
          }
          L.marker(center, {
            icon: createLabelIcon(L, label),
            keyboard: false,
          }).addTo(labelLayer);
        },
      }).addTo(map);

      const bounds = geoLayer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.15));
      } else {
        map.setView([36.35, 127.95], 7);
      }
    }

    renderMap();

    return () => {
      cancelled = true;
      if (map) {
        map.remove();
      }
    };
  }, [sourceGeoJson]);

  return <div ref={containerRef} className="h-[560px] w-full rounded-[26px]" />;
}

function resolveFeatureLabel(feature: { properties?: Record<string, unknown> } | undefined): string {
  if (!feature || !feature.properties) {
    return "";
  }
  const candidate =
    feature.properties.label ??
    feature.properties.name ??
    feature.properties.num ??
    feature.properties.force_label;

  if (typeof candidate === "string") {
    return candidate.trim();
  }
  return candidate ? String(candidate).trim() : "";
}

function resolveLayerCenter(layer: unknown): { lat: number; lng: number } | null {
  if (
    layer &&
    typeof layer === "object" &&
    "getLatLng" in layer &&
    typeof (layer as { getLatLng?: () => { lat: number; lng: number } }).getLatLng === "function"
  ) {
    return (layer as { getLatLng: () => { lat: number; lng: number } }).getLatLng();
  }
  if (
    layer &&
    typeof layer === "object" &&
    "getBounds" in layer &&
    typeof (layer as { getBounds?: () => { isValid: () => boolean; getCenter: () => { lat: number; lng: number } } })
      .getBounds === "function"
  ) {
    const bounds = (
      layer as { getBounds: () => { isValid: () => boolean; getCenter: () => { lat: number; lng: number } } }
    ).getBounds();
    if (bounds.isValid()) {
      return bounds.getCenter();
    }
  }
  return null;
}

function createLabelIcon(L: LeafletModule, label: string) {
  return L.divIcon({
    className: "doo-map-label",
    html: `<span>${escapeHtml(label)}</span>`,
    iconSize: [0, 0],
  });
}

function buildFallbackGeoJson(payload: MapPayload): FeatureCollection<Geometry> {
  if (payload.mode === "polygon") {
    return {
      type: "FeatureCollection",
      features: payload.polygons
        .filter((polygon) => Array.isArray(polygon.points) && polygon.points.length >= 3)
        .map((polygon, index) => {
          const ring = polygon.points.map(([lat, lon]) => [lon, lat]);
          const closedRing = closeRing(ring);
          return {
            type: "Feature",
            properties: {
              label: polygon.label || polygon.num || `Polygon ${index + 1}`,
            },
            geometry: {
              type: "Polygon",
              coordinates: [closedRing],
            },
          };
        }),
    };
  }

  return {
    type: "FeatureCollection",
    features: payload.results
      .filter(
        (row) =>
          typeof row.s_lat === "number" &&
          typeof row.s_lon === "number" &&
          typeof row.e_lat === "number" &&
          typeof row.e_lon === "number",
      )
      .map((row, index) => ({
        type: "Feature",
        properties: {
          label: row.num || row.force_label || String(index + 1),
        },
        geometry: {
          type: "LineString",
          coordinates: [
            [row.s_lon as number, row.s_lat as number],
            [row.e_lon as number, row.e_lat as number],
          ],
        },
      })),
  };
}

function closeRing(points: number[][]): number[][] {
  if (points.length < 3) {
    return points;
  }
  const [firstLon, firstLat] = points[0];
  const [lastLon, lastLat] = points[points.length - 1];
  if (firstLon === lastLon && firstLat === lastLat) {
    return points;
  }
  return [...points, [firstLon, firstLat]];
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
