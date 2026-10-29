/** Task-oriented CLI overview and per-command help. */
import { bold, cyan, dim } from '../shared/colors.js';
import { readPkgVersion } from '../shared/version.js';
export { readPkgVersion };

const workspace = `  --base <폴더>             작업공간 지정(상위 작업공간 자동 탐색)
  --reference-root <폴더>   다른 작업공간의 게시 매핑으로 링크 연결(반복 가능)`;
const help: Record<string, string> = {
  init: `csync init [--base <폴더>] [--force]
csync init --connect [--base <폴더>]
csync init --migrate [--base <폴더>] [--dry-run]

  init             .env 생성. 터미널에서는 값을 입력하고, 비대화형은 빈 템플릿 생성
  --base <폴더>    .env를 생성하거나 연결할 기존 폴더(기본: 현재 폴더)
  --force          기존 .env 교체
  --connect        준비된 .env로 기준 폴더 ↔ 스페이스 연결. 문서 다운로드·업로드 없음
  --migrate        기존 루트 메타데이터를 .csync/로 이전(.env·문서 유지, API 호출 없음)
  --dry-run        --migrate 이전 내역만 확인

  기존 스페이스 받기: csync init → .env 값 입력 → csync pull
  로컬 문서부터 시작: csync init → .env 값 입력 → csync init --connect → csync add 문서.md
  연결 정보만 있는 폴더에서도 Pull이 스페이스를 확인하고 자동 연결합니다. 별도 스코프 설정은 없습니다.`,
  status: `csync status [--base <폴더>] [--reference-root <폴더>]

${workspace}

  로컬 문서와 저장된 Fetch 결과를 합쳐 표시합니다. Confluence API 호출·파일 저장 없음.
  ↓ 받을 변경: 원격에서만 변경 → csync pull
  ↑ 보낼 변경: 로컬 작업 → csync diff 문서.md → csync add 문서.md
  ! 양쪽 변경: 양쪽 모두 변경 → csync diff 문서.md --remote로 비교
  ! 확인 필요: 재추가 필요, 파일 누락, 원격 조회 불가 또는 기준 버전 확인 필요
  [추가됨]은 다음 Push에 포함, [미선택]은 제외입니다.
  원격 조회 시각을 확인하세요. 원격 미확인·오래된 결과는 csync fetch로 갱신합니다.
  로컬 누락 복구: csync restore README.md (기존 파일은 덮어쓰지 않음)
  원격 누락을 삭제로 확정하거나 로컬 파일 삭제를 원격에 전파하지 않습니다.`,
  fetch: `csync fetch [--base <폴더>] [--refresh]

  --base <폴더>    원격 변경을 확인할 작업공간
  --refresh        2분 캐시를 건너뛰고 원격 상태 다시 조회

  스페이스의 페이지 메타데이터를 100개씩 조회해 원격 신규·버전·제목·위치를 확인합니다. 본문·첨부는 받지 않습니다.
  .csync/remote.json에 저장하고 2분 동안 재사용합니다. 한 실행 최대 20회 요청.
  문서·매핑의 동기화 기준과 업로드 선택은 유지합니다. 결과는 csync status에서 확인하세요.
  경로 구성에 필요한 폴더 정보만 추가 조회합니다. 페이지 버전이 그대로인 첨부 단독 변경은 감지하지 않습니다.

  예: csync fetch → csync status → csync pull`,
  pull: `csync pull [--base <폴더>] [--obsidian]

  --base <폴더>    작업공간 지정
  --out <폴더>     저장할 작업공간(--base와 같아야 함)
  --obsidian       내부 링크를 [[wikilink]]로 저장
  --mapping <파일> 매핑 파일 지정(기본: .csync/mapping.json)

  Fetch 결과에서 아직 받지 않은 원격 문서와 원격에서만 변경된 문서를 받습니다.
  로컬이 비어 있어도 동일한 동작이며, 최초·전체 가져오기를 구분하지 않습니다.
  연결 정보만 있는 폴더는 .env로 스페이스 연결을 확인합니다.
  2분 이내 Fetch 결과를 재사용하며 없거나 만료되면 메타데이터를 조회합니다.
  로컬 수정·의도적인 삭제·이동 대기·양쪽 변경은 보존하고 원격 삭제를 전파하지 않습니다.
  원복은 csync restore <파일> --overwrite를 사용하세요.

  예: csync fetch → csync status → csync pull
      csync pull --out ./docs`,
  restore: `csync restore <파일.md...> [--overwrite] [--base <폴더>] [--obsidian]

  --base <폴더>    기존 작업공간 지정
  --obsidian       복구 문서의 내부 링크를 [[wikilink]]로 저장
  --overwrite      지정 문서의 로컬 수정과 관련 첨부를 버리고 원격 최신으로 교체

  지정한 문서를 매핑의 pageId로 조회해 최신 원격 본문과 첨부로 복구합니다.
  원격에 쓰거나 삭제하지 않습니다. 하위 페이지·전체 스페이스는 탐색하지 않습니다.
  기본은 누락 파일만 복구하며 기존 로컬 문서·첨부를 보호합니다.
  --overwrite는 지정한 문서와 원격에서 참조하는 첨부를 교체합니다. 로컬 수정은 사라집니다.
  다운로드 중 추가로 변경된 파일은 옵션과 관계없이 보존하고 중단합니다.
  제외 규칙·독립 작업공간·이동 대기·같은 pageId의 이동한 로컬 문서는 복구하지 않습니다.
  복구한 문서는 업로드 선택에서 제외합니다. 다시 올리려면 직접 add하세요.
  일반 pull은 로컬 삭제를 보존합니다. restore는 사용자가 지정한 파일만 복구합니다.

  예: csync restore README.md
      csync restore "수정한 문서.md" --overwrite
      csync restore "지식자산/문서.md" --base ./스페이스`,
  add: `csync add <파일·폴더...> [--base <폴더>] [--reference-root <폴더>]

${workspace}

  다음 Push에 포함할 문서를 .csync/index.json에 저장합니다. 폴더는 하위 문서 전체, .은 전체.
  Confluence API를 호출하지 않으며 원본 파일은 유지합니다.
  내용 사본이나 일부 줄을 저장하는 기능은 아닙니다. 추가 후 문서·첨부·링크가 바뀌면 재추가하세요.
  참조 폴더는 add와 push에 같은 값을 지정하세요.

  예: csync add "지식자산/특허출원/문서.md"
      csync status
      csync push --dry-run
      csync push`,
  unstage: `csync unstage <파일·폴더...> [--base <폴더>]

  --base <폴더>    작업공간 지정

  저장된 업로드 선택에서만 제외합니다. 문서·첨부·매핑·원격 내용은 유지합니다.
  파일 변경을 취소하거나 원래 내용으로 복원하는 명령이 아닙니다.

  예: csync unstage 문서.md
      csync unstage .     # 모두 선택 해제`,
  push: `csync push [파일·폴더...] [옵션]

${workspace}
  --dry-run         업로드 계획만 확인(기본은 API 호출 없음)
  --verify          변경 없는 문서까지 원격 버전·존재 확인(--dry-run과 함께 읽기 전용 조회)
  --list            인식된 문서·제목·계층만 출력(인증·API 호출 없음)
  --force           본문 강제 갱신(원격 충돌 검사는 유지)
  --exclude <패턴>  제외 패턴(반복 가능, .csync/ignore도 적용)
  --mapping <파일>  매핑 파일 지정(기본: .csync/mapping.json)

  경로 없는 push: add로 선택한 문서만 처리합니다. 선택이 없으면 중단합니다.
  push 문서.md: 저장된 선택과 별개로 명시한 문서를 직접 처리합니다.
  추가 후 수정한 문서는 다시 add해야 하며 성공·변경없음 항목은 선택 해제, 실패 항목은 유지합니다.
  CLI 미리보기는 선택 사항입니다. 웹은 미리보기 완료 후에만 업로드할 수 있습니다.
  미리보기 여부와 관계없이 원격 버전 충돌 검사는 유지하며 자동 병합하지 않습니다.
  상위 README는 부모 연결에만 사용합니다. 미연결 상위 README는 함께 추가하거나 Pull로 연결하세요.
  위키링크·각주·PDF 페이지 참조·Obsidian callout을 전처리하며 원본은 유지합니다.

  권장: csync add 문서.md → csync push --dry-run --verify → csync push
  직접: csync push 문서.md --dry-run → csync push 문서.md`,
  diff: `csync diff <파일.md> [--remote] [--base <폴더>]

  --base <폴더>    작업공간 지정
  --remote         해당 페이지 본문 1회 조회 후 현재 원격 ↔ 로컬 비교

  기본은 마지막 성공한 Pull·Push의 저장된 Markdown 기준본과 비교합니다(API 호출 없음).
  새 문서는 빈 내용과 비교하며 옛 매핑에 기준본이 없으면 --remote로 현재 원격과 비교하세요.
  원격 비교는 HTML → Markdown 근사 변환이며 과거 동기화 시점의 내용이 아닙니다.
  문서·매핑·업로드 선택은 변경하지 않습니다.

  예: csync diff "지식자산/문서.md"
      csync diff "지식자산/문서.md" --remote`,
  remap: `csync remap [--base <폴더>] [--dry-run]

  --base <폴더>           작업공간 지정
  --dry-run              계획만 확인, 저장 없음
  --from-mapping <파일>   외부 매핑에서 ID·해시 가져오기(원본 유지)
  --mapping <파일>        대상 매핑(기본: .csync/mapping.json)
  --exclude <패턴>        제외 패턴(반복 가능)

  로컬 파일의 pageId로 이동한 경로를 재연결합니다. API 호출·원격 이동 없음.
  보통 파일 이동 후 add와 push로 자동 인식하므로 별도 remap은 필요하지 않습니다.
  원격 위치 변경은 명시적으로 Push할 때 반영합니다. 폴더 ID의 경로 변경은 자동 추론하지 않습니다.`,
  convert: `csync convert [파일·폴더...] --to markdown|obsidian [옵션]
csync convert [파일·폴더...] --fix [옵션]

  --to markdown    위키링크·이미지·각주·PDF 페이지 참조를 Markdown으로 변환
  --to obsidian    Markdown 링크를 [[wikilink]]로 변환
  --fix            옛 Confluence 결과의 CSS 잔해·코드블록 언어·불필요한 이스케이프 보정
  --base <폴더>    링크 해석 기준(기본: 대상의 공통 상위 폴더)
  --out <폴더>     별도 출력 위치. 생략하면 원본 파일을 변경합니다.
  --dry-run        변경할 파일만 확인, 저장 없음

  로컬 전용이며 Confluence API·인증은 필요하지 않습니다.
  첨부는 문서 옆 attachments/<문서명>/에 보관합니다.
  Push는 필요한 전처리를 내부 수행하므로 먼저 변환본을 만들 필요는 없습니다.

  예: csync convert --to markdown ./vault --out ./markdown`,
  web: `csync web [--base <폴더>] [--port <번호>] [--no-open] [--ui <배포 웹 URL>] [--hosted]

  --base <폴더>    시작 폴더(기본: 홈 폴더, 화면에서 변경 가능)
  --port <번호>    웹 포트(기본: 4318)
  --no-open        브라우저 자동 열기 생략
  --hosted         브라우저 폴더 접근을 사용하는 배포 서버 실행(기본 포트 8080)
  --ui <URL>      배포 웹을 이 컴퓨터의 실행기에 연결(HTTPS, 로컬 개발은 HTTP 허용)

  localhost / 127.0.0.1에서 로컬 웹 화면을 실행합니다.
  문서 변환·표 서식·미리보기와 CLI와 같은 Fetch·Pull·업로드 선택·Push를 제공합니다.
  접속 설정은 선택한 기준 폴더의 .env 또는 직접 가져온 .env를 사용합니다.
  --ui는 지정한 웹 출처만 허용하며 연결 키는 csync를 종료하면 만료됩니다.
  예: csync web --ui https://csync.example.com --base ./vault`,
};
export function printHelp(command?: string): void {
  if (command) {
    if (!help[command]) throw new Error(`지원하지 않는 명령입니다: ${command}. csync --help를 확인하세요.`);
    console.log(`${bold(cyan(`csync ${command}`))}\n\n사용법: ${help[command]}\n\n  -h, --help  이 명령의 도움말\n  --no-color  색상 없이 출력(NO_COLOR 환경변수도 지원)`);
    return;
  }
  console.log(`${bold(cyan(`confluence-sync v${readPkgVersion()}`))}
${dim('Confluence Cloud ↔ Markdown · 기준 폴더 하나가 스페이스 작업공간입니다.')}

${bold('사용법:')} csync <명령> [옵션]
  init       .env 준비 / --connect로 기존 문서 폴더 연결
  status     로컬 변경 + 마지막 Fetch 결과 + 업로드 선택 확인(API 호출 없음)
  fetch      연결된 페이지의 원격 변경 확인(본문·첨부 유지, 2분 캐시)
  pull       아직 받지 않은 문서와 원격에서만 바뀐 문서 받기
  restore    선택한 문서를 원격 최신으로 복구(--overwrite로 로컬 수정 원복)
  diff       문서 내용 비교(--remote는 원격 본문 1회 조회)
  add        다음 Push에 포함할 문서 선택
  unstage    업로드 선택 해제(원본 유지)
  push       선택한 문서 업로드(명시한 경로는 직접 처리)
  web        로컬 웹 화면 실행
  convert    로컬 문서 형식 변환
  remap      고급: 이동한 로컬 파일의 매핑 정리

${bold('시작:')}
  csync init → .env 값 입력 → csync pull
  Pull 없이 로컬 문서부터: csync init → .env 값 입력 → csync init --connect

${bold('반복 작업:')}
  csync fetch → csync status → csync pull
  문서 편집 → csync diff 문서.md → csync add 문서.md
  csync push --dry-run → csync push

  Push는 선택한 문서만 처리하고, 기본 Pull은 로컬 수정·양쪽 변경을 보존합니다.
  새 원격 문서는 Fetch로 발견하고 Pull로 받습니다. 자동 병합하지 않습니다.
  add 후 문서·첨부·링크를 수정했다면 다시 add하세요.
  CLI --dry-run은 선택 사항이며 원격 충돌 검사는 항상 적용합니다.

${bold('도움말:')}
  csync <명령> --help    해당 명령의 옵션과 예제
  csync --version       버전 확인
  --no-color            색상 없이 출력(NO_COLOR 환경변수도 지원)
  csync                 도움말만 표시(업로드하지 않음)
  confluence-sync도 같은 명령으로 사용할 수 있습니다.`);
}
