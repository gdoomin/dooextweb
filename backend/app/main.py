import json
import os
import re
import sys
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request as UrlRequest, urlopen
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel


ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from shared.python_core import POLYGON_ONLY_MESSAGE, build_web_map_html, build_web_map_payload, format_text, parse_kml, save_excel
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
RUNTIME_DIR = BACKEND_DIR / "runtime"
JOBS_DIR = RUNTIME_DIR / "jobs"
VIEWER_STATE_DIR = RUNTIME_DIR / "viewer_states"
USER_HISTORY_DIR = RUNTIME_DIR / "user_history"
MAP_TEMPLATE_PATH = ASSETS_DIR / "web_map_template.html"
MAP_LAYER_DATA_PATH = ASSETS_DIR / "map_layers.json"
HTML2CANVAS_PATH = ASSETS_DIR / "html2canvas.min.js"
BANNER_PATH = ASSETS_DIR / "doogpx.png"

USER_HISTORY_LIMIT = 50
SUPABASE_HTTP_TIMEOUT_SECONDS = 10
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class PasswordResetRequest(BaseModel):
    email: str
    redirect_to: str | None = None

for path in (JOBS_DIR, VIEWER_STATE_DIR, USER_HISTORY_DIR):
    path.mkdir(parents=True, exist_ok=True)


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
    return str(value or "").strip()[:320]


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


def _request_user_identity(request: Request, *, required: bool = False) -> tuple[str, str]:
    user_id = _normalize_user_identity(request.headers.get("X-DOO-USER-ID"))
    user_email = _normalize_user_email(request.headers.get("X-DOO-USER-EMAIL"))
    if required and not user_id:
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
    if not user_id:
        return
    path = _user_history_path(user_id)
    existing = _load_json(path, [])
    items = existing if isinstance(existing, list) else []
    entry = _job_history_entry(job)
    next_items = [entry]
    next_items.extend(item for item in items if isinstance(item, dict) and item.get("job_id") != entry["job_id"])
    _save_json(path, next_items[:USER_HISTORY_LIMIT])


def _load_user_history(user_id: str) -> list[dict]:
    items = _load_json(_user_history_path(user_id), [])
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


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


@app.post("/api/convert")
async def convert_kml(request: Request, file: UploadFile = File(...)):
    suffix = Path(file.filename or "upload.kml").suffix.lower() or ".kml"
    if suffix != ".kml":
        raise HTTPException(status_code=400, detail="현재 MVP는 KML 파일만 지원합니다.")

    with NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        temp_path = Path(temp_file.name)
        temp_file.write(await file.read())

    try:
        results, error, mode = parse_kml(str(temp_path))
        if error or not results or not mode:
            raise HTTPException(status_code=400, detail=error or "변환에 실패했습니다.")

        project_name = Path(file.filename or temp_path.name).stem
        map_payload = build_web_map_payload(results, project_name, mode, _build_map_layer_catalog())
        text_output = format_text(results, project_name, mode)
        job_id = uuid4().hex
        base_url = _external_base_url(request)
        user_id, user_email = _request_user_identity(request)

        job_data = {
            "job_id": job_id,
            "filename": file.filename,
            "project_name": project_name,
            "mode": mode,
            "result_count": len(results),
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
    finally:
        temp_path.unlink(missing_ok=True)


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


@app.get("/api/history")
def get_history(request: Request):
    user_id, _user_email = _request_user_identity(request, required=True)
    return JSONResponse({"items": _load_user_history(user_id)})


@app.get("/api/history/{job_id}")
def get_history_item(job_id: str, request: Request):
    user_id, _user_email = _request_user_identity(request, required=True)
    job = _load_job(job_id)
    if _normalize_user_identity(str(job.get("user_id") or "")) != user_id:
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
