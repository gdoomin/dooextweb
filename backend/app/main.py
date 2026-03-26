import json
import os
import re
import secrets
import shutil
import sys
import hashlib
import threading
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, urlencode, urlparse
from urllib.request import Request as UrlRequest, urlopen
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
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
USER_ACTIVITY_DIR = RUNTIME_DIR / "user_activity"
USER_BILLING_DIR = RUNTIME_DIR / "user_billing"
PAYMENT_ORDER_DIR = RUNTIME_DIR / "payment_orders"
PAYMENT_EVENT_DIR = RUNTIME_DIR / "payment_events"
PAYMENT_USAGE_DIR = RUNTIME_DIR / "payment_usage"
MAP_TEMPLATE_PATH = ASSETS_DIR / "web_map_template.html"
MAP_LAYER_DATA_PATH = ASSETS_DIR / "map_layers.json"
KOREA_OUTLINE_PATH = ASSETS_DIR / "korea_outline.geojson"
HTML2CANVAS_PATH = ASSETS_DIR / "html2canvas.min.js"
BANNER_PATH = ASSETS_DIR / "doogpx.png"
ADS_TXT_PATH = ASSETS_DIR / "ads.txt"
FONTS_DIR = ASSETS_DIR / "fonts"
POPUP_NOTICE_PATH = RUNTIME_DIR / "popup_notice.json"
PROMO_CODES_PATH = RUNTIME_DIR / "promo_codes.json"

DEFAULT_POPUP_NOTICE_MESSAGE = "筌왖疫?筌띾Ŧ猷???덈┷野?????肉???낅쑓??꾨뱜 餓λ쵐???덈뼄. 雅뚭쑴???몃빍??"

USER_HISTORY_LIMIT = 50
HISTORY_SUPABASE_FETCH_LIMIT = 500
SUPABASE_HTTP_TIMEOUT_SECONDS = 10
JOB_PAYLOAD_SUPABASE_DEFAULT_BUCKET = "doo-job-payloads"
JOB_PAYLOAD_SUPABASE_DEFAULT_TABLE = "doo_job_payload_meta"
PAYAPP_API_URL = "https://api.payapp.kr/oapi/apiLoad.html"
PAYAPP_DEFAULT_OPENPAYTYPE = "card,phone,kakaopay,naverpay,rbank,smilepay,payco,applepay,tosspay"
PAYAPP_SUPPORTED_OPENPAYTYPE_TOKENS = {
    "card",
    "phone",
    "rbank",
    "vbank",
    "kakaopay",
    "naverpay",
    "smilepay",
    "applepay",
    "payco",
    "wechat",
    "myaccount",
    "tosspay",
    "dvpay",
}
NOTAM_DEFAULT_SUPABASE_URL = "https://zxocgwaogeyhwkefqmts.supabase.co"
NOTAM_DEFAULT_SUPABASE_ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp4b2Nnd2FvZ2V5aHdrZWZxbXRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NDgxNjAsImV4cCI6MjA4NzQyNDE2MH0."
    "YTryJaDm_pmR8tNuuc_HOsRvuDUo29hLCwTz8sQQt_8"
)
NOTAM_MAX_LIMIT = 3000
NOTAM_DEFAULT_LIMIT = 1200
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
SOURCE_HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$")
PROMO_CODE_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9_-]{3,31}$")
DEFAULT_PLAN_CODE = "free"
LITE_PLAN_CODE = "lite"
PRO_PLAN_CODE = "pro"
LEGACY_PLAN_CODE = "legacy"
SUPPORTED_PLAN_CODES = {DEFAULT_PLAN_CODE, LITE_PLAN_CODE, PRO_PLAN_CODE}
ALL_PLAN_CODES = SUPPORTED_PLAN_CODES | {LEGACY_PLAN_CODE}
SUBSCRIPTION_STATUSES = {"inactive", "pending", "active", "cancelled", "payment_failed", "paused"}
PAYAPP_SUCCESS_STATE = "4"
PAYAPP_FAIL_STATE = "99"
PAYAPP_CANCEL_STATES = {"8", "9", "32", "64"}
PAYAPP_PARTIAL_CANCEL_STATES = {"70", "71"}
PAYAPP_PENDING_STATES = {"1", "10"}
MONTH_KEY_FORMAT = "%Y-%m"
DEFAULT_BILLING_CUTOVER_AT = datetime(2026, 3, 19, 0, 0, tzinfo=timezone(timedelta(hours=9)))
PLAN_POLICIES: dict[str, dict[str, Any]] = {
    DEFAULT_PLAN_CODE: {
        "monthly_kml_limit": 5,
        "file_size_limit_mb": 1,
        "history_days": 0,
        "history_limit": 0,
        "features": {
            "history": False,
            "viewer_state": False,
            "text_download": False,
            "excel_download": False,
            "weather_metar_taf": False,
            "weather_satellite": False,
            "notam_detail": False,
        },
    },
    LITE_PLAN_CODE: {
        "monthly_kml_limit": 30,
        "file_size_limit_mb": 5,
        "history_days": 30,
        "history_limit": 10,
        "features": {
            "history": True,
            "viewer_state": True,
            "text_download": True,
            "excel_download": True,
            "weather_metar_taf": True,
            "weather_satellite": False,
            "notam_detail": True,
        },
    },
    PRO_PLAN_CODE: {
        "monthly_kml_limit": 0,
        "file_size_limit_mb": 200,
        "history_days": 36500,
        "history_limit": 5000,
        "features": {
            "history": True,
            "viewer_state": True,
            "text_download": True,
            "excel_download": True,
            "weather_metar_taf": True,
            "weather_satellite": True,
            "notam_detail": True,
        },
    },
    LEGACY_PLAN_CODE: {
        "monthly_kml_limit": 0,
        "file_size_limit_mb": 200,
        "history_days": 36500,
        "history_limit": 5000,
        "features": {
            "history": True,
            "viewer_state": True,
            "text_download": True,
            "excel_download": True,
            "weather_metar_taf": True,
            "weather_satellite": True,
            "notam_detail": True,
        },
    },
}
PLAN_PRICES_KRW = {
    DEFAULT_PLAN_CODE: 0,
    LITE_PLAN_CODE: 3900,
    PRO_PLAN_CODE: 8900,
}
PLAN_PAYAPP_GOODNAME = {
    LITE_PLAN_CODE: "DOO Extractor Lite Monthly",
    PRO_PLAN_CODE: "DOO Extractor Pro Monthly",
}
JOB_PAYLOAD_BUCKET_CACHE: set[str] = set()
PROMO_CODE_LOCK = threading.Lock()


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
    source_file_bytes: int = 0
    source_hash: str = ""


class PopupNoticeAuthPayload(BaseModel):
    password: str


class PopupNoticeUpdatePayload(BaseModel):
    password: str
    message: str
    enabled: bool = False


class PromoCodeCreatePayload(BaseModel):
    password: str
    code: str = ""
    plan_code: Literal["lite", "pro"] = "pro"
    duration_days: int = 30
    max_uses: int = 1
    expires_at: str | None = None


class PromoCodeTogglePayload(BaseModel):
    password: str
    code: str
    enabled: bool


class BillingStartPayload(BaseModel):
    plan_code: Literal["lite", "pro"]
    buyer_phone: str
    return_url: str | None = None


class BillingCancelPayload(BaseModel):
    reason: str = ""


class BillingPromoRedeemPayload(BaseModel):
    code: str

for path in (
    JOBS_DIR,
    VIEWER_STATE_DIR,
    USER_HISTORY_DIR,
    USER_ACTIVITY_DIR,
    USER_BILLING_DIR,
    PAYMENT_ORDER_DIR,
    PAYMENT_EVENT_DIR,
    PAYMENT_USAGE_DIR,
):
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


def _user_activity_path(user_id: str) -> Path:
    return USER_ACTIVITY_DIR / f"{user_id}.json"


def _user_email_activity_path(user_email: str) -> Path:
    normalized = _normalize_user_email(user_email)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return USER_ACTIVITY_DIR / f"email_{digest}.json"


def _user_billing_path(user_id: str) -> Path:
    return USER_BILLING_DIR / f"{user_id}.json"


def _user_payment_usage_path(user_id: str) -> Path:
    return PAYMENT_USAGE_DIR / f"{user_id}.json"


def _payment_order_path(order_id: str) -> Path:
    return PAYMENT_ORDER_DIR / f"{order_id}.json"


def _payment_event_path(event_key: str) -> Path:
    digest = hashlib.sha256(event_key.encode("utf-8")).hexdigest()
    return PAYMENT_EVENT_DIR / f"{digest}.json"


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


def _activity_paths_for_identity(user_id: str, user_email: str) -> list[Path]:
    paths: list[Path] = []
    normalized_user_id = _normalize_user_identity(user_id)
    normalized_email = _normalize_user_email(user_email)

    if normalized_user_id:
        paths.append(_user_activity_path(normalized_user_id))
    if normalized_email:
        paths.append(_user_email_activity_path(normalized_email))

    unique_paths: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique_paths.append(path)
    return unique_paths


