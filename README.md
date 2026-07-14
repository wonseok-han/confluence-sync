# confluence-sync

**Confluence Cloud ↔ Markdown 양방향 동기화 CLI**

- **push** — 로컬 `.md` 디렉토리를 Confluence 페이지 트리로 발행. 폴더 구조가 그대로 페이지 계층이 됩니다.
- **pull** — Confluence 페이지·폴더·**스페이스 전체**를 읽어 `.md` 로 가져옵니다.

문서를 git으로 관리하면서(docs-as-code) Confluence를 미러로 두거나, 반대로 Confluence에 쌓인 문서를 마크다운으로 내려받아 쓸 수 있습니다. 내려받은 마크다운은 Obsidian·VS Code 등 어디서든 그대로 열립니다.

---

## 설치

```bash
npm i -g @wonseok-han/confluence-sync

confluence-sync --version
confluence-sync --help
```

공개 npm 패키지라 **토큰이나 `.npmrc` 설정이 필요 없습니다.** (Node 20+)

## 빠른 시작

```bash
cd /path/to/docs          # 동기화할 .md 들이 있는 폴더

confluence-sync init      # 대화형으로 .env 생성 (토큰 입력은 가려짐)
confluence-sync --dry-run # 무엇이 올라갈지 미리보기
confluence-sync           # 실제 발행
```

반대로 Confluence에서 가져오려면:

```bash
confluence-sync pull --space --out ./docs   # 스페이스 전체를 .md 로
```

---

## 설정

Confluence 접속 정보를 담은 `.env` 가 **실행 위치(cwd)** 에 있어야 합니다(셸 환경변수도 가능).

**대화형 생성 (권장)**

```bash
confluence-sync init      # 항목별 안내에 따라 입력 → cwd 에 .env 생성
```

**직접 작성**

| 변수 | 설명 |
| --- | --- |
| `CONFLUENCE_BASE_URL` | `https://api.atlassian.com/ex/confluence/<CLOUD_ID>/wiki` |
| `CONFLUENCE_EMAIL` | Atlassian 계정 이메일 |
| `CONFLUENCE_API_TOKEN` | Scoped API 토큰 (아래 참고) |
| `CONFLUENCE_SPACE_KEY` | URL `.../wiki/spaces/<KEY>/...` 의 KEY |
| `CONFLUENCE_PARENT_ID` | (선택) 루트 앵커 — 부모 **페이지 또는 폴더** ID. 비우면 공간 최상위 |
| `CONFLUENCE_SYNC_BASE` | push 할 루트 디렉토리 (`--base` 로도 지정 가능) |

### API 토큰 발급

1. https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token with scopes**
2. 앱 **Confluence** 선택
3. 쓰려는 기능에 맞춰 스코프 선택:

   | 기능 | 필요 스코프 |
   | --- | --- |
   | **push 기본** (조회·생성·갱신) | `read:space` · `read:page` · `write:page` |
   | 이미지/첨부 업로드 | `read:content-details` + `write:attachment` (둘 다) |
   | README 없는 폴더를 Confluence 폴더로 생성 | `write:folder` |
   | `--rebuild` (삭제 후 재생성) | `delete:page` (+ 폴더 있으면 `delete:folder`) |
   | **pull** (읽기) | `read:page` + `read:content-details` |
   | pull 시 첨부 이미지 다운로드 | `read:attachment` |

   > 모두 `:confluence` 접미사가 붙습니다 (예: `read:page:confluence`).

4. 토큰 계정은 대상 Space에 해당 권한이 있어야 합니다.

### cloudId 확인

`BASE_URL` 의 `<CLOUD_ID>` 는 아래에서 확인합니다.

```
https://<your-domain>.atlassian.net/_edge/tenant_info
```

---

## Push — Markdown → Confluence

```bash
confluence-sync --list                 # 인식된 문서·제목·계층만 출력 (호출·인증 없음)
confluence-sync --dry-run              # 대상·상태(신규/변경/동일) 미리보기
confluence-sync                        # 변경된 문서만 갱신 (+ 신규 생성)

confluence-sync --base /abs/path/docs  # 동기화 루트 지정 (env 미설정 시 필수)
confluence-sync guide/                 # 지정 폴더만 (부모 README 자동 포함)
confluence-sync guide/setup.md         # 단일 문서만
confluence-sync --force                # 변경 감지 무시, 전체 강제 갱신
confluence-sync --verify               # 변경 없는 문서도 페이지 존재 확인
confluence-sync --rebuild              # 매핑된 페이지 전부 삭제 후 재생성
confluence-sync --exclude '*-draft.md' # 제외 패턴 (반복 가능)
```

### 폴더 = 페이지 계층

- 폴더의 **`README.md`** 가 그 폴더의 **대표 페이지**가 되고, 같은 폴더의 다른 문서는 그 자식이 됩니다.
- README 가 **없는** 폴더는 **Confluence 폴더**로 생성되고 그 아래로 문서가 들어갑니다 (`write:folder` 스코프 필요).
- `README.md` 는 폴더 맨 앞, 나머지는 파일명순(숫자 prefix `01-`, `10-` … 로 순서 제어)으로 정렬되어 부모가 자식보다 먼저 생성됩니다.

