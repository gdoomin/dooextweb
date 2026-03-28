const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_ECMWF_URL = "https://api.open-meteo.com/v1/ecmwf";
const OPEN_METEO_AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

const ALLOWED_PARAMS = new Set([
  "latitude",
  "longitude",
  "hourly",
  "current",
  "models",
  "timezone",
  "forecast_days",
  "wind_speed_unit",
  "domains",
]);

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Origin, Accept",
  "Cache-Control": "no-store",
};

export function buildProxyUrl(
  requestUrl: string,
  mode: "forecast" | "air-quality",
): string {
  const input = new URL(requestUrl);
  const params = new URLSearchParams();
  input.searchParams.forEach((value, key) => {
    if (!ALLOWED_PARAMS.has(key)) {
      return;
    }
    const normalized = String(value || "").trim();
    if (normalized) {
      params.set(key, normalized);
    }
  });

  const latitude = Number(params.get("latitude"));
  const longitude = Number(params.get("longitude"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("latitude and longitude are required");
  }
  params.set("latitude", latitude.toFixed(2));
  params.set("longitude", longitude.toFixed(2));

  let upstream = mode === "air-quality" ? OPEN_METEO_AIR_QUALITY_URL : OPEN_METEO_FORECAST_URL;
  if (mode === "forecast") {
    const model = String(params.get("models") || "").trim().toLowerCase();
    if (model.startsWith("ecmwf")) {
      upstream = OPEN_METEO_ECMWF_URL;
      params.delete("models");
    }
  }

  return `${upstream}?${params.toString()}`;
}

export async function fetchUpstreamJson(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "dooextweb-cf-weather/0.1",
      "Accept": "application/json,text/plain,*/*",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
    cache: "no-store",
    redirect: "follow",
  });
  return response;
}
