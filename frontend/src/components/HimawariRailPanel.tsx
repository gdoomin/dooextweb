"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

const SOUTH_KOREA_MAINLAND_OUTLINE: Array<[number, number]> = [
  [128.3618, 38.6169],
  [127.9567, 38.3176],
  [127.6887, 38.3222],
  [127.1379, 38.3155],
  [126.9065, 38.1168],
  [126.6787, 37.8936],
  [126.3487, 37.7972],
  [126.1066, 37.686],
  [126.3757, 37.3963],
  [126.4211, 37.2238],
  [126.4719, 37.0683],
  [126.1313, 36.8225],
  [126.2576, 36.5979],
  [126.5021, 36.1833],
  [126.5831, 35.8546],
  [126.4526, 35.6484],
  [126.3441, 35.3017],
  [126.3551, 35.1547],
  [126.1574, 35.1542],
  [126.0942, 34.9889],
  [126.2556, 34.8302],
  [126.2329, 34.5518],
  [126.2844, 34.3599],
  [126.465, 34.4177],
  [126.511, 34.2828],
  [126.6772, 34.2873],
  [126.9429, 34.4188],
  [127.1619, 34.6801],
  [127.1063, 34.4986],
  [127.243, 34.5054],
  [127.4366, 34.4539],
  [127.5142, 34.5953],
  [127.6948, 34.545],
  [127.8349, 34.4845],
  [127.7765, 34.7343],
  [127.7909, 34.931],
  [127.9179, 34.7337],
  [128.082, 34.7557],
  [128.2125, 34.8887],
  [128.3656, 34.745],
  [128.5304, 34.6959],
  [128.7419, 34.7732],
  [128.8614, 35.0469],
  [129.2816, 35.3017],
  [129.5425, 36.0968],
  [129.4533, 36.556],
  [129.3489, 37.2861],
  [128.632, 38.1475],
  [128.3618, 38.6169],
];

const JEJU_OUTLINE: Array<[number, number]> = [
  [126.8152, 33.5757],
  [126.4856, 33.5311],
  [126.2329, 33.4349],
  [126.156, 33.35],
  [126.178, 33.2421],
  [126.2466, 33.1559],
  [126.3016, 33.1881],
  [126.3936, 33.2261],
  [126.6092, 33.2215],
  [126.8069, 33.2823],
  [126.9415, 33.4108],
  [126.9786, 33.4761],
  [126.9525, 33.5357],
  [126.855, 33.5448],
  [126.8152, 33.5757],
];

const DOKDO_OUTLINES: Array<Array<[number, number]>> = [
  [
    [131.8669, 37.2417],
    [131.8696, 37.2423],
    [131.869, 37.2444],
    [131.8663, 37.2438],
    [131.8669, 37.2417],
  ],
  [
    [131.8642, 37.238],
    [131.8656, 37.2384],
    [131.8651, 37.2395],
    [131.8637, 37.2391],
    [131.8642, 37.238],
  ],
];

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
  const mainlandOutline = useMemo(
    () => (snapshot ? buildOutlinePoints(SOUTH_KOREA_MAINLAND_OUTLINE, snapshot.baseX, snapshot.baseY) : ""),
    [snapshot],
  );
  const jejuOutline = useMemo(
    () => (snapshot ? buildOutlinePoints(JEJU_OUTLINE, snapshot.baseX, snapshot.baseY) : ""),
    [snapshot],
  );
  const dokdoOutlines = useMemo(
    () =>
      snapshot ? DOKDO_OUTLINES.map((outline) => buildOutlinePoints(outline, snapshot.baseX, snapshot.baseY)) : [],
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
                <polyline points={mainlandOutline} />
                <polyline points={jejuOutline} />
                {dokdoOutlines.map((outlinePoints, index) => (
                  <polyline key={`dokdo-${index}`} points={outlinePoints} />
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
