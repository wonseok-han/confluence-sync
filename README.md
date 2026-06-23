# confluence-sync

지정한 디렉토리(`--base`)의 `*.md`(하위 폴더 포함)를 **Confluence Cloud** 페이지로 **단방향 동기화**하는 수동 실행 도구입니다.
git 이 원천(SoT)이고 Confluence 는 미러입니다. 양방향 동기화는 하지 않습니다.

## 빠른 시작 (3단계)

이미 설치돼 있다면 동기화할 문서 폴더에서:
```bash
cd /path/to/docs            # 동기화할 .md 들이 있는 폴더
confluence-sync init        # 대화형으로 .env 생성(토큰 입력은 가려짐)
confluence-sync --dry-run   # 무엇이 올라갈지 미리보기 → 문제 없으면
confluence-sync             # 실제 동기화
```
처음이라면 아래 **설치 → 설정** 순서를 따르세요. 막히면 `confluence-sync --help`.

## 설치

### 글로벌 CLI (권장) — 어디서나 `confluence-sync` 실행

이 패키지는 사내 **Git 호스팅 Package Registry**에 올라가 있어, npm 에게 "`@wonseok-han` 스코프는 Git 호스팅 에서 받아라"라고 한 번 알려줘야 합니다. (공개 npm 에 없으므로 이 설정이 없으면 설치가 404 로 실패합니다.)

**1) 액세스 토큰 발급** — Git 호스팅 에서 패키지를 내려받을 권한.
   - Git 호스팅 → 우상단 프로필 → **Edit profile → Access Tokens** → **`read_package_registry`** 스코프로 토큰 생성(만료일 지정 권장).
   - 또는 confluence-sync 프로젝트의 **Settings → Repository → Deploy tokens** 에서 `read_package_registry` 토큰 발급.

**2) `~/.npmrc` 에 스코프 매핑 추가** — 홈 디렉토리의 `~/.npmrc` 파일(없으면 새로 만듦)에 아래 두 줄을 넣고 `<TOKEN>` 을 1)에서 받은 값으로 교체합니다.
   ```
   @wonseok-han:registry=https://git.internal.example/api/v4/projects/0/packages/npm/
   //git.internal.example/api/v4/projects/0/packages/npm/:_authToken=<TOKEN>
   ```
   명령으로 넣어도 됩니다(`<TOKEN>` 교체):
   ```bash
   npm config set @wonseok-han:registry "https://git.internal.example/api/v4/projects/0/packages/npm/"
   npm config set "//git.internal.example/api/v4/projects/0/packages/npm/:_authToken" "<TOKEN>"
   ```

**3) 설치 & 확인**
   ```bash
   npm i -g @wonseok-han/confluence-sync
   confluence-sync --version   # 버전이 찍히면 성공
   confluence-sync --help      # 사용법
   ```
   > 설치가 `registry.npmjs.org ... 404` 로 실패하면 2)의 스코프 매핑이 빠졌거나 `~/.npmrc` 위치가 잘못된 것입니다. 인증 실패(401/403)면 토큰 권한·만료를 확인하세요.

### 로컬 개발 (소스에서 실행)

```bash
git clone https://git.internal.example/wonseok-han/confluence-sync.git
cd confluence-sync
npm install
```

## 설정

동기화하려면 Confluence 접속 정보를 담은 `.env` 가 **실행 위치(cwd)** 에 있어야 합니다(또는 셸 환경변수). 그러니 **동기화할 문서 디렉토리에서** 아래 중 하나로 만드세요.