def _history_supabase_config() -> dict[str, str] | None:
    supabase_url = str(os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip().rstrip("/")
    service_role_key = str(os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    anon_key = str(os.getenv("SUPABASE_ANON_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY") or "").strip()
    table_name = str(os.getenv("DOO_HISTORY_SUPABASE_TABLE") or "doo_user_history").strip()
    if not supabase_url or not table_name:
        return None
    if not service_role_key and not anon_key:
        return None
    if not _is_http_url(supabase_url):
        return None
    return {
        "supabase_url": supabase_url,
        "service_role_key": service_role_key,
        "anon_key": anon_key,
        "table_name": table_name,
    }


def _history_supabase_headers(config: dict[str, str], *, access_token: str = "") -> dict[str, str] | None:
    service_role_key = str(config.get("service_role_key") or "").strip()
    anon_key = str(config.get("anon_key") or "").strip()
    normalized_access_token = access_token.strip()

    if service_role_key:
        return {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Accept": "application/json",
        }

    if not anon_key or not normalized_access_token:
        return None

    return {
        "apikey": anon_key,
        "Authorization": f"Bearer {normalized_access_token}",
        "Accept": "application/json",
    }


def _history_supabase_fetch(user_id: str, user_email: str, access_token: str = "") -> list[dict]:
    config = _history_supabase_config()
    if config is None:
        return []

    headers = _history_supabase_headers(config, access_token=access_token)
    if headers is None:
        return []

    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    table_name = str(config.get("table_name") or "").strip()
    normalized_user_id = _normalize_user_identity(user_id)
    normalized_email = _normalize_user_email(user_email)
    if not normalized_user_id and not normalized_email:
        return []

    query_items: list[tuple[str, str]] = [
        ("select", "job_id,filename,project_name,mode,result_count,uploaded_at"),
        ("order", "uploaded_at.desc"),
        ("limit", str(HISTORY_SUPABASE_FETCH_LIMIT)),
    ]
    if normalized_user_id and normalized_email:
        encoded_user_id = quote(normalized_user_id, safe="-_.")
        encoded_email = quote(normalized_email, safe="@-_.")
        query_items.append(("or", f"(user_id.eq.{encoded_user_id},user_email.eq.{encoded_email})"))
    elif normalized_user_id:
        query_items.append(("user_id", f"eq.{quote(normalized_user_id, safe='-_.')}"))
    else:
        query_items.append(("user_email", f"eq.{quote(normalized_email, safe='@-_.')}"))

    url = f"{supabase_url}/rest/v1/{table_name}?{urlencode(query_items)}"
    request = UrlRequest(
        url=url,
        method="GET",
        headers=headers,
    )
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read()
    except Exception:
        return []

    try:
        payload = json.loads(raw.decode("utf-8")) if raw else []
    except Exception:
        return []
    if not isinstance(payload, list):
        return []
    rows: list[dict] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        rows.append(
            {
                "job_id": str(item.get("job_id") or ""),
                "filename": str(item.get("filename") or ""),
                "project_name": str(item.get("project_name") or ""),
                "mode": str(item.get("mode") or ""),
                "result_count": int(item.get("result_count") or 0),
                "uploaded_at": str(item.get("uploaded_at") or ""),
            }
        )
    return rows


def _history_supabase_upsert(user_id: str, user_email: str, entry: dict, access_token: str = "") -> bool:
    config = _history_supabase_config()
    if config is None:
        return False

    normalized_user_id = _normalize_user_identity(user_id)
    normalized_email = _normalize_user_email(user_email)
    if not normalized_user_id:
        return False

    headers = _history_supabase_headers(config, access_token=access_token)
    if headers is None:
        return False

    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    table_name = str(config.get("table_name") or "").strip()
    url = f"{supabase_url}/rest/v1/{table_name}?on_conflict=user_id,job_id"
    payload = [
        {
            "user_id": normalized_user_id,
            "user_email": normalized_email,
            "job_id": str(entry.get("job_id") or ""),
            "filename": str(entry.get("filename") or ""),
            "project_name": str(entry.get("project_name") or ""),
            "mode": str(entry.get("mode") or ""),
            "result_count": int(entry.get("result_count") or 0),
            "uploaded_at": str(entry.get("uploaded_at") or _utc_now_iso()),
        }
    ]
    body = json.dumps(payload).encode("utf-8")
    request = UrlRequest(
        url=url,
        method="POST",
        data=body,
        headers={
            **headers,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS):
            return True
    except Exception:
        return False


def _history_supabase_delete(user_id: str, user_email: str, job_id: str, access_token: str = "") -> bool:
    config = _history_supabase_config()
    if config is None:
        return False

    normalized_job_id = str(job_id or "").strip()
    if not normalized_job_id:
        return False

    normalized_user_id = _normalize_user_identity(user_id)
    normalized_email = _normalize_user_email(user_email)
    if not normalized_user_id and not normalized_email:
        return False

    headers = _history_supabase_headers(config, access_token=access_token)
    if headers is None:
        return False

    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    table_name = str(config.get("table_name") or "").strip()
    if not supabase_url or not table_name:
        return False

    query_items: list[tuple[str, str]] = [("job_id", f"eq.{quote(normalized_job_id, safe='-_')}")]
    if normalized_user_id:
        query_items.append(("user_id", f"eq.{quote(normalized_user_id, safe='-_')}"))
    else:
        query_items.append(("user_email", f"eq.{quote(normalized_email, safe='@-_.')}"))

    request = UrlRequest(
        url=f"{supabase_url}/rest/v1/{table_name}?{urlencode(query_items)}",
        method="DELETE",
        headers={
            **headers,
            "Prefer": "return=minimal",
        },
    )
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS):
            return True
    except Exception:
        return False


def _history_supabase_delete_all(user_id: str, user_email: str, access_token: str = "") -> int:
    config = _history_supabase_config()
    if config is None:
        return 0

    normalized_user_id = _normalize_user_identity(user_id)
    normalized_email = _normalize_user_email(user_email)
    if not normalized_user_id and not normalized_email:
        return 0

    headers = _history_supabase_headers(config, access_token=access_token)
    if headers is None:
        return 0

    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    table_name = str(config.get("table_name") or "").strip()
    if not supabase_url or not table_name:
        return 0

    if normalized_user_id and normalized_email:
        encoded_user_id = quote(normalized_user_id, safe="-_.")
        encoded_email = quote(normalized_email, safe="@-_.")
        query_items = [("or", f"(user_id.eq.{encoded_user_id},user_email.eq.{encoded_email})")]
    elif normalized_user_id:
        query_items = [("user_id", f"eq.{quote(normalized_user_id, safe='-_.')}")]
    else:
        query_items = [("user_email", f"eq.{quote(normalized_email, safe='@-_.')}")]

    request = UrlRequest(
        url=f"{supabase_url}/rest/v1/{table_name}?{urlencode(query_items)}",
        method="DELETE",
        headers={
            **headers,
            "Prefer": "count=exact,return=representation",
        },
    )
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read()
            count_header = response.headers.get("Content-Range")
    except Exception:
        return 0

    if raw:
        try:
            payload = json.loads(raw.decode("utf-8"))
            if isinstance(payload, list):
                return len(payload)
        except Exception:
            pass

    if count_header and "/" in count_header:
        try:
            return max(0, int(str(count_header).split("/")[-1]))
        except ValueError:
            return 0
    return 0


def _job_payload_supabase_config() -> dict[str, str] | None:
    base = _history_supabase_config()
    if base is None:
        return None

    bucket_name = str(
        os.getenv("DOO_JOB_PAYLOAD_SUPABASE_BUCKET")
        or os.getenv("DOO_JOB_PAYLOAD_BUCKET")
        or JOB_PAYLOAD_SUPABASE_DEFAULT_BUCKET
        or ""
    ).strip()
    table_name = str(
        os.getenv("DOO_JOB_PAYLOAD_SUPABASE_TABLE")
        or os.getenv("DOO_JOB_PAYLOAD_META_TABLE")
        or JOB_PAYLOAD_SUPABASE_DEFAULT_TABLE
        or ""
    ).strip()
    if not bucket_name:
        return None

    return {
        **base,
        "bucket_name": bucket_name,
        "meta_table": table_name,
    }


def _job_payload_storage_path(job: dict) -> str:
    job_id = _normalize_user_identity(str(job.get("job_id") or ""))
    if not job_id:
        fallback_seed = str(job.get("created_at") or _utc_now_iso())
        job_id = hashlib.sha256(fallback_seed.encode("utf-8")).hexdigest()[:24]
    return f"jobs/by-id/{job_id}.json"


def _job_payload_storage_ref(job: dict) -> tuple[str, str]:
    config = _job_payload_supabase_config()
    default_bucket = str(config.get("bucket_name") or "") if config else ""
    bucket_name = str(job.get("payload_bucket") or default_bucket or "").strip()
    object_path = str(job.get("payload_path") or "").strip()
    if not object_path:
        object_path = _job_payload_storage_path(job)
    return bucket_name, object_path


def _job_payload_supabase_ensure_bucket(config: dict[str, str], headers: dict[str, str]) -> bool:
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    bucket_name = str(config.get("bucket_name") or "").strip()
    service_role_key = str(config.get("service_role_key") or "").strip()
    if not supabase_url or not bucket_name:
        return False

    cache_key = f"{supabase_url}:{bucket_name}"
    if cache_key in JOB_PAYLOAD_BUCKET_CACHE:
        return True

    bucket_url = f"{supabase_url}/storage/v1/bucket/{quote(bucket_name, safe='-_.')}"
    check_request = UrlRequest(url=bucket_url, method="GET", headers=headers)
    try:
        with urlopen(check_request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS):
            JOB_PAYLOAD_BUCKET_CACHE.add(cache_key)
            return True
    except HTTPError as error:
        if error.code != 404 or not service_role_key:
            return False
    except Exception:
        return False

    create_body = json.dumps({"id": bucket_name, "name": bucket_name, "public": False}).encode("utf-8")
    create_request = UrlRequest(
        url=f"{supabase_url}/storage/v1/bucket",
        method="POST",
        data=create_body,
        headers={
            **headers,
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(create_request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS):
            JOB_PAYLOAD_BUCKET_CACHE.add(cache_key)
            return True
    except HTTPError as error:
        if error.code == 409:
            JOB_PAYLOAD_BUCKET_CACHE.add(cache_key)
            return True
        return False
    except Exception:
        return False


def _job_payload_supabase_upload(
    config: dict[str, str],
    headers: dict[str, str],
    bucket_name: str,
    object_path: str,
    payload: dict,
) -> bool:
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    if not supabase_url or not bucket_name or not object_path:
        return False

    if not _job_payload_supabase_ensure_bucket(config, headers):
        return False

    path = quote(object_path.lstrip("/"), safe="-_./")
    upload_url = f"{supabase_url}/storage/v1/object/{quote(bucket_name, safe='-_.')}/{path}"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = UrlRequest(
        url=upload_url,
        method="POST",
        data=body,
        headers={
            **headers,
            "Content-Type": "application/json; charset=utf-8",
            "x-upsert": "true",
        },
    )
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS):
            return True
    except Exception:
        return False


def _job_payload_supabase_upsert_meta(
    config: dict[str, str],
    headers: dict[str, str],
    job: dict,
    bucket_name: str,
    object_path: str,
) -> bool:
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    table_name = str(config.get("meta_table") or "").strip()
    job_id = str(job.get("job_id") or "").strip()
    if not supabase_url or not table_name or not job_id:
        return False

    row = {
        "job_id": job_id,
        "user_id": _normalize_user_identity(str(job.get("user_id") or "")),
        "user_email": _normalize_user_email(str(job.get("user_email") or "")),
        "payload_bucket": bucket_name,
        "payload_path": object_path,
        "source_hash": _normalize_source_hash(str(job.get("source_hash") or "")),
        "filename": str(job.get("filename") or ""),
        "project_name": str(job.get("project_name") or ""),
        "mode": str(job.get("mode") or ""),
        "result_count": int(job.get("result_count") or 0),
        "uploaded_at": str(job.get("created_at") or _utc_now_iso()),
        "updated_at": _utc_now_iso(),
    }
    body = json.dumps([row]).encode("utf-8")
    request = UrlRequest(
        url=f"{supabase_url}/rest/v1/{table_name}?on_conflict=job_id",
        method="POST",
        data=body,
        headers={
            **headers,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS):
            return True
    except Exception:
        return False


def _job_payload_supabase_store(job: dict, access_token: str = "") -> tuple[str, str]:
    config = _job_payload_supabase_config()
    if config is None:
        return "", ""
    headers = _history_supabase_headers(config, access_token=access_token)
    if headers is None:
        return "", ""

    bucket_name, object_path = _job_payload_storage_ref(job)
    if not bucket_name or not object_path:
        return "", ""

    if not _job_payload_supabase_upload(config, headers, bucket_name, object_path, job):
        return "", ""

    _job_payload_supabase_upsert_meta(config, headers, job, bucket_name, object_path)
    return bucket_name, object_path


def _job_payload_supabase_fetch_meta(
    config: dict[str, str],
    headers: dict[str, str],
    job_id: str,
) -> tuple[str, str]:
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    table_name = str(config.get("meta_table") or "").strip()
    normalized_job_id = str(job_id or "").strip()
    if not supabase_url or not table_name or not normalized_job_id:
        return "", ""

    query_items = [
        ("select", "payload_bucket,payload_path"),
        ("job_id", f"eq.{quote(normalized_job_id, safe='-_')}"),
        ("limit", "1"),
    ]
    request = UrlRequest(
        url=f"{supabase_url}/rest/v1/{table_name}?{urlencode(query_items)}",
        method="GET",
        headers=headers,
    )
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read()
    except Exception:
        return "", ""

    try:
        payload = json.loads(raw.decode("utf-8")) if raw else []
    except Exception:
        return "", ""
    if not isinstance(payload, list) or not payload:
        return "", ""
    first = payload[0] if isinstance(payload[0], dict) else {}
    return str(first.get("payload_bucket") or "").strip(), str(first.get("payload_path") or "").strip()


def _job_payload_supabase_download(
    config: dict[str, str],
    headers: dict[str, str],
    bucket_name: str,
    object_path: str,
) -> dict | None:
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    if not supabase_url or not bucket_name or not object_path:
        return None

    object_url = f"{supabase_url}/storage/v1/object/{quote(bucket_name, safe='-_.')}/{quote(object_path.lstrip('/'), safe='-_./')}"
    request = UrlRequest(url=object_url, method="GET", headers=headers)
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read()
    except Exception:
        return None
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _load_job_from_supabase(job_id: str, access_token: str = "") -> dict | None:
    config = _job_payload_supabase_config()
    if config is None:
        return None
    headers = _history_supabase_headers(config, access_token=access_token)
    if headers is None:
        return None

    bucket_name, object_path = _job_payload_supabase_fetch_meta(config, headers, job_id)
    if not bucket_name or not object_path:
        bucket_name = str(config.get("bucket_name") or "").strip()
        object_path = _job_payload_storage_path({"job_id": job_id})

    payload = _job_payload_supabase_download(config, headers, bucket_name, object_path)
    if not isinstance(payload, dict) or not payload:
        return None

    payload["job_id"] = str(payload.get("job_id") or job_id)
    payload["payload_bucket"] = bucket_name
    payload["payload_path"] = object_path
    payload["source_hash"] = _normalize_source_hash(str(payload.get("source_hash") or ""))
    if not isinstance(payload.get("map_payload"), dict):
        payload["map_payload"] = {}
    if not isinstance(payload.get("results"), list):
        payload["results"] = []
    return payload


def _normalize_source_hash(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    if SOURCE_HASH_PATTERN.fullmatch(normalized):
        return normalized
    return ""


def _viewer_state_owner_key(job: dict) -> str:
    user_id = _normalize_user_identity(str(job.get("user_id") or ""))
    if user_id:
        return f"user_id:{user_id}"
    user_email = _normalize_user_email(str(job.get("user_email") or ""))
    if user_email:
        return f"user_email:{user_email}"
    return ""


def _viewer_state_storage_keys(job: dict) -> list[str]:
    keys: list[str] = []
    owner_key = _viewer_state_owner_key(job)
    source_hash = _normalize_source_hash(str(job.get("source_hash") or ""))
    job_id = str(job.get("job_id") or "").strip()

    if owner_key and source_hash:
        keys.append(f"file:{owner_key}:{source_hash}")
    if job_id:
        keys.append(f"job:{job_id}")

    deduped: list[str] = []
    seen: set[str] = set()
    for item in keys:
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)
    return deduped


def _viewer_state_primary_storage_key(job: dict) -> str:
    keys = _viewer_state_storage_keys(job)
    if keys:
        return keys[0]
    fallback_job_id = str(job.get("job_id") or "").strip()
    return f"job:{fallback_job_id}" if fallback_job_id else ""


def _viewer_state_path_for_storage_key(storage_key: str) -> Path:
    digest = hashlib.sha256(storage_key.encode("utf-8")).hexdigest()
    return VIEWER_STATE_DIR / f"state_{digest}.json"


def _viewer_state_paths_for_job(job: dict) -> list[Path]:
    paths: list[Path] = []
    for storage_key in _viewer_state_storage_keys(job):
        if not storage_key:
            continue
        paths.append(_viewer_state_path_for_storage_key(storage_key))

    job_id = str(job.get("job_id") or "").strip()
    if job_id:
        paths.append(_viewer_state_path(job_id))

    deduped: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(path)
    return deduped


def _viewer_state_supabase_config() -> dict[str, str] | None:
    supabase_url = str(os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip().rstrip("/")
    service_role_key = str(os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    anon_key = str(os.getenv("SUPABASE_ANON_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY") or "").strip()
    table_name = str(os.getenv("DOO_VIEWER_STATE_SUPABASE_TABLE") or "doo_viewer_state").strip()
    if not supabase_url or not table_name:
        return None
    if not service_role_key and not anon_key:
        return None
    if not _is_http_url(supabase_url):
        return None
    return {
        "supabase_url": supabase_url,
        "service_role_key": service_role_key,
        "anon_key": anon_key,
        "table_name": table_name,
    }


def _normalize_viewer_state_payload(value: Any) -> dict | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except Exception:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _viewer_state_supabase_fetch_one(
    config: dict[str, str],
    headers: dict[str, str],
    *,
    field_name: str,
    field_value: str,
) -> dict | None:
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    table_name = str(config.get("table_name") or "").strip()
    encoded_value = quote(str(field_value), safe="-_.:@")
    query_items: list[tuple[str, str]] = [
        ("select", "state_json,state,payload"),
        (field_name, f"eq.{encoded_value}"),
        ("limit", "1"),
    ]
    url = f"{supabase_url}/rest/v1/{table_name}?{urlencode(query_items)}"
    request = UrlRequest(url=url, method="GET", headers=headers)

    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read()
    except Exception:
        return None

    try:
        payload = json.loads(raw.decode("utf-8")) if raw else []
    except Exception:
        return None

    rows: list[dict] = []
    if isinstance(payload, list):
        rows = [item for item in payload if isinstance(item, dict)]
    elif isinstance(payload, dict):
        rows = [payload]
    if not rows:
        return None

    first_row = rows[0]
    for key in ("state_json", "state", "payload"):
        normalized = _normalize_viewer_state_payload(first_row.get(key))
        if normalized is not None:
            return normalized
    return None


def _viewer_state_supabase_fetch(job: dict, access_token: str = "") -> dict | None:
    config = _viewer_state_supabase_config()
    if config is None:
        return None
    headers = _history_supabase_headers(config, access_token=access_token)
    if headers is None:
        return None

    for storage_key in _viewer_state_storage_keys(job):
        fetched = _viewer_state_supabase_fetch_one(
            config,
            headers,
            field_name="storage_key",
            field_value=storage_key,
        )
        if isinstance(fetched, dict):
            return fetched

    job_id = str(job.get("job_id") or "").strip()
    if job_id:
        return _viewer_state_supabase_fetch_one(
            config,
            headers,
            field_name="job_id",
            field_value=job_id,
        )
    return None


def _viewer_state_supabase_upsert_one(
    config: dict[str, str],
    headers: dict[str, str],
    *,
    row: dict[str, Any],
    conflict_key: str,
) -> bool:
    supabase_url = str(config.get("supabase_url") or "").strip().rstrip("/")
    table_name = str(config.get("table_name") or "").strip()
    body = json.dumps([row]).encode("utf-8")
    url = f"{supabase_url}/rest/v1/{table_name}?on_conflict={quote(conflict_key, safe='-_')}"
    request = UrlRequest(
        url=url,
        method="POST",
        data=body,
        headers={
            **headers,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS):
            return True
    except Exception:
        return False


def _viewer_state_supabase_upsert(job: dict, payload: dict, access_token: str = "") -> bool:
    config = _viewer_state_supabase_config()
    if config is None:
        return False
    headers = _history_supabase_headers(config, access_token=access_token)
    if headers is None:
        return False

    job_id = str(job.get("job_id") or "").strip()
    if not job_id:
        return False

    user_id = _normalize_user_identity(str(job.get("user_id") or ""))
    user_email = _normalize_user_email(str(job.get("user_email") or ""))
    source_hash = _normalize_source_hash(str(job.get("source_hash") or ""))
    updated_at = _utc_now_iso()

    success = False
    for storage_key in _viewer_state_storage_keys(job):
        row = {
            "storage_key": storage_key,
            "job_id": job_id,
            "user_id": user_id,
            "user_email": user_email,
            "source_hash": source_hash,
            "state_json": payload,
            "updated_at": updated_at,
        }
        if _viewer_state_supabase_upsert_one(config, headers, row=row, conflict_key="storage_key"):
            success = True

    # Backward compatibility with legacy table schema using job_id unique key.
    legacy_row = {
        "job_id": job_id,
        "user_id": user_id,
        "user_email": user_email,
        "state_json": payload,
        "updated_at": updated_at,
    }
    if _viewer_state_supabase_upsert_one(config, headers, row=legacy_row, conflict_key="job_id"):
        success = True

    return success


def _home_state_storage_keys(user_id: str, user_email: str) -> list[str]:
    normalized_user_id = _normalize_user_identity(user_id)
    normalized_email = _normalize_user_email(user_email)
    keys: list[str] = []
    if normalized_user_id:
        keys.append(f"home:user_id:{normalized_user_id}")
    if normalized_email:
        keys.append(f"home:user_email:{normalized_email}")
    deduped: list[str] = []
    seen: set[str] = set()
    for key in keys:
        if key in seen:
            continue
        seen.add(key)
        deduped.append(key)
    return deduped


def _home_state_paths(user_id: str, user_email: str) -> list[Path]:
    paths: list[Path] = []
    for storage_key in _home_state_storage_keys(user_id, user_email):
        paths.append(_viewer_state_path_for_storage_key(storage_key))
    return paths


def _home_state_supabase_fetch(user_id: str, user_email: str, access_token: str = "") -> dict | None:
    config = _viewer_state_supabase_config()
    if config is None:
        return None
    headers = _history_supabase_headers(config, access_token=access_token)
    if headers is None:
        return None

    for storage_key in _home_state_storage_keys(user_id, user_email):
        fetched = _viewer_state_supabase_fetch_one(
            config,
            headers,
            field_name="storage_key",
            field_value=storage_key,
        )
        if isinstance(fetched, dict):
            return fetched
    return None


def _home_state_supabase_upsert(user_id: str, user_email: str, payload: dict, access_token: str = "") -> bool:
    config = _viewer_state_supabase_config()
    if config is None:
        return False
    headers = _history_supabase_headers(config, access_token=access_token)
    if headers is None:
        return False

    normalized_user_id = _normalize_user_identity(user_id)
    normalized_email = _normalize_user_email(user_email)
    if not normalized_user_id and not normalized_email:
        return False

    updated_at = _utc_now_iso()
    success = False
    for storage_key in _home_state_storage_keys(normalized_user_id, normalized_email):
        row = {
            "storage_key": storage_key,
            "job_id": storage_key,
            "user_id": normalized_user_id,
            "user_email": normalized_email,
            "source_hash": "",
            "state_json": payload,
            "updated_at": updated_at,
        }
        if _viewer_state_supabase_upsert_one(config, headers, row=row, conflict_key="storage_key"):
            success = True
    return success


def _load_json(path: Path, default):
    if not path.exists():
        return default
    raw: bytes | None = None
    try:
        raw = path.read_bytes()
    except Exception:
        return default
    if raw is None:
        return default

    for encoding in ("utf-8", "utf-8-sig", "cp949", "euc-kr"):
        try:
            return json.loads(raw.decode(encoding))
        except Exception:
            continue
    return default


def _save_json(path: Path, data) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)


def _default_promo_code_store() -> dict[str, Any]:
    return {"codes": {}}


def _sanitize_promo_code_record(record: dict[str, Any]) -> dict[str, Any]:
    now_iso = _utc_now_iso()
    try:
        max_uses = max(int(record.get("max_uses") or 1), 1)
    except (TypeError, ValueError):
        max_uses = 1
    try:
        used_count = max(int(record.get("used_count") or 0), 0)
    except (TypeError, ValueError):
        used_count = 0
    try:
        duration_days = max(int(record.get("duration_days") or 30), 1)
    except (TypeError, ValueError):
        duration_days = 30
    redeemed_user_ids = record.get("redeemed_user_ids", [])
    if not isinstance(redeemed_user_ids, list):
        redeemed_user_ids = []
    return {
        "code": _normalize_promo_code(str(record.get("code") or "")),
        "plan_code": _normalize_paid_plan_code(str(record.get("plan_code") or "")),
        "duration_days": min(duration_days, 365),
        "max_uses": max_uses,
        "used_count": min(used_count, max_uses),
        "enabled": bool(record.get("enabled", True)),
        "expires_at": str(record.get("expires_at") or "").strip(),
        "created_at": str(record.get("created_at") or now_iso).strip() or now_iso,
        "updated_at": str(record.get("updated_at") or now_iso).strip() or now_iso,
        "redeemed_user_ids": [
            _normalize_user_identity(str(item or ""))
            for item in redeemed_user_ids
            if _normalize_user_identity(str(item or ""))
        ],
    }


def _load_promo_code_store() -> dict[str, Any]:
    payload = _load_json(PROMO_CODES_PATH, _default_promo_code_store())
    raw_codes = payload.get("codes", {}) if isinstance(payload, dict) else {}
    normalized_codes: dict[str, dict[str, Any]] = {}
    if isinstance(raw_codes, dict):
        iterable = raw_codes.values()
    elif isinstance(raw_codes, list):
        iterable = raw_codes
    else:
        iterable = []
    for item in iterable:
        if not isinstance(item, dict):
            continue
        sanitized = _sanitize_promo_code_record(item)
        code = sanitized.get("code") or ""
        if not code or not sanitized.get("plan_code"):
            continue
        normalized_codes[code] = sanitized
    return {"codes": normalized_codes}


def _save_promo_code_store(store: dict[str, Any]) -> dict[str, Any]:
    raw_codes = store.get("codes", {}) if isinstance(store, dict) else {}
    normalized_codes: dict[str, dict[str, Any]] = {}
    if isinstance(raw_codes, dict):
        iterable = raw_codes.values()
    else:
        iterable = []
    for item in iterable:
        if not isinstance(item, dict):
            continue
        sanitized = _sanitize_promo_code_record(item)
        code = sanitized.get("code") or ""
        if not code or not sanitized.get("plan_code"):
            continue
        normalized_codes[code] = sanitized
    payload = {"codes": normalized_codes}
    _save_json(PROMO_CODES_PATH, payload)
    return payload


def _list_promo_codes() -> list[dict[str, Any]]:
    store = _load_promo_code_store()
    codes = list((store.get("codes") or {}).values())
    codes.sort(
        key=lambda row: _parse_iso_datetime(str(row.get("created_at") or "")) or datetime.fromtimestamp(0, tz=timezone.utc),
        reverse=True,
    )
    return codes


def _generate_promo_code_value(existing_codes: set[str]) -> str:
    for _ in range(20):
        candidate = f"DOO-{secrets.token_hex(3).upper()}"
        if candidate not in existing_codes:
            return candidate
    raise HTTPException(status_code=500, detail="프로모션 코드 생성에 실패했습니다. 다시 시도해 주세요.")


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
        raise HTTPException(status_code=503, detail="?온?귐딆쁽 ??쑬?甕곕뜇?뉐첎? ??쇱젟??? ??녿릭??щ빍??")
    if not secrets.compare_digest(str(password or ""), configured):
        raise HTTPException(status_code=401, detail="??쑬?甕곕뜇?뉐첎? ??깊뒄??? ??녿뮸??덈뼄.")


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _record_user_activity(request: Request, user_id: str, user_email: str) -> None:
    normalized_user_id = _normalize_user_identity(user_id)
    normalized_email = _normalize_user_email(user_email)
    paths = _activity_paths_for_identity(normalized_user_id, normalized_email)
    if not paths:
        return

    request_path = str(request.url.path or "").strip()
    request_method = str(request.method or "").strip().upper()
    accessed_at = _utc_now_iso()
    now_dt = _parse_iso_datetime(accessed_at)

    for path in paths:
        payload = _load_json(path, {})
        if not isinstance(payload, dict):
            payload = {}

        previous_path = str(payload.get("last_access_path") or "").strip()
        previous_method = str(payload.get("last_access_method") or "").strip().upper()
        previous_at = _parse_iso_datetime(str(payload.get("last_accessed_at") or "").strip())
        if (
            now_dt is not None
            and previous_at is not None
            and previous_path == request_path
            and previous_method == request_method
            and (now_dt - previous_at).total_seconds() < 15
        ):
            if normalized_user_id and not str(payload.get("user_id") or "").strip():
                payload["user_id"] = normalized_user_id
            if normalized_email and not str(payload.get("user_email") or "").strip():
                payload["user_email"] = normalized_email
            _save_json(path, payload)
            continue

        payload.update(
            {
                "user_id": normalized_user_id,
                "user_email": normalized_email,
                "last_accessed_at": accessed_at,
                "last_access_path": request_path,
                "last_access_method": request_method,
            }
        )
        _save_json(path, payload)


def _collect_popup_admin_usage_rows() -> tuple[str, list[dict[str, Any]]]:
    month_key = _current_month_key()
    rows_by_key: dict[str, dict[str, Any]] = {}

    def _row_key(user_id: str, user_email: str) -> str:
        normalized_id = _normalize_user_identity(user_id)
        normalized_email = _normalize_user_email(user_email)
        if normalized_id:
            return f"id:{normalized_id}"
        if normalized_email:
            return f"email:{normalized_email}"
        return ""

    def _ensure_row(user_id: str, user_email: str) -> dict[str, Any] | None:
        normalized_id = _normalize_user_identity(user_id)
        normalized_email = _normalize_user_email(user_email)
        key = _row_key(normalized_id, normalized_email)
        if not key:
            return None

        row = rows_by_key.get(key)
        if row is None:
            row = {
                "user_id": normalized_id,
                "user_email": normalized_email,
                "plan_code": "",
                "subscription_status": "",
                "monthly_kml_used": 0,
                "total_kml_used": 0,
                "total_jobs": 0,
                "last_accessed_at": "",
                "last_access_path": "",
                "last_uploaded_at": "",
                "last_filename": "",
            }
            rows_by_key[key] = row

        if normalized_id and not str(row.get("user_id") or "").strip():
            row["user_id"] = normalized_id
        if normalized_email and not str(row.get("user_email") or "").strip():
            row["user_email"] = normalized_email
        return row

    for billing_path in USER_BILLING_DIR.glob("*.json"):
        payload = _load_json(billing_path, {})
        if not isinstance(payload, dict):
            continue
        user_id = _normalize_user_identity(str(payload.get("user_id") or billing_path.stem))
        user_email = _normalize_user_email(str(payload.get("user_email") or ""))
        row = _ensure_row(user_id, user_email)
        if row is None:
            continue

        plan_code_raw = str(payload.get("plan_code") or "").strip()
        if plan_code_raw:
            row["plan_code"] = _normalize_plan_code(plan_code_raw, fallback=DEFAULT_PLAN_CODE)

        subscription_status = str(payload.get("subscription_status") or "").strip().lower()
        if subscription_status:
            row["subscription_status"] = subscription_status

    for usage_path in PAYMENT_USAGE_DIR.glob("*.json"):
        user_id = _normalize_user_identity(usage_path.stem)
        if not user_id:
            continue
        payload = _load_json(usage_path, {})
        if not isinstance(payload, dict):
            continue
        monthly = payload.get("monthly")
        if not isinstance(monthly, dict):
            continue
        row = _ensure_row(user_id, "")
        if row is None:
            continue

        total = 0
        current = 0
        for usage_month_key, usage_month_payload in monthly.items():
            if not isinstance(usage_month_payload, dict):
                continue
            count = max(0, _safe_int(usage_month_payload.get("kml_conversions"), 0))
            total += count
            if str(usage_month_key) == month_key:
                current = count
        row["monthly_kml_used"] = current
        row["total_kml_used"] = total

    for activity_path in USER_ACTIVITY_DIR.glob("*.json"):
        payload = _load_json(activity_path, {})
        if not isinstance(payload, dict):
            continue
        user_id = _normalize_user_identity(str(payload.get("user_id") or ""))
        user_email = _normalize_user_email(str(payload.get("user_email") or ""))
        row = _ensure_row(user_id, user_email)
        if row is None:
            continue

        accessed_at = str(payload.get("last_accessed_at") or "").strip()
        current_access_raw = str(row.get("last_accessed_at") or "").strip()
        current_access = _parse_iso_datetime(current_access_raw)
        accessed_dt = _parse_iso_datetime(accessed_at)
        should_update_access = False
        if accessed_dt is not None:
            should_update_access = current_access is None or accessed_dt > current_access
        elif accessed_at and not current_access_raw:
            should_update_access = True
        if should_update_access:
            row["last_accessed_at"] = accessed_at
            row["last_access_path"] = str(payload.get("last_access_path") or "").strip()

    for job_path in JOBS_DIR.glob("*.json"):
        payload = _load_json(job_path, {})
        if not isinstance(payload, dict):
            continue
        user_id = _normalize_user_identity(str(payload.get("user_id") or ""))
        user_email = _normalize_user_email(str(payload.get("user_email") or ""))
        row = _ensure_row(user_id, user_email)
        if row is None:
            continue

        row["total_jobs"] = _safe_int(row.get("total_jobs"), 0) + 1

        created_at = str(payload.get("created_at") or payload.get("uploaded_at") or "").strip()
        if not created_at:
            continue
        current_last_raw = str(row.get("last_uploaded_at") or "").strip()
        current_last = _parse_iso_datetime(current_last_raw)
        created_dt = _parse_iso_datetime(created_at)
        should_update = False
        if created_dt is not None:
            should_update = current_last is None or created_dt > current_last
        elif not current_last_raw:
            should_update = True
        if should_update:
            row["last_uploaded_at"] = created_at
            row["last_filename"] = str(payload.get("filename") or "").strip()

    rows = list(rows_by_key.values())
    rows.sort(
        key=lambda item: (
            _safe_int(item.get("monthly_kml_used"), 0),
            _safe_int(item.get("total_kml_used"), 0),
            _safe_int(item.get("total_jobs"), 0),
            str(item.get("last_uploaded_at") or ""),
            str(item.get("user_email") or ""),
        ),
        reverse=True,
    )
    return month_key, rows


def _load_map_layers() -> dict:
    data = _load_json(MAP_LAYER_DATA_PATH, {"layers": []})
    layers = data.get("layers", []) if isinstance(data, dict) else []
    if not isinstance(layers, list):
        layers = []
    korea_outline = _load_json(KOREA_OUTLINE_PATH, {"type": "FeatureCollection", "features": []})
    if not isinstance(korea_outline, dict):
        korea_outline = {"type": "FeatureCollection", "features": []}
    return {"layers": layers, "korea_outline": korea_outline}


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


def _load_job(job_id: str, access_token: str = "") -> dict:
    data = _load_json(_job_path(job_id), {})
    if isinstance(data, dict) and data:
        return data

    remote = _load_job_from_supabase(job_id, access_token=access_token)
    if isinstance(remote, dict) and remote:
        _save_json(_job_path(job_id), remote)
        return remote

    raise HTTPException(status_code=404, detail="복원할 변환 데이터가 서버에 없습니다. 파일을 다시 변환해 주세요.")


def _viewer_html_with_paths(payload: dict, viewer_state_path: str, layers_path: str) -> str:
    html = build_web_map_html(payload, str(MAP_TEMPLATE_PATH))
    replacements = {
        'src="/html2canvas.min.js"': 'src="/api/assets/html2canvas.min.js"',
        'src="/doogpx.png"': 'src="/api/assets/doogpx.png"',
        "fetch('/viewer-state'": f"fetch('{viewer_state_path}'",
        "fetch('/layers.json'": f"fetch('{layers_path}'",
    }
    for source, target in replacements.items():
        html = html.replace(source, target)
    return html


def _viewer_html(job_id: str, payload: dict) -> str:
    return _viewer_html_with_paths(
        payload,
        f"/api/viewer/{job_id}/viewer-state",
        f"/api/viewer/{job_id}/layers.json",
    )


def _default_viewer_payload() -> dict[str, Any]:
    layer_catalog = _build_map_layer_catalog()
    return {
        "project_name": "DOO Extractor Viewer",
        "mode": "linestring",
        "results": [],
        "polygons": [],
        "has_kml_num": False,
        "default_force_num": False,
        "default_show_num": False,
        "has_layers": bool(layer_catalog),
        "layer_catalog": layer_catalog,
        "default_gray_map": False,
        "meta_text": "KML 癰궰????곸뵠??Viewer????????됰뮸??덈뼄.",
    }


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


def _parse_iso_datetime(value: str | None) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _billing_enabled() -> bool:
    raw = str(os.getenv("DOO_BILLING_ENABLED") or "").strip().lower()
    if raw in {"1", "true", "yes", "on", "y"}:
        return True
    if raw in {"0", "false", "no", "off", "n"}:
        return False
    return False


def _billing_cutover_at() -> datetime | None:
    raw = str(os.getenv("DOO_BILLING_CUTOVER_AT") or "").strip()
    if not raw:
        return DEFAULT_BILLING_CUTOVER_AT
    parsed = _parse_iso_datetime(raw)
    return parsed if parsed is not None else DEFAULT_BILLING_CUTOVER_AT


def _normalize_plan_code(value: str | None, *, fallback: str = DEFAULT_PLAN_CODE) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in ALL_PLAN_CODES:
        return normalized
    return fallback


def _normalize_paid_plan_code(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in {LITE_PLAN_CODE, PRO_PLAN_CODE} else ""


def _normalize_subscription_status(value: str | None, *, fallback: str = "inactive") -> str:
    normalized = str(value or "").strip().lower()
    if normalized in SUBSCRIPTION_STATUSES:
        return normalized
    return fallback


def _plan_policy(plan_code: str) -> dict[str, Any]:
    normalized = _normalize_plan_code(plan_code, fallback=DEFAULT_PLAN_CODE)
    return PLAN_POLICIES.get(normalized, PLAN_POLICIES[DEFAULT_PLAN_CODE])


def _normalize_promo_code(value: str | None) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "", str(value or "").strip().upper())
    return cleaned[:32]


def _clear_promo_fields(record: dict[str, Any]) -> None:
    record["promo_code"] = ""
    record["promo_plan_code"] = ""
    record["promo_applied_at"] = ""
    record["promo_expires_at"] = ""


def _promo_snapshot_from_record(record: dict[str, Any]) -> dict[str, Any] | None:
    promo_code = _normalize_promo_code(str(record.get("promo_code") or ""))
    promo_plan_code = _normalize_paid_plan_code(str(record.get("promo_plan_code") or ""))
    promo_expires_at = str(record.get("promo_expires_at") or "").strip()
    expires_at = _parse_iso_datetime(promo_expires_at)
    if not promo_code or not promo_plan_code or expires_at is None:
        return None
    now = datetime.now(timezone.utc)
    if expires_at <= now:
        return None
    applied_at = str(record.get("promo_applied_at") or "").strip()
    remaining_seconds = max((expires_at - now).total_seconds(), 0)
    remaining_days = max(int((remaining_seconds + 86399) // 86400), 0)
    return {
        "code": promo_code,
        "plan_code": promo_plan_code,
        "applied_at": applied_at,
        "expires_at": promo_expires_at,
        "remaining_days": remaining_days,
    }


def _refresh_record_promo_state(record: dict[str, Any]) -> bool:
    snapshot = _promo_snapshot_from_record(record)
    if snapshot is not None:
        return False
    if any(
        str(record.get(key) or "").strip()
        for key in ("promo_code", "promo_plan_code", "promo_applied_at", "promo_expires_at")
    ):
        _clear_promo_fields(record)
        return True
    return False


def _effective_plan_code(billing_record: dict) -> str:
    if bool(billing_record.get("legacy_full_access")):
        return LEGACY_PLAN_CODE
    promo_snapshot = _promo_snapshot_from_record(billing_record)
    if promo_snapshot is not None:
        return _normalize_plan_code(str(promo_snapshot.get("plan_code") or ""), fallback=DEFAULT_PLAN_CODE)
    return _normalize_plan_code(str(billing_record.get("plan_code") or ""), fallback=DEFAULT_PLAN_CODE)


def _sanitize_phone(value: str | None) -> str:
    digits = re.sub(r"[^0-9]", "", str(value or ""))
    return digits[:20]


def _payapp_config() -> tuple[str, str, str, str]:
    userid = str(os.getenv("PAYAPP_USERID") or "").strip()
    linkkey = str(os.getenv("PAYAPP_LINKKEY") or "").strip()
    linkval = str(os.getenv("PAYAPP_LINKVAL") or "").strip()
    api_url = str(os.getenv("PAYAPP_API_URL") or PAYAPP_API_URL).strip()

    if not userid or not linkkey or not linkval:
        raise HTTPException(status_code=503, detail="PayApp ??쇱젟(PAYAPP_USERID/LINKKEY/LINKVAL)???袁⑥뵭??뤿???щ빍??")
    if not _is_http_url(api_url):
        raise HTTPException(status_code=503, detail="PAYAPP_API_URL ?類ㅻ뻼????而?몴?? ??녿뮸??덈뼄.")

    return userid, linkkey, linkval, api_url


def _payapp_openpaytype() -> str:
    configured = str(os.getenv("PAYAPP_OPENPAYTYPE") or PAYAPP_DEFAULT_OPENPAYTYPE).strip()
    if not configured:
        return PAYAPP_DEFAULT_OPENPAYTYPE
    tokens: list[str] = []
    seen: set[str] = set()
    for token in configured.split(","):
        normalized = str(token or "").strip().lower()
        if not normalized or normalized in seen:
            continue
        if normalized not in PAYAPP_SUPPORTED_OPENPAYTYPE_TOKENS:
            continue
        seen.add(normalized)
        tokens.append(normalized)
    if not tokens:
        return PAYAPP_DEFAULT_OPENPAYTYPE
    return ",".join(tokens)


def _payment_return_url(request: Request, payload_return_url: str | None = None) -> str:
    payload_value = str(payload_return_url or "").strip()
    if payload_value and _is_http_url(payload_value):
        return payload_value
    configured = str(os.getenv("PAYAPP_RETURN_URL") or "").strip()
    if configured and _is_http_url(configured):
        return configured
    return f"{_external_base_url(request)}/"


def _payment_feedback_url(request: Request) -> str:
    configured = str(os.getenv("PAYAPP_FEEDBACK_URL") or "").strip()
    if configured and _is_http_url(configured):
        return configured
    return f"{_external_base_url(request)}/api/billing/payapp/feedback"


def _payment_fail_url(request: Request) -> str:
    configured = str(os.getenv("PAYAPP_FAIL_URL") or "").strip()
    if configured and _is_http_url(configured):
        return configured
    return f"{_external_base_url(request)}/api/billing/payapp/fail"


def _payment_rebill_expire() -> str:
    configured = str(os.getenv("PAYAPP_REBILL_EXPIRE") or "").strip()
    if configured:
        parsed = _parse_iso_datetime(configured)
        if parsed is not None:
            return parsed.date().isoformat()
    expire_at = datetime.now(timezone.utc) + timedelta(days=3650)
    return expire_at.date().isoformat()


def _parse_urlencoded_bytes(raw: bytes) -> dict[str, str]:
    if not raw:
        return {}
    try:
        decoded = raw.decode("utf-8")
    except UnicodeDecodeError:
        decoded = raw.decode("cp949", errors="ignore")
    pairs = parse_qsl(decoded, keep_blank_values=True)
    result: dict[str, str] = {}
    for key, value in pairs:
        if key:
            result[str(key)] = str(value)
    return result


def _payapp_request(payload: dict[str, str]) -> dict[str, str]:
    userid, _, _, api_url = _payapp_config()
    post_body = urlencode(payload).encode("utf-8")
    request = UrlRequest(
        url=api_url,
        method="POST",
        data=post_body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "doo-extractor-web/1.0",
        },
    )
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read()
    except HTTPError as error:
        detail = _parse_urlencoded_bytes(error.read()).get("errorMessage", "").strip()
        raise HTTPException(status_code=502, detail=detail or "PayApp ?遺욧퍕????쎈솭??됰뮸??덈뼄.") from error
    except URLError as error:
        raise HTTPException(status_code=502, detail="PayApp ??뺤쒔???怨뚭퍙??? 筌륁궢六??щ빍??") from error

    parsed = _parse_urlencoded_bytes(raw)
    state = str(parsed.get("state") or "").strip()
    if state not in {"0", "1"}:
        # Some responses can be plain text; return minimal payload for debugging.
        text = raw.decode("utf-8", errors="ignore").strip()
        if text and not parsed:
            parsed = {"raw": text}
    if str(payload.get("userid") or "").strip() and str(payload.get("userid")).strip() != userid:
        raise HTTPException(status_code=500, detail="PayApp userid ?遺욧퍕揶쏅?????而?몴?? ??녿뮸??덈뼄.")
    return parsed


def _default_billing_record(user_id: str, user_email: str) -> dict[str, Any]:
    now_iso = _utc_now_iso()
    return {
        "user_id": _normalize_user_identity(user_id),
        "user_email": _normalize_user_email(user_email),
        "plan_code": DEFAULT_PLAN_CODE,
        "legacy_full_access": False,
        "legacy_checked": False,
        "subscription_status": "inactive",
        "subscription_active": False,
        "subscription_started_at": "",
        "subscription_updated_at": "",
        "payapp_rebill_no": "",
        "payapp_last_mul_no": "",
        "payapp_last_pay_state": "",
        "promo_code": "",
        "promo_plan_code": "",
        "promo_applied_at": "",
        "promo_expires_at": "",
        "created_at": now_iso,
        "updated_at": now_iso,
        "notes": "",
    }


def _load_user_billing_record(user_id: str) -> dict[str, Any]:
    normalized_id = _normalize_user_identity(user_id)
    if not normalized_id:
        return {}
    payload = _load_json(_user_billing_path(normalized_id), {})
    return payload if isinstance(payload, dict) else {}


def _save_user_billing_record(record: dict[str, Any]) -> dict[str, Any]:
    normalized_id = _normalize_user_identity(str(record.get("user_id") or ""))
    if not normalized_id:
        return record
    now_iso = _utc_now_iso()
    next_record = dict(record)
    next_record["user_id"] = normalized_id
    next_record["user_email"] = _normalize_user_email(str(record.get("user_email") or ""))
    next_record["plan_code"] = _normalize_plan_code(str(record.get("plan_code") or ""), fallback=DEFAULT_PLAN_CODE)
    next_record["legacy_full_access"] = bool(record.get("legacy_full_access"))
    next_record["legacy_checked"] = bool(record.get("legacy_checked"))
    next_record["subscription_status"] = _normalize_subscription_status(
        str(record.get("subscription_status") or ""),
        fallback="inactive",
    )
    next_record["subscription_active"] = bool(record.get("subscription_active"))
    next_record["promo_code"] = _normalize_promo_code(str(record.get("promo_code") or ""))
    next_record["promo_plan_code"] = _normalize_paid_plan_code(str(record.get("promo_plan_code") or ""))
    next_record["promo_applied_at"] = str(record.get("promo_applied_at") or "").strip()
    next_record["promo_expires_at"] = str(record.get("promo_expires_at") or "").strip()
    _refresh_record_promo_state(next_record)
    next_record.setdefault("created_at", now_iso)
    next_record["updated_at"] = now_iso
    _save_json(_user_billing_path(normalized_id), next_record)
    return next_record


def _load_payment_usage(user_id: str) -> dict[str, Any]:
    normalized_id = _normalize_user_identity(user_id)
    if not normalized_id:
        return {}
    payload = _load_json(_user_payment_usage_path(normalized_id), {})
    return payload if isinstance(payload, dict) else {}


def _save_payment_usage(user_id: str, payload: dict[str, Any]) -> None:
    normalized_id = _normalize_user_identity(user_id)
    if not normalized_id:
        return
    _save_json(_user_payment_usage_path(normalized_id), payload)


def _usage_month_count(user_id: str, month_key: str) -> int:
    usage = _load_payment_usage(user_id)
    monthly = usage.get("monthly", {}) if isinstance(usage, dict) else {}
    if not isinstance(monthly, dict):
        return 0
    month_row = monthly.get(month_key, {})
    if not isinstance(month_row, dict):
        return 0
    try:
        return int(month_row.get("kml_conversions") or 0)
    except (TypeError, ValueError):
        return 0


def _increment_usage_month(user_id: str, month_key: str) -> int:
    usage = _load_payment_usage(user_id)
    if not isinstance(usage, dict):
        usage = {}
    monthly = usage.get("monthly")
    if not isinstance(monthly, dict):
        monthly = {}
        usage["monthly"] = monthly

    month_row = monthly.get(month_key)
    if not isinstance(month_row, dict):
        month_row = {"kml_conversions": 0, "updated_at": ""}
        monthly[month_key] = month_row
    try:
        current_count = int(month_row.get("kml_conversions") or 0)
    except (TypeError, ValueError):
        current_count = 0

    next_count = current_count + 1
    month_row["kml_conversions"] = next_count
    month_row["updated_at"] = _utc_now_iso()
    _save_payment_usage(user_id, usage)
    return next_count


def _current_month_key() -> str:
    return datetime.now(timezone.utc).strftime(MONTH_KEY_FORMAT)


def _payment_order_exists(order_id: str) -> bool:
    normalized = _normalize_user_identity(order_id)
    if not normalized:
        return False
    return _payment_order_path(normalized).exists()


def _load_payment_order(order_id: str) -> dict[str, Any]:
    normalized = _normalize_user_identity(order_id)
    if not normalized:
        return {}
    payload = _load_json(_payment_order_path(normalized), {})
    return payload if isinstance(payload, dict) else {}


def _save_payment_order(order_data: dict[str, Any]) -> dict[str, Any]:
    order_id = _normalize_user_identity(str(order_data.get("order_id") or ""))
    if not order_id:
        raise HTTPException(status_code=400, detail="野껉퀣??雅뚯눖揆甕곕뜇?뉐첎? ??而?몴?? ??녿뮸??덈뼄.")

    now_iso = _utc_now_iso()
    next_payload = dict(order_data)
    next_payload["order_id"] = order_id
    next_payload["user_id"] = _normalize_user_identity(str(order_data.get("user_id") or ""))
    next_payload["user_email"] = _normalize_user_email(str(order_data.get("user_email") or ""))
    next_payload["plan_code"] = _normalize_plan_code(str(order_data.get("plan_code") or ""), fallback=DEFAULT_PLAN_CODE)
    next_payload["price"] = int(order_data.get("price") or 0)
    next_payload.setdefault("created_at", now_iso)
    next_payload["updated_at"] = now_iso
    _save_json(_payment_order_path(order_id), next_payload)
    return next_payload


def _mark_payment_event_processed(event_key: str, payload: dict[str, Any]) -> bool:
    path = _payment_event_path(event_key)
    if path.exists():
        return False
    _save_json(path, payload)
    return True


def _parse_payapp_form(request_body: bytes) -> dict[str, str]:
    payload = _parse_urlencoded_bytes(request_body)
    normalized: dict[str, str] = {}
    for key, value in payload.items():
        normalized[str(key).strip()] = str(value).strip()
    return normalized


def _supabase_lookup_user_profile(
    supabase_url: str,
    service_role_key: str,
    *,
    user_id: str = "",
    user_email: str = "",
) -> dict[str, Any]:
    normalized_user_id = _normalize_user_identity(user_id)
    normalized_email = _normalize_user_email(user_email)

    if normalized_user_id:
        try:
            payload = _supabase_request_json(
                "GET",
                f"{supabase_url}/auth/v1/admin/users/{normalized_user_id}",
                service_role_key,
            )
            if isinstance(payload, dict):
                payload.setdefault("id", normalized_user_id)
                return payload
        except HTTPException:
            pass

    if normalized_email:
        query = urlencode({"email": normalized_email})
        payload = _supabase_request_json("GET", f"{supabase_url}/auth/v1/admin/users?{query}", service_role_key)
        users = payload.get("users", []) if isinstance(payload, dict) else []
        if isinstance(users, list):
            for user in users:
                if not isinstance(user, dict):
                    continue
                if _normalize_user_email(str(user.get("email") or "")) == normalized_email:
                    return user
    return {}


def _is_legacy_member(created_at: str | None) -> bool:
    cutover = _billing_cutover_at()
    if cutover is None:
        return False
    joined_at = _parse_iso_datetime(created_at)
    if joined_at is None:
        return False
    return joined_at <= cutover


def _mark_legacy_full_access(record: dict[str, Any], note: str = "legacy_member_before_billing_cutover") -> None:
    record["legacy_full_access"] = True
    record["legacy_checked"] = True
    record["plan_code"] = LEGACY_PLAN_CODE
    record["subscription_status"] = "active"
    record["subscription_active"] = True
    if note:
        record["notes"] = note


def _try_mark_legacy_from_admin_profile(record: dict[str, Any], user_id: str, user_email: str) -> tuple[bool, bool]:
    try:
        supabase_url, service_role_key = _supabase_admin_config()
        profile = _supabase_lookup_user_profile(
            supabase_url,
            service_role_key,
            user_id=user_id,
            user_email=user_email,
        )
        created_at = str(profile.get("created_at") or "").strip()
        if _is_legacy_member(created_at):
            _mark_legacy_full_access(record)
            return True, True
        record["legacy_checked"] = True
        return True, False
    except HTTPException:
        record["notes"] = "supabase_profile_lookup_failed"
        return False, False


def _ensure_billing_record(user_id: str, user_email: str, created_at_hint: str = "") -> dict[str, Any]:
    normalized_user_id = _normalize_user_identity(user_id)
    if not normalized_user_id:
        return _default_billing_record("", user_email)

    existing = _load_user_billing_record(normalized_user_id)
    if existing:
        changed = False
        if user_email and _normalize_user_email(str(existing.get("user_email") or "")) != _normalize_user_email(user_email):
            existing["user_email"] = _normalize_user_email(user_email)
            changed = True
        if _refresh_record_promo_state(existing):
            changed = True
        if not bool(existing.get("legacy_full_access")):
            if _is_legacy_member(created_at_hint):
                _mark_legacy_full_access(existing, "legacy_member_from_access_token")
                changed = True
            elif not bool(existing.get("legacy_checked")):
                checked, upgraded = _try_mark_legacy_from_admin_profile(existing, normalized_user_id, user_email)
                if checked or upgraded:
                    changed = True
        if changed:
            existing = _save_user_billing_record(existing)
        return existing

    next_record = _default_billing_record(normalized_user_id, user_email)
    if _is_legacy_member(created_at_hint):
        _mark_legacy_full_access(next_record, "legacy_member_from_access_token")
    else:
        _try_mark_legacy_from_admin_profile(next_record, normalized_user_id, user_email)
    _refresh_record_promo_state(next_record)

    return _save_user_billing_record(next_record)


def _billing_status_for_user(user_id: str, user_email: str, created_at_hint: str = "") -> dict[str, Any]:
    normalized_user_id = _normalize_user_identity(user_id)
    normalized_email = _normalize_user_email(user_email)
    billing_enabled = _billing_enabled()

    if not normalized_user_id:
        effective_plan = DEFAULT_PLAN_CODE if billing_enabled else LEGACY_PLAN_CODE
        policy = _plan_policy(effective_plan)
        return {
            "billing_enabled": billing_enabled,
            "user_id": "",
            "user_email": normalized_email,
            "plan_code": effective_plan,
            "base_plan_code": effective_plan,
            "legacy_full_access": not billing_enabled,
            "is_new_pricing_user": billing_enabled,
            "subscription_status": "inactive",
            "subscription_active": False,
            "promo_active": False,
            "promo_code": "",
            "promo_plan_code": "",
            "promo_applied_at": "",
            "promo_expires_at": "",
            "promo_remaining_days": 0,
            "features": dict(policy.get("features") or {}),
            "monthly_kml_limit": int(policy.get("monthly_kml_limit") or 0),
            "monthly_kml_used": 0,
            "monthly_kml_remaining": int(policy.get("monthly_kml_limit") or 0),
            "file_size_limit_mb": int(policy.get("file_size_limit_mb") or 0),
            "history_days": int(policy.get("history_days") or 0),
            "history_limit": int(policy.get("history_limit") or 0),
        }

    if not billing_enabled:
        policy = _plan_policy(LEGACY_PLAN_CODE)
        return {
            "billing_enabled": False,
            "user_id": normalized_user_id,
            "user_email": normalized_email,
            "plan_code": LEGACY_PLAN_CODE,
            "base_plan_code": LEGACY_PLAN_CODE,
            "legacy_full_access": True,
            "is_new_pricing_user": False,
            "subscription_status": "active",
            "subscription_active": True,
            "promo_active": False,
            "promo_code": "",
            "promo_plan_code": "",
            "promo_applied_at": "",
            "promo_expires_at": "",
            "promo_remaining_days": 0,
            "features": dict(policy.get("features") or {}),
            "monthly_kml_limit": 0,
            "monthly_kml_used": 0,
            "monthly_kml_remaining": -1,
            "file_size_limit_mb": int(policy.get("file_size_limit_mb") or 0),
            "history_days": int(policy.get("history_days") or 0),
            "history_limit": int(policy.get("history_limit") or 0),
        }

    record = _ensure_billing_record(normalized_user_id, normalized_email, created_at_hint=created_at_hint)
    promo_snapshot = _promo_snapshot_from_record(record)
    effective_plan = _effective_plan_code(record)
    policy = _plan_policy(effective_plan)
    monthly_limit = int(policy.get("monthly_kml_limit") or 0)
    month_key = _current_month_key()
    monthly_used = _usage_month_count(normalized_user_id, month_key)
    monthly_remaining = -1 if monthly_limit <= 0 else max(monthly_limit - monthly_used, 0)
    features = dict(policy.get("features") or {})
    return {
        "billing_enabled": True,
        "user_id": normalized_user_id,
        "user_email": normalized_email or _normalize_user_email(str(record.get("user_email") or "")),
        "plan_code": effective_plan,
        "base_plan_code": _normalize_plan_code(str(record.get("plan_code") or ""), fallback=DEFAULT_PLAN_CODE),
        "legacy_full_access": bool(record.get("legacy_full_access")),
        "is_new_pricing_user": not bool(record.get("legacy_full_access")),
        "subscription_status": _normalize_subscription_status(str(record.get("subscription_status") or ""), fallback="inactive"),
        "subscription_active": bool(record.get("subscription_active")),
        "promo_active": promo_snapshot is not None,
        "promo_code": str((promo_snapshot or {}).get("code") or ""),
        "promo_plan_code": str((promo_snapshot or {}).get("plan_code") or ""),
        "promo_applied_at": str((promo_snapshot or {}).get("applied_at") or ""),
        "promo_expires_at": str((promo_snapshot or {}).get("expires_at") or ""),
        "promo_remaining_days": int((promo_snapshot or {}).get("remaining_days") or 0),
        "features": features,
        "monthly_kml_limit": monthly_limit,
        "monthly_kml_used": monthly_used,
        "monthly_kml_remaining": monthly_remaining,
        "file_size_limit_mb": int(policy.get("file_size_limit_mb") or 0),
        "history_days": int(policy.get("history_days") or 0),
        "history_limit": int(policy.get("history_limit") or 0),
        "payapp_rebill_no": str(record.get("payapp_rebill_no") or ""),
    }


def _has_feature_access(billing_status: dict[str, Any], feature_key: str) -> bool:
    if not billing_status.get("billing_enabled"):
        return True
    features = billing_status.get("features", {})
    if not isinstance(features, dict):
        return False
    return bool(features.get(feature_key))


def _job_owner_billing_status(job: dict) -> dict[str, Any]:
    return _billing_status_for_user(
        _normalize_user_identity(str(job.get("user_id") or "")),
        _normalize_user_email(str(job.get("user_email") or "")),
    )


def _viewer_billing_payload(billing_status: dict[str, Any]) -> dict[str, Any]:
    plan_code = _normalize_plan_code(str(billing_status.get("plan_code") or ""), fallback=DEFAULT_PLAN_CODE)
    features = billing_status.get("features", {})
    if not isinstance(features, dict):
        features = {}

    is_free = plan_code == DEFAULT_PLAN_CODE
    is_pro_like = plan_code in {PRO_PLAN_CODE, LEGACY_PLAN_CODE}

    return {
        "plan_code": plan_code,
        "billing_enabled": bool(billing_status.get("billing_enabled")),
        "is_new_pricing_user": bool(billing_status.get("is_new_pricing_user")),
        "flags": {
            "text_tool": not is_free,
            "text_color_customize": is_pro_like,
            "done_tool": not is_free,
            "force_tool": not is_free,
            "measure_tool": not is_free,
            "done_style_customize": is_pro_like,
            "force_style_customize": is_pro_like,
            "measure_style_customize": is_pro_like,
            "collapse_toolbar": not is_free,
            "weather_metar_taf": bool(features.get("weather_metar_taf")),
            "weather_satellite": bool(features.get("weather_satellite")),
            "notam_detail": bool(features.get("notam_detail")),
            "all_layers": not is_free,
        },
        "allowed_layer_keys": [] if not is_free else ["moa"],
    }


def _public_plan_rows() -> list[dict[str, Any]]:
    return [
        {
            "plan_code": DEFAULT_PLAN_CODE,
            "name": "Free",
            "price_krw_monthly": PLAN_PRICES_KRW[DEFAULT_PLAN_CODE],
        },
        {
            "plan_code": LITE_PLAN_CODE,
            "name": "Lite",
            "price_krw_monthly": PLAN_PRICES_KRW[LITE_PLAN_CODE],
        },
        {
            "plan_code": PRO_PLAN_CODE,
            "name": "Pro",
            "price_krw_monthly": PLAN_PRICES_KRW[PRO_PLAN_CODE],
        },
    ]


def _transition_user_plan_from_payment(
    user_id: str,
    user_email: str,
    *,
    next_plan_code: str | None = None,
    pay_state: str = "",
    rebill_no: str = "",
    subscription_status: str | None = None,
    active: bool | None = None,
) -> dict[str, Any]:
    normalized_user_id = _normalize_user_identity(user_id)
    normalized_user_email = _normalize_user_email(user_email)
    if not normalized_user_id:
        return {}

    record = _ensure_billing_record(normalized_user_id, normalized_user_email)
    if normalized_user_email:
        record["user_email"] = normalized_user_email

    if next_plan_code:
        normalized_plan = _normalize_plan_code(next_plan_code, fallback=DEFAULT_PLAN_CODE)
        if normalized_plan in SUPPORTED_PLAN_CODES:
            record["plan_code"] = normalized_plan

    if rebill_no:
        record["payapp_rebill_no"] = str(rebill_no).strip()
    if pay_state:
        record["payapp_last_pay_state"] = str(pay_state).strip()
    if subscription_status:
        record["subscription_status"] = _normalize_subscription_status(subscription_status, fallback="inactive")
    if active is not None:
        record["subscription_active"] = bool(active)

    if _normalize_paid_plan_code(next_plan_code) and bool(active):
        _clear_promo_fields(record)

    if bool(record.get("legacy_full_access")):
        record["plan_code"] = LEGACY_PLAN_CODE
        record["subscription_status"] = "active"
        record["subscription_active"] = True

    return _save_user_billing_record(record)


def _trim_history_for_plan(items: list[dict], billing_status: dict[str, Any]) -> list[dict]:
    history_days = int(billing_status.get("history_days") or 0)
    history_limit = int(billing_status.get("history_limit") or 0)
    if history_limit <= 0:
        history_limit = USER_HISTORY_LIMIT

    now = datetime.now(timezone.utc)
    min_time = now - timedelta(days=history_days) if history_days > 0 else None
    filtered: list[dict] = []
    for item in items:
        uploaded = _parse_iso_datetime(str(item.get("uploaded_at") or ""))
        if min_time is not None and uploaded is not None and uploaded < min_time:
            continue
        filtered.append(item)

    return filtered[:history_limit]


def _validate_payapp_callback_payload(payload: dict[str, str], *, expected_price: int | None = None) -> None:
    userid, linkkey, linkval, _ = _payapp_config()
    if str(payload.get("userid") or "") != userid:
        raise HTTPException(status_code=400, detail="invalid payapp userid")
    if str(payload.get("linkkey") or "") != linkkey:
        raise HTTPException(status_code=400, detail="invalid payapp linkkey")
    if str(payload.get("linkval") or "") != linkval:
        raise HTTPException(status_code=400, detail="invalid payapp linkval")
    if expected_price is not None:
        try:
            posted_price = int(str(payload.get("price") or "0"))
        except ValueError as error:
            raise HTTPException(status_code=400, detail="invalid payapp price") from error
        if posted_price != expected_price:
            raise HTTPException(status_code=400, detail="invalid payapp price")


def _payment_event_key(payload: dict[str, str]) -> str:
    parts = [
        str(payload.get("mul_no") or ""),
        str(payload.get("pay_state") or ""),
        str(payload.get("var1") or ""),
        str(payload.get("price") or ""),
        str(payload.get("pay_date") or ""),
        str(payload.get("reqdate") or ""),
    ]
    return "|".join(parts)


def _supabase_auth_config() -> tuple[str, str]:
    supabase_url = str(os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip().rstrip("/")
    service_role_key = str(os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    anon_key = str(os.getenv("SUPABASE_ANON_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY") or "").strip()
    auth_key = service_role_key or anon_key

    if not supabase_url or not auth_key:
        raise HTTPException(status_code=503, detail="??뺤쒔 Supabase ?紐꾩쵄 ??쇱젟???袁⑥뵭??뤿???щ빍??")
    if not _is_http_url(supabase_url):
        raise HTTPException(status_code=503, detail="SUPABASE_URL ?類ㅻ뻼????而?몴?? ??녿뮸??덈뼄.")

    return supabase_url, auth_key


def _supabase_admin_config() -> tuple[str, str]:
    supabase_url = str(os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip().rstrip("/")
    service_role_key = str(os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()

    if not supabase_url or not service_role_key:
        raise HTTPException(status_code=503, detail="??뺤쒔 Supabase ?온?귐딆쁽 ?紐꾩쵄 ??쇱젟???袁⑥뵭??뤿???щ빍??")
    if not _is_http_url(supabase_url):
        raise HTTPException(status_code=503, detail="SUPABASE_URL ?類ㅻ뻼????而?몴?? ??녿뮸??덈뼄.")

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
            raise HTTPException(status_code=503, detail="??뺤쒔 Supabase ?온?귐딆쁽 ??? ??而?몴?? ??녿뮸??덈뼄.") from error
        if error.code == 429:
            raise HTTPException(status_code=429, detail="?遺욧퍕??筌띾‘???덈뼄. ?醫롫뻻 ????쇰뻻 ??뺣즲??雅뚯눘苑??") from error
        raise HTTPException(status_code=502, detail=detail or "Supabase ?紐꾩쵄 ?遺욧퍕????쎈솭??됰뮸??덈뼄.") from error
    except URLError as error:
        raise HTTPException(status_code=502, detail="Supabase ?紐꾩쵄 ??뺤쒔???怨뚭퍙??? 筌륁궢六??щ빍??") from error

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
        raise HTTPException(status_code=503, detail="NOTAM Supabase ??쇱젟???袁⑥뵭??뤿???щ빍??")
    if not _is_http_url(supabase_url):
        raise HTTPException(status_code=503, detail="NOTAM Supabase URL ?類ㅻ뻼????而?몴?? ??녿뮸??덈뼄.")
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
            raise HTTPException(status_code=503, detail="NOTAM Supabase API ??? ??而?몴?? ??녿뮸??덈뼄.") from error
        if error.code == 404:
            raise HTTPException(status_code=404, detail=detail or "NOTAM ?怨쀬뵠?????뮞??筌≪뼚? 筌륁궢六??щ빍??") from error
        if error.code == 429:
            raise HTTPException(status_code=429, detail="NOTAM ?遺욧퍕??筌띾‘???덈뼄. ?醫롫뻻 ????쇰뻻 ??뺣즲??雅뚯눘苑??") from error
        raise HTTPException(status_code=502, detail=detail or "NOTAM Supabase ?遺욧퍕????쎈솭??됰뮸??덈뼄.") from error
    except URLError as error:
        raise HTTPException(status_code=502, detail="NOTAM Supabase ??뺤쒔???怨뚭퍙??? 筌륁궢六??щ빍??") from error

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
        raise HTTPException(status_code=404, detail="NOTAM ???뵠??notam_scraper/notams)??筌≪뼚? 筌륁궢六??щ빍??")
    return []


def _extract_bearer_token(request: Request) -> str:
    auth_header = str(request.headers.get("Authorization") or "").strip()
    if not auth_header:
        return ""
    parts = auth_header.split(" ", 1)
    if len(parts) != 2:
        return ""
    scheme, token = parts[0].strip().lower(), parts[1].strip()
    if scheme != "bearer" or not token:
        return ""
    return token


def _supabase_user_from_access_token(access_token: str) -> tuple[str, str]:
    supabase_url, service_role_key = _supabase_auth_config()
    request = UrlRequest(
        url=f"{supabase_url}/auth/v1/user",
        method="GET",
        headers={
            "apikey": service_role_key,
            "Authorization": f"Bearer {access_token}",
        },
    )
    try:
        with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read()
    except HTTPError as error:
        detail = _extract_supabase_error_message(error.read())
        if error.code in {401, 403}:
            raise HTTPException(status_code=401, detail=detail or "?紐꾩쵄 ?醫뤾쿃????而?몴?? ??녿뮸??덈뼄.") from error
        raise HTTPException(status_code=502, detail=detail or "??????紐꾩쵄 ?類ㅼ뵥????쎈솭??됰뮸??덈뼄.") from error
    except URLError as error:
        raise HTTPException(status_code=502, detail="Supabase ?紐꾩쵄 ??뺤쒔???怨뚭퍙??? 筌륁궢六??щ빍??") from error

    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=502, detail="??????紐꾩쵄 ?臾먮뼗????곴퐤??? 筌륁궢六??щ빍??")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="??????紐꾩쵄 ?臾먮뼗 ?類ㅻ뻼????而?몴?? ??녿뮸??덈뼄.")

    user_id = _normalize_user_identity(str(payload.get("id") or ""))
    user_email = _normalize_user_email(str(payload.get("email") or ""))
    if not user_id:
        raise HTTPException(status_code=401, detail="?醫륁뒞??嚥≪뮄????紐꾨???袁⑤뻸??덈뼄.")
    return user_id, user_email


def _request_identity_with_created_at(
    request: Request,
    *,
    required: bool = False,
    require_token: bool = False,
) -> tuple[str, str, str]:
    token = _extract_bearer_token(request)
    if token:
        try:
            supabase_url, auth_key = _supabase_auth_config()
            supabase_request = UrlRequest(
                url=f"{supabase_url}/auth/v1/user",
                method="GET",
                headers={
                    "apikey": auth_key,
                    "Authorization": f"Bearer {token}",
                },
            )
            with urlopen(supabase_request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS) as response:
                raw = response.read()
            payload = json.loads(raw.decode("utf-8")) if raw else {}
            if isinstance(payload, dict):
                user_id = _normalize_user_identity(str(payload.get("id") or ""))
                user_email = _normalize_user_email(str(payload.get("email") or ""))
                created_at = str(payload.get("created_at") or "").strip()
                if user_id:
                    _record_user_activity(request, user_id, user_email)
                    return user_id, user_email, created_at
        except HTTPException:
            if required:
                raise
        except Exception:
            if required:
                raise HTTPException(status_code=401, detail="?筌뤾쑴理???ルㅎ荑???熬곣뫗???紐껊퉵?? ???곕뻣 ?β돦裕??筌뤿굝???낅슣?섋땻??")

    if required and require_token:
        raise HTTPException(status_code=401, detail="?筌뤾쑴理???ルㅎ荑???熬곣뫗???紐껊퉵?? ???곕뻣 ?β돦裕??筌뤿굝???낅슣?섋땻??")

    user_id, user_email = _request_user_identity(request, required=required)
    if user_id or user_email:
        _record_user_activity(request, user_id, user_email)
    return user_id, user_email, ""


def _request_user_identity(request: Request, *, required: bool = False) -> tuple[str, str]:
    user_id = _normalize_user_identity(request.headers.get("X-DOO-USER-ID"))
    user_email = _normalize_user_email(request.headers.get("X-DOO-USER-EMAIL"))
    if required and not user_id and not user_email:
        raise HTTPException(status_code=401, detail="login required")
    return user_id, user_email


def _request_verified_identity(request: Request, *, required: bool = False) -> tuple[str, str]:
    token = _extract_bearer_token(request)
    if token:
        return _supabase_user_from_access_token(token)

    user_id, user_email = _request_user_identity(request, required=False)
    if required and not user_id and not user_email:
        raise HTTPException(status_code=401, detail="login required")
    if required:
        raise HTTPException(status_code=401, detail="?紐꾩쵄 ?醫뤾쿃???袁⑹뒄??몃빍?? ??쇰뻻 嚥≪뮄??紐낅퉸 雅뚯눘苑??")
    return user_id, user_email


def _job_history_entry(job: dict) -> dict:
    payload_bucket, payload_path = _job_payload_storage_ref(job)
    return {
        "job_id": str(job.get("job_id") or ""),
        "filename": str(job.get("filename") or ""),
        "project_name": str(job.get("project_name") or ""),
        "mode": str(job.get("mode") or ""),
        "result_count": int(job.get("result_count") or 0),
        "uploaded_at": str(job.get("created_at") or ""),
        "payload_bucket": payload_bucket,
        "payload_path": payload_path,
    }


def _record_user_history(
    job: dict,
    billing_status: dict[str, Any] | None = None,
    access_token: str = "",
) -> None:
    user_id = _normalize_user_identity(str(job.get("user_id") or ""))
    user_email = _normalize_user_email(str(job.get("user_email") or ""))
    status = billing_status or _billing_status_for_user(user_id, user_email)
    history_paths = _history_paths_for_identity(user_id, user_email)
    if not history_paths and _history_supabase_config() is None:
        return
    entry = _job_history_entry(job)
    _history_supabase_upsert(user_id, user_email, entry, access_token=access_token)
    for path in history_paths:
        existing = _load_json(path, [])
        items = existing if isinstance(existing, list) else []
        next_items = [entry]
        next_items.extend(item for item in items if isinstance(item, dict) and item.get("job_id") != entry["job_id"])
        trimmed_items = _trim_history_for_plan(next_items, status)
        _save_json(path, trimmed_items[:USER_HISTORY_LIMIT])


def _remove_user_history_item(user_id: str, user_email: str, job_id: str) -> bool:
    normalized_job_id = str(job_id or "").strip()
    if not normalized_job_id:
        return False

    removed = False
    history_paths = _history_paths_for_identity(user_id, user_email)
    for path in history_paths:
        existing = _load_json(path, [])
        if not isinstance(existing, list):
            continue

        filtered: list[dict] = []
        changed = False
        for item in existing:
            if not isinstance(item, dict):
                continue
            if str(item.get("job_id") or "").strip() == normalized_job_id:
                changed = True
                continue
            filtered.append(item)

        if changed:
            _save_json(path, filtered[:USER_HISTORY_LIMIT])
            removed = True

    return removed


def _clear_user_history_items(user_id: str, user_email: str) -> int:
    removed_count = 0
    history_paths = _history_paths_for_identity(user_id, user_email)
    for path in history_paths:
        existing = _load_json(path, [])
        if not isinstance(existing, list):
            continue
        filtered = [item for item in existing if isinstance(item, dict)]
        removed_count += len(filtered)
        if path.exists():
            path.unlink(missing_ok=True)
    return removed_count


def _load_user_history(
    user_id: str,
    user_email: str = "",
    billing_status: dict[str, Any] | None = None,
    access_token: str = "",
) -> list[dict]:
    history_paths = _history_paths_for_identity(user_id, user_email)
    if not history_paths and _history_supabase_config() is None:
        return []

    merged: list[dict] = []
    seen_job_ids: set[str] = set()
    for item in _history_supabase_fetch(user_id, user_email, access_token=access_token):
        if not isinstance(item, dict):
            continue
        job_id = str(item.get("job_id") or "").strip()
        if job_id and job_id in seen_job_ids:
            continue
        if job_id:
            seen_job_ids.add(job_id)
        merged.append(item)

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
    status = billing_status or _billing_status_for_user(user_id, user_email)
    return _trim_history_for_plan(merged[:USER_HISTORY_LIMIT], status)


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
        "source_hash": _normalize_source_hash(str(job.get("source_hash") or "")),
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


@app.post("/api/admin/popup-notice/usage")
def get_popup_notice_admin_usage(payload: PopupNoticeAuthPayload):
    _require_popup_admin_password(payload.password)
    month_key, rows = _collect_popup_admin_usage_rows()
    return JSONResponse({"ok": True, "month_key": month_key, "count": len(rows), "users": rows})


@app.post("/api/admin/promo-codes/list")
def list_admin_promo_codes(payload: PopupNoticeAuthPayload):
    _require_popup_admin_password(payload.password)
    return JSONResponse({"ok": True, "codes": _list_promo_codes()})


@app.post("/api/admin/promo-codes")
def create_admin_promo_code(payload: PromoCodeCreatePayload):
    _require_popup_admin_password(payload.password)

    requested_code = _normalize_promo_code(payload.code)
    if requested_code and not PROMO_CODE_PATTERN.match(requested_code):
        raise HTTPException(status_code=400, detail="프로모션 코드는 영문 대문자, 숫자, -, _만 사용할 수 있습니다.")

    plan_code = _normalize_paid_plan_code(payload.plan_code)
    if not plan_code:
        raise HTTPException(status_code=400, detail="프로모션 대상 플랜은 lite 또는 pro만 가능합니다.")

    duration_days = max(min(int(payload.duration_days or 30), 365), 1)
    max_uses = max(min(int(payload.max_uses or 1), 100000), 1)
    expires_at = str(payload.expires_at or "").strip()
    if expires_at and _parse_iso_datetime(expires_at) is None:
        raise HTTPException(status_code=400, detail="코드 만료일 형식이 올바르지 않습니다.")

    with PROMO_CODE_LOCK:
        store = _load_promo_code_store()
        codes = store.setdefault("codes", {})
        if not isinstance(codes, dict):
            codes = {}
            store["codes"] = codes
        code = requested_code or _generate_promo_code_value(set(codes.keys()))
        if code in codes:
            raise HTTPException(status_code=400, detail="이미 존재하는 프로모션 코드입니다.")
        now_iso = _utc_now_iso()
        record = {
            "code": code,
            "plan_code": plan_code,
            "duration_days": duration_days,
            "max_uses": max_uses,
            "used_count": 0,
            "enabled": True,
            "expires_at": expires_at,
            "created_at": now_iso,
            "updated_at": now_iso,
            "redeemed_user_ids": [],
        }
        codes[code] = record
        saved_store = _save_promo_code_store(store)
        saved_record = dict((saved_store.get("codes") or {}).get(code) or record)

    return JSONResponse(
        {
            "ok": True,
            "promo_code": saved_record,
            "codes": _list_promo_codes(),
        }
    )


@app.post("/api/admin/promo-codes/toggle")
def toggle_admin_promo_code(payload: PromoCodeTogglePayload):
    _require_popup_admin_password(payload.password)
    code = _normalize_promo_code(payload.code)
    if not code:
        raise HTTPException(status_code=400, detail="프로모션 코드를 확인해 주세요.")

    with PROMO_CODE_LOCK:
        store = _load_promo_code_store()
        codes = store.setdefault("codes", {})
        if not isinstance(codes, dict) or code not in codes:
            raise HTTPException(status_code=404, detail="프로모션 코드를 찾을 수 없습니다.")
        record = dict(codes.get(code) or {})
        record["enabled"] = bool(payload.enabled)
        record["updated_at"] = _utc_now_iso()
        codes[code] = record
        _save_promo_code_store(store)

    return JSONResponse({"ok": True, "promo_code": codes.get(code), "codes": _list_promo_codes()})


@app.post("/api/admin/popup-notice")
def update_popup_notice(payload: PopupNoticeUpdatePayload):
    _require_popup_admin_password(payload.password)

    message = str(payload.message or "").strip()
    if len(message) > 500:
        raise HTTPException(status_code=400, detail="??밸씜 ?얜㈇???500????꾨릭嚥???낆젾??雅뚯눘苑??")

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
    access_token = _extract_bearer_token(request)
    user_id, user_email, created_at_hint = _request_identity_with_created_at(request, required=False)
    billing_status = _billing_status_for_user(user_id, user_email, created_at_hint=created_at_hint)

    if user_id and billing_status.get("billing_enabled"):
        file_size_limit_mb = int(billing_status.get("file_size_limit_mb") or 0)
        file_size_limit_bytes = file_size_limit_mb * 1024 * 1024 if file_size_limit_mb > 0 else 0
        source_file_bytes = max(int(payload.source_file_bytes or 0), 0)
        if file_size_limit_bytes > 0 and source_file_bytes > file_size_limit_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"?袁⑹삺 ???삏?????뵬 ??몄쎗 ??뺣즲({file_size_limit_mb}MB)???λ뜃???됰뮸??덈뼄.",
            )

        monthly_limit = int(billing_status.get("monthly_kml_limit") or 0)
        monthly_used = int(billing_status.get("monthly_kml_used") or 0)
        if monthly_limit > 0 and monthly_used >= monthly_limit:
            raise HTTPException(
                status_code=402,
                detail=f"??苡???KML 癰궰????뺣즲({monthly_limit}????筌뤴뫀紐??????됰뮸??덈뼄.",
            )

    source_hash = _normalize_source_hash(payload.source_hash)
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
        "source_file_bytes": int(payload.source_file_bytes or 0),
        "source_hash": source_hash,
    }
    payload_bucket, payload_path = _job_payload_supabase_store(job_data, access_token=access_token)
    if payload_bucket and payload_path:
        job_data["payload_bucket"] = payload_bucket
        job_data["payload_path"] = payload_path
    _save_json(_job_path(job_id), job_data)
    _record_user_history(
        job_data,
        billing_status=billing_status,
        access_token=access_token,
    )
    if user_id and billing_status.get("billing_enabled") and int(billing_status.get("monthly_kml_limit") or 0) > 0:
        _increment_usage_month(user_id, _current_month_key())

    return _job_response(job_data, base_url)


@app.post("/api/auth/password-reset/request")
async def request_password_reset(payload: PasswordResetRequest):
    email = _normalize_user_email(payload.email).lower()
    if not email or not EMAIL_PATTERN.match(email):
        raise HTTPException(status_code=400, detail="?醫륁뒞????李??깆뱽 ??낆젾??雅뚯눘苑??")

    redirect_to = str(payload.redirect_to or "").strip()
    if redirect_to and not _is_http_url(redirect_to):
        raise HTTPException(status_code=400, detail="redirect_to URL ?類ㅻ뻼????而?몴?? ??녿뮸??덈뼄.")

    supabase_url, service_role_key = _supabase_admin_config()
    if not _supabase_user_exists(supabase_url, service_role_key, email):
        raise HTTPException(status_code=404, detail="揶쎛??낅┷筌왖 ??? ??李??깆뿯??덈뼄.")

    _send_supabase_password_reset(supabase_url, service_role_key, email, redirect_to or None)
    return {"ok": True}


@app.get("/api/download/{job_id}/txt")
def download_txt(job_id: str):
    job = _load_job(job_id)
    billing_status = _job_owner_billing_status(job)
    if not _has_feature_access(billing_status, "text_download"):
        raise HTTPException(status_code=402, detail="?袁⑹삺 ???삏?癒?퐣????용뮞????쇱뒲嚥≪뮆諭띄몴??????????곷뮸??덈뼄.")
    content = (job.get("text_output") or "").encode("utf-8-sig")
    filename = _download_filename(job, ".txt")
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(BytesIO(content), media_type="text/plain; charset=utf-8", headers=headers)


@app.get("/api/download/{job_id}/xlsx")
def download_xlsx(job_id: str):
    job = _load_job(job_id)
    billing_status = _job_owner_billing_status(job)
    if not _has_feature_access(billing_status, "excel_download"):
        raise HTTPException(status_code=402, detail="?袁⑹삺 ???삏?癒?퐣???臾? ??쇱뒲嚥≪뮆諭띄몴??????????곷뮸??덈뼄.")

    with NamedTemporaryFile(delete=False, suffix=".xlsx") as temp_file:
        temp_path = Path(temp_file.name)

    try:
        map_payload = job.get("map_payload") if isinstance(job.get("map_payload"), dict) else {}
        polygons = map_payload.get("polygons") if isinstance(map_payload, dict) else []
        if not isinstance(polygons, list):
            polygons = []
        save_excel(
            job.get("results") or [],
            str(temp_path),
            str(job.get("project_name") or ""),
            str(job.get("mode") or "linestring"),
            polygons=polygons,
        )
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
    payload["viewer_state_key"] = _viewer_state_primary_storage_key(job)
    payload["viewer_billing"] = _viewer_billing_payload(_job_owner_billing_status(job))

    preview_gate = str(request.query_params.get("preview_gate", "")).lower() in {"1", "true", "yes", "on"}
    if preview_gate:
        payload["preview_gate"] = True
        payload["signup_url"] = request.query_params.get("signup_url") or f"{_allowed_origins()[0]}/login?next=/"

    return HTMLResponse(_viewer_html(job_id, payload))


@app.get("/api/viewer/default", response_class=HTMLResponse)
def get_default_viewer(request: Request):
    payload = _default_viewer_payload()
    viewer_user_id = _normalize_user_identity(str(request.query_params.get("user_id") or ""))
    viewer_user_email = _normalize_user_email(str(request.query_params.get("user_email") or ""))
    viewer_created_at = str(request.query_params.get("created_at") or "").strip()
    payload["viewer_billing"] = _viewer_billing_payload(
        _billing_status_for_user(viewer_user_id, viewer_user_email, created_at_hint=viewer_created_at)
    )

    preview_gate = str(request.query_params.get("preview_gate", "")).lower() in {"1", "true", "yes", "on"}
    if preview_gate:
        payload["preview_gate"] = True
        payload["signup_url"] = request.query_params.get("signup_url") or f"{_allowed_origins()[0]}/login?next=/"

    return HTMLResponse(
        _viewer_html_with_paths(
            payload,
            "/api/viewer-default/viewer-state",
            "/api/viewer-default/layers.json",
        )
    )


@app.get("/api/viewer-default/viewer-state")
def get_default_viewer_state():
    return JSONResponse({})


@app.post("/api/viewer-default/viewer-state")
async def save_default_viewer_state():
    return {"ok": True, "saved": False, "reason": "default_viewer"}


@app.get("/api/viewer-default/layers.json")
def get_default_viewer_layers():
    return JSONResponse(_load_map_layers())


@app.get("/api/home-state")
def get_home_state(request: Request):
    access_token = _extract_bearer_token(request)
    user_id, user_email, created_at_hint = _request_identity_with_created_at(request, required=True)
    billing_status = _billing_status_for_user(user_id, user_email, created_at_hint=created_at_hint)
    if not _has_feature_access(billing_status, "viewer_state"):
        return JSONResponse({})
    remote_state = _home_state_supabase_fetch(user_id, user_email, access_token=access_token)
    if isinstance(remote_state, dict):
        return JSONResponse(remote_state)
    for path in _home_state_paths(user_id, user_email):
        data = _load_json(path, {})
        if isinstance(data, dict) and data:
            return JSONResponse(data)
    return JSONResponse({})


@app.post("/api/home-state")
async def save_home_state(request: Request):
    access_token = _extract_bearer_token(request)
    user_id, user_email, created_at_hint = _request_identity_with_created_at(request, required=True)
    billing_status = _billing_status_for_user(user_id, user_email, created_at_hint=created_at_hint)
    if not _has_feature_access(billing_status, "viewer_state"):
        return JSONResponse({"ok": False, "saved": False, "reason": "plan_restricted"})
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="home state payload must be object")
    for path in _home_state_paths(user_id, user_email):
        _save_json(path, payload)
    _home_state_supabase_upsert(user_id, user_email, payload, access_token=access_token)
    return {"ok": True}


@app.get("/api/viewer/{job_id}/viewer-state")
def get_viewer_state(job_id: str, request: Request):
    access_token = _extract_bearer_token(request)
    _request_identity_with_created_at(request, required=False)
    job = _load_job(job_id, access_token=access_token)
    billing_status = _job_owner_billing_status(job)
    if not _has_feature_access(billing_status, "viewer_state"):
        return JSONResponse({})
    remote_state = _viewer_state_supabase_fetch(job, access_token=access_token)
    if isinstance(remote_state, dict):
        return JSONResponse(remote_state)
    for path in _viewer_state_paths_for_job(job):
        data = _load_json(path, {})
        if isinstance(data, dict) and data:
            return JSONResponse(data)
    return JSONResponse({})


@app.post("/api/viewer/{job_id}/viewer-state")
async def save_viewer_state(job_id: str, request: Request):
    access_token = _extract_bearer_token(request)
    _request_identity_with_created_at(request, required=False)
    job = _load_job(job_id, access_token=access_token)
    billing_status = _job_owner_billing_status(job)
    if not _has_feature_access(billing_status, "viewer_state"):
        return JSONResponse({"ok": False, "saved": False, "reason": "plan_restricted"})
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="viewer state??揶쏆빘猿??鍮???몃빍??")
    for path in _viewer_state_paths_for_job(job):
        _save_json(path, payload)
    _viewer_state_supabase_upsert(job, payload, access_token=access_token)
    return {"ok": True}


@app.get("/api/viewer/{job_id}/layers.json")
def get_layers(job_id: str, request: Request):
    _request_identity_with_created_at(request, required=False)
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
        raise HTTPException(status_code=400, detail="limit 揶쏅?????而?몴?? ??녿뮸??덈뼄.") from error
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
    user_id, user_email, created_at_hint = _request_identity_with_created_at(request, required=True)
    billing_status = _billing_status_for_user(user_id, user_email, created_at_hint=created_at_hint)
    return JSONResponse(
        {
            "items": _load_user_history(
                user_id,
                user_email,
                billing_status=billing_status,
                access_token=_extract_bearer_token(request),
            )
        }
    )


@app.delete("/api/history")
def delete_history_all(request: Request):
    user_id, user_email, created_at_hint = _request_identity_with_created_at(request, required=True)
    access_token = _extract_bearer_token(request)
    status = _billing_status_for_user(user_id, user_email, created_at_hint=created_at_hint)
    items = _load_user_history(user_id, user_email, billing_status=status, access_token=access_token)

    local_deleted_count = _clear_user_history_items(user_id, user_email)
    supabase_deleted_count = _history_supabase_delete_all(user_id, user_email, access_token=access_token)
    if local_deleted_count <= 0 and supabase_deleted_count <= 0:
        local_deleted_count = len(items)

    return JSONResponse(
        {
            "ok": True,
            "deleted_count": max(local_deleted_count, supabase_deleted_count),
        }
    )


@app.get("/api/history/{job_id}")
def get_history_item(job_id: str, request: Request):
    user_id, user_email, _ = _request_identity_with_created_at(request, required=True)
    job = _load_job(job_id, access_token=_extract_bearer_token(request))
    owner_id = _normalize_user_identity(str(job.get("user_id") or ""))
    owner_email = _normalize_user_email(str(job.get("user_email") or ""))
    request_email = _normalize_user_email(user_email)

    matches_id = bool(user_id) and owner_id == user_id
    matches_email = bool(request_email) and bool(owner_email) and owner_email == request_email
    if not (matches_id or matches_email):
        raise HTTPException(status_code=404, detail="history item not found")
    return JSONResponse(_job_response(job, _external_base_url(request)))


@app.delete("/api/history/{job_id}")
def delete_history_item(job_id: str, request: Request):
    user_id, user_email, created_at_hint = _request_identity_with_created_at(request, required=True)
    access_token = _extract_bearer_token(request)
    status = _billing_status_for_user(user_id, user_email, created_at_hint=created_at_hint)
    items = _load_user_history(user_id, user_email, billing_status=status, access_token=access_token)

    target_job_id = str(job_id or "").strip()
    if not target_job_id:
        raise HTTPException(status_code=400, detail="job_id is required")

    if not any(str(item.get("job_id") or "").strip() == target_job_id for item in items):
        raise HTTPException(status_code=404, detail="history item not found")

    removed_local = _remove_user_history_item(user_id, user_email, target_job_id)
    removed_supabase = _history_supabase_delete(user_id, user_email, target_job_id, access_token=access_token)
    return JSONResponse({"ok": True, "deleted": bool(removed_local or removed_supabase), "job_id": target_job_id})


@app.get("/api/billing/plans")
def get_billing_plans():
    return JSONResponse(
        {
            "ok": True,
            "billing_enabled": _billing_enabled(),
            "plans": _public_plan_rows(),
            "notice": {
                "legacy": "野껉퀣????뽯뮞???袁⑹뿯????곸읈 揶쎛??놁쁽??疫꿸퀣??揶쎛??놁쁽 ??쀪문(疫꿸퀣??疫꿸퀡?????醫???몃빍??",
                "rejoin": "??덉뵬?紐꾩뵠?遺얠뵬??????李??곗쨮 ?醫됲뇣 揶쎛??뉖립 野껋럩???醫됲뇣 ???뜚 ?類ㅼ퐠???怨몄뒠??몃빍??",
            },
        }
    )


@app.get("/api/billing/status")
def get_billing_status(request: Request):
    user_id, user_email, created_at_hint = _request_identity_with_created_at(request, required=False)
    status = _billing_status_for_user(user_id, user_email, created_at_hint=created_at_hint)
    status["plans"] = _public_plan_rows()
    return JSONResponse(status)


@app.post("/api/billing/promo-code/redeem")
def redeem_billing_promo_code(payload: BillingPromoRedeemPayload, request: Request):
    user_id, user_email, created_at_hint = _request_identity_with_created_at(request, required=True, require_token=True)
    billing_status = _billing_status_for_user(user_id, user_email, created_at_hint=created_at_hint)
    if not billing_status.get("billing_enabled"):
        raise HTTPException(status_code=400, detail="현재는 프로모션 코드가 필요하지 않은 상태입니다.")
    if not billing_status.get("is_new_pricing_user"):
        raise HTTPException(status_code=400, detail="기존 가입자 혜택 계정은 별도 프로모션 코드가 필요하지 않습니다.")
    if bool(billing_status.get("subscription_active")):
        raise HTTPException(status_code=400, detail="이미 활성 구독 중인 계정에는 프로모션 코드를 적용할 수 없습니다.")
    if bool(billing_status.get("promo_active")):
        raise HTTPException(status_code=400, detail="이미 적용 중인 프로모션이 있습니다.")

    code = _normalize_promo_code(payload.code)
    if not code:
        raise HTTPException(status_code=400, detail="프로모션 코드를 입력해 주세요.")

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    applied_record = _ensure_billing_record(user_id, user_email, created_at_hint=created_at_hint)

    with PROMO_CODE_LOCK:
        store = _load_promo_code_store()
        codes = store.setdefault("codes", {})
        if not isinstance(codes, dict):
            raise HTTPException(status_code=500, detail="프로모션 코드 저장소를 불러오지 못했습니다.")
        promo_record = dict(codes.get(code) or {})
        if not promo_record:
            raise HTTPException(status_code=404, detail="유효하지 않은 프로모션 코드입니다.")
        if not bool(promo_record.get("enabled")):
            raise HTTPException(status_code=400, detail="현재 사용할 수 없는 프로모션 코드입니다.")

        code_expires_at = _parse_iso_datetime(str(promo_record.get("expires_at") or ""))
        if code_expires_at is not None and code_expires_at <= now:
            raise HTTPException(status_code=400, detail="만료된 프로모션 코드입니다.")

        max_uses = max(int(promo_record.get("max_uses") or 1), 1)
        used_count = max(int(promo_record.get("used_count") or 0), 0)
        if used_count >= max_uses:
            raise HTTPException(status_code=400, detail="사용 가능 횟수가 모두 소진된 프로모션 코드입니다.")

        redeemed_user_ids = promo_record.get("redeemed_user_ids", [])
        if not isinstance(redeemed_user_ids, list):
            redeemed_user_ids = []
        normalized_redeemers = {
            _normalize_user_identity(str(item or ""))
            for item in redeemed_user_ids
            if _normalize_user_identity(str(item or ""))
        }
        if user_id in normalized_redeemers:
            raise HTTPException(status_code=400, detail="이 계정에는 이미 적용한 프로모션 코드입니다.")

        duration_days = max(int(promo_record.get("duration_days") or 30), 1)
        promo_expires_at = (now + timedelta(days=duration_days)).isoformat()
        applied_record["promo_code"] = code
        applied_record["promo_plan_code"] = _normalize_paid_plan_code(str(promo_record.get("plan_code") or ""))
        applied_record["promo_applied_at"] = now_iso
        applied_record["promo_expires_at"] = promo_expires_at
        _save_user_billing_record(applied_record)

        normalized_redeemers.add(user_id)
        promo_record["used_count"] = used_count + 1
        promo_record["redeemed_user_ids"] = sorted(normalized_redeemers)
        promo_record["updated_at"] = now_iso
        codes[code] = promo_record
        _save_promo_code_store(store)

    latest_billing_status = _billing_status_for_user(user_id, user_email, created_at_hint=created_at_hint)
    latest_billing_status["plans"] = _public_plan_rows()
    return JSONResponse(
        {
            "ok": True,
            "message": f"{code} 코드가 적용되었습니다. {int(latest_billing_status.get('promo_remaining_days') or 0)}일 동안 {str(latest_billing_status.get('plan_code') or '').upper()} 기능을 사용할 수 있습니다.",
            "billing_status": latest_billing_status,
        }
    )


@app.post("/api/billing/payapp/start")
async def start_payapp_subscription(payload: BillingStartPayload, request: Request):
    user_id, user_email, created_at_hint = _request_identity_with_created_at(request, required=True, require_token=True)
    billing_status = _billing_status_for_user(user_id, user_email, created_at_hint=created_at_hint)
    if not billing_status.get("billing_enabled"):
        raise HTTPException(status_code=400, detail="野껉퀣??疫꿸퀡????袁⑹춦 ??뽮쉐?遺얜┷筌왖 ??녿릭??щ빍??")
    if not billing_status.get("is_new_pricing_user"):
        raise HTTPException(status_code=400, detail="疫꿸퀣??揶쎛??놁쁽 ??쀪문 ???怨몄쁽??癰귢쑬猷?野껉퀣?ｅ첎? ?袁⑹뒄??? ??녿뮸??덈뼄.")

    plan_code = _normalize_plan_code(payload.plan_code, fallback=DEFAULT_PLAN_CODE)
    if plan_code not in {LITE_PLAN_CODE, PRO_PLAN_CODE}:
        raise HTTPException(status_code=400, detail="筌왖?癒곕릭筌왖 ??낅뮉 ?닌됰즴 ???삏??낅빍??")

    buyer_phone = _sanitize_phone(payload.buyer_phone)
    if len(buyer_phone) < 9:
        raise HTTPException(status_code=400, detail="野껉퀣???????袁れ넅 甕곕뜇?뉒몴???而?몴?우쓺 ??낆젾??雅뚯눘苑??")

    price = int(PLAN_PRICES_KRW.get(plan_code) or 0)
    if price <= 0:
        raise HTTPException(status_code=500, detail="野껉퀣??疫뀀뜆釉???쇱젟????而?몴?? ??녿뮸??덈뼄.")

    order_id = uuid4().hex
    userid, _, _, _ = _payapp_config()
    openpaytype = _payapp_openpaytype()
    order = _save_payment_order(
        {
            "order_id": order_id,
            "user_id": user_id,
            "user_email": user_email,
            "plan_code": plan_code,
            "price": price,
            "status": "request_created",
            "pay_state": "",
            "rebill_no": "",
            "payurl": "",
        }
    )

    payapp_payload = {
        "cmd": "rebillRegist",
        "userid": userid,
        "goodname": PLAN_PAYAPP_GOODNAME.get(plan_code, f"DOO Extractor {plan_code.title()} Monthly"),
        "goodprice": str(price),
        "recvemail": user_email,
        "recvphone": buyer_phone,
        "rebillCycleType": "Month",
        "rebillCycleMonth": str(os.getenv("PAYAPP_REBILL_CYCLE_MONTH") or "90").strip(),
        "rebillExpire": _payment_rebill_expire(),
        "feedbackurl": _payment_feedback_url(request),
        "failurl": _payment_fail_url(request),
        "returnurl": _payment_return_url(request, payload.return_url),
        "checkretry": "y",
        "smsuse": "n",
        "openpaytype": openpaytype,
        "pay_type": openpaytype,
        "var1": order_id,
        "var2": plan_code,
    }
    response_payload = _payapp_request(payapp_payload)
    state = str(response_payload.get("state") or "").strip()
    if state != "1":
        error_message = str(response_payload.get("errorMessage") or response_payload.get("raw") or "").strip()
        _save_payment_order(
            {
                **order,
                "status": "request_failed",
                "error_message": error_message,
            }
        )
        raise HTTPException(status_code=502, detail=error_message or "PayApp ?類?┛野껉퀣???遺욧퍕 ?源낆쨯????쎈솭??됰뮸??덈뼄.")

    payurl = str(response_payload.get("payurl") or "").strip()
    rebill_no = str(response_payload.get("rebill_no") or "").strip()
    saved_order = _save_payment_order(
        {
            **order,
            "status": "awaiting_first_approval",
            "payurl": payurl,
            "rebill_no": rebill_no,
            "pay_state": "1",
        }
    )
    _transition_user_plan_from_payment(
        user_id,
        user_email,
        pay_state="1",
        rebill_no=rebill_no,
        subscription_status="pending",
        active=False,
    )

    return JSONResponse(
        {
            "ok": True,
            "order_id": saved_order.get("order_id"),
            "plan_code": plan_code,
            "price_krw": price,
            "payurl": payurl,
            "rebill_no": rebill_no,
        }
    )


@app.post("/api/billing/payapp/feedback")
async def payapp_feedback(request: Request):
    raw_body = await request.body()
    payload = _parse_payapp_form(raw_body)
    if not payload:
        payload = {key: str(value) for key, value in request.query_params.items()}

    try:
        order_id = _normalize_user_identity(payload.get("var1"))
        order = _load_payment_order(order_id) if order_id else {}
        expected_price = int(order.get("price") or 0) if order else None
        _validate_payapp_callback_payload(payload, expected_price=expected_price)

        event_key = _payment_event_key(payload)
        if not event_key.strip("|"):
            event_key = f"{order_id}:{payload.get('pay_state', '')}:{payload.get('mul_no', '')}"
        is_new_event = _mark_payment_event_processed(
            event_key,
            {
                "received_at": _utc_now_iso(),
                "payload": payload,
            },
        )
        if not is_new_event:
            return PlainTextResponse("SUCCESS")

        pay_state = str(payload.get("pay_state") or "").strip()
        rebill_no = str(payload.get("rebill_no") or order.get("rebill_no") or "").strip()
        mul_no = str(payload.get("mul_no") or "").strip()

        if order:
            updated_order = dict(order)
            updated_order["pay_state"] = pay_state
            updated_order["last_mul_no"] = mul_no
            updated_order["rebill_no"] = rebill_no
            if pay_state == PAYAPP_SUCCESS_STATE:
                updated_order["status"] = "active"
            elif pay_state == PAYAPP_FAIL_STATE:
                updated_order["status"] = "payment_failed"
            elif pay_state in PAYAPP_CANCEL_STATES:
                updated_order["status"] = "cancelled"
            elif pay_state in PAYAPP_PARTIAL_CANCEL_STATES:
                updated_order["status"] = "partially_cancelled"
            else:
                updated_order["status"] = "pending"
            _save_payment_order(updated_order)

            owner_user_id = _normalize_user_identity(str(order.get("user_id") or ""))
            owner_email = _normalize_user_email(str(order.get("user_email") or ""))
            owner_plan = _normalize_plan_code(str(order.get("plan_code") or ""), fallback=DEFAULT_PLAN_CODE)
            if owner_user_id:
                if pay_state == PAYAPP_SUCCESS_STATE:
                    _transition_user_plan_from_payment(
                        owner_user_id,
                        owner_email,
                        next_plan_code=owner_plan,
                        pay_state=pay_state,
                        rebill_no=rebill_no,
                        subscription_status="active",
                        active=True,
                    )
                elif pay_state in PAYAPP_CANCEL_STATES:
                    _transition_user_plan_from_payment(
                        owner_user_id,
                        owner_email,
                        next_plan_code=DEFAULT_PLAN_CODE,
                        pay_state=pay_state,
                        rebill_no=rebill_no,
                        subscription_status="cancelled",
                        active=False,
                    )
                elif pay_state in PAYAPP_PENDING_STATES:
                    _transition_user_plan_from_payment(
                        owner_user_id,
                        owner_email,
                        pay_state=pay_state,
                        rebill_no=rebill_no,
                        subscription_status="pending",
                        active=False,
                    )
                elif pay_state in PAYAPP_PARTIAL_CANCEL_STATES:
                    _transition_user_plan_from_payment(
                        owner_user_id,
                        owner_email,
                        pay_state=pay_state,
                        rebill_no=rebill_no,
                    )

    except Exception:
        return PlainTextResponse("FAIL")

    return PlainTextResponse("SUCCESS")


@app.post("/api/billing/payapp/fail")
async def payapp_fail(request: Request):
    raw_body = await request.body()
    payload = _parse_payapp_form(raw_body)
    if not payload:
        payload = {key: str(value) for key, value in request.query_params.items()}

    try:
        order_id = _normalize_user_identity(payload.get("var1"))
        order = _load_payment_order(order_id) if order_id else {}
        expected_price = int(order.get("price") or 0) if order else None
        _validate_payapp_callback_payload(payload, expected_price=expected_price)
        event_key = f"fail:{_payment_event_key(payload)}"
        _mark_payment_event_processed(
            event_key,
            {
                "received_at": _utc_now_iso(),
                "payload": payload,
            },
        )

        if order:
            _save_payment_order(
                {
                    **order,
                    "status": "payment_failed",
                    "pay_state": str(payload.get("pay_state") or PAYAPP_FAIL_STATE),
                    "last_mul_no": str(payload.get("mul_no") or ""),
                }
            )
            owner_user_id = _normalize_user_identity(str(order.get("user_id") or ""))
            owner_email = _normalize_user_email(str(order.get("user_email") or ""))
            if owner_user_id:
                _transition_user_plan_from_payment(
                    owner_user_id,
                    owner_email,
                    next_plan_code=DEFAULT_PLAN_CODE,
                    pay_state=str(payload.get("pay_state") or PAYAPP_FAIL_STATE),
                    rebill_no=str(payload.get("rebill_no") or order.get("rebill_no") or ""),
                    subscription_status="payment_failed",
                    active=False,
                )
    except Exception:
        return PlainTextResponse("FAIL")

    return PlainTextResponse("SUCCESS")


@app.post("/api/billing/subscription/cancel")
def cancel_subscription(payload: BillingCancelPayload, request: Request):
    user_id, user_email, created_at_hint = _request_identity_with_created_at(request, required=True, require_token=True)
    billing_status = _billing_status_for_user(user_id, user_email, created_at_hint=created_at_hint)
    if not billing_status.get("billing_enabled"):
        raise HTTPException(status_code=400, detail="野껉퀣??疫꿸퀡????袁⑹춦 ??뽮쉐?遺얜┷筌왖 ??녿릭??щ빍??")
    if not billing_status.get("is_new_pricing_user"):
        raise HTTPException(status_code=400, detail="疫꿸퀣??揶쎛??놁쁽 ??쀪문 ?④쑴??? ??? ???怨몄뵠 ?袁⑤뻸??덈뼄.")

    record = _ensure_billing_record(user_id, user_email, created_at_hint=created_at_hint)
    rebill_no = str(record.get("payapp_rebill_no") or "").strip()
    if not rebill_no:
        raise HTTPException(status_code=400, detail="??????類?┛野껉퀣???類ｋ궖揶쎛 ??곷뮸??덈뼄.")

    userid, linkkey, _, _ = _payapp_config()
    response_payload = _payapp_request(
        {
            "cmd": "rebillCancel",
            "userid": userid,
            "linkkey": linkkey,
            "rebill_no": rebill_no,
        }
    )
    if str(response_payload.get("state") or "").strip() != "1":
        error_message = str(response_payload.get("errorMessage") or "").strip()
        raise HTTPException(status_code=502, detail=error_message or "?類?┛野껉퀣????? ?遺욧퍕????쎈솭??됰뮸??덈뼄.")

    _transition_user_plan_from_payment(
        user_id,
        user_email,
        next_plan_code=DEFAULT_PLAN_CODE,
        pay_state="cancel",
        rebill_no=rebill_no,
        subscription_status="cancelled",
        active=False,
    )
    return JSONResponse({"ok": True, "message": "?類?┛野껉퀣?ｅ첎? ?????뤿???щ빍??", "reason": payload.reason})


@app.get("/ads.txt")
def get_ads_txt():
    if ADS_TXT_PATH.exists():
        return FileResponse(ADS_TXT_PATH, media_type="text/plain; charset=utf-8")
    return PlainTextResponse(
        "google.com, pub-7599505823176898, DIRECT, f08c47fec0942fa0",
        media_type="text/plain; charset=utf-8",
    )


@app.get("/api/assets/html2canvas.min.js")
def get_html2canvas():
    if not HTML2CANVAS_PATH.exists():
        raise HTTPException(status_code=404, detail="html2canvas ?癒?텦??筌≪뼚??????곷뮸??덈뼄.")
    return FileResponse(HTML2CANVAS_PATH, media_type="application/javascript")


@app.get("/api/assets/doogpx.png")
def get_banner():
    if not BANNER_PATH.exists():
        raise HTTPException(status_code=404, detail="獄쏄퀡瑗????筌왖??筌≪뼚??????곷뮸??덈뼄.")
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
