from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.app.pilot_jobs import (
    build_error_cache_payload,
    build_fresh_cache_payload,
    build_stale_cache_payload,
    fetch_pilot_jobs_from_source,
    load_cache_payload,
    sync_pilot_jobs_to_supabase,
    write_cache_payload,
)


OUTPUT_PATH = ROOT_DIR / "frontend" / "public" / "data" / "pilot-jobs.json"


def main() -> int:
    attempted_at = datetime.now(timezone.utc).isoformat()
    existing = load_cache_payload(OUTPUT_PATH)

    try:
        items = fetch_pilot_jobs_from_source()
        payload = build_fresh_cache_payload(items, attempted_at)
        write_cache_payload(OUTPUT_PATH, payload)
        print(f"updated pilot jobs cache: {len(items)} items")

        try:
            sync_result = sync_pilot_jobs_to_supabase(items, attempted_at)
        except Exception as error:
            print(f"warning: Supabase sync failed ({error})", file=sys.stderr)
        else:
            if sync_result.get("synced"):
                print(
                    "synced pilot jobs to Supabase: "
                    f"{sync_result.get('inserted_count', 0)} inserted, "
                    f"{sync_result.get('updated_count', 0)} updated, "
                    f"{sync_result.get('closed_count', 0)} closed"
                )
            else:
                print("notice: Supabase config missing, skipped DB sync", file=sys.stderr)

        return 0
    except Exception as error:
        if existing.get("items"):
            stale_payload = build_stale_cache_payload(existing, attempted_at, "Airportal 연결 문제로 이전 캐시를 표시 중입니다.")
            write_cache_payload(OUTPUT_PATH, stale_payload)
            print(f"warning: source fetch failed, keeping existing cache ({error})", file=sys.stderr)
            return 1

        error_payload = build_error_cache_payload(attempted_at, "채용정보를 가져오지 못했습니다.")
        write_cache_payload(OUTPUT_PATH, error_payload)
        print(f"error: unable to update pilot jobs cache ({error})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
