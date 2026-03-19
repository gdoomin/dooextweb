# Backend

FastAPI backend for persistence and viewer/download APIs.

## Current Role

- Accepts already-converted JSON payloads from the browser at `POST /api/convert`
- Stores conversion jobs/history metadata
- Serves viewer pages and download endpoints (`/api/viewer/*`, `/api/download/*`)

The backend no longer parses uploaded KML files directly.

## Persistent Data (Railway)

- Runtime data (jobs/history/viewer state) is stored under `DOO_DATA_DIR`.
- Recommended container path is `/data/dooextweb`.
- For Railway production, mount a Railway Volume to `/data` and set `DOO_DATA_DIR=/data/dooextweb` so redeploy does not wipe JSON files.
- Converted job payloads can be archived in Supabase Storage with metadata in Supabase DB (`DOO_JOB_PAYLOAD_SUPABASE_BUCKET`, `DOO_JOB_PAYLOAD_SUPABASE_TABLE`).
- If `DOO_DATA_DIR` changes, backend auto-copies missing files from legacy `backend/runtime` on startup.
- Popup notice settings are stored in `DOO_DATA_DIR/popup_notice.json`.
- Set `DOO_ADMIN_POPUP_PASSWORD` to use the popup admin page (`/admin/popup` on frontend).

## Run

```powershell
cd C:\Users\indoo\Desktop\DH_APP\DOO_EXTRACTOR_Web
.\.venv\Scripts\Activate.ps1
uvicorn backend.app.main:app --reload
```
