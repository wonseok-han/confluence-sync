# 설정과 작업공간

[← README로 돌아가기](../../README.md)

설치, Confluence 인증, 작업공간 상태 파일과 기존 버전에서 이전하는 방법입니다.

- [설치](#설치)
- [API 토큰 발급](#api-토큰-발급)
- [cloudId 확인](#cloudid-확인)
- [빠른 시작](#빠른-시작)
- [v2: 스페이스 작업공간](#v2-스페이스-작업공간)
- [상태 파일 보관과 기존 파일 이전](#상태-파일-보관과-기존-파일-이전)
- [v1에서 이전할 때](#v1에서-이전할-때)

## 설치

```bash
npm i -g @wonseok-han/confluence-sync

confluence-sync --version
confluence-sync --help
```

Node.js 22.13 이상인 22.x 또는 24.x가 필요합니다.

> 짧은 이름 **`csync`** 도 같이 설치됩니다 — 아래 예시의 `confluence-sync` 는 전부 `csync` 로 바꿔 쓸 수 있습니다.

## API 토큰 발급

웹의 **.env 연결 설정 → API 토큰 발급 가이드**에서 클릭 위치가 표시된 7단계 스크린샷과 권한 목록을 볼 수 있습니다. 상단 **사용 도움말 → API 토큰 발급**에서도 열 수 있습니다.

1. https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token with scopes**
2. 앱 **Confluence** 선택
3. 쓰려는 기능에 맞춰 스코프 선택:

   | 기능 | 필요 스코프 |
   | --- | --- |
   | **스코프 조회·push 기본** (조회·생성·갱신) | `read:space` · `read:page` · `read:content-details` · `write:page` |
   | 이미지/첨부 업로드 | `read:content-details` + `write:attachment` (둘 다) |
   | README 없는 폴더를 Confluence 폴더로 생성 | `write:folder` |
   | **pull** (읽기) | `read:page` + `read:content-details` |
   | pull 시 첨부 이미지 다운로드 | `read:attachment` |

   > 모두 `:confluence` 접미사가 붙습니다 (예: `read:page:confluence`).

4. 토큰 계정은 대상 Space에 해당 권한이 있어야 합니다.

## cloudId 확인

`BASE_URL` 의 `<CLOUD_ID>` 는 아래에서 확인합니다.

```
https://<your-domain>.atlassian.net/_edge/tenant_info
```

## 빠른 시작

```bash
cd /path/to/docs          # 동기화할 .md 들이 있는 폴더

confluence-sync init      # 대화형으로 .env 생성 (토큰 입력은 가려짐)
confluence-sync init --connect --base . # Pull 없이 기존 문서 폴더 연결
confluence-sync add .          # 작업공간 문서를 업로드 대상으로 선택
confluence-sync push --dry-run # 무엇이 올라갈지 미리보기
confluence-sync push           # 실제 발행
```

반대로 Confluence에서 가져오려면:

```bash
confluence-sync pull                      # 원격 신규·안전한 변경 받기
```


## v2: 스페이스 작업공간

**기준 폴더 하나를 스페이스 전체의 로컬 작업공간으로 사용합니다.** 별도 파일·폴더 스코프 설정은 없습니다. Push는 직접 선택한 문서만 업로드하고, 기본 Pull은 원격에서만 바뀐 문서를 가져옵니다.

```bash
csync init                              # .env 생성 후 값 입력
csync pull                              # 받을 원격 문서 가져오기
csync fetch                             # 원격 메타데이터 확인
csync pull                              # 원격에서만 바뀐 기존 문서 받기
csync add "지식자산/특허출원/문서.md"     # 이 문서만 업로드 대상으로 추가
csync push --dry-run --verify
csync push
```

Pull 없이 구성한 로컬 폴더는 `.env`를 준비하고 `csync init --connect --base <폴더>`로 연결하세요. 새 문서도 `add` 후 Push할 수 있습니다. 기준 폴더 밖 경로는 거부하며 별도 백업 폴더의 문서를 쓰려면 그 폴더를 기준 폴더로 선택해야 합니다.

기존 v2 설정의 로컬 `scope`·`syncPaths`는 필터로 사용하지 않습니다. 문서와 페이지 매핑은 유지하며, 재연결하면 예전 필터 필드를 제거합니다. 기존 원격 루트 연결은 임의로 바꾸지 않습니다. 예전에 스페이스의 일부 원격 폴더에 연결한 작업공간을 전체 스페이스로 확장하려면 별도 기준 폴더에 새로 Pull하세요. `CONFLUENCE_PARENT_ID`와 `init --scope`는 사용하지 않습니다.

### 상태 파일 보관과 기존 파일 이전

`.env`는 기존 위치에 두고 csync가 관리하는 파일은 `.csync/` 안에 모읍니다. 문서 경로와 매핑 키의 기준은 계속 작업공간 루트이며 `.csync/`로 바뀌지 않습니다.

```text
문서 루트/
  .env
  .csync/
    mapping.json
    workspace.json
    ignore             # 선택: 제외 규칙
  README.md
  지식자산/
```

기존 루트의 `.confluence-sync.json`, `.confluence-workspace.json`, `.confluence-syncignore`도 계속 읽고 같은 위치에 저장합니다. 기존 파일을 모으려면 다음 명령을 명시적으로 실행하세요.

```bash
csync init --migrate --base . --dry-run
csync init --migrate --base .
```

매핑 ID·해시·원격 버전·이동 대기·관리 범위와 제외 규칙의 내용을 그대로 복사하고 검증한 뒤 기존 파일을 제거합니다. `.env`와 문서·첨부는 이동하지 않으며 Confluence 호출도 없습니다. 양쪽 위치의 파일 내용이 다르면 덮어쓰지 않고 중단합니다. 중첩된 다른 작업공간은 이전하지 않습니다. 명시적인 `--mapping <path>` 경로는 계속 지원하며 자동 이전 대상이 아닙니다.

### v1에서 이전할 때

1. 문서·첨부·매핑·`.env`를 백업하고 미저장 로컬 변경을 별도로 보관합니다. 메타데이터 위치를 옮기려면 위 `init --migrate`를 사용합니다.
2. `csync init --connect --base <실제 문서 루트>`로 스페이스에 연결합니다. 예전 부모 환경변수와 로컬 필터를 사용하지 않으며 기존 매핑은 유지합니다.
3. **예전 매핑에는 `remoteVersion`이 없어 변경 업로드를 차단합니다.** `csync restore 문서.md --overwrite`로 원격 최신을 받아 기준을 확보하세요. 로컬 수정은 사라지므로 필요한 변경은 먼저 보관·비교하세요.
4. 예전 `pull --space` 결과가 `<출력>/<스페이스>/`에 있고 매핑은 출력 바깥 기준이라면, 새 빈 `--out`에 받아 구조를 비교하세요. 기존 경로·설정을 자동 이동하거나 매핑을 추측해 재작성하지 않습니다. 이미 수동 보정한 문서 루트는 그대로 사용합니다.
5. 하위에 별도 `.env`·매핑을 만든 기존 작업공간은 독립적으로 유지합니다. 자동 병합하지 않으므로 해당 하위 폴더를 `--base`로 지정해 사용할 수 있습니다. 새 작업공간에서는 스페이스 기준 폴더 하나와 업로드 문서 선택을 사용합니다.

v1의 `pull --root`·`--no-mapping`은 지원하지 않습니다. 전체 탐색은 스페이스 **홈페이지의 하위 트리**이며 홈페이지 밖 별도 최상위 페이지까지 열거하지 않습니다.
