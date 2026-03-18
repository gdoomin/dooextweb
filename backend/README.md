# Backend

FastAPI 백엔드입니다.

## 주요 파일

- `app/main.py`: API 시작점
- `requirements.txt`: 백엔드 의존성

## 현재 API

- `GET /health`
- `POST /api/convert`

## 실행

```powershell
cd C:\Users\indoo\Desktop\DH_APP\DOO_EXTRACTOR_Web
.\.venv\Scripts\Activate.ps1
uvicorn backend.app.main:app --reload
```
