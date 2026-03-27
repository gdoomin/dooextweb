"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EAST_ASIA_OUTLINES } from "./himawariEastAsiaOutline";

type HimawariSnapshot = {
  updatedAt: string;
  bandLabel: string;
  tiles: string[];
  baseX: number;
  baseY: number;
};

type JmaTimeEntry = {
  validtime?: string;
  basetime?: string;
};

const KOREA_CENTER = { lat: 36.2, lng: 127.8 };
const TILE_GRID_SIZE = 3;
const TILE_ZOOM = 5;
const CARD_SCALE = 1.9;
const KOREA_BOUNDS = {
  south: 33.0,
  west: 124.0,
  north: 39.0,
  east: 132.0,
};

function parseCompactUtcTimestamp(rawValue: string) {
  const value = String(rawValue || "").trim();
  if (!/^\d{14}$/.test(value)) {
    return null;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  if ([year, month, day, hour, minute, second].some((valuePart) => !Number.isFinite(valuePart))) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
}

function getDayOfYearKst(utcDate: Date) {
  const kstDate = new Date(utcDate.getTime() + 9 * 60 * 60 * 1000);
  const year = kstDate.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const current = Date.UTC(year, kstDate.getUTCMonth(), kstDate.getUTCDate());
  return Math.floor((current - start) / 86400000) + 1;
}

function isDaylightOverKorea(utcDate: Date) {
  const centerLat = (KOREA_BOUNDS.south + KOREA_BOUNDS.north) / 2;
  const centerLng = (KOREA_BOUNDS.west + KOREA_BOUNDS.east) / 2;
  const latitudeRad = (centerLat * Math.PI) / 180;
  const dayOfYear = getDayOfYearKst(utcDate);
  const declinationRad = (23.44 * Math.PI) / 180 * Math.sin(((2 * Math.PI) / 365) * (dayOfYear - 81));
  const b = (2 * Math.PI * (dayOfYear - 81)) / 364;
  const equationOfTime = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const sunriseZenith = (90.833 * Math.PI) / 180;
  const cosHourAngle =
    Math.cos(sunriseZenith) / (Math.cos(latitudeRad) * Math.cos(declinationRad)) -
    Math.tan(latitudeRad) * Math.tan(declinationRad);

  if (cosHourAngle <= -1) {
    return true;
  }
  if (cosHourAngle >= 1) {
    return false;
  }

  const hourAngleDeg = (Math.acos(cosHourAngle) * 180) / Math.PI;
  const solarNoonMinutes = 720 - 4 * centerLng - equationOfTime + 9 * 60;
  const sunriseMinutes = solarNoonMinutes - 4 * hourAngleDeg;
  const sunsetMinutes = solarNoonMinutes + 4 * hourAngleDeg;
  const kstDate = new Date(utcDate.getTime() + 9 * 60 * 60 * 1000);
  const currentMinutes = kstDate.getUTCHours() * 60 + kstDate.getUTCMinutes();
  return currentMinutes >= sunriseMinutes && currentMinutes <= sunsetMinutes;
}

function resolveLatestTimestamp(entries: JmaTimeEntry[]) {
  let selectedRaw = "";
  let selectedDate: Date | null = null;

  for (const entry of entries) {
    const candidateRaw = String(entry?.validtime || entry?.basetime || "").trim();
    const candidateDate = parseCompactUtcTimestamp(candidateRaw);
    if (!candidateDate || Number.isNaN(candidateDate.getTime())) {
      continue;
    }
    if (!selectedDate || candidateDate.getTime() >= selectedDate.getTime()) {
      selectedRaw = candidateRaw;
      selectedDate = candidateDate;
    }
  }

  if (!selectedRaw || !selectedDate) {
    return null;
  }
  return { raw: selectedRaw, date: selectedDate };
}

function lngLatToTile(lng: number, lat: number, zoom: number) {
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** zoom;
  const x = ((lng + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

function buildTileSnapshot(timestampRaw: string, isDay: boolean) {
  const bandPath = isDay ? "B03/ALBD" : "B13/TBB";
  const root = `https://www.jma.go.jp/bosai/himawari/data/satimg/${timestampRaw}/fd/${timestampRaw}/${bandPath}`;
  const centerTile = lngLatToTile(KOREA_CENTER.lng, KOREA_CENTER.lat, TILE_ZOOM);
  const baseX = Math.floor(centerTile.x) - 1;
  const baseY = Math.floor(centerTile.y) - 1;
  const tiles: string[] = [];
  for (let row = 0; row < TILE_GRID_SIZE; row += 1) {
    for (let col = 0; col < TILE_GRID_SIZE; col += 1) {
      tiles.push(`${root}/${TILE_ZOOM}/${baseX + col}/${baseY + row}.jpg?v=${timestampRaw}`);
    }
  }
  return { tiles, baseX, baseY };
}

function formatKst(isoValue: string) {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "Asia/Seoul",
    }).format(new Date(isoValue));
  } catch {
    return isoValue;
  }
}

function projectOutlinePoint(lng: number, lat: number, baseX: number, baseY: number) {
  const projected = lngLatToTile(lng, lat, TILE_ZOOM);
  const x = ((projected.x - baseX) / TILE_GRID_SIZE) * 100;
  const y = ((projected.y - baseY) / TILE_GRID_SIZE) * 100;
  return `${x.toFixed(3)},${y.toFixed(3)}`;
}

function buildOutlinePoints(outline: Array<[number, number]>, baseX: number, baseY: number) {
  return outline.map(([lng, lat]) => projectOutlinePoint(lng, lat, baseX, baseY)).join(" ");
}

export function HimawariRailPanel() {
  const [snapshot, setSnapshot] = useState<HimawariSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadSnapshot = useCallback(async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `https://www.jma.go.jp/bosai/himawari/data/satimg/targetTimes_fd.json${force ? `?t=${Date.now()}` : ""}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error("히마와리 시각 정보를 불러오지 못했습니다.");
      }
      const payload = (await response.json()) as JmaTimeEntry[];
      const latest = resolveLatestTimestamp(Array.isArray(payload) ? payload : []);
      if (!latest) {
        throw new Error("최신 히마와리 시각을 찾지 못했습니다.");
      }
      const isDay = isDaylightOverKorea(latest.date);
      const tileSnapshot = buildTileSnapshot(latest.raw, isDay);
      setSnapshot({
        updatedAt: latest.date.toISOString(),
        bandLabel: isDay ? "B03 / 가시광 단일밴드" : "B13 / 적외 단일밴드",
        tiles: tileSnapshot.tiles,
        baseX: tileSnapshot.baseX,
        baseY: tileSnapshot.baseY,
      });
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "히마와리 이미지를 불러오지 못했습니다.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const timeLabel = useMemo(() => (snapshot ? formatKst(snapshot.updatedAt) : "-"), [snapshot]);
  const eastAsiaOutlines = useMemo(
    () => (snapshot ? EAST_ASIA_OUTLINES.map((outline) => buildOutlinePoints(outline, snapshot.baseX, snapshot.baseY)) : []),
    [snapshot],
  );

  return (
    <section className="doo-rail-card doo-rail-card-hima" aria-label="히마와리 실시간">
      <div className="doo-rail-card-head">
        <div className="doo-rail-card-copy">
          <strong>히마와리 실시간</strong>
          <span>{snapshot?.bandLabel || "단일밴드 로딩 중"}</span>
        </div>
        <button type="button" className="doo-rail-refresh" onClick={() => void loadSnapshot(true)} disabled={loading}>
          {loading ? "..." : "새로고침"}
        </button>
      </div>

      <div className="doo-rail-hima-meta">{snapshot ? `${timeLabel} KST` : "최신 시각을 확인 중입니다."}</div>

      <div className="doo-rail-hima-canvas">
        {snapshot ? (
          <>
            <div className="doo-rail-hima-stage" style={{ transform: `scale(${CARD_SCALE})` }}>
              <div className="doo-rail-hima-grid">
                {snapshot.tiles.map((tileUrl, index) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={`${tileUrl}-${index}`} src={tileUrl} alt="히마와리 타일" className="doo-rail-hima-tile" loading="lazy" />
                ))}
              </div>
              <svg className="doo-rail-hima-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                {eastAsiaOutlines.map((outlinePoints, index) => (
                  <polyline key={`east-asia-outline-${index}`} points={outlinePoints} />
                ))}
              </svg>
            </div>
          </>
        ) : (
          <div className="doo-rail-hima-empty">{error || "히마와리 이미지를 준비 중입니다."}</div>
        )}
      </div>
    </section>
  );
}
