from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


DEFAULT_WEATHER_BBOX = (33.0, 124.0, 39.0, 132.0)
GK2A_IMAGE_PROXY_PATH = "/api/weather/satellite-image"
GK2A_API_BASE_URL = "https://apihub.kma.go.kr/api/typ05/api/GK2A/LE1B"
GK2A_DEFAULT_AUTH_KEY = "essYXrddTSaLGF63Xc0mAw"
GK2A_FETCH_TIMEOUT_SECONDS = 6
GK2A_API_FAILURE_COOLDOWN_SECONDS = 90
GK2A_DAILY_LIMIT_COOLDOWN_SECONDS = 900
GK2A_CACHE_KEEP_PER_CHANNEL = 8
GK2A_SUPABASE_DEFAULT_BUCKET = "doo-weather-satellite-cache"
GK2A_SUPABASE_LIST_TTL_SECONDS = 60
GK2A_TIMESTAMP_RE = re.compile(r"^\d{12}$")
GK2A_CHANNEL_MAP = {
    "vi006": "VI006",
    "ir105": "IR105",
}
_CACHE: dict[str, tuple[float, Any]] = {}
_USER_AGENT = "dooextweb-weather/0.1"
_GK2A_CACHE_DIR: Path | None = None
_GK2A_FETCH_LOCK = threading.Lock()
_GK2A_FAILURE_CACHE: dict[str, float] = {}
_GK2A_BLOCKED_UNTIL_TS = 0.0
_GK2A_SUPABASE_CONFIG: dict[str, str] | None = None
_GK2A_SUPABASE_BUCKET_READY = False
_GK2A_SUPABASE_LIST_CACHE: dict[str, tuple[float, list[str]]] = {}


class WeatherProviderError(RuntimeError):
    pass


