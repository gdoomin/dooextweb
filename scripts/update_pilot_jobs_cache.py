from __future__ import annotations

import html
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen


ROOT_DIR = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT_DIR / "frontend" / "public" / "data" / "pilot-jobs.json"
AIRPORTAL_WORK_LIST_API_URL = "https://www.airportal.go.kr/work/getAirworkJobList.do"
AIRPORTAL_WORK_DETAIL_URL = "https://www.airportal.go.kr/work/employment/workDetail.do"
AIRPORTAL_TIMEOUT_SECONDS = 20
PILOT_JOBS_SOURCE_LABEL = "Airportal 항공일자리"
PILOT_JOB_FETCH_TERMS = [
    "운항승무원",
    "조종사",
    "부기장",
    "기장",
    "사업용",
    "pilot",
    "first officer",
    "captain",
]
PILOT_JOB_MATCH_GROUPS = {
    "운항승무원": ["운항승무원", "flight crew"],
    "조종사": ["비행기조종사", "조종사", "pilot"],
    "부기장": ["부기장", "first officer"],
    "기장": ["기장", "captain"],
    "사업용 면장": ["사업용 면장", "사업용조종사", "사업용 조종사", "사업용 조종사면장"],
    "파일럿": ["파일럿"],
}
PILOT_JOB_NEGATIVE_KEYWORDS = ["드론", "uav", "무인기", "무인 항공", "무인항공", "군집 드론"]
PILOT_JOB_CONTEXT_KEYWORDS = [
    "운항승무원",
    "항공기",
    "조종사",
    "부기장",
    "기장",
    "pilot",
    "first officer",
    "captain",
    "cadet pilot",
]


def normalize_space_text(value: Any) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or "")).strip())


def normalize_search_text(value: Any) -> str:
    return normalize_space_text(value).lower()


def airportal_job_detail_url(job_no: Any) -> str:
    return f"{AIRPORTAL_WORK_DETAIL_URL}?num={str(job_no or '').strip()}"


def post_airportal_jobs(payload: dict[str, Any]) -> dict[str, Any]:
    request_body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
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
    if not isinstance(data, dict) or str(data.get("resultCode") or "") != "200":
        raise RuntimeError("Airportal 채용정보 응답을 읽지 못했습니다.")
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

    matched: list[str] = []
    for label, patterns in PILOT_JOB_MATCH_GROUPS.items():
        if any(pattern in normalized for pattern in patterns):
            matched.append(label)

    if not matched:
        return []

    if any(keyword in normalized for keyword in PILOT_JOB_NEGATIVE_KEYWORDS):
        if not any(keyword in normalized for keyword in PILOT_JOB_CONTEXT_KEYWORDS):
            return []

    return matched


def normalize_pilot_job_item(item: dict[str, Any], matched_keywords: list[str]) -> dict[str, Any]:
    job_no = str(item.get("jobNo") or "").strip()
    company = normalize_space_text(item.get("compNm"))
    title = normalize_space_text(item.get("title"))
    deadline_date = normalize_space_text(item.get("viewEdate"))
    deadline_start = normalize_space_text(item.get("viewSdate"))
    d_day = normalize_space_text(item.get("dDay"))
    always_recruit = str(item.get("alwaysRecruitYn") or "").strip().upper() == "Y"
    deadline_text = "상시채용" if always_recruit else " · ".join(part for part in [d_day, deadline_date] if part)
    if not deadline_text:
        deadline_text = d_day or deadline_date or "마감정보 확인"
    return {
        "id": job_no or f"{company}:{title}",
        "job_no": job_no,
        "title": title,
        "company": company,
        "location": normalize_space_text(item.get("areaCodeNm") or item.get("workRegion")),
        "employment_type": normalize_space_text(item.get("empTypeCodeNm")),
        "experience": ", ".join(
            normalize_space_text(name)
            for name in item.get("jobExpCodeNmList") or []
            if normalize_space_text(name)
        ),
        "deadline_text": deadline_text,
        "deadline_date": deadline_date,
        "period_text": "상시채용" if always_recruit else " ~ ".join(part for part in [deadline_start, deadline_date] if part),
        "d_day": d_day,
        "matched_keywords": matched_keywords,
        "source": PILOT_JOBS_SOURCE_LABEL,
        "url": airportal_job_detail_url(job_no),
    }