**권장: 대화형 마법사**
```bash
confluence-sync init     # 각 항목을 안내에 따라 입력 → cwd 에 .env 생성. API 토큰 입력은 *로 가려짐
```
- 이미 `.env` 가 있으면 덮어쓸지 물어봅니다(`--force` 로 건너뜀).
- 토큰 발급·CLOUD_ID 확인 방법은 아래 [API 토큰 발급](#api-토큰-발급-scoped-필수)·[cloudId 확인](#cloudid-확인-base_url-구성에-필요) 참고.

**수동 작성**: 아래 표를 보고 직접 `.env` 를 작성해도 됩니다(로컬 개발 시 `cp .env.example .env`).

   | 변수 | 설명 |
   | --- | --- |
   | `CONFLUENCE_BASE_URL` | `https://api.atlassian.com/ex/confluence/<CLOUD_ID>/wiki` (scoped 토큰용) |
   | `CONFLUENCE_EMAIL` | Atlassian 계정 이메일 |
   | `CONFLUENCE_API_TOKEN` | scoped API 토큰 (아래 발급 안내) |
   | `CONFLUENCE_SPACE_KEY` | URL `.../wiki/spaces/<KEY>/...` 의 KEY |
   | `CONFLUENCE_PARENT_PAGE_ID` | (선택) 자식으로 만들 부모 페이지 ID |
   | `CONFLUENCE_SYNC_BASE` | **(필수)** 동기화 루트 디렉토리. `--base` 인자로도 지정. 절대경로 권장(상대경로는 cwd 기준) |

### API 토큰 발급 (Scoped 필수)

> Classic(스코프 없는) 토큰은 2026.3~5월에 만료됨. **Scoped 토큰**을 발급하고, 엔드포인트는 `api.atlassian.com`을 쓴다.

1. https://id.atlassian.com/manage-profile/security/api-tokens → **"Create API token with scopes"**
2. 이름·만료일 입력 → 앱 **Confluence** 선택
3. 스코프 선택:
   - `read:space:confluence` (Space 조회)
   - `read:page:confluence` (페이지 버전 조회)
   - `write:page:confluence` (페이지 생성·갱신)
   - `read:content-details:confluence` + `write:attachment:confluence` (**이미지가 있는 문서**를 올릴 때 필요 — 첨부 업로드. **둘 다** 있어야 함)
   - `delete:page:confluence` (**`--rebuild` 사용 시에만** 필요 — 페이지 삭제)
4. 생성 후 토큰 즉시 복사
5. 토큰 계정은 대상 Space에 **페이지 추가/편집·첨부(및 rebuild 시 삭제) 권한**이 있어야 함

### cloudId 확인 (BASE_URL 구성에 필요)

브라우저에서 아래를 열고 `cloudId` 값을 복사 → `BASE_URL`의 `<CLOUD_ID>`에 넣는다.
```
https://<your-domain>.atlassian.net/_edge/tenant_info
```

## 실행

> 동기화 루트는 **`CONFLUENCE_SYNC_BASE`(env) 또는 `--base`로 반드시 지정**해야 합니다(기본값 없음). 미지정 시 에러로 중단됩니다. 상대경로는 **실행 cwd 기준**이므로 혼선을 막으려면 절대경로를 쓰거나 `.env`의 `CONFLUENCE_SYNC_BASE`에 절대경로를 넣으세요.

### 글로벌 CLI

```bash
confluence-sync init                   # 대화형으로 .env 생성
confluence-sync --help                 # 사용법, -v/--version 버전
confluence-sync --list                 # base에서 인식된 문서·제목·계층만 출력 (Confluence 호출·인증 없음)
confluence-sync --dry-run              # 호출 없이 대상·상태(신규/변경/동일)·링크·이미지 확인 (먼저 권장)
confluence-sync                        # 변경된 문서만 갱신 (+신규 생성)
confluence-sync --rebuild              # 매핑된 페이지 전부 삭제 후 재생성

# 인자
confluence-sync --base /abs/path/docs  # 동기화 루트 지정 (env 미설정 시 필수)
confluence-sync 20-design              # 지정 폴더만 (대표 README 자동 포함)
confluence-sync 90-glossary.md         # 단일 문서만
confluence-sync --force                # 변경 감지 무시, 전체 강제 갱신
confluence-sync --verify               # 변경 없는 문서도 페이지 존재 확인(삭제됐으면 재생성)
```

### 로컬 개발 (npm run)

소스에서 직접 실행할 때는 `npm run` 스크립트를 씁니다. 인자는 반드시 **`--` 뒤에** 둬야 합니다(npm이 가로채지 않도록). 예) `npm run list -- --base ./docs`.

| 글로벌 | 로컬 dev |
| --- | --- |
| `confluence-sync` | `npm run sync` |
| `confluence-sync --dry-run` | `npm run sync:dry` |
| `confluence-sync --rebuild` | `npm run sync:rebuild` |
| `confluence-sync --list` | `npm run list` |

