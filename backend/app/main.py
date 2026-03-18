import json
import os
import sys
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse


ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from shared.python_core import POLYGON_ONLY_MESSAGE, build_web_map_html, build_web_map_payload, format_text, parse_kml, save_excel


APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
ASSETS_DIR = BACKEND_DIR / "assets"
RUNTIME_DIR = BACKEND_DIR / "runtime"
JOBS_DIR = RUNTIME_DIR / "jobs"
VIEWER_STATE_DIR = RUNTIME_DIR / "viewer_states"
MAP_TEMPLATE_PATH = ASSETS_DIR / "web_map_template.html"
MAP_LAYER_DATA_PATH = ASSETS_DIR / "map_layers.json"
HTML2CANVAS_PATH = ASSETS_DIR / "html2canvas.min.js"
BANNER_PATH = ASSETS_DIR / "doogpx.png"

for path in (JOBS_DIR, VIEWER_STATE_DIR):
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
        base_url = str(request.base_url).rstrip("/")

        job_data = {
            "job_id": job_id,
            "filename": file.filename,
            "project_name": project_name,
            "mode": mode,
            "result_count": len(results),
            "text_output": text_output,
            "map_payload": map_payload,
            "results": results,
        }
        _save_json(_job_path(job_id), job_data)

        return {
            "ok": True,
            "filename": file.filename,
            "project_name": project_name,
            "mode": mode,
            "result_count": len(results),
            "text_output": text_output,
            "map_payload": map_payload,
            "results": results,
            "job_id": job_id,
            "viewer_url": f"{base_url}/api/viewer/{job_id}",
            "txt_download_url": f"{base_url}/api/download/{job_id}/txt",
            "xlsx_download_url": f"{base_url}/api/download/{job_id}/xlsx",
        }
    finally:
        temp_path.unlink(missing_ok=True)


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
