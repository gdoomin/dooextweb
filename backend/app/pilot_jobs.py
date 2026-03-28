from __future__ import annotations

import hashlib
import html
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode
from urllib.request import Request as UrlRequest, urlopen


AIRPORTAL_WORK_LIST_API_URL = "https://www.airportal.go.kr/work/getAirworkJobList.do"
AIRPORTAL_WORK_DETAIL_URL = "https://www.airportal.go.kr/work/employment/workDetail.do"
AIRPORTAL_TIMEOUT_SECONDS = 20
SUPABASE_HTTP_TIMEOUT_SECONDS = 10
KST = timezone(timedelta(hours=9))

PILOT_JOBS_SOURCE_CODE = "airportal"
PILOT_JOBS_SOURCE_LABEL = "Airportal 항공일자리"
PILOT_JOBS_SOURCE_BASE_URL = "https://www.airportal.go.kr"
PILOT_JOBS_SOURCE_CAREERS_URL = "https://www.airportal.go.kr/work/employment/list.do"

PILOT_JOB_FETCH_TERMS = [
    "운항승무원",
    "조종사",
    "파일럿",
    "기장",
    "부기장",
    "비행교관",
    "교관 조종사",
    "사업용",
    "운송용",
    "cadet pilot",
    "flight instructor",
    "first officer",
    "captain",
    "pilot",
]

PILOT_JOB_NEGATIVE_KEYWORDS = [
    "드론",
    "uav",
    "무인기",
    "무인 항공",
    "무인항공",
    "군집 드론",
    "드론조종",
]

PILOT_JOB_POSITIVE_OVERRIDE_KEYWORDS = [
    "운항승무원",
    "항공기",
    "비행교관",
    "교관 조종사",
    "부기장",
    "기장",
    "captain",
    "first officer",
    "flight instructor",
    "cadet pilot",
    "a320",
    "a321",
    "b737",
    "b787",
    "atr",
    "c208",
    "helicopter",
    "rotary",
]

AIRCRAFT_TYPE_PATTERNS: tuple[tuple[str, str], ...] = (
    ("A320", r"\ba320(?:neo)?\b"),
    ("A321", r"\ba321(?:neo)?\b"),
    ("A330", r"\ba330(?:neo)?\b"),
    ("A350", r"\ba350\b"),
    ("B737", r"\bb737(?:ng|max)?\b"),
    ("B747", r"\bb747\b"),
    ("B767", r"\bb767\b"),
    ("B777", r"\bb777\b"),
    ("B787", r"\bb787\b"),
    ("ATR72", r"\batr\s?72(?:-\d+)?\b"),
    ("C208", r"\bc208\b"),
    ("DHC-6", r"\bdhc-?6\b"),
    ("EC135", r"\bec135\b"),
    ("H145", r"\bh145\b"),
    ("KA-32", r"\bka-?32\b"),
    ("S-76", r"\bs-?76\b"),
    ("AW139", r"\baw139\b"),
)

ROTARY_AIRCRAFT_TYPES = {"EC135", "H145", "KA-32", "S-76", "AW139"}
KOREAN_LOCATION_MARKERS = {
    "서울",
    "경기",
    "인천",
    "강원",
    "충북",
    "충남",
    "대전",
    "세종",
    "전북",
    "전남",
    "광주",
    "경북",
    "경남",
    "대구",
    "부산",
    "울산",
    "제주",
    "지역무관",
    "전국",
}

ROLE_FAMILY_LABELS = {
    "pilot": "조종사",
    "captain": "기장",
    "first_officer": "부기장",
    "flight_instructor": "비행교관",
    "cadet": "Cadet",
    "helicopter_pilot": "회전익 조종사",
    "special_mission_pilot": "특수운항 조종사",
    "other_flight_crew": "운항승무원",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_space_text(value: Any) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or "")).strip())


def normalize_search_text(value: Any) -> str:
    return normalize_space_text(value).lower()


def dedupe_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        text = normalize_space_text(value)
        if not text or text in seen:
            continue
        seen.add(text)
        output.append(text)
    return output


def slugify_text(value: str, fallback_prefix: str) -> str:
    normalized = normalize_search_text(value)
    cleaned = re.sub(r"[^\w\s-]", "", normalized, flags=re.UNICODE)
    cleaned = re.sub(r"[-\s]+", "-", cleaned, flags=re.UNICODE).strip("-_")
    if cleaned:
        return cleaned[:120]
    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:10]
    return f"{fallback_prefix}-{digest}"


def airportal_job_detail_url(job_no: Any) -> str:
    return f"{AIRPORTAL_WORK_DETAIL_URL}?num={quote(str(job_no or '').strip())}"


def parse_dot_date(value: Any) -> datetime | None:
    text = normalize_space_text(value)
    if not text:
        return None
    try:
        parsed = datetime.strptime(text, "%Y.%m.%d")
    except ValueError:
        return None
    return parsed.replace(tzinfo=KST)


def to_start_of_day_iso(value: Any) -> str:
    parsed = parse_dot_date(value)
    if parsed is None:
        return ""
    return parsed.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()


def to_end_of_day_iso(value: Any) -> str:
    parsed = parse_dot_date(value)
    if parsed is None:
        return ""
    return parsed.replace(hour=23, minute=59, second=59, microsecond=0).isoformat()


def post_airportal_jobs(payload: dict[str, Any]) -> dict[str, Any]:
    request_body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = UrlRequest(
        url=AIRPORTAL_WORK_LIST_API_URL,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        },
        data=request_body,
    )
    with urlopen(request, timeout=AIRPORTAL_TIMEOUT_SECONDS) as response:
        raw = response.read().decode("utf-8", errors="ignore")
    data = json.loads(raw or "{}")
    if not isinstance(data, dict):
        raise RuntimeError("채용정보 응답 형식이 올바르지 않습니다.")
    if str(data.get("resultCode") or "") != "200":
        raise RuntimeError("채용정보 응답 코드가 올바르지 않습니다.")
    return data