def is_open_pilot_job(item: dict[str, Any]) -> bool:
    d_day = str(item.get("d_day") or "").strip()
    if "채용종료" in d_day:
        return False
    deadline_date = str(item.get("deadline_date") or "").strip()
    if not deadline_date:
        return True
    try:
        parsed_deadline = datetime.strptime(deadline_date, "%Y.%m.%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return True
    return parsed_deadline.date() >= datetime.now(timezone.utc).date()


def pilot_job_sort_key(item: dict[str, Any]) -> tuple[int, datetime, str]:
    deadline_date = str(item.get("deadline_date") or "").strip()
    try:
        parsed_deadline = datetime.strptime(deadline_date, "%Y.%m.%d").replace(tzinfo=timezone.utc)
        always_rank = 0
    except ValueError:
        parsed_deadline = datetime.max.replace(tzinfo=timezone.utc)
        always_rank = 1
    title = str(item.get("title") or "").strip().lower()
    return always_rank, parsed_deadline, title


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
            if not is_open_pilot_job(normalized_item):
                continue
            job_id = str(normalized_item.get("id") or "").strip()
            if not job_id:
                continue
            existing = collected.get(job_id)
            if existing:
                merged = sorted(set(existing.get("matched_keywords") or []).union(normalized_item.get("matched_keywords") or []))
                existing["matched_keywords"] = merged[:4]
                continue
            collected[job_id] = normalized_item

    if not collected:
        response_payload = post_airportal_jobs({"pageNumber": 1, "pageSize": 120})
        for raw_item in response_payload.get("content") or []:
            if not isinstance(raw_item, dict):
                continue
            matched_keywords = extract_pilot_job_matches(raw_item)
            if not matched_keywords:
                continue
            normalized_item = normalize_pilot_job_item(raw_item, matched_keywords)
            if not is_open_pilot_job(normalized_item):
                continue
            collected[str(normalized_item.get("id") or len(collected))] = normalized_item

    items = list(collected.values())
    items.sort(key=pilot_job_sort_key)
    return items[:12]


def load_existing_payload() -> dict[str, Any]:
    if not OUTPUT_PATH.exists():
        return {"updated_at": "", "source_label": PILOT_JOBS_SOURCE_LABEL, "items": []}
    try:
        payload = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"updated_at": "", "source_label": PILOT_JOBS_SOURCE_LABEL, "items": []}
    if not isinstance(payload, dict):
        return {"updated_at": "", "source_label": PILOT_JOBS_SOURCE_LABEL, "items": []}
    items = payload.get("items")
    return {
        "updated_at": str(payload.get("updated_at") or "").strip(),
        "source_label": str(payload.get("source_label") or PILOT_JOBS_SOURCE_LABEL).strip() or PILOT_JOBS_SOURCE_LABEL,
        "items": items if isinstance(items, list) else [],
    }


def write_payload(payload: dict[str, Any]) -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    try:
        items = fetch_pilot_jobs_from_source()
        payload = {
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "source_label": PILOT_JOBS_SOURCE_LABEL,
            "items": items,
        }
        write_payload(payload)
        print(f"updated pilot jobs cache: {len(items)} items")
        return 0
    except Exception as error:
        existing = load_existing_payload()
        if existing.get("items"):
            print(f"warning: source fetch failed, keeping existing cache ({error})", file=sys.stderr)
            return 0
        print(f"error: unable to update pilot jobs cache ({error})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
