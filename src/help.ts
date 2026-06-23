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
${dim('Markdown 디렉토리를 Confluence Cloud 페이지로 단방향 동기화합니다.')}

${h('사용법:')}
  ${o('confluence-sync')} [옵션] [경로...]      문서를 동기화(md → Confluence)
  ${o('confluence-sync init')}                  대화형으로 .env 설정 파일 생성
  ${o('confluence-sync pull <pageId|url>')}     Confluence 페이지/폴더를 .md 로 가져오기(역방향)
  ${o('confluence-sync --help | --version')}

${h('동기화 옵션:')}
  ${o('--base <dir>')}      동기화 루트 (또는 env CONFLUENCE_SYNC_BASE). 미지정 시 중단
  ${o('--mapping <path>')}  매핑 파일 위치 (기본: <base>/.confluence-sync.json)
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
  ${o('--out <dir>')}       .md 를 생성할 디렉토리(기본: 현재 폴더)
  ${o('--children')}        하위 페이지까지 재귀적으로 가져와 폴더 트리로 복원
  예)  ${o('confluence-sync pull https://.../pages/12345/Title --out ./docs --children')}

${h('설정(.env):')}
  실행 위치(cwd)의 .env 또는 셸 환경변수를 읽습니다.
  필수: CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, CONFLUENCE_SPACE_KEY
  선택: CONFLUENCE_PARENT_ID(페이지/폴더 id), CONFLUENCE_SYNC_BASE
  ${o("'confluence-sync init'")} 으로 대화형 생성 가능.`);
}