def extract_pilot_job_matches(item: dict[str, Any]) -> list[str]:
    title = normalize_space_text(item.get("title"))
    company = normalize_space_text(item.get("compNm"))
    area = normalize_space_text(item.get("areaCodeNm") or item.get("workRegion"))
    duty_names = " ".join(normalize_space_text(name) for name in item.get("jobDutyCodeNmList") or [])
    experience_names = " ".join(normalize_space_text(name) for name in item.get("jobExpCodeNmList") or [])
    combined = " ".join(part for part in [title, company, area, duty_names, experience_names] if part)
    normalized = normalize_search_text(combined)
    if not normalized:
        return []

    has_negative_keyword = any(keyword in normalized for keyword in PILOT_JOB_NEGATIVE_KEYWORDS)
    has_positive_override = any(keyword in normalized for keyword in PILOT_JOB_POSITIVE_OVERRIDE_KEYWORDS)
    if has_negative_keyword and not has_positive_override:
        return []

    first_officer_hit = any(keyword in normalized for keyword in ("부기장", "first officer"))
    captain_hit = bool(re.search(r"(?<!부)기장", normalized)) or "captain" in normalized
    instructor_hit = any(keyword in normalized for keyword in ("비행교관", "교관 조종사", "flight instructor", "cfi"))
    flight_crew_hit = any(keyword in normalized for keyword in ("운항승무원", "flight crew"))
    cadet_hit = any(keyword in normalized for keyword in ("cadet pilot", "cadet"))
    cpl_hit = any(keyword in normalized for keyword in ("사업용 면장", "사업용조종사", "사업용 조종사", "사업용 조종사면장", " cpl"))
    atpl_hit = any(keyword in normalized for keyword in ("운송용 면장", "운송용조종사", "운송용 조종사", " atpl"))
    pilot_hit = any(keyword in normalized for keyword in ("비행기조종사", "조종사", "파일럿", "pilot"))

    matched: list[str] = []
    if flight_crew_hit:
        matched.append("운항승무원")
    if pilot_hit or first_officer_hit or captain_hit or instructor_hit or cadet_hit:
        matched.append("조종사")
    if "파일럿" in normalized or "pilot" in normalized:
        matched.append("파일럿")
    if first_officer_hit:
        matched.append("부기장")
    if captain_hit and not first_officer_hit:
        matched.append("기장")
    if instructor_hit:
        matched.append("비행교관")
    if cpl_hit:
        matched.append("사업용 면장")
    if atpl_hit:
        matched.append("운송용 면장")
    if cadet_hit:
        matched.append("Cadet")

    return dedupe_preserve_order(matched)


def extract_license_tags(normalized_text: str, matched_keywords: list[str]) -> list[str]:
    tags: list[str] = []
    if "사업용 면장" in matched_keywords or " cpl" in normalized_text:
        tags.append("CPL")
    if "운송용 면장" in matched_keywords or " atpl" in normalized_text:
        tags.append("ATPL")
    if any(keyword in normalized_text for keyword in ("계기", "instrument", " ir ")):
        tags.append("IR")
    if any(keyword in normalized_text for keyword in ("다발", "multi-engine", " me ")):
        tags.append("ME")
    if any(keyword in normalized_text for keyword in ("비행교관", "flight instructor", "cfi", "교관")):
        tags.append("FI")
    if "type rating" in normalized_text or "자격한정" in normalized_text:
        tags.append("Type Rating")
    return dedupe_preserve_order(tags)


def extract_aircraft_types(normalized_text: str) -> list[str]:
    detected: list[str] = []
    for aircraft_type, pattern in AIRCRAFT_TYPE_PATTERNS:
        if re.search(pattern, normalized_text, flags=re.IGNORECASE):
            detected.append(aircraft_type)
    if "helicopter" in normalized_text or "회전익" in normalized_text:
        detected.append("HELICOPTER")
    return dedupe_preserve_order(detected)


def derive_aircraft_category(normalized_text: str, aircraft_types: list[str]) -> str:
    if any(aircraft_type in ROTARY_AIRCRAFT_TYPES for aircraft_type in aircraft_types) or "helicopter" in normalized_text or "회전익" in normalized_text:
        return "rotary_wing"
    if any(aircraft_type.startswith(("A", "B", "ATR")) for aircraft_type in aircraft_types):
        return "airliner"
    if any(aircraft_type in {"C208", "DHC-6"} for aircraft_type in aircraft_types):
        return "fixed_wing"
    if any(keyword in normalized_text for keyword in ("business jet", "bizjet", "비즈젯")):
        return "business_jet"
    return "fixed_wing"


def derive_role_family(normalized_text: str, matched_keywords: list[str], aircraft_types: list[str]) -> str:
    if "비행교관" in matched_keywords:
        return "flight_instructor"
    if "부기장" in matched_keywords:
        return "first_officer"
    if "기장" in matched_keywords:
        return "captain"
    if "Cadet" in matched_keywords:
        return "cadet"
    if any(aircraft_type in ROTARY_AIRCRAFT_TYPES for aircraft_type in aircraft_types) or "회전익" in normalized_text or "helicopter" in normalized_text:
        return "helicopter_pilot"
    if "운항승무원" in matched_keywords and "조종사" not in matched_keywords:
        return "other_flight_crew"
    return "pilot"


def derive_experience_level(experience_text: str) -> str:
    normalized = normalize_search_text(experience_text)
    if not normalized or "무관" in normalized:
        return "open"
    if "신입" in normalized and "경력" not in normalized:
        return "entry"
    if "신입" in normalized and "경력" in normalized:
        return "open"
    if "경력" in normalized:
        return "experienced"
    return "open"


