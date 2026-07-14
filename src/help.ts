/** --help / --version 출력. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bold, cyan, dim } from './colors.js';

/** 설치된 패키지(package.json)의 버전을 읽는다(dist·src 어느 쪽에서 실행해도 ../package.json). */
export function readPkgVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
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
  ${o('confluence-sync init')}                  대화형으로 .env 설정 파일 생성
  ${o('confluence-sync pull <pageId|url>')}     Confluence 페이지/폴더를 .md 로 가져오기(역방향)
  ${o('confluence-sync convert --to <형식>')}   이미 받은 .md 의 링크 표기를 바꾸기(로컬 전용)
  ${o('confluence-sync --help | --version')}

${h('동기화 옵션:')}
  ${o('--base <dir>')}      동기화 루트 (또는 env CONFLUENCE_SYNC_BASE). 미지정 시 중단
  ${o('--mapping <path>')}  매핑 파일 위치 (기본: <base>/.confluence-sync.json)
  ${o('--exclude <glob>')}  동기화 제외 패턴(반복 가능). <base>/.confluence-syncignore(.gitignore 방식)도 사용
  ${o('--dry-run')}         호출 없이 대상·상태(신규/변경/동일)·링크·이미지 출력
  ${o('--list')}            인식된 문서·제목·계층만 출력 (Confluence 호출·인증 없음)
  ${o('--force')}           변경 감지 무시, 전체 강제 갱신
  ${o('--verify')}          변경 없는 문서도 페이지 존재 확인(삭제됐으면 재생성)
  ${o('--rebuild')}         매핑된 페이지 전부 삭제 후 재생성
  ${o('--no-color')}        컬러 출력 끄기
  ${o('-h, --help')}        이 도움말
  ${o('-v, --version')}     버전 출력

${h('경로 인자:')}
  파일/폴더를 주면 그 문서만 동기화합니다(부모 README 자동 포함).
  예)  ${o('confluence-sync 20-design')}        ${o('confluence-sync 90-glossary.md')}

${h('pull(역방향) 옵션:')}
  ${o('--out <dir>')}         .md 를 생성할 디렉토리(기본: 현재 폴더)
  ${o('--children')}          하위 페이지까지 재귀적으로 가져와 폴더 트리로 복원
  ${o('--space')}             대상 없이 스페이스(CONFLUENCE_SPACE_KEY) 홈페이지부터 전체를 가져옴
  ${o('--obsidian')}       내부 링크를 [[wikilink]] 로 출력(기본: 어디서나 열리는 상대 .md 링크)
  (이미지는 항상 attachments/<문서명>/ 하위에 저장됨)
  예)  ${o('confluence-sync pull https://.../pages/12345/Title --out ./docs --children')}
       ${o('confluence-sync pull --space --out ./docs')}

${h('convert(이미 받아둔 .md 손보기) 옵션:')} ${dim('Confluence 호출·인증 없음')}
  ${o('--to obsidian')}    상대 .md 링크 → [[wikilink]]
  ${o('--to markdown')}    [[wikilink]] · ![[embed]] → 상대 .md 링크 (되돌리기)
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

${h('Obsidian:')}
  pull 결과는 vault 에서 바로 열립니다. 함께 받은 페이지끼리의 내부 링크가 이어져 그래프·백링크가
  동작하고, 각 문서의 frontmatter 에 pageId 가 남아 원본 페이지를 가리킵니다.
  [[wikilink]] 표기를 원하면 ${o('pull --obsidian')}, 이미 받아둔 문서라면 ${o('convert --to obsidian')}.

  push 는 vault 문법을 그대로 이해합니다: ${o('[[wikilink]]')} · ${o('![[embed]]')} · YAML frontmatter
  (frontmatter 의 ${o('title')} 이 페이지 제목이 되고, ${o('pageId')} 가 있으면 매핑이 없어도 그 페이지를 갱신합니다).

${h('설정(.env):')}
  실행 위치(cwd)의 .env 또는 셸 환경변수를 읽습니다.
  필수: CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, CONFLUENCE_SPACE_KEY
  선택: CONFLUENCE_PARENT_ID(페이지/폴더 id), CONFLUENCE_SYNC_BASE
  ${o("'confluence-sync init'")} 으로 대화형 생성 가능.`);
}
