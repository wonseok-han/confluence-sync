import { withProgress } from '../shared/progress.js';
import { red } from '../shared/colors.js';
import { runRestore } from '../sync/restore.js';
import { runStatus } from './status.js';
import { runDiff } from '../sync/diff.js';
/** CLI command dispatch. Feature modules do not run on import. */
import { positionalArgs } from './args.js';
import { printHelp, readPkgVersion } from './help.js';
import { runInit } from './init.js';
import { runConvert } from '../conversion/convert.js';
import { runPull } from '../sync/pull.js';
import { runRemap } from '../sync/remap.js';
import { runFetch } from '../sync/fetch.js';
import { runStaging } from '../sync/staging.js';
import { runPush } from '../sync/push.js';

const argv = process.argv.slice(2);
try {
  if (argv.includes('--help') || argv.includes('-h')) printHelp(positionalArgs(argv)[0]);
  else if (argv.includes('--version') || argv.includes('-v')) console.log(readPkgVersion());
  else {
    switch (positionalArgs(argv)[0]) {
      case 'diff': await withProgress(argv.includes('--remote') ? '원격 본문 비교' : '저장된 기준본과 문서 비교', () => runDiff(argv)); break;
      case 'status': await withProgress('로컬 변경과 업로드 선택 확인', () => runStatus(argv)); break;
      case 'add': case 'unstage': await withProgress(positionalArgs(argv)[0] === 'add' ? '업로드 문서 선택 저장' : '업로드 선택 해제', () => runStaging(argv)); break;
      case 'init': if (argv.includes('--connect') || argv.includes('--migrate')) await withProgress(argv.includes('--connect') ? '스페이스 작업공간 연결' : '메타데이터 이전 확인', () => runInit(argv)); else await runInit(argv); break;
      case 'convert': await withProgress('로컬 문서 변환', () => runConvert(argv)); break;
      case 'remap': await withProgress('페이지 ID와 로컬 경로 재연결', () => runRemap(argv)); break;
      case 'push': { const args = [...argv]; args.splice(args.indexOf(positionalArgs(argv)[0]), 1); await withProgress(argv.includes('--list') ? '문서 목록 확인' : argv.includes('--dry-run') ? '업로드 미리보기' : 'Confluence 문서 업로드', () => runPush(args)); break; }
      case 'fetch': await withProgress('원격 페이지 메타데이터 확인', () => runFetch(argv)); break;
      case 'restore': await withProgress('선택한 로컬 문서를 원격에서 복구', () => runRestore(argv)); break;
      case 'pull': await withProgress('Confluence 문서 가져오기', () => runPull(argv)); break;
      case 'web': { const { runWeb } = await import('../web/server.js'); await runWeb(argv); break; }
      case undefined:
        if (!argv.length) { printHelp(); break; }
        throw new Error('실행할 명령을 지정하세요. 업로드: csync push, 가져오기: csync pull, 도움말: csync --help');
      default: throw new Error('지원하지 않는 명령입니다. 업로드: csync push, 가져오기: csync pull, 도움말: csync --help');
    }
  }
} catch (error) {
  console.error(red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
