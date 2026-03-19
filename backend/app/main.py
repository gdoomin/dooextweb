import json
import os
import re
import secrets
import shutil
import sys
import hashlib
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request as UrlRequest, urlopen
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel


ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from shared.python_core import POLYGON_ONLY_MESSAGE, build_web_map_html, build_web_map_payload, save_excel
from .weather import (
    WeatherProviderError,
    build_advisory_overlay,
    build_aviation_overlay,
    build_weather_config,
    build_weather_grid,
    parse_bbox_param,
)


APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
ASSETS_DIR = BACKEND_DIR / "assets"
LEGACY_RUNTIME_DIR = BACKEND_DIR / "runtime"


def _prepare_runtime_dir(candidate: Path, label: str) -> Path | None:
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        probe = candidate / ".doo_runtime_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return candidate
    except OSError as error:
        print(
            f"[warn] {label}={candidate} is not writable ({error})",
            file=sys.stderr,
        )
        return None


def _resolve_runtime_dir() -> Path:
    configured = str(os.getenv("DOO_DATA_DIR") or os.getenv("DOO_RUNTIME_DIR") or "").strip()
    if configured:
        candidate = Path(configured).expanduser()
        if not candidate.is_absolute():
            candidate = (BACKEND_DIR / candidate).resolve()
        prepared = _prepare_runtime_dir(candidate, "DOO_DATA_DIR")
        if prepared is not None:
            return prepared

    auto_candidates: list[tuple[str, Path]] = []
    railway_mount = str(os.getenv("RAILWAY_VOLUME_MOUNT_PATH") or "").strip()
    if railway_mount:
        auto_candidates.append(("RAILWAY_VOLUME_MOUNT_PATH", Path(railway_mount).expanduser() / "dooextweb"))
    auto_candidates.append(("AUTO_DATA_DIR", Path("/data/dooextweb")))

    for label, candidate in auto_candidates:
        prepared = _prepare_runtime_dir(candidate, label)
        if prepared is not None:
            return prepared

    return LEGACY_RUNTIME_DIR


RUNTIME_DIR = _resolve_runtime_dir()
JOBS_DIR = RUNTIME_DIR / "jobs"
VIEWER_STATE_DIR = RUNTIME_DIR / "viewer_states"
USER_HISTORY_DIR = RUNTIME_DIR / "user_history"
MAP_TEMPLATE_PATH = ASSETS_DIR / "web_map_template.html"
MAP_LAYER_DATA_PATH = ASSETS_DIR / "map_layers.json"
HTML2CANVAS_PATH = ASSETS_DIR / "html2canvas.min.js"
BANNER_PATH = ASSETS_DIR / "doogpx.png"
FONTS_DIR = ASSETS_DIR / "fonts"
POPUP_NOTICE_PATH = RUNTIME_DIR / "popup_notice.json"

DEFAULT_POPUP_NOTICE_MESSAGE = "지금 말도 안되게 대낮에 업데이트 중입니다. 죄송합니다."

USER_HISTORY_LIMIT = 50
SUPABASE_HTTP_TIMEOUT_SECONDS = 10
NOTAM_DEFAULT_SUPABASE_URL = "https://zxocgwaogeyhwkefqmts.supabase.co"
NOTAM_DEFAULT_SUPABASE_ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp4b2Nnd2FvZ2V5aHdrZWZxbXRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NDgxNjAsImV4cCI6MjA4NzQyNDE2MH0."
    "YTryJaDm_pmR8tNuuc_HOsRvuDUo29hLCwTz8sQQt_8"
)
NOTAM_MAX_LIMIT = 3000
NOTAM_DEFAULT_LIMIT = 1200
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class PasswordResetRequest(BaseModel):
    email: str
    redirect_to: str | None = None


class ClientConvertPayload(BaseModel):
    filename: str
    project_name: str
    mode: Literal["linestring", "polygon"]
    result_count: int
    text_output: str
    map_payload: dict
    results: list[dict]


class PopupNoticeAuthPayload(BaseModel):
    password: str


class PopupNoticeUpdatePayload(BaseModel):
    password: str
    message: str
    enabled: bool = False

