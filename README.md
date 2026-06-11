# confluence-sync

`docs/*.md`(하위 폴더 포함)를 **Confluence Cloud** 페이지로 **단방향 동기화**하는 수동 실행 도구입니다.
git 이 원천(SoT)이고 Confluence 는 미러입니다. 양방향 동기화는 하지 않습니다.

## 설정

1. 의존성 설치
   ```bash
   cd tools/confluence-sync
   npm install
   ```
2. `.env` 생성 후 값 채우기
   ```bash
   cp .env.example .env
   ```
   | 변수 | 설명 |
   | --- | --- |
   | `CONFLUENCE_BASE_URL` | `https://api.atlassian.com/ex/confluence/<CLOUD_ID>/wiki` (scoped 토큰용) |
   | `CONFLUENCE_EMAIL` | Atlassian 계정 이메일 |
   | `CONFLUENCE_API_TOKEN` | scoped API 토큰 (아래 발급 안내) |
   | `CONFLUENCE_SPACE_KEY` | URL `.../wiki/spaces/<KEY>/...` 의 KEY |
   | `CONFLUENCE_PARENT_PAGE_ID` | (선택) 자식으로 만들 부모 페이지 ID |

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

```bash
npm run sync:dry          # 호출 없이 대상 파일·제목·부모만 확인 (먼저 권장)
npm run sync              # 실제 생성/갱신 (계층 유지)
npm run sync -- --rebuild # 매핑된 기존 페이지 전부 삭제 후 처음부터 재생성
```

- 각 문서의 **첫 `# 제목`** 이 페이지 제목이 되고, 본문은 storage format으로 변환됩니다.
- 코드블록은 Confluence **code 매크로**로, 표·리스트·헤딩은 그대로 변환됩니다.
- **내부 `.md` 링크는 Confluence 페이지 링크로 자동 변환**됩니다(대상 문서의 제목 기반). 외부 URL은 일반 링크로 유지됩니다.
- **로컬 이미지**(`![](./img.png)`)는 해당 페이지의 **첨부로 업로드**되고 본문에서 참조됩니다. 외부 URL 이미지는 그대로 표시됩니다.
- 파일↔pageId 매핑은 `mapping.json`에 저장됩니다. **이 파일은 커밋**해야 다음 실행에서 같은 페이지를 갱신합니다(삭제하면 중복 생성됨).
- `sync:dry`는 문서별 **내부링크·이미지 수**도 함께 보여줍니다.

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
- `mapping.json`에 기록된 페이지만 삭제하므로, 수동으로 만든 페이지는 건드리지 않습니다.

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
docs/**/*.md ─┬─ 첫 H1 → 제목
              └─ 본문 → markdown-it → storage format(코드는 code 매크로)
                         │
              mapping.json 조회 ─┬─ pageId 있음 → 버전+1 PUT (갱신)
                                 └─ 없음        → POST (생성) → pageId 저장
```
