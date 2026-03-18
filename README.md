# DOO Extractor Web

웹 MVP 작업 폴더입니다.

## 현재 상태

- `backend`: FastAPI 업로드 API 준비 완료
- `frontend`: Next.js 업로드 화면 준비 완료
- `shared/python_core`: 데스크톱 앱에서 분리한 KML 처리 코어

## 실행 순서

백엔드:

```powershell
cd C:\Users\indoo\Desktop\DH_APP\DOO_EXTRACTOR_Web
.\.venv\Scripts\Activate.ps1
uvicorn backend.app.main:app --reload
```

프론트엔드:

```powershell
cd C:\Users\indoo\Desktop\DH_APP\DOO_EXTRACTOR_Web\frontend
copy .env.local.example .env.local
npm run dev
```

## 접속 주소

- 프론트엔드: `http://127.0.0.1:3000`
- 백엔드: `http://127.0.0.1:8000`
- API 문서: `http://127.0.0.1:8000/docs`

## 다음 작업

1. 결과 지도 페이지 추가
2. TXT 다운로드 버튼 추가
3. 업로드 이력 저장 구조 설계
