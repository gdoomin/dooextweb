# DOO Extractor Web Backend on Railway

## 권장 구성

- 프론트엔드: Cloudflare Workers
- 백엔드: Railway
- 인증: Supabase

현재 백엔드는 `backend/runtime` 아래에 파일을 저장하므로, Railway에서 Volume을 하나 붙여야 합니다.

## 1. Railway 프로젝트 만들기

1. Railway 로그인
2. `New Project`
3. `Deploy from GitHub repo`
4. `gdoomin/dooextweb` 선택

이 저장소는 이미 `railway.json`을 포함하고 있어 Dockerfile 빌드가 자동 설정됩니다.

## 2. Volume 추가

서비스에 Volume을 추가하고 mount path를 아래로 설정합니다.

```text
/app/backend/runtime
```

이 경로가 업로드 결과, viewer state, 사용자 히스토리를 저장합니다.

## 3. 환경 변수 추가

Railway 서비스의 Variables에서 아래 값 추가:

```env
DOO_WEB_CORS_ORIGINS=https://dooext.dooheetv.com,http://127.0.0.1:3000,http://localhost:3000
```

## 4. 배포 확인

배포가 끝나면 Railway public domain에서 아래 URL을 확인합니다.

```text
/health
```

정상 응답이 오면 백엔드가 떠 있는 상태입니다.

## 5. 커스텀 도메인 연결

Railway 서비스의 Networking 또는 Domains에서 custom domain을 추가합니다.

```text
dooext-api.dooheetv.com
```

Railway가 보여주는 CNAME 값을 Cloudflare `dooheetv.com` DNS에 등록합니다.

## 6. Cloudflare 프론트와 연결

Cloudflare Workers 환경 변수:

```env
NEXT_PUBLIC_API_BASE_URL=https://dooext-api.dooheetv.com
```

값을 추가하거나 수정한 뒤 프론트를 다시 배포합니다.

## 왜 Railway를 권장하나

- GitHub 저장소에서 바로 배포 가능
- Dockerfile 배포가 쉬움
- FastAPI와 잘 맞음
- Volume을 붙여 현재 파일 저장 구조를 유지할 수 있음

## Supabase / Firebase를 바로 백엔드로 쓰지 않는 이유

- GitHub: 저장소 호스팅이지 FastAPI 런타임은 아님
- Supabase: auth/db/storage는 좋지만 현재 FastAPI 앱을 그대로 올리는 호스팅은 아님
- Firebase: 현재 구조의 Python FastAPI + 파일 저장 백엔드에 가장 단순한 선택은 아님

나중에는 `backend/runtime` 저장 구조를 Supabase Storage + DB로 옮겨서 더 서버리스하게 바꿀 수 있습니다.