- **변경 감지**: 각 문서의 `제목 + 변환 결과`를 해시로 매핑 파일에 저장하고, 같으면 **건드리지 않고 스킵**(`= 변경없음`)합니다. 실제로 바뀐 문서만 새 버전이 됩니다. `--force`로 무시할 수 있습니다.
- **삭제 복구**: Confluence에서 페이지가 삭제됐는데 그 문서를 갱신하려 하면, 404를 감지해 **자동으로 재생성**(`♻ 재생성`)합니다. 단 내용이 그대로(스킵)면 호출을 안 해서 못 잡으므로, 이때는 `--verify`로 **존재까지 확인**해 재생성하세요(매 문서 조회가 생겨 느려짐).
- **링크 재연결**: 재생성이 일어나면, 그 문서를 내부 링크로 가리키던 다른 문서들을 **자동으로 다시 발행**(`🔗 링크 재연결`)해 깨진 링크를 복구합니다. (Confluence는 링크를 발행 시점의 대상 페이지에 묶기 때문에, 대상이 새 페이지로 재생성되면 링크를 가진 문서도 다시 올려야 연결이 갱신됩니다.)
- **선택 동기화**: 위치 인자로 파일/폴더를 주면 그것만 처리하며, 자식 문서의 **부모 README가 자동 포함**됩니다(부모 pageId 확보용).
- 경로(mapping 키·내부 링크·계층)는 모두 **base 기준 상대경로**입니다.
- 각 문서의 **첫 `# 제목`** 이 페이지 제목, 본문은 storage format으로 변환됩니다.
- 코드블록 → **code 매크로**, 표·리스트·헤딩은 그대로.
- **내부 `.md` 링크** → 페이지 링크(대상 제목 기반) 자동 변환. 외부 URL은 일반 링크.
- **로컬 이미지** → 페이지 첨부로 업로드 후 참조. 외부 URL 이미지는 그대로.
- 매핑은 **`<base>/.confluence-sync.json`**(base 루트의 숨김 파일)에 저장됩니다. 그 문서셋과 **함께 커밋**해야 다음 실행에서 같은 페이지를 갱신합니다(삭제하면 중복 생성됨). `--mapping <path>`로 위치를 덮어쓸 수 있습니다.

### 폴더 = 계층 + 넘버링 순서

하위 폴더의 **`README.md`**가 그 폴더의 대표 페이지가 되고, 같은 폴더의 다른 문서는 그 자식으로 생성됩니다. 로컬 `docs/` 구조가 Confluence 페이지 트리로 재현됩니다.

`README.md`는 (prefix 없이) 항상 그 폴더의 **맨 앞**에 오고, 나머지 문서는 **숫자 prefix(`01-`,`10-`,`20-`…)순**으로 정렬됩니다.

```
[루트 부모 = CONFLUENCE_PARENT_PAGE_ID]
├── README · 01~03 기획서 · 90-glossary · 91-WORKLOG   ← 루트 직속
├── 10-pre-design/README  (PoC 개발 설계 전 정리)
│   └── 01~03 pre-design                                  ← 자식
└── 20-design/README  (PoC 개발 설계서)
    └── 01~03 design                                       ← 자식
```

부모는 자식보다 먼저 생성되도록 자동 정렬됩니다. 폴더 대표는 파일명이 `README.md`로 끝나는 문서(prefix 무관)로 인식합니다. `CONFLUENCE_PARENT_PAGE_ID`를 비우면 루트 직속 문서가 공간 최상위에 생성됩니다.

### --rebuild (구조를 갈아엎을 때)

부모 관계는 **생성 시점에만** 지정되고 v2 API로는 사후 이동이 어렵습니다. 그래서 계층을 바꾸려면 `--rebuild`로 **매핑된 페이지를 모두 삭제(휴지통) 후 재생성**합니다.

- `delete:page:confluence` 스코프가 토큰에 있어야 합니다.
- 매핑 파일(`.confluence-sync.json`)에 기록된 페이지만 삭제하므로, 수동으로 만든 페이지는 건드리지 않습니다.

## Confluence → Markdown 가져오기 (pull)

평소 동기화 방향(md → Confluence)의 **역방향**입니다. Confluence 페이지를 읽어 로컬 `.md` 로 생성합니다 — 기존 콘텐츠 부트스트랩이나 복구 용도.

```bash
confluence-sync pull <pageId|url>                       # 한 페이지를 현재 폴더에 .md 로
confluence-sync pull <url> --out ./docs                 # 출력 디렉토리 지정
confluence-sync pull <url> --out ./docs --children      # 하위 페이지까지 폴더 트리로 복원
```