```
docs/                      → [CONFLUENCE_PARENT_ID 또는 공간 최상위]
├── README.md              → 루트 페이지
├── 10-guide/
│   ├── README.md          → "10-guide" 대표 페이지
│   └── 01-setup.md        → 그 자식 페이지
└── 20-notes/              → README 없음 → Confluence 폴더
    └── memo.md            → 폴더 안 페이지
```

### 변환 규칙

- 각 문서의 **첫 `# 제목`** 이 페이지 제목이 되고, 본문은 storage format 으로 변환됩니다.
- 코드블록 → **code 매크로**, 표·리스트·헤딩은 그대로.
- **내부 `.md` 링크** → Confluence 페이지 링크로 자동 변환.
- **로컬 이미지** → 페이지 첨부로 업로드 후 참조 (같은 파일명은 새 버전으로 갱신). 외부 URL 이미지는 그대로.

### 변경 감지와 매핑

- 문서의 `제목 + 본문 + 참조 이미지 내용` 해시를 저장해두고, **바뀐 문서만** 새 버전으로 올립니다(`= 변경없음` 은 API 호출조차 하지 않음). `--force` 로 무시할 수 있습니다.
- 매핑은 **`<base>/.confluence-sync.json`** 에 저장됩니다. **문서셋과 함께 커밋하세요** — 지우면 다음 실행에서 페이지가 중복 생성됩니다. (`--mapping <path>` 로 위치 변경 가능)
- Confluence 에서 페이지가 삭제됐다면 자동으로 **재생성**하고, 그 페이지를 가리키던 문서들도 **링크를 다시 연결**합니다. 내용이 그대로라 스킵되는 경우까지 잡으려면 `--verify` 를 씁니다.

### 동기화 제외 (로컬 전용 문서 유지)

같은 폴더에 올릴 문서와 로컬에만 둘 문서가 섞여 있을 때 제외할 수 있습니다.

- **`<base>/.confluence-syncignore`** — `.gitignore` 방식 패턴 파일 (문서셋과 함께 커밋)

  ```gitignore
  *-draft.md            # 초안 전부 제외
  notes/local-only.md   # 특정 파일만 (notes/ 의 나머지는 동기화)
  secret/               # 폴더 통째로
  ```

- **`--exclude <glob>`** — 일회성 제외 (반복 가능)

제외된 문서는 list·dry-run·sync 모든 모드에서 빠지고, 그 문서만 있던 폴더는 생성되지 않습니다. 부정(`!`), `**` 등 `.gitignore` 규칙을 그대로 따릅니다.

### `--rebuild`

부모 관계는 **생성 시점에만** 지정되어 사후 이동이 어렵습니다. 계층을 갈아엎으려면 `--rebuild` 로 매핑된 페이지·폴더를 모두 삭제(휴지통) 후 재생성합니다. 매핑에 기록된 것만 지우므로 수동으로 만든 페이지는 건드리지 않습니다.

---

## Pull — Confluence → Markdown

```bash
confluence-sync pull <pageId|url>                  # 한 페이지를 현재 폴더에 .md 로
confluence-sync pull <url> --out ./docs            # 출력 디렉토리 지정
confluence-sync pull <url> --out ./docs --children # 하위 페이지·폴더까지 트리로 복원
confluence-sync pull --space --out ./docs          # 스페이스 전체 (홈페이지부터 전부)
```

- 대상은 **숫자 ID** 또는 **URL** (`.../pages/<ID>/...` 페이지, `.../folder/<ID>` 폴더) 둘 다 됩니다.
- **`--children`** — 하위를 재귀 복원합니다. 자식이 있는 페이지는 `<제목>/README.md` 폴더로 펼쳐져 **push 계층 관례와 맞물립니다**.
- **`--space`** — 대상 없이 스페이스 전체를 가져옵니다. 페이지가 많으면 시간이 걸립니다.
- **이미지/첨부** 는 문서별로 `attachments/<문서명>/` 아래에 내려받고 링크를 그 경로로 씁니다 (문서 폴더가 이미지로 지저분해지지 않음). 다운로드에는 `read:attachment` 스코프가 필요합니다.
- 본문은 `export_view`(HTML)를 [turndown](https://github.com/mixmark-io/turndown) 으로 변환합니다 — 코드블록(언어 포함, 미지정은 `plaintext`), GFM 표, 리스트 등.

> **무손실 왕복은 아닙니다.** Confluence storage → Markdown 은 근사 변환이라 일부 매크로·레이아웃은 단순화됩니다. 내부 페이지 링크는 절대 URL로 유지됩니다.

---

## 개발

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

## 릴리스

`v*` 태그를 푸시하면 GitHub Actions 가 빌드 → npm 배포 → GitHub Release 까지 자동 처리합니다.

```bash
npm version patch     # 또는 minor / major
git push && git push --tags
```

워크플로는 `package.json` 버전과 태그가 일치하는지 검증한 뒤 배포합니다. 변경 이력은 [CHANGELOG.md](CHANGELOG.md) 를 참고하세요.

> 사전 설정: npm Automation 토큰을 저장소 **Settings → Secrets and variables → Actions** 에 `NPM_TOKEN` 으로 등록해야 합니다.

## 라이선스

[MIT](LICENSE)
