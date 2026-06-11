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
   | `CONFLUENCE_BASE_URL` | `https://<도메인>.atlassian.net/wiki` |
   | `CONFLUENCE_EMAIL` | Atlassian 계정 이메일 |
   | `CONFLUENCE_API_TOKEN` | [API 토큰](https://id.atlassian.com/manage-profile/security/api-tokens) |
   | `CONFLUENCE_SPACE_KEY` | URL `.../wiki/spaces/<KEY>/...` 의 KEY |
   | `CONFLUENCE_PARENT_PAGE_ID` | (선택) 자식으로 만들 부모 페이지 ID |

   토큰 계정은 대상 Space에 **페이지 추가/편집 권한**이 있어야 합니다.

## 실행

```bash
npm run sync:dry   # 호출 없이 대상 파일·제목만 확인 (먼저 권장)
npm run sync       # 실제 생성/업데이트
```

- 각 문서의 **첫 `# 제목`** 이 페이지 제목이 되고, 본문은 storage format으로 변환됩니다.
- 코드블록은 Confluence **code 매크로**로, 표·리스트·헤딩은 그대로 변환됩니다.
- 파일↔pageId 매핑은 `mapping.json`에 저장됩니다. **이 파일은 커밋**해야 다음 실행에서 같은 페이지를 갱신합니다(삭제하면 중복 생성됨).

## 현재 한계 (개선 여지)

- **상대 링크**(`../docs/...`, `./design/...`)는 Confluence 페이지 링크로 자동 변환되지 않습니다. 페이지 간 링크는 수동 보정이 필요합니다.
- **ASCII 다이어그램**은 코드블록(``` ```)으로 감싸야 정렬이 보존됩니다. 본 레포 문서는 대부분 코드블록 안에 있어 안전합니다.
- 제목이 같은 문서가 둘 이상이면 충돌할 수 있습니다(현재 레포 문서는 첫 H1이 모두 고유).
- 페이지 **삭제**는 동기화하지 않습니다(생성·갱신만).

## 동작 방식

```
docs/**/*.md ─┬─ 첫 H1 → 제목
              └─ 본문 → markdown-it → storage format(코드는 code 매크로)
                         │
              mapping.json 조회 ─┬─ pageId 있음 → 버전+1 PUT (갱신)
                                 └─ 없음        → POST (생성) → pageId 저장
```