- 식별자는 **숫자 ID** 또는 **URL**(`.../pages/<ID>/...` 페이지, `.../folder/<ID>` 폴더) 모두 됩니다.
- **폴더**를 주면 디렉토리로 만들고 그 안의 폴더·페이지를 재귀적으로 가져옵니다(폴더 자체는 본문이 없어 README 없음).
- `--children`: 하위를 재귀적으로 가져오며, 자식이 있는 페이지는 `<제목>/README.md` 폴더로 펼칩니다(push 계층 관례의 역).
- 본문은 Confluence `export_view`(HTML)를 [turndown](https://github.com/mixmark-io/turndown)으로 변환합니다. 코드블록 → ``` 펜스(언어 포함), 표 → GFM 표.
- **이미지/첨부**는 `.md` 옆에 내려받고 `![](파일명)` 으로 링크를 로컬화합니다. 외부 URL 이미지는 그대로 둡니다.
- 읽기 스코프 필요: `read:page:confluence`, `read:content-details:confluence`(첨부 조회·다운로드).

> ⚠️ **무손실 왕복은 아닙니다.** storage/export_view → Markdown 은 근사 변환이라 일부 매크로·레이아웃이 단순화될 수 있습니다. 또 내부 페이지 링크는 현재 **절대 URL로 유지**됩니다(상대 `.md` 링크 재작성은 미지원).

## 릴리스 (배포)

릴리즈 노트(changelog) 작성이 배포의 시작점입니다. **changelog를 `main`에 올리면 → Git 호스팅 Release+태그가 생기고 → 그 태그가 npm publish를 트리거**합니다.

```bash
# 1) package.json 버전 bump (changelog 파일명과 반드시 일치)
npm version 0.2.0 --no-git-tag-version

# 2) 릴리즈 노트 작성 (changelogs/TEMPLATE.md 참고)
cp changelogs/TEMPLATE.md changelogs/v0.2.0.md   # 편집해서 Added/Fixed/Changed 채우기

# 3) main 에 커밋·푸시
git add package.json changelogs/v0.2.0.md
git commit -m "chore: release v0.2.0"
git push origin main
```

이후 CI가 자동으로:
1. `create_release` 잡(`ci/.git-host-ci.release.yml`)이 `changelogs/` 변경을 감지 → 최신 `v*.md`로 **Git 호스팅 Release + `v0.2.0` 태그** 생성
2. 생성된 태그가 `publish` 잡을 트리거 → **Git 호스팅 Package Registry에 npm publish**

> **사전 설정 (1회)**: `create_release`는 Git 호스팅 Release API를 호출하므로, `api` 스코프의 Personal Access Token을 프로젝트 **Settings → CI/CD → Variables**에 `GITLAB_TOKEN`(Masked)으로 등록해야 합니다. publish는 `CI_JOB_TOKEN`을 자동으로 사용합니다.

- 릴리즈 노트는 `changelogs/vX.Y.Z.md`에 수동 작성하며, 파일명 버전 = `package.json` 버전이어야 publish 버전이 맞습니다.
- 같은 버전은 재배포 불가하므로 항상 버전을 올립니다(`create_release`는 태그가 이미 있으면 skip).
- 로컬에서 수동 배포하려면 `~/.npmrc`에 `write_package_registry` 토큰을 설정하고 `npm publish` 하면 됩니다(`prepublishOnly`가 자동 빌드).

## 현재 한계 (개선 여지)

- 내부 링크는 **대상 문서 제목(content-title) 기반**입니다. 대상의 H1 제목이 바뀌면 다음 sync로 양쪽을 다시 올리기 전까지 링크가 깨질 수 있습니다.
- 헤딩 **앵커(`#섹션`) 링크**는 해당 페이지로만 연결되고, 섹션 위치까지 이동하지는 않습니다.
- 이미지 첨부는 **로컬 파일만** 지원합니다(`write:attachment:confluence` 스코프 필요). 같은 파일명은 갱신되지만, 문서에서 이미지를 제거해도 기존 첨부는 자동 삭제되지 않습니다.
- **ASCII 다이어그램**은 코드블록(``` ```)으로 감싸야 정렬이 보존됩니다. 본 레포 문서는 대부분 코드블록 안에 있어 안전합니다.
- 제목이 같은 문서가 둘 이상이면 페이지·링크가 충돌할 수 있습니다(현재 레포 문서는 첫 H1이 모두 고유).
- 일반 `sync`는 생성·갱신만 합니다. git에서 문서를 **삭제**해도 Confluence에서 자동 삭제되진 않습니다(개별 정리 또는 `--rebuild` 필요).
- 폴더의 `README.md`가 없으면 그 폴더 문서는 루트 직속으로 생성됩니다.

## 동작 방식

```
base/**/*.md ─┬─ 첫 H1 → 제목
              └─ 본문 → markdown-it → storage(code 매크로·내부링크·이미지첨부)
                         │
              해시 비교 ─┬─ mapping에 동일 해시 → 스킵(변경없음)
                         ├─ pageId 있음·해시 다름 → 버전+1 PUT (갱신)
                         └─ pageId 없음          → POST (생성)
                         + 로컬 이미지 → POST /child/attachment
```
