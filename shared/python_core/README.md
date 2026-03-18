# Python Core

데스크톱 앱에서 분리한 공용 처리 로직입니다.

## 현재 포함된 함수

- `parse_kml`
- `format_text`
- `build_web_map_payload`
- `build_web_map_html`

## 목적

- `tkinter` 없이 순수 KML 처리만 담당
- FastAPI에서 바로 재사용 가능
- 이후 테스트 코드 추가가 쉬운 구조 유지