for path in (JOBS_DIR, VIEWER_STATE_DIR, USER_HISTORY_DIR):
    path.mkdir(parents=True, exist_ok=True)

FONTS_DIR.mkdir(parents=True, exist_ok=True)


def _same_path(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve()
    except Exception:
        return str(a) == str(b)


def _migrate_legacy_runtime_data() -> None:
    if _same_path(RUNTIME_DIR, LEGACY_RUNTIME_DIR):
        return

    buckets = ("jobs", "viewer_states", "user_history")
    for bucket in buckets:
        src_dir = LEGACY_RUNTIME_DIR / bucket
        dst_dir = RUNTIME_DIR / bucket
        if not src_dir.exists() or not src_dir.is_dir():
            continue
        dst_dir.mkdir(parents=True, exist_ok=True)
        for src_file in src_dir.glob("*.json"):
            dst_file = dst_dir / src_file.name
            if dst_file.exists():
                continue
            try:
                shutil.copy2(src_file, dst_file)
            except OSError:
                continue

    src_popup = LEGACY_RUNTIME_DIR / "popup_notice.json"
    dst_popup = RUNTIME_DIR / "popup_notice.json"
    if src_popup.exists() and not dst_popup.exists():
        try:
            shutil.copy2(src_popup, dst_popup)
        except OSError:
            pass


_migrate_legacy_runtime_data()


def _allowed_origins() -> list[str]:
    raw = os.getenv("DOO_WEB_CORS_ORIGINS", "")
    if raw.strip():
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    return ["http://127.0.0.1:3000", "http://localhost:3000"]


app = FastAPI(title="DOO Extractor Web API", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _job_path(job_id: str) -> Path:
    return JOBS_DIR / f"{job_id}.json"


def _viewer_state_path(job_id: str) -> Path:
    return VIEWER_STATE_DIR / f"{job_id}.json"


def _user_history_path(user_id: str) -> Path:
    return USER_HISTORY_DIR / f"{user_id}.json"


def _user_email_history_path(user_email: str) -> Path:
    normalized = _normalize_user_email(user_email)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return USER_HISTORY_DIR / f"email_{digest}.json"


def _history_paths_for_identity(user_id: str, user_email: str) -> list[Path]:
    paths: list[Path] = []
    normalized_user_id = _normalize_user_identity(user_id)
    normalized_email = _normalize_user_email(user_email)

    if normalized_user_id:
        paths.append(_user_history_path(normalized_user_id))
    if normalized_email:
        paths.append(_user_email_history_path(normalized_email))

    unique_paths: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique_paths.append(path)
    return unique_paths


def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data
    except Exception:
        return default


def _save_json(path: Path, data) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)


def _default_popup_notice() -> dict:
    return {
        "enabled": False,
        "message": DEFAULT_POPUP_NOTICE_MESSAGE,
        "updated_at": "",
    }


def _coerce_bool(value, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"", "0", "false", "off", "no", "n", "disabled"}:
            return False
        if normalized in {"1", "true", "on", "yes", "y", "enabled"}:
            return True
        return default
    return default


def _normalize_popup_notice(data: dict | None) -> dict:
    baseline = _default_popup_notice()
    payload = data if isinstance(data, dict) else {}

    message = str(payload.get("message") or "").strip()
    enabled = _coerce_bool(payload.get("enabled", baseline["enabled"]), bool(baseline["enabled"]))
    updated_at = str(payload.get("updated_at") or "").strip()

    return {
        "enabled": enabled,
        "message": message or baseline["message"],
        "updated_at": updated_at,
    }


def _load_popup_notice() -> dict:
    raw = _load_json(POPUP_NOTICE_PATH, None)
    return _normalize_popup_notice(raw if isinstance(raw, dict) else None)


def _save_popup_notice(message: str, enabled: bool) -> dict:
    notice = {
        "enabled": bool(enabled),
        "message": str(message or "").strip() or DEFAULT_POPUP_NOTICE_MESSAGE,
        "updated_at": _utc_now_iso(),
    }
    _save_json(POPUP_NOTICE_PATH, notice)
    return notice


def _admin_popup_password() -> str:
    return str(os.getenv("DOO_ADMIN_POPUP_PASSWORD") or os.getenv("DOO_ADMIN_PASSWORD") or "").strip()


def _require_popup_admin_password(password: str) -> None:
    configured = _admin_popup_password()
    if not configured:
        raise HTTPException(status_code=503, detail="관리자 비밀번호가 설정되지 않았습니다.")
    if not secrets.compare_digest(str(password or ""), configured):
        raise HTTPException(status_code=401, detail="비밀번호가 일치하지 않습니다.")


def _load_map_layers() -> dict:
    data = _load_json(MAP_LAYER_DATA_PATH, {"layers": []})
    layers = data.get("layers", []) if isinstance(data, dict) else []
    if not isinstance(layers, list):
        layers = []
    return {"layers": layers}


def _build_map_layer_catalog() -> list[dict]:
    catalog: list[dict] = []
    for layer in _load_map_layers().get("layers", []):
        if not isinstance(layer, dict):
            continue
        key = str(layer.get("key", "")).strip()
        label = str(layer.get("label", "")).strip()
        if not key or not label:
            continue
        features = layer.get("features", [])
        if not isinstance(features, list):
            features = []
        catalog.append(
            {
                "key": key,
                "label": label,
                "default_color": str(layer.get("default_color", "#4466CC")).strip() or "#4466CC",
                "count": len(features),
            }
        )
    return catalog


def _load_job(job_id: str) -> dict:
    data = _load_json(_job_path(job_id), {})
    if not isinstance(data, dict) or not data:
        raise HTTPException(status_code=404, detail="작업 데이터를 찾을 수 없습니다.")
    return data


def _viewer_html(job_id: str, payload: dict) -> str:
    html = build_web_map_html(payload, str(MAP_TEMPLATE_PATH))
    replacements = {
        'src="/html2canvas.min.js"': 'src="/api/assets/html2canvas.min.js"',
        'src="/doogpx.png"': 'src="/api/assets/doogpx.png"',
        "fetch('/viewer-state'": f"fetch('/api/viewer/{job_id}/viewer-state'",
        "fetch('/layers.json'": f"fetch('/api/viewer/{job_id}/layers.json'",
    }
    for source, target in replacements.items():
        html = html.replace(source, target)
    return html


def _download_filename(job: dict, suffix: str) -> str:
    base = Path(job.get("project_name") or "DOO_EXTRACTOR").stem
    return f"{base}_DMS{suffix}"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_user_identity(value: str | None) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "", str(value or "").strip())
    return cleaned[:128]