def parse_bbox_param(raw: str | None) -> tuple[float, float, float, float]:
    if not raw:
        return DEFAULT_WEATHER_BBOX

    parts = [part.strip() for part in str(raw).split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must have south,west,north,east")

    south, west, north, east = [float(part) for part in parts]
    south = max(-90.0, min(90.0, south))
    north = max(-90.0, min(90.0, north))
    west = max(-180.0, min(180.0, west))
    east = max(-180.0, min(180.0, east))

    if south > north:
        south, north = north, south
    if west > east:
        west, east = east, west

    return south, west, north, east


def build_weather_config() -> dict[str, Any]:
    maps = _get_json(
        "weather:rainviewer:maps",
        "https://api.rainviewer.com/public/weather-maps.json",
        ttl_seconds=600,
    )
    host = str(maps.get("host") or "https://tilecache.rainviewer.com").rstrip("/")
    radar_root = maps.get("radar") if isinstance(maps, dict) else {}
    frame = _pick_radar_frame(radar_root if isinstance(radar_root, dict) else {})
    radar_url = ""
    radar_generated = ""
    if frame:
        radar_path = str(frame.get("path") or "").strip()
        radar_time = frame.get("time")
        if radar_path:
            radar_url = f"{host}{radar_path}/256/{{z}}/{{x}}/{{y}}/6/1_1.png"
        if radar_time:
            radar_generated = datetime.fromtimestamp(int(radar_time), tz=timezone.utc).isoformat()

    gk2a_base_url = GK2A_IMAGE_PROXY_PATH
    gk2a_delay_minutes = 4
    gk2a_refresh_seconds = 120
    gk2a_day_channel = "vi006"
    gk2a_night_channel = "ir105"
    gk2a_fallback_steps = 0
    capture_utc = datetime.now(timezone.utc) - timedelta(minutes=gk2a_delay_minutes)
    capture_utc = capture_utc.replace(minute=(capture_utc.minute // 2) * 2, second=0, microsecond=0)
    capture_yyyymmdd = capture_utc.strftime("%Y%m%d")
    capture_hhmm = capture_utc.strftime("%H%M")
    satellite_channel = gk2a_night_channel
    satellite_image_url = f"{gk2a_base_url}?channel={satellite_channel}&date={capture_yyyymmdd}{capture_hhmm}"

    return {
        "ok": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "radar": {
            "tile_url": radar_url,
            "updated_at": radar_generated,
            "attribution": "RainViewer",
            "opacity": 0.68,
            "max_zoom": 19,
            "max_native_zoom": 7,
        },
        "satellite": {
            "provider": "gk2a",
            "base_url": gk2a_base_url,
            "upstream_base_url": GK2A_API_BASE_URL,
            "image_url": satellite_image_url,
            "updated_at": capture_utc.isoformat(),
            "yyyymmdd": capture_yyyymmdd,
            "hhmm": capture_hhmm,
            "day_channel": gk2a_day_channel,
            "night_channel": gk2a_night_channel,
            "delay_minutes": gk2a_delay_minutes,
            "fallback_steps": gk2a_fallback_steps,
            "refresh_seconds": gk2a_refresh_seconds,
            # GK-2A KO 영역 코너(문서 기준) 평균 경도대를 사용한 근사 bounds
            # TL: 45.728965N, 113.996418E / TR: 45.728965N, 138.003582E
            # BL: 29.312252N, 116.753260E / BR: 29.312252N, 135.246740E
            "bounds": [[29.312252, 115.374839], [45.728965, 136.625161]],
            "attribution": "NMSC GK-2A AMI",
            "opacity": 0.75,
            "max_zoom": 12,
        },
    }


def build_weather_grid(
    bbox: tuple[float, float, float, float],
    rows: int = 4,
    cols: int = 5,
) -> dict[str, Any]:
    south, west, north, east = bbox
    rows = max(2, min(6, int(rows)))
    cols = max(2, min(6, int(cols)))
    points = _sample_grid_points(south, west, north, east, rows, cols)
    latitudes = ",".join(f"{lat:.4f}" for lat, _ in points)
    longitudes = ",".join(f"{lng:.4f}" for _, lng in points)
    cache_key = f"weather:grid:{rows}:{cols}:{_bbox_key(bbox)}"
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={latitudes}"
        f"&longitude={longitudes}"
        "&current=precipitation,cloud_cover,wind_speed_10m,wind_direction_10m,weather_code"
    )
    data = _get_json(cache_key, url, ttl_seconds=180)
    items = data if isinstance(data, list) else []

    output = []
    for item in items:
        if not isinstance(item, dict):
            continue
        current = item.get("current") if isinstance(item.get("current"), dict) else {}
        current_units = item.get("current_units") if isinstance(item.get("current_units"), dict) else {}
        lat = _as_float(item.get("latitude"))
        lng = _as_float(item.get("longitude"))
        wind_speed = _as_float(current.get("wind_speed_10m"))
        wind_speed_knots = _to_knots(wind_speed, str(current_units.get("wind_speed_10m") or "km/h"))
        output.append(
            {
                "lat": lat,
                "lng": lng,
                "precipitation_mm": _as_float(current.get("precipitation")),
                "cloud_cover": _as_float(current.get("cloud_cover")),
                "wind_speed": wind_speed,
                "wind_speed_knots": round(wind_speed_knots, 1),
                "wind_direction_deg": _as_float(current.get("wind_direction_10m")),
                "weather_code": _as_int(current.get("weather_code")),
                "observed_at": str(current.get("time") or ""),
            }
        )

    return {
        "ok": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "rows": rows,
        "cols": cols,
        "points": output,
    }


def build_aviation_overlay(bbox: tuple[float, float, float, float]) -> dict[str, Any]:
    south, west, north, east = bbox
    bbox_value = f"{south:.4f},{west:.4f},{north:.4f},{east:.4f}"
    metar = _get_json(
        f"weather:metar:{_bbox_key(bbox)}",
        f"https://aviationweather.gov/api/data/metar?format=geojson&bbox={bbox_value}",
        ttl_seconds=300,
    )
    taf_items = _get_json(
        f"weather:taf:{_bbox_key(bbox)}",
        f"https://aviationweather.gov/api/data/taf?format=json&bbox={bbox_value}",
        ttl_seconds=300,
    )

    taf_by_icao: dict[str, dict[str, Any]] = {}
    if isinstance(taf_items, list):
        for item in taf_items:
            if not isinstance(item, dict):
                continue
            icao = str(item.get("icaoId") or "").strip().upper()
            if icao:
                taf_by_icao[icao] = item

    features: list[dict[str, Any]] = []
    for feature in _feature_list(metar):
        geometry = feature.get("geometry")
        props = dict(feature.get("properties") or {})
        icao = str(props.get("id") or props.get("icaoId") or props.get("site") or "").strip().upper()
        taf = taf_by_icao.pop(icao, None)
        props["icaoId"] = icao
        props["kind"] = "metar-taf" if taf else "metar"
        props["tafRaw"] = str((taf or {}).get("rawTAF") or "")
        props["tafValidFrom"] = str((taf or {}).get("validTimeFrom") or "")
        props["tafValidTo"] = str((taf or {}).get("validTimeTo") or "")
        props["tafName"] = str((taf or {}).get("name") or props.get("site") or icao)
        props["tafForecastCount"] = len((taf or {}).get("fcsts") or [])
        features.append(
            {
                "type": "Feature",
                "geometry": geometry,
                "properties": props,
            }
        )

    for icao, taf in taf_by_icao.items():
        lat = _as_float(taf.get("lat"))
        lng = _as_float(taf.get("lon"))
        if lat is None or lng is None:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [lng, lat],
                },
                "properties": {
                    "icaoId": icao,
                    "site": str(taf.get("name") or icao),
                    "kind": "taf",
                    "rawOb": "",
                    "obsTime": "",
                    "fltcat": "",
                    "wx": "",
                    "tafRaw": str(taf.get("rawTAF") or ""),
                    "tafValidFrom": str(taf.get("validTimeFrom") or ""),
                    "tafValidTo": str(taf.get("validTimeTo") or ""),
                    "tafForecastCount": len(taf.get("fcsts") or []),
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "features": features,
    }


def build_advisory_overlay(bbox: tuple[float, float, float, float]) -> dict[str, Any]:
    isigmet = _get_json(
        "weather:isigmet",
        "https://aviationweather.gov/api/data/isigmet?format=geojson",
        ttl_seconds=600,
    )
    gairmet = _get_json(
        "weather:gairmet",
        "https://aviationweather.gov/api/data/gairmet?format=geojson",
        ttl_seconds=600,
    )

    features: list[dict[str, Any]] = []
    features.extend(_normalize_advisories(_feature_list(isigmet), bbox, "ISIGMET"))
    features.extend(_normalize_advisories(_feature_list(gairmet), bbox, "GAIRMET"))

    return {
        "type": "FeatureCollection",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "features": features,
    }


def _normalize_advisories(
    raw_features: list[dict[str, Any]],
    bbox: tuple[float, float, float, float],
    source: str,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for feature in raw_features:
        if not _feature_intersects_bbox(feature, bbox):
            continue
        props = dict(feature.get("properties") or {})
        hazard = str(props.get("hazard") or props.get("forecast") or props.get("tag") or "").strip()
        title_bits = [source]
        if hazard:
            title_bits.append(hazard)
        title = " · ".join(title_bits)
        props["source"] = source
        props["title"] = title
        props["detail"] = str(props.get("rawSigmet") or props.get("forecast") or props.get("dueTo") or "")
        props["validFrom"] = str(props.get("validTimeFrom") or props.get("issueTime") or "")
        props["validTo"] = str(props.get("validTimeTo") or props.get("validTime") or "")
        items.append(
            {
                "type": "Feature",
                "geometry": feature.get("geometry"),
                "properties": props,
            }
        )
    return items


def _pick_radar_frame(radar_root: dict[str, Any]) -> dict[str, Any] | None:
    for key in ("nowcast", "past"):
        frames = radar_root.get(key)
        if isinstance(frames, list) and frames:
            for frame in reversed(frames):
                if isinstance(frame, dict) and frame.get("path"):
                    return frame
    return None


def configure_gk2a_cache_dir(path: str | Path | None) -> Path | None:
    global _GK2A_CACHE_DIR
    if path is None:
        _GK2A_CACHE_DIR = None
        return None

    target = Path(path).expanduser()
    target.mkdir(parents=True, exist_ok=True)
    _GK2A_CACHE_DIR = target
    return target


def _gk2a_is_http_url(value: str) -> bool:
    normalized = str(value or "").strip().lower()
    return normalized.startswith("http://") or normalized.startswith("https://")


def configure_gk2a_supabase_cache_from_env() -> dict[str, str] | None:
    global _GK2A_SUPABASE_CONFIG, _GK2A_SUPABASE_BUCKET_READY, _GK2A_SUPABASE_LIST_CACHE

    backend = str(os.getenv("DOO_GK2A_CACHE_BACKEND") or "supabase").strip().lower()
    if backend in {"local", "filesystem", "file", "none", "off"}:
        _GK2A_SUPABASE_CONFIG = None
        _GK2A_SUPABASE_BUCKET_READY = False
        _GK2A_SUPABASE_LIST_CACHE = {}
        return None

    supabase_url = str(os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip().rstrip("/")
    service_role_key = str(os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    bucket_name = str(os.getenv("DOO_GK2A_SUPABASE_BUCKET") or GK2A_SUPABASE_DEFAULT_BUCKET).strip()
    if not supabase_url or not service_role_key or not bucket_name or not _gk2a_is_http_url(supabase_url):
        _GK2A_SUPABASE_CONFIG = None
        _GK2A_SUPABASE_BUCKET_READY = False
        _GK2A_SUPABASE_LIST_CACHE = {}
        return None

    _GK2A_SUPABASE_CONFIG = {
        "supabase_url": supabase_url,
        "service_role_key": service_role_key,
        "bucket_name": bucket_name,
    }
    _GK2A_SUPABASE_BUCKET_READY = False
    _GK2A_SUPABASE_LIST_CACHE = {}
    return dict(_GK2A_SUPABASE_CONFIG)


def _gk2a_supabase_enabled() -> bool:
    return bool(_GK2A_SUPABASE_CONFIG)


def _gk2a_supabase_headers(*, content_type: str = "", accept: str = "application/json") -> dict[str, str]:
    config = _GK2A_SUPABASE_CONFIG or {}
    token = str(config.get("service_role_key") or "").strip()
    headers = {
        "apikey": token,
        "Authorization": f"Bearer {token}",
        "Accept": accept,
    }
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _gk2a_supabase_object_path(channel: str, timestamp: str) -> str:
    return f"gk2a/{channel}_{timestamp}.png"


def _gk2a_cache_file(channel: str, timestamp: str) -> Path | None:
    if _GK2A_CACHE_DIR is None:
        return None
    return _GK2A_CACHE_DIR / f"{channel}_{timestamp}.png"


def _gk2a_read_local_png(channel: str, timestamp: str) -> bytes | None:
    path = _gk2a_cache_file(channel, timestamp)
    if path is None or not path.exists():
        return None
    try:
        payload = path.read_bytes()
    except OSError:
        return None
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return payload
    return None


def _gk2a_write_local_png(channel: str, timestamp: str, payload: bytes) -> None:
    path = _gk2a_cache_file(channel, timestamp)
    if path is None:
        return
    try:
        path.write_bytes(payload)
    except OSError:
        return
    _gk2a_trim_cache(channel)


def _gk2a_supabase_ensure_bucket() -> bool:
    global _GK2A_SUPABASE_BUCKET_READY
    if not _gk2a_supabase_enabled():
        return False
    if _GK2A_SUPABASE_BUCKET_READY:
        return True

    config = _GK2A_SUPABASE_CONFIG or {}
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    bucket_name = str(config.get("bucket_name") or "").strip()
    if not supabase_url or not bucket_name:
        return False

    bucket_url = f"{supabase_url}/storage/v1/bucket/{quote(bucket_name, safe='-_.')}"
    check_request = Request(url=bucket_url, method="GET", headers=_gk2a_supabase_headers())
    try:
        with urlopen(check_request, timeout=GK2A_FETCH_TIMEOUT_SECONDS):
            _GK2A_SUPABASE_BUCKET_READY = True
            return True
    except HTTPError as error:
        not_found = error.code == 404
        if not not_found:
            try:
                payload = error.read().decode("utf-8", errors="ignore")
            except Exception:
                payload = ""
            if payload:
                try:
                    parsed = json.loads(payload)
                except json.JSONDecodeError:
                    parsed = {}
                status_code = str(parsed.get("statusCode") or "").strip()
                message = str(parsed.get("message") or parsed.get("error") or "").lower()
                not_found = status_code == "404" or "bucket not found" in message
        if not not_found:
            return False
    except (URLError, TimeoutError):
        return False

    payload = json.dumps({"id": bucket_name, "name": bucket_name, "public": False}).encode("utf-8")
    create_request = Request(
        url=f"{supabase_url}/storage/v1/bucket",
        method="POST",
        data=payload,
        headers=_gk2a_supabase_headers(content_type="application/json"),
    )
    try:
        with urlopen(create_request, timeout=GK2A_FETCH_TIMEOUT_SECONDS):
            _GK2A_SUPABASE_BUCKET_READY = True
            return True
    except HTTPError as error:
        if error.code == 409:
            _GK2A_SUPABASE_BUCKET_READY = True
            return True
        return False
    except (URLError, TimeoutError):
        return False


def _gk2a_supabase_download_png(channel: str, timestamp: str) -> bytes | None:
    if not _gk2a_supabase_enabled() or not _gk2a_supabase_ensure_bucket():
        return None

    config = _GK2A_SUPABASE_CONFIG or {}
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    bucket_name = str(config.get("bucket_name") or "").strip()
    object_path = _gk2a_supabase_object_path(channel, timestamp)
    object_url = f"{supabase_url}/storage/v1/object/{quote(bucket_name, safe='-_.')}/{quote(object_path, safe='-_.~/')}"
    request = Request(url=object_url, method="GET", headers=_gk2a_supabase_headers(accept="*/*"))
    try:
        with urlopen(request, timeout=GK2A_FETCH_TIMEOUT_SECONDS) as response:
            payload = response.read()
    except HTTPError as error:
        if error.code == 403:
            _gk2a_mark_daily_limited()
        return None
    except (URLError, TimeoutError):
        return None

    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return payload
    return None


def _gk2a_supabase_upload_png(channel: str, timestamp: str, payload: bytes) -> None:
    if not _gk2a_supabase_enabled() or not _gk2a_supabase_ensure_bucket():
        return

    config = _GK2A_SUPABASE_CONFIG or {}
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    bucket_name = str(config.get("bucket_name") or "").strip()
    object_path = _gk2a_supabase_object_path(channel, timestamp)
    object_url = f"{supabase_url}/storage/v1/object/{quote(bucket_name, safe='-_.')}/{quote(object_path, safe='-_.~/')}"
    headers = _gk2a_supabase_headers(content_type="image/png", accept="application/json")
    headers["x-upsert"] = "true"
    headers["cache-control"] = "public, max-age=600"
    request = Request(url=object_url, method="POST", data=payload, headers=headers)
    try:
        with urlopen(request, timeout=GK2A_FETCH_TIMEOUT_SECONDS):
            _GK2A_SUPABASE_LIST_CACHE.pop(channel, None)
    except (HTTPError, URLError, TimeoutError):
        return


def _gk2a_supabase_list_timestamps(channel: str) -> list[str]:
    if not _gk2a_supabase_enabled() or not _gk2a_supabase_ensure_bucket():
        return []

    cached = _GK2A_SUPABASE_LIST_CACHE.get(channel)
    if cached and cached[0] > time.time():
        return list(cached[1])

    config = _GK2A_SUPABASE_CONFIG or {}
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    bucket_name = str(config.get("bucket_name") or "").strip()
    list_url = f"{supabase_url}/storage/v1/object/list/{quote(bucket_name, safe='-_.')}"
    body = json.dumps(
        {
            "prefix": "gk2a/",
            "limit": max(20, GK2A_CACHE_KEEP_PER_CHANNEL * 8),
            "offset": 0,
            "sortBy": {"column": "name", "order": "desc"},
        }
    ).encode("utf-8")
    request = Request(
        url=list_url,
        method="POST",
        data=body,
        headers=_gk2a_supabase_headers(content_type="application/json"),
    )
    try:
        with urlopen(request, timeout=GK2A_FETCH_TIMEOUT_SECONDS) as response:
            raw = response.read()
    except HTTPError as error:
        if error.code == 403:
            _gk2a_mark_daily_limited()
        return []
    except (URLError, TimeoutError):
        return []

    try:
        rows = json.loads(raw.decode("utf-8", errors="ignore"))
    except json.JSONDecodeError:
        return []
    if not isinstance(rows, list):
        return []

    prefix = f"{channel}_"
    timestamps: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if "/" in name:
            name = name.rsplit("/", 1)[-1]
        if not name.startswith(prefix) or not name.endswith(".png"):
            continue
        timestamp = name[len(prefix):-4]
        if not GK2A_TIMESTAMP_RE.match(timestamp):
            continue
        timestamps.append(timestamp)

    unique = sorted(set(timestamps), reverse=True)
    _GK2A_SUPABASE_LIST_CACHE[channel] = (time.time() + GK2A_SUPABASE_LIST_TTL_SECONDS, unique)
    return list(unique)


def _gk2a_read_cached_png(channel: str, timestamp: str) -> bytes | None:
    local = _gk2a_read_local_png(channel, timestamp)
    if local is not None:
        return local

    remote = _gk2a_supabase_download_png(channel, timestamp)
    if remote is not None:
        _gk2a_write_local_png(channel, timestamp, remote)
        return remote
    return None


def _gk2a_write_cached_png(channel: str, timestamp: str, payload: bytes) -> None:
    _gk2a_write_local_png(channel, timestamp, payload)
    _gk2a_supabase_upload_png(channel, timestamp, payload)


def sync_gk2a_local_cache_to_supabase(max_files: int = 32) -> int:
    if _GK2A_CACHE_DIR is None or not _gk2a_supabase_enabled() or not _gk2a_supabase_ensure_bucket():
        return 0

    try:
        limit = max(1, int(max_files))
    except (TypeError, ValueError):
        limit = 32

    uploaded = 0
    pattern = re.compile(r"^(vi006|ir105)_(\d{12})\.png$")
    files = sorted(
        _GK2A_CACHE_DIR.glob("*.png"),
        key=lambda item: item.stat().st_mtime if item.exists() else 0.0,
        reverse=True,
    )
    for path in files[:limit]:
        match = pattern.match(path.name)
        if match is None:
            continue
        channel, timestamp = match.group(1), match.group(2)
        try:
            payload = path.read_bytes()
        except OSError:
            continue
        if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
            continue
        _gk2a_supabase_upload_png(channel, timestamp, payload)
        uploaded += 1

    return uploaded


def _gk2a_trim_cache(channel: str) -> None:
    if _GK2A_CACHE_DIR is None:
        return
    files = sorted(_GK2A_CACHE_DIR.glob(f"{channel}_*.png"), reverse=True)
    keep = max(1, GK2A_CACHE_KEEP_PER_CHANNEL)
    for stale in files[keep:]:
        try:
            stale.unlink()
        except OSError:
            continue


def _gk2a_cached_fallback(channel: str, requested_timestamp: str) -> tuple[bytes, str] | None:
    if _GK2A_CACHE_DIR is not None:
        candidates: list[tuple[str, Path]] = []
        for path in _GK2A_CACHE_DIR.glob(f"{channel}_*.png"):
            name = path.stem
            prefix = f"{channel}_"
            if not name.startswith(prefix):
                continue
            timestamp = name[len(prefix):]
            if not GK2A_TIMESTAMP_RE.match(timestamp):
                continue
            candidates.append((timestamp, path))
        if candidates:
            older = [(ts, p) for ts, p in candidates if ts <= requested_timestamp]
            ordered = sorted(older or candidates, key=lambda item: item[0], reverse=True)
            for timestamp, path in ordered:
                try:
                    payload = path.read_bytes()
                except OSError:
                    continue
                if payload.startswith(b"\x89PNG\r\n\x1a\n"):
                    return payload, timestamp

    for timestamp in _gk2a_supabase_list_timestamps(channel):
        if timestamp > requested_timestamp:
            continue
        payload = _gk2a_supabase_download_png(channel, timestamp)
        if payload is None:
            continue
        _gk2a_write_local_png(channel, timestamp, payload)
        return payload, timestamp
    return None


def _gk2a_is_temporarily_blocked() -> bool:
    return _GK2A_BLOCKED_UNTIL_TS > time.time()


def _gk2a_mark_failure(channel: str, timestamp: str, cooldown_seconds: int = GK2A_API_FAILURE_COOLDOWN_SECONDS) -> None:
    key = f"{channel}:{timestamp}"
    _GK2A_FAILURE_CACHE[key] = time.time() + max(1, int(cooldown_seconds))


def _gk2a_failure_active(channel: str, timestamp: str) -> bool:
    key = f"{channel}:{timestamp}"
    expires_at = _GK2A_FAILURE_CACHE.get(key, 0.0)
    if expires_at <= time.time():
        _GK2A_FAILURE_CACHE.pop(key, None)
        return False
    return True


def _gk2a_mark_daily_limited() -> None:
    global _GK2A_BLOCKED_UNTIL_TS
    _GK2A_BLOCKED_UNTIL_TS = time.time() + GK2A_DAILY_LIMIT_COOLDOWN_SECONDS


def _gk2a_mark_temporarily_blocked(cooldown_seconds: int = GK2A_API_FAILURE_COOLDOWN_SECONDS) -> None:
    global _GK2A_BLOCKED_UNTIL_TS
    next_until = time.time() + max(1, int(cooldown_seconds))
    _GK2A_BLOCKED_UNTIL_TS = max(_GK2A_BLOCKED_UNTIL_TS, next_until)


def _gk2a_parse_error_payload(payload: bytes) -> tuple[int, str]:
    try:
        decoded = payload.decode("utf-8", errors="ignore")
        parsed = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return 0, ""
    result = parsed.get("result") if isinstance(parsed, dict) else {}
    if not isinstance(result, dict):
        return 0, ""
    status = result.get("status")
    message = str(result.get("message") or "").strip()
    try:
        status_code = int(status)
    except (TypeError, ValueError):
        status_code = 0
    return status_code, message


def parse_gk2a_capture_datetime(raw: str | None, default_delay_minutes: int = 4) -> datetime:
    value = str(raw or "").strip()
    if not value:
        current = datetime.now(timezone.utc) - timedelta(minutes=default_delay_minutes)
        return current.replace(minute=(current.minute // 2) * 2, second=0, microsecond=0)

    if not GK2A_TIMESTAMP_RE.match(value):
        raise ValueError("date must be yyyymmddHHMM")

    return datetime.strptime(value, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def normalize_gk2a_channel(raw: str | None) -> str:
    channel = str(raw or "ir105").strip().lower()
    if channel in GK2A_CHANNEL_MAP:
        return channel
    raise ValueError("channel must be vi006 or ir105")


def fetch_gk2a_image(
    channel: str,
    capture_utc: datetime,
    *,
    allow_stale_fallback: bool = True,
) -> tuple[bytes, str, str]:
    normalized_channel = normalize_gk2a_channel(channel)
    source_channel = GK2A_CHANNEL_MAP[normalized_channel]
    timestamp = capture_utc.strftime("%Y%m%d%H%M")
    auth_key = str(os.getenv("KMA_APIHUB_AUTH_KEY") or GK2A_DEFAULT_AUTH_KEY).strip()
    if not auth_key:
        raise WeatherProviderError("missing KMA_APIHUB_AUTH_KEY")

    cached = _gk2a_read_cached_png(normalized_channel, timestamp)
    if cached is not None:
        return cached, normalized_channel, timestamp

    if _gk2a_failure_active(normalized_channel, timestamp) or _gk2a_is_temporarily_blocked():
        if allow_stale_fallback:
            fallback = _gk2a_cached_fallback(normalized_channel, timestamp)
            if fallback is not None:
                payload, fallback_timestamp = fallback
                return payload, normalized_channel, fallback_timestamp
        raise WeatherProviderError("gk2a request temporarily throttled")

    url = (
        f"{GK2A_API_BASE_URL}/{source_channel}/KO/image"
        f"?date={timestamp}&authKey={quote(auth_key, safe='')}"
    )

    request = Request(
        url,
        headers={
            "User-Agent": _USER_AGENT,
            "Accept": "image/png,image/*;q=0.9,*/*;q=0.5",
        },
    )
    with _GK2A_FETCH_LOCK:
        cached_after_lock = _gk2a_read_cached_png(normalized_channel, timestamp)
        if cached_after_lock is not None:
            return cached_after_lock, normalized_channel, timestamp

        try:
            with urlopen(request, timeout=GK2A_FETCH_TIMEOUT_SECONDS) as response:
                payload = response.read()
        except HTTPError as error:
            _gk2a_mark_failure(normalized_channel, timestamp)
            if error.code == 404:
                if allow_stale_fallback:
                    fallback = _gk2a_cached_fallback(normalized_channel, timestamp)
                    if fallback is not None:
                        fallback_payload, fallback_timestamp = fallback
                        return fallback_payload, normalized_channel, fallback_timestamp
                raise WeatherProviderError("image not found") from error
            if error.code == 403:
                _gk2a_mark_daily_limited()
            else:
                _gk2a_mark_temporarily_blocked()
            if allow_stale_fallback:
                fallback = _gk2a_cached_fallback(normalized_channel, timestamp)
                if fallback is not None:
                    fallback_payload, fallback_timestamp = fallback
                    return fallback_payload, normalized_channel, fallback_timestamp
            raise WeatherProviderError(f"gk2a request failed: http {error.code}") from error
        except (URLError, TimeoutError) as error:
            _gk2a_mark_failure(normalized_channel, timestamp)
            _gk2a_mark_temporarily_blocked()
            if allow_stale_fallback:
                fallback = _gk2a_cached_fallback(normalized_channel, timestamp)
                if fallback is not None:
                    fallback_payload, fallback_timestamp = fallback
                    return fallback_payload, normalized_channel, fallback_timestamp
            raise WeatherProviderError(f"gk2a request failed: {error}") from error

        if payload.startswith(b"\x89PNG\r\n\x1a\n"):
            _gk2a_write_cached_png(normalized_channel, timestamp, payload)
            return payload, normalized_channel, timestamp

        status_code, message = _gk2a_parse_error_payload(payload)
        _gk2a_mark_failure(normalized_channel, timestamp)
        if status_code == 403:
            _gk2a_mark_daily_limited()
        else:
            _gk2a_mark_temporarily_blocked()
        if allow_stale_fallback:
            fallback = _gk2a_cached_fallback(normalized_channel, timestamp)
            if fallback is not None:
                fallback_payload, fallback_timestamp = fallback
                return fallback_payload, normalized_channel, fallback_timestamp

        detail = message or "invalid gk2a image payload"
        raise WeatherProviderError(detail)


def _sample_grid_points(
    south: float,
    west: float,
    north: float,
    east: float,
    rows: int,
    cols: int,
) -> list[tuple[float, float]]:
    lat_step = (north - south) / (rows - 1) if rows > 1 else 0.0
    lng_step = (east - west) / (cols - 1) if cols > 1 else 0.0
    points: list[tuple[float, float]] = []
    for row in range(rows):
        lat = north - (lat_step * row) if rows > 1 else (south + north) / 2
        for col in range(cols):
            lng = west + (lng_step * col) if cols > 1 else (west + east) / 2
            points.append((round(lat, 4), round(lng, 4)))
    return points


def _bbox_key(bbox: tuple[float, float, float, float]) -> str:
    south, west, north, east = bbox
    return f"{south:.2f}:{west:.2f}:{north:.2f}:{east:.2f}"


def _get_json(cache_key: str, url: str, ttl_seconds: int) -> Any:
    cached = _CACHE.get(cache_key)
    now = time.time()
    if cached and cached[0] > now:
        return cached[1]

    request = Request(
        url,
        headers={
            "User-Agent": _USER_AGENT,
            "Accept": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=18) as response:
            payload = json.load(response)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
        raise WeatherProviderError(str(error)) from error

    _CACHE[cache_key] = (now + ttl_seconds, payload)
    return payload


def _feature_list(data: Any) -> list[dict[str, Any]]:
    features = data.get("features") if isinstance(data, dict) else []
    return features if isinstance(features, list) else []


def _feature_intersects_bbox(feature: dict[str, Any], bbox: tuple[float, float, float, float]) -> bool:
    feature_bbox = _geometry_bbox(feature.get("geometry"))
    if not feature_bbox:
        return False
    f_south, f_west, f_north, f_east = feature_bbox
    south, west, north, east = bbox
    return not (f_east < west or f_west > east or f_north < south or f_south > north)


def _geometry_bbox(geometry: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(geometry, dict):
        return None
    coords = geometry.get("coordinates")
    if coords is None:
        return None

    min_lat = 91.0
    max_lat = -91.0
    min_lng = 181.0
    max_lng = -181.0
    found = False

    for lng, lat in _iter_lon_lat(coords):
        found = True
        min_lat = min(min_lat, lat)
        max_lat = max(max_lat, lat)
        min_lng = min(min_lng, lng)
        max_lng = max(max_lng, lng)

    if not found:
        return None
    return min_lat, min_lng, max_lat, max_lng


def _iter_lon_lat(value: Any):
    if isinstance(value, (list, tuple)):
        if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
            yield float(value[0]), float(value[1])
            return
        for item in value:
            yield from _iter_lon_lat(item)


def _to_knots(value: float | None, unit: str) -> float:
    speed = value or 0.0
    normalized = unit.strip().lower()
    if normalized in {"km/h", "kmh", "kph"}:
        return speed / 1.852
    if normalized in {"m/s", "ms"}:
        return speed * 1.943844
    return speed


def _as_float(value: Any) -> float | None:
    try:
        if value in ("", None):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any) -> int | None:
    try:
        if value in ("", None):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None
