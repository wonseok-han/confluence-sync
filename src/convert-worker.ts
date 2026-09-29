// Keep CLI exits and CPU-heavy PDF rendering out of the web server process.
import { runConvert } from './convert.js';
try {
  await runConvert(['convert', ...process.argv.slice(2)]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
