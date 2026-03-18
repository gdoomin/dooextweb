# DOO Extractor Web Cloudflare Deployment

## 권장 구조

현재 프로젝트는 백엔드가 `backend/runtime` 아래에 작업 결과, viewer state, 사용자 히스토리를 파일로 저장합니다. 그래서 첫 배포는 아래 구조가 가장 안전합니다.

- 프론트엔드: Cloudflare Workers
- 백엔드: 디스크가 있는 VPS 또는 서버
- 백엔드 공개 주소: `https://dooext-api.dooheetv.com`
- 프론트 공개 주소: `https://dooext.dooheetv.com`

## 1. 도메인 준비

Cloudflare 대시보드에서 `dooheetv.com` 존이 정상적으로 관리되고 있어야 합니다.

- 앱 도메인: `dooext.dooheetv.com`
- API 도메인: `dooext-api.dooheetv.com`

`api.dooext.dooheetv.com` 대신 `dooext-api.dooheetv.com`를 권장합니다. 설정이 단순하고 환경 변수도 읽기 쉽습니다.

## 2. 백엔드 서버 준비

서버에 이 저장소를 배포한 뒤, 루트에서 아래 파일을 준비합니다.

1. `backend/.env.production.example`를 복사해서 `backend/.env.production` 생성
2. `DOO_WEB_CORS_ORIGINS`를 실제 프론트 주소로 설정

예시:

```env
DOO_WEB_CORS_ORIGINS=https://dooext.dooheetv.com,http://127.0.0.1:3000,http://localhost:3000
```

그 다음 루트에서 백엔드를 실행합니다.

```powershell
docker compose -f docker-compose.backend.yml up -d --build
```

정상 동작 확인:

```powershell
curl http://127.0.0.1:8000/health
```

## 3. 백엔드 도메인 연결

권장 방식은 Cloudflare Tunnel입니다.

Cloudflare 대시보드에서:

1. `Zero Trust`
2. `Networks`
3. `Tunnels`
4. 새 tunnel 생성
5. 서버에 `cloudflared` 설치
6. Public hostname 추가

권장 Public hostname:

- Hostname: `dooext-api.dooheetv.com`
- Service: `http://localhost:8000`

이 구성이 끝나면 `https://dooext-api.dooheetv.com/health`가 열려야 합니다.

## 4. 프론트 환경 변수 준비

`frontend/.env.production.example`를 참고해서 실제 배포용 값을 준비합니다.

필수 값:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_API_BASE_URL=https://dooext-api.dooheetv.com
```

로컬에서 Wrangler로 배포할 때는 `frontend/.env.production.local`에 넣고 진행하면 가장 간단합니다.

## 5. 프론트 Cloudflare 배포

Windows 로컬에서는 `OpenNext` 빌드가 불안정할 수 있습니다. 실제 운영 배포는 아래 둘 중 하나를 권장합니다.

- 권장: GitHub Actions로 Ubuntu에서 배포
- 대안: WSL 또는 리눅스 환경에서 직접 배포

GitHub Actions를 쓰려면 아래 GitHub Secrets를 먼저 넣습니다.

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_API_BASE_URL`

이미 워크플로 파일이 추가되어 있습니다.

- `.github/workflows/deploy-frontend-cloudflare.yml`

직접 배포할 경우에는 `frontend` 폴더에서 실행합니다.

```powershell
npx wrangler login
npm run cf:deploy
```

필요한 설정 파일은 이미 추가되어 있습니다.

- `frontend/wrangler.jsonc`
- `frontend/open-next.config.ts`

첫 배포가 끝나면 Cloudflare Worker 주소가 하나 생성됩니다.

## 6. 프론트 도메인 연결

Cloudflare 대시보드에서 Workers 프로젝트를 열고 custom domain을 추가합니다.

- Custom domain: `dooext.dooheetv.com`

연결 후에는 `https://dooext.dooheetv.com`에서 사이트가 열려야 합니다.

## 7. Supabase 설정 수정

Supabase 프로젝트 설정에서도 운영 도메인을 추가해야 로그인 리디렉션이 정상 동작합니다.

- Site URL: `https://dooext.dooheetv.com`
- Redirect URL:
  - `https://dooext.dooheetv.com/auth/callback`
  - `http://127.0.0.1:3000/auth/callback`

## 8. 최종 점검

아래 순서로 확인합니다.

1. `https://dooext-api.dooheetv.com/health`
2. `https://dooext.dooheetv.com`
3. 로그인
4. KML 업로드
5. viewer 열기
6. 히스토리 저장 및 다시열기

## 나중에 할 수 있는 개선

백엔드를 완전히 Cloudflare 런타임으로 옮기려면 현재 파일 저장 구조를 바꿔야 합니다.

- `backend/runtime/jobs` -> R2 또는 DB
- `backend/runtime/viewer_states` -> KV, D1 또는 DB
- `backend/runtime/user_history` -> D1 또는 DB

첫 운영 배포는 지금 문서의 하이브리드 구조로 가는 편이 훨씬 빠르고 안정적입니다.
