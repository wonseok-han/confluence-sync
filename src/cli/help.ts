/** --help / --version 출력. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bold, cyan, dim } from '../shared/colors.js';

/** 설치된 패키지(package.json)의 버전을 읽는다(dist·src 어느 쪽에서 실행해도 ../../package.json). */
export function readPkgVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function printHelp(): void {
  const h = (s: string) => bold(s); // 섹션 제목
  const o = (s: string) => cyan(s); // 옵션/명령
  console.log(`${bold(cyan(`confluence-sync v${readPkgVersion()}`))}
${dim('Confluence Cloud ↔ Markdown 양방향 동기화 CLI.')}
${dim('짧은 이름')} ${o('csync')} ${dim('로도 실행할 수 있습니다(아래 confluence-sync 를 csync 로 대체 가능).')}

${h('사용법:')}
  ${o('confluence-sync')} [옵션] [경로...]      문서를 동기화(md → Confluence)
  ${o('confluence-sync web')}                   문서 변환·Confluence 동기화 웹 화면(로컬 전용)
  ${o('confluence-sync init')}                  대화형으로 .env 설정 파일 생성
  ${o('confluence-sync pull [pageId|url]')}     Confluence 페이지/폴더를 .md 로 가져오기(역방향)
  ${o('confluence-sync convert --to <형식>')}   이미 받은 .md 의 링크 표기를 바꾸기(로컬 전용)
  ${o('confluence-sync --help | --version')}

${h('remap 옵션(로컬 매핑만 갱신, Confluence 호출 없음):')}
  ${o('csync remap --base <dir>')}  pageId로 경로를 재연결하고 이동 대기 기록
  ${o('--from-mapping <path>')}  원본 매핑에서 기존 ID·해시 가져오기(원본 유지)
  ${o('--mapping <path>')}       저장할 매핑(기본: <base>/.csync/mapping.json)
  ${o('--exclude <glob>')}       제외 패턴(반복 가능), .csync/ignore도 적용
  ${o('--dry-run')}              변경 내역만 출력, 파일 저장 없음
  이후 ${o('csync sync --base <dir> --dry-run')}으로 확인하고, 명시적으로 sync할 때 이동 반영.
  기존 해시가 없으면 sync에서 본문도 갱신합니다. 폴더 ID의 경로 변경은 자동 추론하지 않습니다.

${h('메타데이터 이전(로컬 전용):')}
  ${o('csync init --migrate --base <dir> --dry-run')}  기존 루트 메타데이터 이전 미리보기
  ${o('csync init --migrate --base <dir>')}            .csync/ 안으로 이전(.env·문서 유지)
  기존 이름도 계속 읽습니다. 기존·새 파일의 내용이 다르면 중단합니다.

${h('관리 범위 설정(로컬 전용):')}
  ${o('csync init --base <dir> --scope <원격경로|id:ID>')}  필수 원격 스코프 직접 설정(.env 유지, 메타데이터 조회만)
  ${o('--base')}는 로컬 루트, ${o('--scope')}는 스페이스 기준 원격 경로 하나. 기본값 없음.
  전체도 ${o('--scope /')}로 직접 선택합니다. 기존 부모 환경변수·로컬 범위는 자동 전환하지 않습니다.
  sync·pull·remap·웹이 같은 범위를 적용하며, 독립된 하위 매핑은 자동 병합하지 않습니다.

${h('web 옵션:')}
  ${o('--base <dir>')}      처음 열 폴더(기본: 홈 폴더). 화면에서 기준 폴더를 바꿀 수 있음
  ${o('--port <number>')}   웹 포트(기본: 4318)
  ${o('--no-open')}         브라우저를 자동으로 열지 않음
  localhost / 127.0.0.1 로컬 주소에서 실행. 화면에서 출력 폴더 지정 가능. 원본 유지.

${h('동기화 옵션:')}
  ${o('--reference-root <dir>')}  동기화 링크 참조 폴더(반복 가능, 참조 문서는 업로드하지 않음)
  ${o('--base <dir>')}      동기화 루트 (환경변수 또는 현재 위치의 상위 작업공간에서 자동 탐색)
  ${o('--mapping <path>')}  매핑 파일 위치 (기본: <base>/.csync/mapping.json)
  ${o('--exclude <glob>')}  동기화 제외 패턴(반복 가능). <base>/.csync/ignore(.gitignore 방식)도 사용
  ${o('--dry-run')}         호출 없이 대상·상태(신규/변경/동일)·링크·이미지 출력
  ${o('--list')}            인식된 문서·제목·계층만 출력 (Confluence 호출·인증 없음)
  ${o('--force')}           로컬 해시가 같아도 갱신 (원격 충돌 검사는 유지)
  ${o('--verify')}          변경 없는 문서도 원격 버전·존재 확인. --dry-run과 함께 읽기 전용 검사
  ${o('--rebuild')}         v2 스코프 기반 동기화에서는 거부
  ${o('--no-color')}        컬러 출력 끄기
  ${o('-h, --help')}        이 도움말
  ${o('-v, --version')}     버전 출력

${h('경로 인자:')}
  파일/폴더를 주면 ${bold('그 문서만')} 발행합니다.
  상위 ${o('README.md')} 는 자식을 붙일 부모 pageId 를 얻는 데만 쓰이고 내용은 갱신되지 않습니다
  ${dim('(아직 페이지가 없으면 자식을 붙일 곳이 없으므로 그때는 생성됩니다).')}
  상위 문서까지 갱신하려면 함께 지정하세요.
  예)  ${o('confluence-sync 20-design')}        ${o('confluence-sync 90-glossary.md')}

${h('pull(역방향) 옵션:')}
  ${o('--out <dir>')}         .md 를 생성할 디렉토리(기본: 현재 폴더)
  ${o('--children')}          하위 페이지까지 재귀적으로 가져와 폴더 트리로 복원
  ${o('--space')}             / 스코프를 직접 선택한 경우에만 사용 가능
  ${o('--obsidian')}          내부 링크를 [[wikilink]] 로 출력(기본: 어디서나 열리는 상대 .md 링크)
  ${o('--base <dir>')}        매핑 키의 기준(기본: --out 에서 위로 올라가며 .csync/ 또는 기존 매핑을 찾음)
  ${o('--mapping <path>')}    매핑 파일 위치 (기본: <base>/.csync/mapping.json)
  (이미지는 항상 attachments/<문서명>/ 하위에 저장됨)
  대상을 생략하면 저장된 원격 스코프를 재귀적으로 가져옵니다. 미설정 시 중단합니다.
  --root·--no-mapping은 지원하지 않습니다. 하위 ID는 스코프 안의 기존 매핑만 사용합니다.
  로컬 변경·이동 대기 문서는 덮어쓰지 않으며, 전체 다운로드 후 충돌 검사합니다.
  받아온 문서는 원격 버전·pageId 와 ${dim('변경 해시')}가 매핑에 기록되어, ${bold('pull 직후 push 하면 "변경없음"')} 입니다
  ${dim('(기록하지 않으면 방금 받아온 내용을 그대로 되올려 보내게 됩니다).')}
  예)  ${o('confluence-sync pull https://.../pages/12345/Title --out ./docs --children')}
       ${o('confluence-sync init --base ./docs --scope /')}
       ${o('confluence-sync pull --base ./docs')}

${h('convert(이미 받아둔 .md 손보기) 옵션:')} ${dim('Confluence 호출·인증 없음')}
  ${o('--to obsidian')}    상대 .md 링크 → [[wikilink]]
  ${o('--to markdown')}    [[wikilink]] · ![[embed]] → 상대 .md 링크 (되돌리기)
                   각주 → 위첨자 링크·제목 앵커, PDF #page=N → 해당 쪽 이미지
                   --to obsidian은 변환 표식으로 각주·PDF 참조를 복원
                   절대경로·file://·../ 로컬 첨부는 출력 트리에 복사하고 링크 변경
  ${o('--fix')}            옛 pull 결과 보정 — 코드블록 언어(java→plaintext)·CSS 잔해·
                   불필요한 \\ 이스케이프·리스트 사이 빈 줄
  ${o('--base <dir>')}     링크를 해석할 문서 트리 루트(기본: 준 경로들의 공통 상위 폴더)
  ${o('--out <dir>')}      원본을 두고 결과를 다른 트리에 쓰기(참조된 첨부도 함께 복사)
  ${o('--dry-run')}        바뀔 파일만 출력하고 쓰지 않음

  파일·폴더를 여러 개 줄 수 있고, 안 주면 base 전체가 대상입니다.
  ${o('--out')} 없이 실행하면 ${dim('원본 파일을 덮어씁니다')}.
  예)  ${o('confluence-sync convert --fix ./docs --dry-run')}
       ${o('confluence-sync convert --to obsidian --fix ./docs --out ~/MyVault')}
       ${o('confluence-sync convert --fix ./docs/가이드/설치.md --base ./docs')}  ${dim('(파일 하나만)')}

${h('섹션 링크(앵커):')}
  ${o('[§1 개요](#1-개요)')} 처럼 헤딩을 가리키는 링크가 Confluence 에서도 동작합니다.
  같은 문서(${o('#슬러그')} · ${o('[[#헤딩]]')})·다른 문서(${o('문서.md#슬러그')} · ${o('[[문서#헤딩]]')}) 모두 지원합니다.
  Confluence 의 자동 헤딩 id 는 배포판마다 달라서, 가리켜지는 헤딩 앞에 ${dim('Anchor 매크로')}로
  이름을 직접 심고 그 이름을 가리킵니다. pull 은 반대로 슬러그를 되돌립니다.
  대응하는 헤딩을 못 찾으면 링크를 바꾸지 않고 ${dim('⚠ 대응 헤딩 없는 앵커')} 로 알려 줍니다
  ${dim('(대개 문서 쪽 오타나 깨진 상대경로입니다)')}.

${h('Obsidian:')}
  pull 결과는 vault 에서 바로 열립니다. 함께 받은 페이지끼리의 내부 링크가 이어져 그래프·백링크가
  동작하고, 각 문서의 frontmatter 에 pageId 가 남아 원본 페이지를 가리킵니다.
  [[wikilink]] 표기를 원하면 ${o('pull --obsidian')}, 이미 받아둔 문서라면 ${o('convert --to obsidian')}.

  push 는 vault 문법을 그대로 이해합니다: ${o('[[wikilink]]')} · ${o('![[embed]]')} · ${o('[[문서#헤딩]]')} · YAML frontmatter
  (frontmatter 의 ${o('title')} 이 페이지 제목이 되고, ${o('pageId')} 가 있으면 매핑이 없어도 그 페이지를 갱신합니다).

${h('설정(.env):')}
  작업공간의 .env(없으면 실행 위치 .env)를 읽으며 셸 환경변수가 우선합니다.
  이전 매핑에 원격 버전이 없으면 변경 push를 차단합니다. 로컬 변경을 보관한 후 pull로 기준을 확보하세요.
  필수: CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, CONFLUENCE_SPACE_KEY
  선택: CONFLUENCE_SYNC_BASE. 부모 ID 환경변수는 사용하지 않습니다.
  원격 스코프는 init --scope로 직접 선택해야 합니다.
  ${o("'confluence-sync init'")} 으로 대화형 생성 가능.`);
}
