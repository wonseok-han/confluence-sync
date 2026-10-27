/** CLI command dispatch. Feature modules do not run on import. */
import { positionalArgs } from './args.js';
import { printHelp, readPkgVersion } from './help.js';
import { runInit } from './init.js';
import { runConvert } from '../conversion/convert.js';
import { runPull } from '../sync/pull.js';
import { runRemap } from '../sync/remap.js';
import { runFetch } from '../sync/fetch.js';
import { runPush } from '../sync/push.js';

const argv = process.argv.slice(2);
try {
  if (argv.includes('--help') || argv.includes('-h')) printHelp();
  else if (argv.includes('--version') || argv.includes('-v')) console.log(readPkgVersion());
  else {
    switch (positionalArgs(argv)[0]) {
      case 'init': await runInit(argv); break;
      case 'convert': await runConvert(argv); break;
      case 'remap': await runRemap(argv); break;
      case 'push': { const args = [...argv]; args.splice(args.indexOf(positionalArgs(argv)[0]), 1); await runPush(args); break; }
      case 'fetch': await runFetch(argv); break;
      case 'pull': await runPull(argv); break;
      case 'web': { const { runWeb } = await import('../web/server.js'); await runWeb(argv); break; }
      case undefined:
        if (!argv.length) { printHelp(); break; }
        throw new Error('실행할 명령을 지정하세요. 업로드: csync push, 가져오기: csync pull, 도움말: csync --help');
      default: throw new Error('지원하지 않는 명령입니다. 업로드: csync push, 가져오기: csync pull, 도움말: csync --help');
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