def derive_employment_type_code(employment_text: str, always_recruit: bool) -> str:
    normalized = normalize_search_text(employment_text)
    if always_recruit:
        return "open_recruiting"
    if "정규직" in normalized:
        return "full_time"
    if "계약직" in normalized:
        return "contract"
    if "인턴" in normalized:
        return "intern"
    if "파트" in normalized or "part" in normalized:
        return "part_time"
    return "full_time" if normalized else "open_recruiting"


def derive_location_fields(location_text: str) -> tuple[str, str, str]:
    location = normalize_space_text(location_text)
    if not location:
        return "", "", ""
    if any(marker in location for marker in KOREAN_LOCATION_MARKERS):
        return "KR", location, ""
    return "", location, ""


def compose_search_document(parts: list[str]) -> str:
    tokens: list[str] = []
    for part in parts:
        text = normalize_space_text(part)
        if not text:
            continue
        tokens.append(text)
    return " ".join(dedupe_preserve_order(tokens))


def is_open_pilot_job(item: dict[str, Any]) -> bool:
    d_day = normalize_space_text(item.get("d_day"))
    if "채용종료" in d_day:
        return False
    deadline_date = normalize_space_text(item.get("deadline_date"))
    if not deadline_date:
        return True
    parsed_deadline = parse_dot_date(deadline_date)
    if parsed_deadline is None:
        return True
    return parsed_deadline.date() >= datetime.now(KST).date()


def pilot_job_sort_key(item: dict[str, Any]) -> tuple[int, datetime, str]:
    deadline_text = normalize_space_text(item.get("deadline_date"))
    parsed_deadline = parse_dot_date(deadline_text)
    if parsed_deadline is None:
        parsed_deadline = datetime.max.replace(tzinfo=timezone.utc)
        always_rank = 1
    else:
        always_rank = 0
    title = normalize_space_text(item.get("title")).lower()
    return always_rank, parsed_deadline, title


def normalize_pilot_job_item(item: dict[str, Any], matched_keywords: list[str]) -> dict[str, Any]:
    job_no = normalize_space_text(item.get("jobNo"))
    company = normalize_space_text(item.get("compNm"))
    title = normalize_space_text(item.get("title"))
    location = normalize_space_text(item.get("areaCodeNm") or item.get("workRegion"))
    employment_type = normalize_space_text(item.get("empTypeCodeNm"))
    experience = ", ".join(
        normalize_space_text(name)
        for name in item.get("jobExpCodeNmList") or []
        if normalize_space_text(name)
    )
    deadline_date = normalize_space_text(item.get("viewEdate"))
    deadline_start = normalize_space_text(item.get("viewSdate"))
    d_day = normalize_space_text(item.get("dDay"))
    always_recruit = normalize_space_text(item.get("alwaysRecruitYn")).upper() == "Y"
    deadline_text = "상시채용" if always_recruit else " · ".join(part for part in [d_day, deadline_date] if part)
    if not deadline_text:
        deadline_text = d_day or deadline_date or "마감정보 확인"
    period_text = "상시채용" if always_recruit else " ~ ".join(part for part in [deadline_start, deadline_date] if part)

    duty_names = " ".join(normalize_space_text(name) for name in item.get("jobDutyCodeNmList") or [])
    combined_text = " ".join(
        part for part in [title, company, location, employment_type, experience, duty_names, " ".join(matched_keywords)] if part
    )
    normalized_text = normalize_search_text(combined_text)
    aircraft_types = extract_aircraft_types(normalized_text)
    role_family = derive_role_family(normalized_text, matched_keywords, aircraft_types)
    license_tags = extract_license_tags(normalized_text, matched_keywords)
    aircraft_category = derive_aircraft_category(normalized_text, aircraft_types)
    location_country, location_region, location_city = derive_location_fields(location)
    employment_type_code = derive_employment_type_code(employment_type, always_recruit)
    experience_level = derive_experience_level(experience)
    company_slug = slugify_text(company or f"{PILOT_JOBS_SOURCE_CODE}-company", f"{PILOT_JOBS_SOURCE_CODE}-company")
    slug_basis = " ".join(part for part in [company, title, job_no] if part)
    slug = slugify_text(slug_basis, f"{PILOT_JOBS_SOURCE_CODE}-job")
    search_document = compose_search_document(
        [
            title,
            company,
            location,
            employment_type,
            experience,
            duty_names,
            " ".join(matched_keywords),
            " ".join(license_tags),
            " ".join(aircraft_types),
            ROLE_FAMILY_LABELS.get(role_family, ""),
        ]
    )
    item_id = job_no or hashlib.sha256(f"{company}:{title}".encode("utf-8")).hexdigest()[:16]
    source_url = airportal_job_detail_url(job_no or item_id)
    summary = " · ".join(part for part in [location, employment_type, experience] if part)

    return {
        "id": item_id,
        "slug": slug,
        "job_no": job_no,
        "source_job_key": job_no or item_id,
        "title": title,
        "company": company,
        "company_slug": company_slug,
        "location": location,
        "employment_type": employment_type,
        "employment_type_code": employment_type_code,
        "experience": experience,
        "experience_level": experience_level,
        "deadline_text": deadline_text,
        "deadline_date": deadline_date,
        "period_text": period_text,
        "d_day": d_day,
        "matched_keywords": matched_keywords,
        "source": PILOT_JOBS_SOURCE_LABEL,
        "source_code": PILOT_JOBS_SOURCE_CODE,
        "source_label": PILOT_JOBS_SOURCE_LABEL,
        "url": source_url,
        "source_url": source_url,
        "role_family": role_family,
        "license_tags": license_tags,
        "aircraft_category": aircraft_category,
        "aircraft_types": aircraft_types,
        "summary": summary,
        "posted_at": to_start_of_day_iso(deadline_start),
        "deadline_at": to_end_of_day_iso(deadline_date),
        "is_always_open": always_recruit,
        "location_country": location_country,
        "location_region": location_region,
        "location_city": location_city,
        "search_document": search_document,
        "raw_payload": {
            "source_record": item,
            "normalized": {
                "id": item_id,
                "job_no": job_no,
                "title": title,
                "company": company,
                "location": location,
                "employment_type": employment_type,
                "experience": experience,
                "deadline_text": deadline_text,
                "deadline_date": deadline_date,
                "period_text": period_text,
                "d_day": d_day,
                "matched_keywords": matched_keywords,
                "source": PILOT_JOBS_SOURCE_LABEL,
                "url": source_url,
                "role_family": role_family,
                "license_tags": license_tags,
                "aircraft_category": aircraft_category,
                "aircraft_types": aircraft_types,
                "summary": summary,
            },
        },
    }