def _normalize_user_email(value: str | None) -> str:
    return str(value or "").strip().lower()[:320]


def _is_http_url(value: str | None) -> bool:
    parsed = urlparse(str(value or "").strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _supabase_auth_config() -> tuple[str, str]:
    supabase_url = str(os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip().rstrip("/")
    service_role_key = str(os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()

    if not supabase_url or not service_role_key:
        raise HTTPException(status_code=503, detail="서버 Supabase 인증 설정이 누락되었습니다.")
    if not _is_http_url(supabase_url):
        raise HTTPException(status_code=503, detail="SUPABASE_URL 형식이 올바르지 않습니다.")

    return supabase_url, service_role_key


def _extract_supabase_error_message(raw: bytes) -> str:
    if not raw:
        return ""

    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        return ""

    if isinstance(payload, dict):
        return str(
            payload.get("msg")
            or payload.get("error_description")
            or payload.get("message")
            or payload.get("error")
            or ""
        ).strip()
    return ""


def _supabase_request_json(method: str, url: str, service_role_key: str, payload: dict | None = None) -> dict:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"

    request = UrlRequest(url=url, method=method.upper(), headers=headers, data=body)
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read()
    except HTTPError as error:
        detail = _extract_supabase_error_message(error.read())
        if error.code in {401, 403}:
            raise HTTPException(status_code=503, detail="서버 Supabase 관리자 키가 올바르지 않습니다.") from error
        if error.code == 429:
            raise HTTPException(status_code=429, detail="요청이 많습니다. 잠시 후 다시 시도해 주세요.") from error
        raise HTTPException(status_code=502, detail=detail or "Supabase 인증 요청에 실패했습니다.") from error
    except URLError as error:
        raise HTTPException(status_code=502, detail="Supabase 인증 서버에 연결하지 못했습니다.") from error

    if not raw:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _supabase_user_exists(supabase_url: str, service_role_key: str, email: str) -> bool:
    query = urlencode({"email": email})
    payload = _supabase_request_json("GET", f"{supabase_url}/auth/v1/admin/users?{query}", service_role_key)
    users = payload.get("users", []) if isinstance(payload, dict) else []
    if not isinstance(users, list):
        return False

    for user in users:
        if not isinstance(user, dict):
            continue
        user_email = str(user.get("email") or "").strip().lower()
        if user_email == email:
            return True
    return False


def _send_supabase_password_reset(supabase_url: str, service_role_key: str, email: str, redirect_to: str | None) -> None:
    url = f"{supabase_url}/auth/v1/recover"
    if redirect_to:
        url = f"{url}?{urlencode({'redirect_to': redirect_to})}"
    _supabase_request_json("POST", url, service_role_key, {"email": email})


def _notam_supabase_config() -> tuple[str, str]:
    supabase_url = str(
        os.getenv("DOO_NOTAM_SUPABASE_URL")
        or os.getenv("NOTAM_SUPABASE_URL")
        or os.getenv("NEXT_PUBLIC_NOTAM_SUPABASE_URL")
        or NOTAM_DEFAULT_SUPABASE_URL
        or ""
    ).strip().rstrip("/")
    api_key = str(
        os.getenv("DOO_NOTAM_SUPABASE_ANON_KEY")
        or os.getenv("NOTAM_SUPABASE_ANON_KEY")
        or os.getenv("NEXT_PUBLIC_NOTAM_SUPABASE_ANON_KEY")
        or NOTAM_DEFAULT_SUPABASE_ANON_KEY
        or ""
    ).strip()

    if not supabase_url or not api_key:
        raise HTTPException(status_code=503, detail="NOTAM Supabase 설정이 누락되었습니다.")
    if not _is_http_url(supabase_url):
        raise HTTPException(status_code=503, detail="NOTAM Supabase URL 형식이 올바르지 않습니다.")
    return supabase_url, api_key


def _supabase_request_payload(method: str, url: str, api_key: str, payload: dict | None = None):
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"

    request = UrlRequest(url=url, method=method.upper(), headers=headers, data=body)
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read()
    except HTTPError as error:
        detail = _extract_supabase_error_message(error.read())
        if error.code in {401, 403}:
            raise HTTPException(status_code=503, detail="NOTAM Supabase API 키가 올바르지 않습니다.") from error
        if error.code == 404:
            raise HTTPException(status_code=404, detail=detail or "NOTAM 데이터 소스를 찾지 못했습니다.") from error
        if error.code == 429:
            raise HTTPException(status_code=429, detail="NOTAM 요청이 많습니다. 잠시 후 다시 시도해 주세요.") from error
        raise HTTPException(status_code=502, detail=detail or "NOTAM Supabase 요청에 실패했습니다.") from error
    except URLError as error:
        raise HTTPException(status_code=502, detail="NOTAM Supabase 서버에 연결하지 못했습니다.") from error

    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


def _normalize_notam_series(value: str | None, fallback_notam_id: str | None = None) -> str:
    raw = str(value or "").strip().upper()
    if raw:
        return raw[0]
    fallback = str(fallback_notam_id or "").strip().upper()
    return fallback[:1]


def _notam_group_key(series: str) -> str:
    if series in {"D", "E"}:
        return "de"
    if series in {"A", "C", "G", "Z"}:
        return "acgz"
    return ""


def _extract_notam_airport(content: str) -> str:
    match = re.search(r"\bA\)\s*([A-Z0-9]{4})\b", str(content or "").upper())
    if not match:
        return ""
    return match.group(1)


def _notam_query_items(bbox: tuple[float, float, float, float] | None, limit: int) -> list[tuple[str, str]]:
    items: list[tuple[str, str]] = [
        ("select", "id,notam_id,content,lat,lng,created_at,series,start_date,end_date"),
        ("order", "created_at.desc"),
        ("limit", str(limit)),
    ]
    if bbox is not None:
        south, west, north, east = bbox
        items.extend(
            [
                ("lat", f"gte.{south:.6f}"),
                ("lat", f"lte.{north:.6f}"),
            ]
        )
        if west <= east:
            items.extend(
                [
                    ("lng", f"gte.{west:.6f}"),
                    ("lng", f"lte.{east:.6f}"),
                ]
            )
    return items


def _fetch_notam_rows(supabase_url: str, api_key: str, bbox: tuple[float, float, float, float] | None, limit: int) -> list[dict]:
    raw_tables = str(os.getenv("DOO_NOTAM_TABLES") or os.getenv("DOO_NOTAM_TABLE") or "notam_scraper,notams")
    table_candidates = [item.strip() for item in raw_tables.split(",") if item.strip()]
    if not table_candidates:
        table_candidates = ["notams"]

    query = urlencode(_notam_query_items(bbox, limit), doseq=True)
    last_error: HTTPException | None = None
    for table_name in table_candidates:
        url = f"{supabase_url}/rest/v1/{table_name}?{query}"
        try:
            payload = _supabase_request_payload("GET", url, api_key)
        except HTTPException as error:
            if error.status_code == 404:
                last_error = error
                continue
            raise
        if isinstance(payload, list):
            return [row for row in payload if isinstance(row, dict)]
        if isinstance(payload, dict):
            data = payload.get("data")
            if isinstance(data, list):
                return [row for row in data if isinstance(row, dict)]
            return []

    if last_error is not None:
        raise HTTPException(status_code=404, detail="NOTAM 테이블(notam_scraper/notams)을 찾지 못했습니다.")
    return []


def _request_user_identity(request: Request, *, required: bool = False) -> tuple[str, str]:
    user_id = _normalize_user_identity(request.headers.get("X-DOO-USER-ID"))
    user_email = _normalize_user_email(request.headers.get("X-DOO-USER-EMAIL"))
    if required and not user_id and not user_email:
        raise HTTPException(status_code=401, detail="login required")
    return user_id, user_email


def _job_history_entry(job: dict) -> dict:
    return {
        "job_id": str(job.get("job_id") or ""),
        "filename": str(job.get("filename") or ""),
        "project_name": str(job.get("project_name") or ""),
        "mode": str(job.get("mode") or ""),
        "result_count": int(job.get("result_count") or 0),
        "uploaded_at": str(job.get("created_at") or ""),
    }


def _record_user_history(job: dict) -> None:
    user_id = _normalize_user_identity(str(job.get("user_id") or ""))
    user_email = _normalize_user_email(str(job.get("user_email") or ""))
    history_paths = _history_paths_for_identity(user_id, user_email)
    if not history_paths:
        return
    entry = _job_history_entry(job)
    for path in history_paths:
        existing = _load_json(path, [])
        items = existing if isinstance(existing, list) else []
        next_items = [entry]
        next_items.extend(item for item in items if isinstance(item, dict) and item.get("job_id") != entry["job_id"])
        _save_json(path, next_items[:USER_HISTORY_LIMIT])


def _load_user_history(user_id: str, user_email: str = "") -> list[dict]:
    history_paths = _history_paths_for_identity(user_id, user_email)
    if not history_paths:
        return []

    merged: list[dict] = []
    seen_job_ids: set[str] = set()
    for path in history_paths:
        items = _load_json(path, [])
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            job_id = str(item.get("job_id") or "").strip()
            if job_id and job_id in seen_job_ids:
                continue
            if job_id:
                seen_job_ids.add(job_id)
            merged.append(item)

    merged.sort(key=lambda item: str(item.get("uploaded_at") or ""), reverse=True)
    return merged[:USER_HISTORY_LIMIT]


def _job_response(job: dict, base_url: str) -> dict:
    job_id = str(job.get("job_id") or "")
    return {
        "ok": True,
        "filename": str(job.get("filename") or ""),
        "project_name": str(job.get("project_name") or ""),
        "mode": str(job.get("mode") or ""),
        "result_count": int(job.get("result_count") or 0),
        "text_output": str(job.get("text_output") or ""),
        "map_payload": job.get("map_payload") or {},
        "results": job.get("results") or [],
        "job_id": job_id,
        "viewer_url": f"{base_url}/api/viewer/{job_id}",
        "txt_download_url": f"{base_url}/api/download/{job_id}/txt",
        "xlsx_download_url": f"{base_url}/api/download/{job_id}/xlsx",
    }


def _external_base_url(request: Request) -> str:
    forwarded_proto = str(request.headers.get("X-Forwarded-Proto") or request.url.scheme).split(",")[0].strip()
    forwarded_host = str(request.headers.get("X-Forwarded-Host") or request.headers.get("Host") or request.url.netloc).split(",")[0].strip()
    if forwarded_host:
        return f"{forwarded_proto}://{forwarded_host}"
    return str(request.base_url).rstrip("/")


@app.get("/health")
def health():
    return {"ok": True, "service": "doo-extractor-web"}


@app.get("/api/popup-notice")
def get_popup_notice():
    return JSONResponse(_load_popup_notice())


@app.post("/api/admin/popup-notice/verify")
def verify_popup_notice_admin(payload: PopupNoticeAuthPayload):
    _require_popup_admin_password(payload.password)
    return JSONResponse({"ok": True, "notice": _load_popup_notice()})


@app.post("/api/admin/popup-notice")
def update_popup_notice(payload: PopupNoticeUpdatePayload):
    _require_popup_admin_password(payload.password)

    message = str(payload.message or "").strip()
    if len(message) > 500:
        raise HTTPException(status_code=400, detail="팝업 문구는 500자 이하로 입력해 주세요.")

    notice = _save_popup_notice(message, payload.enabled)
    return JSONResponse({"ok": True, "notice": notice})


@app.post("/api/convert")
async def convert_kml(request: Request, payload: ClientConvertPayload):
    project_name = Path(payload.project_name or payload.filename or "upload").stem
    mode = payload.mode
    results = payload.results if isinstance(payload.results, list) else []
    text_output = str(payload.text_output or "").strip()
    map_payload = payload.map_payload if isinstance(payload.map_payload, dict) else {}

    if mode == "linestring" and not results:
        raise HTTPException(status_code=400, detail="Converted results are empty.")

    if not map_payload or map_payload.get("mode") != mode:
        map_payload = build_web_map_payload(results, project_name, mode, _build_map_layer_catalog())
    else:
        map_payload = dict(map_payload)
        map_payload.setdefault("project_name", project_name)
        map_payload.setdefault("mode", mode)
        if mode == "linestring":
            map_payload.setdefault("results", results)
            map_payload.setdefault("polygons", [])
        else:
            map_payload.setdefault("results", [])
            map_payload.setdefault("polygons", [])
        layer_catalog = _build_map_layer_catalog()
        map_payload["layer_catalog"] = layer_catalog
        map_payload["has_layers"] = bool(layer_catalog)
        map_payload.setdefault("default_gray_map", False)

    if not text_output:
        text_output = POLYGON_ONLY_MESSAGE if mode == "polygon" else "No formatted text was provided."

    if mode == "polygon":
        polygons = map_payload.get("polygons", [])
        result_count = len(polygons) if isinstance(polygons, list) else len(results)
    else:
        result_count = max(int(payload.result_count or 0), len(results))

    job_id = uuid4().hex
    base_url = _external_base_url(request)
    user_id, user_email = _request_user_identity(request)

    job_data = {
        "job_id": job_id,
        "filename": payload.filename,
        "project_name": project_name,
        "mode": mode,
        "result_count": result_count,
        "text_output": text_output,
        "map_payload": map_payload,
        "results": results,
        "created_at": _utc_now_iso(),
        "user_id": user_id,
        "user_email": user_email,
    }
    _save_json(_job_path(job_id), job_data)
    _record_user_history(job_data)

    return _job_response(job_data, base_url)


@app.post("/api/auth/password-reset/request")
async def request_password_reset(payload: PasswordResetRequest):
    email = _normalize_user_email(payload.email).lower()
    if not email or not EMAIL_PATTERN.match(email):
        raise HTTPException(status_code=400, detail="유효한 이메일을 입력해 주세요.")

    redirect_to = str(payload.redirect_to or "").strip()
    if redirect_to and not _is_http_url(redirect_to):
        raise HTTPException(status_code=400, detail="redirect_to URL 형식이 올바르지 않습니다.")

    supabase_url, service_role_key = _supabase_auth_config()
    if not _supabase_user_exists(supabase_url, service_role_key, email):
        raise HTTPException(status_code=404, detail="가입되지 않은 이메일입니다.")

    _send_supabase_password_reset(supabase_url, service_role_key, email, redirect_to or None)
    return {"ok": True}


@app.get("/api/download/{job_id}/txt")
def download_txt(job_id: str):
    job = _load_job(job_id)
    content = (job.get("text_output") or "").encode("utf-8-sig")
    filename = _download_filename(job, ".txt")
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(BytesIO(content), media_type="text/plain; charset=utf-8", headers=headers)


@app.get("/api/download/{job_id}/xlsx")
def download_xlsx(job_id: str):
    job = _load_job(job_id)
    if job.get("mode") == "polygon":
        raise HTTPException(status_code=400, detail=POLYGON_ONLY_MESSAGE)

    with NamedTemporaryFile(delete=False, suffix=".xlsx") as temp_file:
        temp_path = Path(temp_file.name)

    try:
        save_excel(job.get("results") or [], str(temp_path), str(job.get("project_name") or ""), str(job.get("mode") or "linestring"))
        content = temp_path.read_bytes()
    finally:
        temp_path.unlink(missing_ok=True)

    filename = _download_filename(job, ".xlsx")
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(
        BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.get("/api/viewer/{job_id}", response_class=HTMLResponse)
def get_viewer(job_id: str, request: Request):
    job = _load_job(job_id)
    payload = dict(job["map_payload"])

    preview_gate = str(request.query_params.get("preview_gate", "")).lower() in {"1", "true", "yes", "on"}
    if preview_gate:
        payload["preview_gate"] = True
        payload["signup_url"] = request.query_params.get("signup_url") or f"{_allowed_origins()[0]}/login?next=/"

    return HTMLResponse(_viewer_html(job_id, payload))


@app.get("/api/viewer/{job_id}/viewer-state")
def get_viewer_state(job_id: str):
    _load_job(job_id)
    data = _load_json(_viewer_state_path(job_id), {})
    return JSONResponse(data if isinstance(data, dict) else {})


@app.post("/api/viewer/{job_id}/viewer-state")
async def save_viewer_state(job_id: str, request: Request):
    _load_job(job_id)
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="viewer state는 객체여야 합니다.")
    _save_json(_viewer_state_path(job_id), payload)
    return {"ok": True}


@app.get("/api/viewer/{job_id}/layers.json")
def get_layers(job_id: str):
    _load_job(job_id)
    return JSONResponse(_load_map_layers())


@app.get("/api/notam")
def get_notam_overlay(request: Request):
    bbox_param = str(request.query_params.get("bbox") or "").strip()
    bbox: tuple[float, float, float, float] | None = None
    if bbox_param:
        try:
            bbox = parse_bbox_param(bbox_param)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    try:
        requested_limit = int(request.query_params.get("limit", str(NOTAM_DEFAULT_LIMIT)))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="limit 값이 올바르지 않습니다.") from error
    limit = max(1, min(requested_limit, NOTAM_MAX_LIMIT))

    supabase_url, api_key = _notam_supabase_config()
    rows = _fetch_notam_rows(supabase_url, api_key, bbox=bbox, limit=limit)

    items: list[dict] = []
    counts = {"de": 0, "acgz": 0}
    for row in rows:
        notam_id = str(row.get("notam_id") or "").strip()
        series = _normalize_notam_series(str(row.get("series") or ""), notam_id)
        group_key = _notam_group_key(series)
        if not group_key:
            continue

        try:
            lat = float(row.get("lat"))
            lng = float(row.get("lng"))
        except (TypeError, ValueError):
            continue
        if lat < -90 or lat > 90 or lng < -180 or lng > 180:
            continue

        content = str(row.get("content") or "")
        item = {
            "id": row.get("id"),
            "notam_id": notam_id,
            "series": series,
            "group": group_key,
            "lat": lat,
            "lng": lng,
            "start_date": str(row.get("start_date") or ""),
            "end_date": str(row.get("end_date") or ""),
            "created_at": str(row.get("created_at") or ""),
            "airport": _extract_notam_airport(content),
            "content": content,
        }
        items.append(item)
        counts[group_key] += 1

    return JSONResponse(
        {
            "ok": True,
            "source": "supabase",
            "total": len(items),
            "counts": counts,
            "items": items,
            "fetched_at": _utc_now_iso(),
        }
    )


@app.get("/api/history")
def get_history(request: Request):
    user_id, user_email = _request_user_identity(request, required=True)
    return JSONResponse({"items": _load_user_history(user_id, user_email)})


@app.get("/api/history/{job_id}")
def get_history_item(job_id: str, request: Request):
    user_id, user_email = _request_user_identity(request, required=True)
    job = _load_job(job_id)
    owner_id = _normalize_user_identity(str(job.get("user_id") or ""))
    owner_email = _normalize_user_email(str(job.get("user_email") or ""))
    request_email = _normalize_user_email(user_email)

    matches_id = bool(user_id) and owner_id == user_id
    matches_email = bool(request_email) and bool(owner_email) and owner_email == request_email
    if not (matches_id or matches_email):
        raise HTTPException(status_code=404, detail="history item not found")
    return JSONResponse(_job_response(job, _external_base_url(request)))


@app.get("/api/assets/html2canvas.min.js")
def get_html2canvas():
    if not HTML2CANVAS_PATH.exists():
        raise HTTPException(status_code=404, detail="html2canvas 자산을 찾을 수 없습니다.")
    return FileResponse(HTML2CANVAS_PATH, media_type="application/javascript")


@app.get("/api/assets/doogpx.png")
def get_banner():
    if not BANNER_PATH.exists():
        raise HTTPException(status_code=404, detail="배너 이미지를 찾을 수 없습니다.")
    return FileResponse(BANNER_PATH, media_type="image/png")


@app.get("/api/assets/fonts/{font_file:path}")
def get_font_asset(font_file: str):
    requested = Path(font_file)
    if requested.is_absolute() or any(part in {"..", ""} for part in requested.parts):
        raise HTTPException(status_code=404, detail="font not found")

    try:
        font_path = (FONTS_DIR / requested).resolve(strict=True)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="font not found")

    try:
        font_path.relative_to(FONTS_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=404, detail="font not found")

    media_type = {
        ".ttf": "font/ttf",
        ".otf": "font/otf",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
    }.get(font_path.suffix.lower(), "application/octet-stream")

    return FileResponse(font_path, media_type=media_type)


@app.get("/api/weather/config")
def get_weather_config():
    try:
        return JSONResponse(build_weather_config())
    except WeatherProviderError as error:
        raise HTTPException(status_code=502, detail=f"weather config unavailable: {error}") from error


@app.get("/api/weather/grid")
def get_weather_grid(request: Request):
    try:
        bbox = parse_bbox_param(request.query_params.get("bbox"))
        rows = int(request.query_params.get("rows", "4"))
        cols = int(request.query_params.get("cols", "5"))
        return JSONResponse(build_weather_grid(bbox, rows=rows, cols=cols))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except WeatherProviderError as error:
        raise HTTPException(status_code=502, detail=f"weather grid unavailable: {error}") from error


@app.get("/api/weather/aviation")
def get_weather_aviation(request: Request):
    try:
        bbox = parse_bbox_param(request.query_params.get("bbox"))
        return JSONResponse(build_aviation_overlay(bbox))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except WeatherProviderError as error:
        raise HTTPException(status_code=502, detail=f"aviation weather unavailable: {error}") from error


@app.get("/api/weather/advisories")
def get_weather_advisories(request: Request):
    try:
        bbox = parse_bbox_param(request.query_params.get("bbox"))
        return JSONResponse(build_advisory_overlay(bbox))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except WeatherProviderError as error:
        raise HTTPException(status_code=502, detail=f"advisory weather unavailable: {error}") from error
