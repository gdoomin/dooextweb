"use client";

import { useEffect, useRef } from "react";

import type { MapPayload } from "@/lib/convert";


type LeafletModule = typeof import("leaflet");

type MapPreviewProps = {
  payload: MapPayload;
};

export function MapPreview({ payload }: MapPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

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

      const bounds = L.latLngBounds([]);

      if (payload.mode === "polygon") {
        payload.polygons.forEach((polygon, index) => {
          if (!polygon.points?.length) {
            return;
          }

          const shape = L.polygon(polygon.points, {
            color: "#0f766e",
            weight: 3,
            fillColor: "#14b8a6",
            fillOpacity: 0.22,
          }).addTo(map!);

          bounds.extend(shape.getBounds());

          const center = shape.getBounds().getCenter();
          const label = polygon.label?.trim() || polygon.num?.trim() || `Polygon ${index + 1}`;
          L.marker(center, {
            icon: createLabelIcon(L, label),
            keyboard: false,
          }).addTo(map!);
        });
      } else {
        payload.results.forEach((row, index) => {
          if (
            typeof row.s_lat !== "number" ||
            typeof row.s_lon !== "number" ||
            typeof row.e_lat !== "number" ||
            typeof row.e_lon !== "number"
          ) {
            return;
          }

          const points: [number, number][] = [
            [row.s_lat, row.s_lon],
            [row.e_lat, row.e_lon],
          ];

          const line = L.polyline(points, {
            color: "#1d4ed8",
            weight: 3.5,
            opacity: 0.92,
          }).addTo(map!);

          bounds.extend(line.getBounds());

          const label = row.num?.trim() || row.force_label?.trim() || `${index + 1}`;
          const midPoint: [number, number] = [
            (row.s_lat + row.e_lat) / 2,
            (row.s_lon + row.e_lon) / 2,
          ];

          L.marker(midPoint, {
            icon: createLabelIcon(L, label),
            keyboard: false,
          }).addTo(map!);
        });
      }

      if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.18));
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
  }, [payload]);

  return <div ref={containerRef} className="h-[560px] w-full rounded-[26px]" />;
}

function createLabelIcon(L: LeafletModule, label: string) {
  return L.divIcon({
    className: "doo-map-label",
    html: `<span>${escapeHtml(label)}</span>`,
    iconSize: [0, 0],
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