def fetch_pilot_jobs_from_source() -> list[dict[str, Any]]:
    collected: dict[str, dict[str, Any]] = {}
    for search_term in PILOT_JOB_FETCH_TERMS:
        response_payload = post_airportal_jobs({"searchNm": search_term, "pageNumber": 1, "pageSize": 40})
        for raw_item in response_payload.get("content") or []:
            if not isinstance(raw_item, dict):
                continue
            matched_keywords = extract_pilot_job_matches(raw_item)
            if not matched_keywords:
                continue
            normalized_item = normalize_pilot_job_item(raw_item, matched_keywords)
            job_key = normalize_space_text(normalized_item.get("source_job_key"))
            if not job_key or not is_open_pilot_job(normalized_item):
                continue
            existing = collected.get(job_key)
            if existing:
                merged = dedupe_preserve_order((existing.get("matched_keywords") or []) + (normalized_item.get("matched_keywords") or []))
                existing["matched_keywords"] = merged[:6]
                existing["license_tags"] = dedupe_preserve_order((existing.get("license_tags") or []) + (normalized_item.get("license_tags") or []))
                existing["aircraft_types"] = dedupe_preserve_order((existing.get("aircraft_types") or []) + (normalized_item.get("aircraft_types") or []))
                continue
            collected[job_key] = normalized_item

    items = list(collected.values())
    items.sort(key=pilot_job_sort_key)
    return items


def load_cache_payload(cache_path: Path) -> dict[str, Any]:
    if not cache_path.exists():
        return {
            "updated_at": "",
            "last_successful_at": "",
            "last_attempted_at": "",
            "source_label": PILOT_JOBS_SOURCE_LABEL,
            "cache_status": "",
            "cache_warning": "",
            "items": [],
        }
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception:
        return {
            "updated_at": "",
            "last_successful_at": "",
            "last_attempted_at": "",
            "source_label": PILOT_JOBS_SOURCE_LABEL,
            "cache_status": "",
            "cache_warning": "",
            "items": [],
        }
    if not isinstance(payload, dict):
        return {
            "updated_at": "",
            "last_successful_at": "",
            "last_attempted_at": "",
            "source_label": PILOT_JOBS_SOURCE_LABEL,
            "cache_status": "",
            "cache_warning": "",
            "items": [],
        }
    items = payload.get("items")
    updated_at = normalize_space_text(payload.get("updated_at"))
    return {
        "updated_at": updated_at,
        "last_successful_at": normalize_space_text(payload.get("last_successful_at")) or updated_at,
        "last_attempted_at": normalize_space_text(payload.get("last_attempted_at")),
        "source_label": normalize_space_text(payload.get("source_label")) or PILOT_JOBS_SOURCE_LABEL,
        "cache_status": normalize_space_text(payload.get("cache_status")),
        "cache_warning": normalize_space_text(payload.get("cache_warning")),
        "items": items if isinstance(items, list) else [],
    }


