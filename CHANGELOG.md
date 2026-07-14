# Changelog

## 1.1.0

Obsidian 브릿지. vault 를 그대로 Confluence 에 올리고, Confluence 를 그대로 vault 로 받을 수 있습니다.

### Push — vault 문법을 그대로 이해

- **`[[wikilink]]` · `[[대상|별칭]]`** → Confluence 페이지 링크. 짧은 이름(`[[설계]]`)과 경로(`[[구조/설계]]`) 모두 인식
- **`![[image.png]]`** → 첨부 이미지 업로드
- **YAML frontmatter** — `title` 이 페이지 제목이 되고(없으면 첫 H1 → 파일명 순), 나머지 키는 본문에 새지 않음
- **`pageId` 로 기존 페이지에 재연결** — 매핑 파일(`.confluence-sync.json`) 이 없거나 vault 를 복제해도 중복 생성 대신 원본을 갱신 (`[연결]`)
- 코드블록·인라인 코드 안의 `[[...]]` 는 건드리지 않고, 대상을 못 찾은 링크는 원문 그대로 보존
- `.obsidian/` `.trash/` 등 숨김 디렉토리를 문서 수집에서 제외

### Pull — vault 에 바로 열리는 마크다운

- **내부 링크 연결** — 함께 받은 페이지끼리의 Confluence URL 을 상대 `.md` 링크로 재작성 → Obsidian 그래프·백링크가 동작 (못 받은 페이지는 절대 URL 유지)
- **frontmatter 생성** — `title` · `pageId` · `spaceKey` · `source`(원본 URL) · `updated`. `pageId` 가 push 왕복의 앵커라 매핑 파일을 잃어도 중복 페이지가 생기지 않음
- 제목은 frontmatter `title` 로만 넣고 본문 `# 제목` 은 생략 — 제목을 따로 표시하는 뷰어(Obsidian 등)에서 두 번 보이지 않게. push 는 `title` 을 먼저 읽으므로 왕복 영향 없음
- **`--obsidian`** — 내부 링크를 `[[wikilink]]` 로 출력. 기본값은 Obsidian·GitHub·VS Code 어디서나 열리는 상대 `.md` 링크

### convert — 이미 받아둔 문서 손보기 (신규 명령)

다시 pull 하지 않고 로컬 `.md` 트리를 제자리에서 고칩니다. Confluence 호출·인증 없는 로컬 전용 명령입니다.

- **`--to obsidian` / `--to markdown`** — 링크 표기 전환. 두 방향이 서로의 역변환이라 왕복해도 내용이 보존됨
  - 외부 URL·이미지·깨진 링크·코드블록 안의 링크는 건드리지 않고, 파일명이 겹치면(`README.md` 여러 개 등) 상대 링크를 유지 — 이름만으로 대상을 확정할 수 없기 때문
- **`--fix`** — 변환기 개선 이전에 pull 한 문서의 흔적 보정. 스페이스를 다시 받지 않고 최신 변환 품질을 얻습니다
  - 중복 제목: frontmatter `title` 과 겹치는 본문 첫 H1 제거(제목이 다르면 손대지 않음)
  - 코드블록 언어: 실제 Java 가 아닌데 `java` 로 찍힌 것을 `plaintext` 로 (Confluence 가 언어 미지정 시 `brush: java` 를 붙이는 탓)
  - 본문에 새어 나온 CSS(`[data-colorid=…]{color:…}`) 제거
  - 불필요한 `\` 이스케이프 해제 (`:11\_eleven\_blue:` · `\[선택\]` · `**7️⃣**\-**1️⃣**` · `1\.5`)
  - 리스트 항목 사이 빈 줄 제거(같은 종류끼리만 — 번호↔글머리 경계는 보존)
  - 코드블록 안 줄 끝 공백 정리
  - **멱등적** — 두 번 돌려도 더 바뀌지 않고, 최신 pull 결과에는 아무 동작도 하지 않음
- **대상 지정** — 파일·폴더를 여러 개 줄 수 있고(`convert --fix ./docs/설치.md`), 안 주면 base 전체
- **`--base <dir>`** — 링크를 해석할 문서 트리 루트(기본: 준 경로들의 공통 상위 폴더)
- **`--out <dir>`** — 원본을 두고 결과를 다른 트리로. base 상대 구조를 재현하고 참조된 첨부도 함께 복사하며, base 안을 가리키면 거부
- `--dry-run` 으로 바뀔 파일 미리보기

### 그 외

- **`csync`** — 짧은 이름으로도 실행 가능(`confluence-sync` 와 동일). 전역 설치 시 두 이름 모두 생성됨
- `html2md`: 단어 내부 밑줄(`:11_eleven_blue:`)의 `\_` 이스케이프를 이제 pull 시점에도 해제

## 1.0.0

첫 릴리스.

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
