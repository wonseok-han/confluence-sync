# 기여 안내

버그 수정이나 기능 변경을 제안하려면 재현 방법과 기대 동작을 이슈 또는 Pull Request에 설명해 주세요.

## 개발 환경

`npm test`로 전체 테스트, `npm run test:coverage`로 커버리지를 확인합니다. 테스트는 실제 Confluence에 접속하지 않습니다.

```bash
git clone https://github.com/wonseok-han/confluence-sync.git
cd confluence-sync
npm install
npm run build
```

소스에서 바로 실행할 때는 `npm run` 스크립트를 쓰고, 인자는 **`--` 뒤에** 둡니다.

| 글로벌 | 로컬 |
| --- | --- |
| `confluence-sync` | `npm run sync` |
| `confluence-sync --dry-run` | `npm run sync:dry` |
| `confluence-sync --list` | `npm run list -- --base ./docs` |

웹 화면을 소스에서 실행하려면 `npm run web`을 사용합니다. 변경한 기능에 맞는 테스트를 실행하고, Pull Request에 검증 결과를 함께 적어 주세요.

## 코드 구조

```text
src/
  sync.ts          # 기존 CLI 실행 경로를 유지하는 진입점
  cli/             # 명령 분기, 인자 해석, 도움말, 초기 설정
  sync/            # push/pull, 문서 트리 렌더링, 매핑, 참조 루트, 제외 규칙
  conversion/      # 로컬 convert, 오류 보정, 첨부·각주·PDF 처리
  documents/       # Markdown/Obsidian 문법, 제목·앵커, 문서 목록
  confluence/      # Confluence API 클라이언트와 접속 설정
  web/             # 로컬 HTTP 서버, 작업 실행, 폴더 선택과 결과 저장
    client/        # 브라우저 동작과 스타일
    views/         # 페이지 및 패널 HTML
  shared/          # 여러 기능에서 사용하는 작은 공통 모듈
```

브라우저 코드는 `web/client/`에, 파일 시스템과 프로세스를 사용하는 웹 코드는 `web/`에 둡니다. `cli/main.ts`는 명령 분기를 담당하고, 실제 작업은 각 기능 모듈에서 수행합니다. 문서 문법 처리는 `documents/`, Confluence 업로드를 위한 문서 간 연결은 `sync/`에서 다룹니다.

`npm run build`는 기존 `dist/`를 정리한 뒤 TypeScript와 브라우저 자산을 빌드합니다. 배포용 실행 파일은 `dist/sync.js`, 브라우저 자산은 `dist/web/assets/`입니다. 파일을 옮길 때는 import뿐 아니라 웹 작업 프로세스의 실행 경로와 `import.meta.url` 기준 리소스 경로도 확인하세요.

배포 권한을 가진 유지보수자는 [릴리스 절차](docs/RELEASING.md)를 참고하세요.
