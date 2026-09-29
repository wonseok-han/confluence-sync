import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// TypeScript does not remove obsolete output after modules move.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))], { stdio: 'inherit' });
await import('./build-web.mjs');
