# Changelog

## 1.0.0

첫 공개 릴리스. 사내 Git 호스팅에서 개발하던 0.x 를 정리해 공개 npm(`@wonseok-han/confluence-sync`)으로 통합했습니다.

### Push (Markdown → Confluence)

- `.md` 디렉토리를 Confluence 페이지로 발행. 폴더의 `README.md` 가 대표 페이지가 되고 같은 폴더 문서는 그 자식이 됨
- README 없는 폴더는 **Confluence 폴더**로 생성해 그 아래로 동기화
- 변경 감지(제목·본문·참조 이미지 내용 해시)로 바뀐 문서만 갱신
- 내부 `.md` 링크 → 페이지 링크, 로컬 이미지 → 첨부 업로드(기존 첨부는 갱신), 코드블록 → code 매크로
- 삭제된 페이지 자동 재생성 및 링크 재연결, `--rebuild` 로 전체 재구성
- `.confluence-syncignore` / `--exclude` 로 특정 경로 제외(로컬 전용 문서 유지)
- 옵션: `--base` `--mapping` `--dry-run` `--list` `--force` `--verify` `--rebuild` `--exclude`

### Pull (Confluence → Markdown)

- `confluence-sync pull <pageId|url>` — 페이지·폴더를 `.md` 로 가져오기, `--children` 으로 하위 트리 복원
- `confluence-sync pull --space` — 스페이스 전체를 한 번에 가져오기
- 이미지/첨부는 문서별 `attachments/<문서명>/` 하위에 저장하고 링크를 로컬화
- 코드블록 언어는 storage 의 실제 값 사용(미지정은 `plaintext`), 표는 GFM 표로 변환
- 불필요한 이스케이프·인라인 `<style>` 잔재 제거, 리스트 tight 처리 등 마크다운 품질 정리

### 기타

- `confluence-sync init` — 대화형 `.env` 생성(토큰 입력 마스킹)
- `--help` / `--version`, 컬러 출력(`--no-color`·비TTY 시 자동 비활성)
