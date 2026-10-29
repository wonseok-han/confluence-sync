/** CLI-only progress. Stdout remains intact; redirected stderr gets two plain log lines. */
import { Worker } from 'node:worker_threads';
import { cyan, green, red, yellow } from './colors.js';

let active: { update: (message: string) => void } | undefined;
export function progressStep(message: string): void { active?.update(message); }
const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
function label(text: string, budget: number): string {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  let result = '', width = 0;
  for (const char of clean) {
    const size = char.codePointAt(0)! > 255 ? 2 : 1;
    if (width + size > budget) return result + '…';
    result += char; width += size;
  }
  return result;
}
export async function withProgress<T>(message: string, task: () => Promise<T>): Promise<T> {
  if (active) return task();
  const stream = process.stderr;
  const interactive = stream.isTTY === true && process.stdout.isTTY === true && process.env.TERM !== 'dumb' && !process.env.CI;
  const heading = label(message, 180);
  let phase = heading, frame = 0, finished = false;
  // lock, stopped, visible: coordinate raw worker writes with durable main-thread logs.
  const state = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  let worker: Worker | undefined;
  const lock = () => { while (Atomics.compareExchange(state, 0, 0, 1) !== 0) Atomics.wait(state, 0, 1); };
  const unlock = () => { Atomics.store(state, 0, 0); Atomics.notify(state, 0); };
  let timer: ReturnType<typeof setInterval> | undefined;
  const restorers: Array<() => void> = [];
  const clear = () => { if (Atomics.load(state, 2)) { stream.write('\r\x1b[2K'); Atomics.store(state, 2, 0); } };
  const draw = () => {
    if (finished || !interactive) return;
    lock();
    try {
      clear();
      const width = Math.max(0, (stream.columns ?? 80) - 5);
      stream.write(`${cyan(frames[frame++ % frames.length])} ${label(phase, width)}`);
      Atomics.store(state, 2, 1);
    } finally { unlock(); }
  };
  const fallback = () => { if (!finished && !timer) {timer = setInterval(draw, 100); timer.unref();} };
  const updateWorker = () => {
    try {worker?.postMessage({phase, columns: stream.columns ?? 80});} catch {fallback();}
  };
  // Drawing cannot depend on the main event loop: Markdown parsing and hashing
  // are synchronous. writeSync(fd) also avoids Worker's forwarded stderr stream,
  // whose delivery would otherwise wait for the blocked parent event loop.
  const renderer = String.raw`
    const {workerData, parentPort} = require('node:worker_threads');
    const {writeSync} = require('node:fs');
    const state = new Int32Array(workerData.state), crop = ${label.toString()};
    let phase = workerData.phase, columns = workerData.columns, frame = 1;
    parentPort.on('message', value => {phase = value.phase; columns = value.columns;});
    function draw() {
      if (Atomics.load(state, 1)) return;
      while (Atomics.compareExchange(state, 0, 0, 1) !== 0) {
        Atomics.wait(state, 0, 1);
        if (Atomics.load(state, 1)) return;
      }
      try {
        if (Atomics.load(state, 1)) return;
        writeSync(workerData.fd, '\r\x1b[2K' + workerData.frames[frame++ % workerData.frames.length] + ' ' + crop(phase, Math.max(0, columns - 5)));
        Atomics.store(state, 2, 1);
      } finally {Atomics.store(state, 0, 0); Atomics.notify(state, 0);}
    }
    draw(); setInterval(draw, 100);
  `;
  // Hold the same lock while clearing and writing logs so worker frames cannot
  // land in the middle of a console line. The next worker tick redraws below it.
  if (interactive) for (const method of ['log','info','warn','error','debug'] as const) {
    const original = console[method];
    const wrapped = (...args: unknown[]) => { lock(); try {clear(); original.apply(console, args);} finally {unlock();} };
    console[method] = wrapped;
    restorers.push(() => { if (console[method] === wrapped) console[method] = original; });
  }
  const finish = (outcome: 'success' | 'failed' | 'cancelled') => {
    if (finished) return;
    finished = true;
    Atomics.store(state, 1, 1);
    if (timer) clearInterval(timer);
    lock();
    try {clear();} finally {unlock();}
    if (worker) void worker.terminate().catch(() => {});
    stream.off('resize', updateWorker);
    for (const restore of restorers) restore();
    active = undefined;
    process.off('exit', onExit); process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
    const text = `${outcome === 'success' ? '✓ 완료' : outcome === 'cancelled' ? '− 중단' : '✗ 실패'} · ${heading}`;
    stream.write((outcome === 'success' ? green : outcome === 'cancelled' ? yellow : red)(text) + '\n');
  };
  const onExit = (code: number) => finish(code === 0 ? 'success' : 'failed');
  // Restore the terminal, then retain the process's normal signal termination.
  const onInterrupt = () => { finish('cancelled'); process.kill(process.pid, 'SIGINT'); };
  const onTerminate = () => { finish('cancelled'); process.kill(process.pid, 'SIGTERM'); };
  active = { update: value => { phase = label(value, 300); updateWorker(); } };
  process.once('exit', onExit); process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
  if (interactive) {
    draw();
    stream.on('resize', updateWorker);
    await new Promise<void>(resolve => {
      try {
        worker = new Worker(renderer, {eval:true, execArgv:[], workerData:{state:state.buffer, phase, columns:stream.columns ?? 80, fd:stream.fd, frames:frames.map(cyan)}});
        worker.once('online', () => {worker?.unref(); resolve();});
        worker.on('error', () => {fallback(); resolve();});
        worker.once('exit', () => {fallback(); resolve();});
      } catch {fallback(); resolve();}
    });
  }
  else stream.write(`진행 · ${heading}\n`);
  try {
    const value = await task();
    finish(process.exitCode && Number(process.exitCode) !== 0 ? 'failed' : 'success');
    return value;
  } catch (error) { finish('failed'); throw error; }
}