def write_cache_payload(cache_path: Path, payload: dict[str, Any]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build_fresh_cache_payload(items: list[dict[str, Any]], attempted_at: str) -> dict[str, Any]:
    return {
        "updated_at": attempted_at,
        "last_successful_at": attempted_at,
        "last_attempted_at": attempted_at,
        "source_label": PILOT_JOBS_SOURCE_LABEL,
        "cache_status": "fresh",
        "cache_warning": "",
        "items": items,
    }


def build_stale_cache_payload(existing_payload: dict[str, Any], attempted_at: str, warning_text: str) -> dict[str, Any]:
    return {
        "updated_at": normalize_space_text(existing_payload.get("updated_at")),
        "last_successful_at": normalize_space_text(existing_payload.get("last_successful_at"))
        or normalize_space_text(existing_payload.get("updated_at")),
        "last_attempted_at": attempted_at,
        "source_label": normalize_space_text(existing_payload.get("source_label")) or PILOT_JOBS_SOURCE_LABEL,
        "cache_status": "stale",
        "cache_warning": warning_text,
        "items": existing_payload.get("items") or [],
    }


def build_error_cache_payload(attempted_at: str, warning_text: str) -> dict[str, Any]:
    return {
        "updated_at": "",
        "last_successful_at": "",
        "last_attempted_at": attempted_at,
        "source_label": PILOT_JOBS_SOURCE_LABEL,
        "cache_status": "error",
        "cache_warning": warning_text,
        "items": [],
    }


def build_supabase_config(require_write: bool = False) -> dict[str, str] | None:
    supabase_url = normalize_space_text(os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").rstrip("/")
    service_role_key = normalize_space_text(os.getenv("SUPABASE_SERVICE_ROLE_KEY"))
    anon_key = normalize_space_text(os.getenv("SUPABASE_ANON_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY"))
    if not supabase_url or not supabase_url.startswith(("https://", "http://")):
        return None
    if require_write and not service_role_key:
        return None
    if not service_role_key and not anon_key:
        return None
    return {
        "supabase_url": supabase_url,
        "service_role_key": service_role_key,
        "anon_key": anon_key,
        "jobs_table": normalize_space_text(os.getenv("DOO_PILOT_JOBS_SUPABASE_JOB_TABLE")) or "pilot_jobs",
        "sources_table": normalize_space_text(os.getenv("DOO_PILOT_JOBS_SUPABASE_SOURCE_TABLE")) or "pilot_job_sources",
        "runs_table": normalize_space_text(os.getenv("DOO_PILOT_JOBS_SUPABASE_RUN_TABLE")) or "pilot_job_source_runs",
        "companies_table": normalize_space_text(os.getenv("DOO_PILOT_JOBS_SUPABASE_COMPANY_TABLE")) or "pilot_companies",
    }


def supabase_headers(config: dict[str, str], require_write: bool = False, prefer: str = "") -> dict[str, str] | None:
    service_role_key = normalize_space_text(config.get("service_role_key"))
    anon_key = normalize_space_text(config.get("anon_key"))
    if require_write:
        if not service_role_key:
            return None
        token = service_role_key
    else:
        token = service_role_key or anon_key
    if not token:
        return None
    headers = {
        "apikey": token,
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def supabase_request(
    config: dict[str, str],
    table: str,
    *,
    method: str = "GET",
    query_items: list[tuple[str, str]] | None = None,
    payload: Any = None,
    require_write: bool = False,
    prefer: str = "",
) -> Any:
    headers = supabase_headers(config, require_write=require_write, prefer=prefer)
    if headers is None:
        raise RuntimeError("Supabase 인증 정보가 없습니다.")
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    query_string = f"?{urlencode(query_items)}" if query_items else ""
    request = UrlRequest(
        url=f"{config['supabase_url']}/rest/v1/{table}{query_string}",
        method=method,
        data=body,
        headers=headers,
    )
    with urlopen(request, timeout=SUPABASE_HTTP_TIMEOUT_SECONDS) as response:
        raw = response.read()
    if not raw:
        return None
    return json.loads(raw.decode("utf-8"))


def fetch_all_company_rows(config: dict[str, str]) -> list[dict[str, Any]]:
    rows = supabase_request(
        config,
        config["companies_table"],
        query_items=[("select", "id,slug,name"), ("limit", "5000")],
    )
    return rows if isinstance(rows, list) else []


def fetch_source_row(config: dict[str, str]) -> dict[str, Any] | None:
    rows = supabase_request(
        config,
        config["sources_table"],
        query_items=[
            ("select", "id,code,name,last_success_at,last_attempt_at,last_status"),
            ("code", f"eq.{PILOT_JOBS_SOURCE_CODE}"),
            ("limit", "1"),
        ],
    )
    if not isinstance(rows, list) or not rows:
        return None
    first = rows[0]
    return first if isinstance(first, dict) else None


def fetch_existing_job_rows(config: dict[str, str], source_id: str) -> list[dict[str, Any]]:
    rows = supabase_request(
        config,
        config["jobs_table"],
        query_items=[
            ("select", "id,source_job_key,status"),
            ("source_id", f"eq.{quote(source_id, safe='-')}"),
            ("limit", "5000"),
        ],
    )
    return rows if isinstance(rows, list) else []


def sync_pilot_jobs_to_supabase(items: list[dict[str, Any]], attempted_at: str) -> dict[str, Any]:
    config = build_supabase_config(require_write=True)
    if config is None:
        return {"synced": False, "reason": "missing_config"}

    supabase_request(
        config,
        config["sources_table"],
        method="POST",
        query_items=[("on_conflict", "code")],
        payload=[
            {
                "code": PILOT_JOBS_SOURCE_CODE,
                "name": PILOT_JOBS_SOURCE_LABEL,
                "source_type": "web",
                "base_url": PILOT_JOBS_SOURCE_BASE_URL,
                "careers_url": PILOT_JOBS_SOURCE_CAREERS_URL,
                "is_active": True,
                "refresh_interval_minutes": 180,
                "last_success_at": attempted_at,
                "last_attempt_at": attempted_at,
                "last_status": "success",
                "updated_at": attempted_at,
            }
        ],
        require_write=True,
        prefer="resolution=merge-duplicates,return=representation",
    )

    source_row = fetch_source_row(config)
    if source_row is None:
        raise RuntimeError("pilot_job_sources 행을 확인하지 못했습니다.")
    source_id = normalize_space_text(source_row.get("id"))
    if not source_id:
        raise RuntimeError("pilot_job_sources id가 비어 있습니다.")

    existing_rows = fetch_existing_job_rows(config, source_id)
    existing_keys = {normalize_space_text(row.get("source_job_key")) for row in existing_rows if isinstance(row, dict)}
    existing_row_by_key = {
        normalize_space_text(row.get("source_job_key")): row
        for row in existing_rows
        if isinstance(row, dict) and normalize_space_text(row.get("source_job_key"))
    }

    company_payload = []
    for item in items:
        company_name = normalize_space_text(item.get("company"))
        company_slug = normalize_space_text(item.get("company_slug"))
        if not company_name or not company_slug:
            continue
        company_payload.append(
            {
                "slug": company_slug,
                "name": company_name,
                "region": normalize_space_text(item.get("location_region") or item.get("location")),
                "country_code": normalize_space_text(item.get("location_country")),
                "updated_at": attempted_at,
            }
        )

    if company_payload:
        supabase_request(
            config,
            config["companies_table"],
            method="POST",
            query_items=[("on_conflict", "slug")],
            payload=company_payload,
            require_write=True,
            prefer="resolution=merge-duplicates,return=minimal",
        )

    company_rows = fetch_all_company_rows(config)
    company_id_by_slug = {
        normalize_space_text(row.get("slug")): normalize_space_text(row.get("id"))
        for row in company_rows
        if isinstance(row, dict)
    }

    jobs_payload = []
    incoming_keys: set[str] = set()
    for item in items:
        source_job_key = normalize_space_text(item.get("source_job_key"))
        if not source_job_key:
            continue
        incoming_keys.add(source_job_key)
        jobs_payload.append(
            {
                "source_id": source_id,
                "company_id": company_id_by_slug.get(normalize_space_text(item.get("company_slug"))) or None,
                "source_job_key": source_job_key,
                "slug": normalize_space_text(item.get("slug")) or slugify_text(source_job_key, f"{PILOT_JOBS_SOURCE_CODE}-job"),
                "source_url": normalize_space_text(item.get("source_url") or item.get("url")),
                "title": normalize_space_text(item.get("title")),
                "summary": normalize_space_text(item.get("summary")),
                "body_text": normalize_space_text(item.get("period_text")),
                "role_family": normalize_space_text(item.get("role_family")) or "pilot",
                "license_tags": item.get("license_tags") or [],
                "aircraft_category": normalize_space_text(item.get("aircraft_category")),
                "aircraft_types": item.get("aircraft_types") or [],
                "experience_level": normalize_space_text(item.get("experience_level")) or "open",
                "employment_type": normalize_space_text(item.get("employment_type_code")) or "open_recruiting",
                "location_country": normalize_space_text(item.get("location_country")),
                "location_region": normalize_space_text(item.get("location_region") or item.get("location")),
                "location_city": normalize_space_text(item.get("location_city")),
                "required_languages": [],
                "matched_keywords": item.get("matched_keywords") or [],
                "status": "open",
                "is_always_open": bool(item.get("is_always_open")),
                "posted_at": normalize_space_text(item.get("posted_at")) or None,
                "deadline_at": normalize_space_text(item.get("deadline_at")) or None,
                "last_seen_at": attempted_at,
                "closed_at": None,
                "search_document": normalize_space_text(item.get("search_document")),
                "raw_payload": item.get("raw_payload") or {},
                "updated_at": attempted_at,
            }
        )

    if jobs_payload:
        supabase_request(
            config,
            config["jobs_table"],
            method="POST",
            query_items=[("on_conflict", "source_id,source_job_key")],
            payload=jobs_payload,
            require_write=True,
            prefer="resolution=merge-duplicates,return=minimal",
        )

    closed_count = 0
    for source_job_key, row in existing_row_by_key.items():
        if source_job_key in incoming_keys:
            continue
        job_id = normalize_space_text(row.get("id"))
        if not job_id:
            continue
        supabase_request(
            config,
            config["jobs_table"],
            method="PATCH",
            query_items=[("id", f"eq.{quote(job_id, safe='-')}")],
            payload={"status": "closed", "closed_at": attempted_at, "updated_at": attempted_at},
            require_write=True,
            prefer="return=minimal",
        )
        closed_count += 1

    inserted_count = len(incoming_keys - existing_keys)
    updated_count = len(incoming_keys & existing_keys)

    supabase_request(
        config,
        config["runs_table"],
        method="POST",
        payload=[
            {
                "source_id": source_id,
                "status": "success",
                "started_at": attempted_at,
                "finished_at": utc_now_iso(),
                "fetched_count": len(items),
                "normalized_count": len(items),
                "inserted_count": inserted_count,
                "updated_count": updated_count,
                "closed_count": closed_count,
                "raw_summary": {
                    "source_code": PILOT_JOBS_SOURCE_CODE,
                    "item_count": len(items),
                },
            }
        ],
        require_write=True,
        prefer="return=minimal",
    )

    return {
        "synced": True,
        "inserted_count": inserted_count,
        "updated_count": updated_count,
        "closed_count": closed_count,
        "item_count": len(items),
    }


def build_public_item_from_cache(item: dict[str, Any], source_label: str = PILOT_JOBS_SOURCE_LABEL) -> dict[str, Any]:
    raw_payload = item.get("raw_payload") if isinstance(item.get("raw_payload"), dict) else {}
    normalized_payload = raw_payload.get("normalized") if isinstance(raw_payload.get("normalized"), dict) else {}
    title = normalize_space_text(item.get("title") or normalized_payload.get("title"))
    company = normalize_space_text(item.get("company") or normalized_payload.get("company"))
    location = normalize_space_text(item.get("location") or normalized_payload.get("location"))
    employment_type = normalize_space_text(item.get("employment_type") or normalized_payload.get("employment_type"))
    experience = normalize_space_text(item.get("experience") or normalized_payload.get("experience"))
    matched_keywords = dedupe_preserve_order(list(item.get("matched_keywords") or normalized_payload.get("matched_keywords") or []))
    license_tags = dedupe_preserve_order(list(item.get("license_tags") or normalized_payload.get("license_tags") or []))
    aircraft_types = dedupe_preserve_order(list(item.get("aircraft_types") or normalized_payload.get("aircraft_types") or []))
    role_family = normalize_space_text(item.get("role_family") or normalized_payload.get("role_family")) or derive_role_family(
        normalize_search_text(" ".join([title, company, location, experience, " ".join(matched_keywords)])),
        matched_keywords,
        aircraft_types,
    )
    aircraft_category = normalize_space_text(item.get("aircraft_category") or normalized_payload.get("aircraft_category"))
    if not aircraft_category:
        aircraft_category = derive_aircraft_category(normalize_search_text(" ".join([title, company, " ".join(aircraft_types)])), aircraft_types)
    deadline_at = normalize_space_text(item.get("deadline_at"))
    if not deadline_at:
        deadline_at = to_end_of_day_iso(item.get("deadline_date") or normalized_payload.get("deadline_date"))
    posted_at = normalize_space_text(item.get("posted_at"))
    if not posted_at:
        period_text = normalize_space_text(item.get("period_text") or normalized_payload.get("period_text"))
        period_start = period_text.split("~")[0].strip() if " ~ " in period_text else ""
        posted_at = to_start_of_day_iso(period_start)
    return {
        "id": normalize_space_text(item.get("id") or normalized_payload.get("id")),
        "slug": normalize_space_text(item.get("slug")),
        "job_no": normalize_space_text(item.get("job_no") or normalized_payload.get("job_no")),
        "title": title,
        "company": company,
        "location": location,
        "employment_type": employment_type,
        "experience": experience,
        "deadline_text": normalize_space_text(item.get("deadline_text") or normalized_payload.get("deadline_text")),
        "deadline_date": normalize_space_text(item.get("deadline_date") or normalized_payload.get("deadline_date")),
        "period_text": normalize_space_text(item.get("period_text") or normalized_payload.get("period_text")),
        "d_day": normalize_space_text(item.get("d_day") or normalized_payload.get("d_day")),
        "matched_keywords": matched_keywords,
        "source": normalize_space_text(item.get("source") or normalized_payload.get("source")) or source_label,
        "url": normalize_space_text(item.get("url") or normalized_payload.get("url")),
        "role_family": role_family,
        "license_tags": license_tags,
        "aircraft_category": aircraft_category,
        "aircraft_types": aircraft_types,
        "experience_level": normalize_space_text(item.get("experience_level")) or derive_experience_level(experience),
        "summary": normalize_space_text(item.get("summary") or normalized_payload.get("summary")),
        "posted_at": posted_at,
        "deadline_at": deadline_at,
    }


def fetch_public_items_from_supabase() -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    config = build_supabase_config(require_write=False)
    if config is None:
        return [], None
    try:
        rows = supabase_request(
            config,
            config["jobs_table"],
            query_items=[
                (
                    "select",
                    "id,slug,source_id,company_id,source_url,title,summary,role_family,license_tags,aircraft_category,aircraft_types,"
                    "experience_level,employment_type,location_country,location_region,location_city,matched_keywords,status,"
                    "is_always_open,posted_at,deadline_at,last_seen_at,raw_payload",
                ),
                ("status", "eq.open"),
                ("order", "deadline_at.asc.nullslast,title.asc"),
                ("limit", "5000"),
            ],
        )
    except Exception:
        return [], None
    if not isinstance(rows, list):
        return [], None

    try:
        company_rows = fetch_all_company_rows(config)
        source_row = fetch_source_row(config)
    except Exception:
        return [], None
    company_name_by_id = {
        normalize_space_text(row.get("id")): normalize_space_text(row.get("name"))
        for row in company_rows
        if isinstance(row, dict)
    }
    source_label = normalize_space_text((source_row or {}).get("name")) or PILOT_JOBS_SOURCE_LABEL

    items: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        raw_payload = row.get("raw_payload") if isinstance(row.get("raw_payload"), dict) else {}
        normalized_payload = raw_payload.get("normalized") if isinstance(raw_payload.get("normalized"), dict) else {}
        company_name = company_name_by_id.get(normalize_space_text(row.get("company_id"))) or normalize_space_text(
            normalized_payload.get("company")
        )
        location = normalize_space_text(row.get("location_region") or row.get("location_city") or normalized_payload.get("location"))
        employment_type = normalize_space_text(normalized_payload.get("employment_type"))
        experience = normalize_space_text(normalized_payload.get("experience"))
        deadline_at = normalize_space_text(row.get("deadline_at"))
        deadline_date = ""
        if deadline_at:
            try:
                deadline_date = datetime.fromisoformat(deadline_at).astimezone(KST).strftime("%Y.%m.%d")
            except ValueError:
                deadline_date = ""
        items.append(
            {
                "id": normalize_space_text(row.get("id")),
                "slug": normalize_space_text(row.get("slug")),
                "job_no": normalize_space_text(normalized_payload.get("job_no")),
                "title": normalize_space_text(row.get("title")),
                "company": company_name,
                "location": location,
                "employment_type": employment_type,
                "experience": experience,
                "deadline_text": normalize_space_text(normalized_payload.get("deadline_text")),
                "deadline_date": deadline_date or normalize_space_text(normalized_payload.get("deadline_date")),
                "period_text": normalize_space_text(normalized_payload.get("period_text")),
                "d_day": normalize_space_text(normalized_payload.get("d_day")),
                "matched_keywords": dedupe_preserve_order(list(row.get("matched_keywords") or [])),
                "source": source_label,
                "url": normalize_space_text(row.get("source_url") or normalized_payload.get("url")),
                "role_family": normalize_space_text(row.get("role_family")) or "pilot",
                "license_tags": dedupe_preserve_order(list(row.get("license_tags") or [])),
                "aircraft_category": normalize_space_text(row.get("aircraft_category")),
                "aircraft_types": dedupe_preserve_order(list(row.get("aircraft_types") or [])),
                "experience_level": normalize_space_text(row.get("experience_level")),
                "summary": normalize_space_text(row.get("summary") or normalized_payload.get("summary")),
                "posted_at": normalize_space_text(row.get("posted_at")),
                "deadline_at": deadline_at,
            }
        )

    return items, source_row


def build_source_status(cache_payload: dict[str, Any], source_row: dict[str, Any] | None) -> dict[str, str]:
    if source_row:
        source_status = normalize_space_text(source_row.get("last_status"))
        last_success = normalize_space_text(source_row.get("last_success_at"))
        last_attempt = normalize_space_text(source_row.get("last_attempt_at"))
        return {
            "updated_at": last_success,
            "last_successful_at": last_success,
            "last_attempted_at": last_attempt,
            "source_label": normalize_space_text(source_row.get("name")) or PILOT_JOBS_SOURCE_LABEL,
            "cache_status": "stale" if source_status in {"failed", "stale"} else "fresh",
            "cache_warning": "최근 수집이 불안정해 마지막 성공 기준 데이터를 표시 중입니다." if source_status in {"failed", "stale"} else "",
        }
    return {
        "updated_at": normalize_space_text(cache_payload.get("updated_at")),
        "last_successful_at": normalize_space_text(cache_payload.get("last_successful_at")) or normalize_space_text(cache_payload.get("updated_at")),
        "last_attempted_at": normalize_space_text(cache_payload.get("last_attempted_at")),
        "source_label": normalize_space_text(cache_payload.get("source_label")) or PILOT_JOBS_SOURCE_LABEL,
        "cache_status": normalize_space_text(cache_payload.get("cache_status")) or "fresh",
        "cache_warning": normalize_space_text(cache_payload.get("cache_warning")),
    }


def collect_public_job_snapshot(cache_path: Path) -> tuple[list[dict[str, Any]], dict[str, str]]:
    db_items, source_row = fetch_public_items_from_supabase()
    cache_payload = load_cache_payload(cache_path)
    if db_items:
        return db_items, build_source_status(cache_payload, source_row)
    cache_items = [
        build_public_item_from_cache(item, source_label=str(cache_payload.get("source_label") or PILOT_JOBS_SOURCE_LABEL))
        for item in cache_payload.get("items") or []
        if isinstance(item, dict)
    ]
    return cache_items, build_source_status(cache_payload, None)


def filter_public_items(
    items: list[dict[str, Any]],
    *,
    query: str = "",
    role_family: str = "",
    location: str = "",
    employment_type: str = "",
) -> list[dict[str, Any]]:
    query_text = normalize_search_text(query)
    role_filter = normalize_space_text(role_family)
    location_filter = normalize_space_text(location)
    employment_filter = normalize_space_text(employment_type)

    filtered: list[dict[str, Any]] = []
    for item in items:
        searchable_text = normalize_search_text(
            " ".join(
                [
                    normalize_space_text(item.get("title")),
                    normalize_space_text(item.get("company")),
                    normalize_space_text(item.get("location")),
                    normalize_space_text(item.get("employment_type")),
                    normalize_space_text(item.get("experience")),
                    " ".join(item.get("matched_keywords") or []),
                    " ".join(item.get("license_tags") or []),
                    " ".join(item.get("aircraft_types") or []),
                    ROLE_FAMILY_LABELS.get(normalize_space_text(item.get("role_family")), ""),
                ]
            )
        )
        if query_text and query_text not in searchable_text:
            continue
        if role_filter and normalize_space_text(item.get("role_family")) != role_filter:
            continue
        if location_filter and normalize_space_text(item.get("location")) != location_filter:
            continue
        if employment_filter and normalize_space_text(item.get("employment_type")) != employment_filter:
            continue
        filtered.append(item)
    filtered.sort(key=pilot_job_sort_key)
    return filtered


def build_filter_facets(items: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    role_counts: dict[str, int] = {}
    location_counts: dict[str, int] = {}
    employment_counts: dict[str, int] = {}
    license_counts: dict[str, int] = {}

    for item in items:
        role_value = normalize_space_text(item.get("role_family"))
        location_value = normalize_space_text(item.get("location"))
        employment_value = normalize_space_text(item.get("employment_type"))
        if role_value:
            role_counts[role_value] = role_counts.get(role_value, 0) + 1
        if location_value:
            location_counts[location_value] = location_counts.get(location_value, 0) + 1
        if employment_value:
            employment_counts[employment_value] = employment_counts.get(employment_value, 0) + 1
        for tag in item.get("license_tags") or []:
            normalized_tag = normalize_space_text(tag)
            if not normalized_tag:
                continue
            license_counts[normalized_tag] = license_counts.get(normalized_tag, 0) + 1

    return {
        "role_families": [
            {"value": value, "label": ROLE_FAMILY_LABELS.get(value, value), "count": count}
            for value, count in sorted(role_counts.items(), key=lambda pair: (pair[1] * -1, pair[0]))
        ],
        "locations": [
            {"value": value, "label": value, "count": count}
            for value, count in sorted(location_counts.items(), key=lambda pair: (pair[1] * -1, pair[0]))
        ],
        "employment_types": [
            {"value": value, "label": value, "count": count}
            for value, count in sorted(employment_counts.items(), key=lambda pair: (pair[1] * -1, pair[0]))
        ],
        "license_tags": [
            {"value": value, "label": value, "count": count}
            for value, count in sorted(license_counts.items(), key=lambda pair: (pair[1] * -1, pair[0]))
        ],
    }


def build_jobs_list_response(
    cache_path: Path,
    *,
    query: str = "",
    role_family: str = "",
    location: str = "",
    employment_type: str = "",
    limit: int = 24,
    offset: int = 0,
) -> dict[str, Any]:
    items, source_status = collect_public_job_snapshot(cache_path)
    filtered = filter_public_items(
        items,
        query=query,
        role_family=role_family,
        location=location,
        employment_type=employment_type,
    )
    safe_limit = min(max(int(limit or 24), 1), 100)
    safe_offset = max(int(offset or 0), 0)
    paged_items = filtered[safe_offset:safe_offset + safe_limit]
    return {
        **source_status,
        "total_count": len(filtered),
        "limit": safe_limit,
        "offset": safe_offset,
        "has_more": safe_offset + safe_limit < len(filtered),
        "filters": build_filter_facets(items),
        "items": paged_items,
    }


def build_panel_payload(cache_path: Path, limit: int = 12) -> dict[str, Any]:
    items, source_status = collect_public_job_snapshot(cache_path)
    sorted_items = sorted(items, key=pilot_job_sort_key)
    return {
        **source_status,
        "items": sorted_items[: max(int(limit or 12), 1)],
    }
