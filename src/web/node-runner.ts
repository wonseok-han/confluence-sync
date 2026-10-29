import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SyncRunner } from './sync.js';

export const runSyncCLI: SyncRunner = (args, settings, log) => new Promise((resolveJob, reject) => {
  const source = import.meta.url.endsWith('.ts');
  const worker = fileURLToPath(new URL(source ? '../sync.ts' : '../sync.js', import.meta.url));
  const child = spawn(process.execPath, [...(source ? process.execArgv : []), worker, ...args], {
    env: { ...process.env, ...settings, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Emit complete lines so secret masking cannot be bypassed by split stream chunks.
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      const end = pending.lastIndexOf('\n');
      if (end >= 0) { log(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
    });
    stream.on('end', () => { if (pending) log(pending); });
  }
  child.once('error', reject);
  child.once('close', code => resolveJob(code ?? 1));
});
