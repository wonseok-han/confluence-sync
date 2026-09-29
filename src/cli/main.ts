/** CLI command dispatch. Feature modules do not run on import. */
import 'dotenv/config';
import { positionalArgs } from './args.js';
import { printHelp, readPkgVersion } from './help.js';
import { runInit } from './init.js';
import { runConvert } from '../conversion/convert.js';
import { runPull } from '../sync/pull.js';
import { runPush } from '../sync/push.js';

const argv = process.argv.slice(2);
try {
  if (argv.includes('--help') || argv.includes('-h')) printHelp();
  else if (argv.includes('--version') || argv.includes('-v')) console.log(readPkgVersion());
  else {
    switch (positionalArgs(argv)[0]) {
      case 'init': await runInit(argv); break;
      case 'convert': await runConvert(argv); break;
      case 'pull': await runPull(argv); break;
      case 'web': { const { runWeb } = await import('../web/server.js'); await runWeb(argv); break; }
      default: await runPush(argv);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
