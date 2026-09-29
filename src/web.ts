import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readdir, realpath, stat, readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join, relative, extname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { collectMarkdown } from './docs.js';
import { webPage } from './web-ui.js';
import { createWebSync, type SyncRunner } from './web-sync.js';

import { chooseFolder } from './folder-dialog.js';
import { within, canonical, publishOutput } from './web-output.js';
const execute = promisify(execFile);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function startWeb(options: { start?: string; port?: number; pickFolder?: typeof chooseFolder; syncRunner?: SyncRunner } = {}) {
  const start = await realpath(resolve(options.start ?? homedir()));
  if (!(await stat(start)).isDirectory()) throw new Error('시작 경로가 폴더가 아닙니다.');
  const token = randomBytes(32).toString('hex');
  let origin = '';
  let busy = false;
  let picking = false;
  const assetsRoot = fileURLToPath(new URL('../dist/web/', import.meta.url));
  const results = new Set<string>();
  const sync = createWebSync(options.syncRunner);
  const server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
      json(403, { error: '이 웹 화면에서만 요청할 수 있습니다.' }); return;
    }
    try {
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(webPage(token)); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const path = resolve(assetsRoot, decodeURIComponent(url.pathname.slice('/assets/'.length)));
        if (!within(assetsRoot, path)) { json(403, { error: '잘못된 파일 경로입니다.' }); return; }
        const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };
        if (!types[extname(path)]) { json(404, { error: '없는 파일입니다.' }); return; }
        res.setHeader('Content-Type', types[extname(path)]);
        res.end(await readFile(path)); return;
      }
      if (req.headers['x-csync-token'] !== token) { json(403, { error: '페이지를 새로고침해 주세요.' }); return; }
      if (req.method === 'GET' && url.pathname === '/api/sync/job') { json(200, { job: sync.current() }); return; }
      if (req.method === 'GET' && url.pathname === '/api/browse') {
        const path = await realpath(url.searchParams.get('path') || start);
        const entries = (await readdir(path, { withFileTypes: true }))
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && (e.isDirectory() || (e.isFile() && /\.md$/i.test(e.name))))
          .map(e => ({ name: e.name, path: join(path, e.name), directory: e.isDirectory() }))
          .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'ko'));
        json(200, { path, parent: dirname(path), home: homedir(), entries }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/search') {
        const root = await realpath(url.searchParams.get('path') || start);
        const query = (url.searchParams.get('q') || '').trim().normalize('NFC').toLocaleLowerCase();
        if (!(await stat(root)).isDirectory()) throw new Error('검색 기준 폴더를 확인해 주세요.');
        const entries: { name: string; path: string; relativePath: string; directory: false }[] = [];
        let skipped = 0;
        const pending = query ? [root] : [];
        while (pending.length) {
          if (res.destroyed) return;
          const dir = pending.pop()!;
          let children;
          try { children = await readdir(dir, { withFileTypes: true }); }
          catch (error) {
            if (dir === root) throw error;
            skipped++; continue;
          }
          for (const entry of children) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const path = join(dir, entry.name);
            // Do not follow symlinks: avoid cycles and paths outside the selected tree.
            if (entry.isDirectory()) pending.push(path);
            else if (entry.isFile() && /\.md$/i.test(entry.name)
              && entry.name.normalize('NFC').toLocaleLowerCase().includes(query)) {
              entries.push({ name: entry.name, path, relativePath: relative(root, path), directory: false });
            }
          }
        }
        entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'ko'));
        json(200, { root, entries, skipped }); return;
      }
      if (req.method !== 'POST' || !['/api/convert', '/api/open', '/api/pick-folder', '/api/sync/config', '/api/sync/preview', '/api/sync/push'].includes(url.pathname)) {
        json(404, { error: '없는 요청입니다.' }); return;
      }
      if (!req.headers['content-type']?.startsWith('application/json')) { json(415, { error: 'JSON 요청이 필요합니다.' }); return; }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 16_384) { json(413, { error: '요청이 너무 큽니다.' }); return; }
      }
      const body = JSON.parse(raw);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('요청 내용을 확인해 주세요.');
      if (url.pathname === '/api/sync/config') {
        if (typeof body.base !== 'string' || typeof body.envFile !== 'string') throw new Error('설정 경로를 확인해 주세요.');
        json(200, await sync.config(body.base, body.envFile)); return;
      }
      if (url.pathname === '/api/sync/preview' || url.pathname === '/api/sync/push') {
        if (busy || sync.running()) { json(409, { error: '다른 작업이 진행 중입니다. 완료 후 다시 시도해 주세요.' }); return; }
        const job = url.pathname.endsWith('/preview') ? await sync.preview(body) : await sync.push(body.planId);
        json(202, { job }); return;
      }
      if (url.pathname === '/api/pick-folder') {
        if (picking) { json(409, { error: '이미 열린 폴더 다이얼로그를 먼저 닫아 주세요.' }); return; }
        if (body.kind !== 'base' && body.kind !== 'out') throw new Error('폴더 선택 용도를 확인해 주세요.');
        let initial = start;
        if (typeof body.start === 'string' && body.start) {
          try { const path = await realpath(body.start); if ((await stat(path)).isDirectory()) initial = path; } catch { /* Use initial folder for new paths. */ }
        }
        if (picking) { json(409, { error: '이미 열린 폴더 다이얼로그를 먼저 닫아 주세요.' }); return; }
        picking = true;
        try {
          const selected = await (options.pickFolder ?? chooseFolder)(initial, body.kind === 'base' ? '문서의 기준 폴더 선택' : '변환 결과를 저장할 출력 폴더 선택');
          const path = selected ? await realpath(selected) : null;
          if (path && !(await stat(path)).isDirectory()) throw new Error('폴더를 선택해 주세요.');
          json(200, { path });
        } finally { picking = false; }
        return;
      }
      if (url.pathname === '/api/open') {
        if (typeof body.path !== 'string' || !results.has(body.path)) throw new Error('이번 실행에서 저장한 결과만 열 수 있습니다.');
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
        await execute(command, [body.path], { timeout: 10_000 });
        json(200, { ok: true }); return;
      }
      if (busy || sync.running()) { json(409, { error: '다른 작업이 진행 중입니다. 완료 후 다시 시도해 주세요.' }); return; }
      if (typeof body.base !== 'string' || typeof body.file !== 'string'
        || !['markdown', 'obsidian', 'repair'].includes(body.to)
        || typeof body.fix !== 'boolean' || typeof body.preview !== 'boolean') throw new Error('변환 옵션을 확인해 주세요.');
      const browseBase = await realpath(body.base);
      const file = await realpath(body.file);
      const scope = body.scope ?? 'legacy';
      if (!['file', 'folder', 'legacy'].includes(scope)) throw new Error('파일 또는 폴더를 선택해 주세요.');
      const info = await stat(file);
      if (!(await stat(browseBase)).isDirectory() || !within(browseBase, file)
        || (scope === 'folder' ? !info.isDirectory() : !info.isFile() || !/\.md$/i.test(file))) {
        throw new Error('탐색 폴더 안의 Markdown 파일 또는 폴더를 선택해 주세요.');
      }
      const components = relative(browseBase, file).split(/[\\/]/);
      if ((scope === 'folder' ? components : components.slice(0, -1)).some(p => p.startsWith('.') || p === 'node_modules')) {
        throw new Error('숨김 폴더와 node_modules 안의 문서는 변환 대상이 아닙니다.');
      }
      const base = scope === 'legacy' ? browseBase : scope === 'folder' ? file : dirname(file);
      if (dirname(base) === base) throw new Error('문서가 있는 하위 폴더를 선택해 주세요.');
      const documents = scope === 'folder' ? collectMarkdown(file) : [file];
      if (!documents.length) throw new Error('선택한 폴더에 변환할 Markdown 문서가 없습니다.');
      if (body.out !== undefined && typeof body.out !== 'string') throw new Error('출력 경로를 확인해 주세요.');
      const requestedOut = body.out?.trim() ? await canonical(resolve(body.out.trim())) : null;
      if (requestedOut && (within(base, requestedOut) || within(requestedOut, base))) {
        throw new Error('출력 폴더는 기준 폴더와 겹치지 않는 별도 경로로 지정해 주세요.');
      }
      // Validation above awaits filesystem reads; another request may have acquired the slot.
      if (busy || sync.running()) { json(409, { error: '다른 작업이 진행 중입니다. 완료 후 다시 시도해 주세요.' }); return; }
      busy = true;
      let out: string | undefined;
      let destination: string | null = null;
      let generatedDestination = false;
      let response: unknown;
      try {
        out = await mkdtemp(join(tmpdir(), 'csync-preview-'));
        const args = ['--base', base, file, '--out', out];
        if (body.to !== 'repair') args.push('--to', body.to);
        if (body.fix || body.to === 'repair') args.push('--fix');
        const fromSource = import.meta.url.endsWith('.ts');
        const worker = fileURLToPath(new URL(fromSource ? './convert-worker.ts' : './convert-worker.js', import.meta.url));
        const { stdout } = await execute(process.execPath, [...(fromSource ? process.execArgv : []), worker, ...args], {
          env: { ...process.env, NO_COLOR: '1' }, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
        });
        const readPreview = async (path: string) => {
          if ((await stat(path)).size > 200_000) return '문서가 200KB를 넘어 본문 미리보기를 생략합니다.';
          return readFile(path, 'utf8');
        };
        const previews = await Promise.all(documents.slice(0, 20).map(async path => ({
          path: relative(base, path), before: await readPreview(path), after: await readPreview(join(out!, relative(base, path))),
        })));
        const { before, after } = previews[0];
        if (!body.preview) {
          destination = requestedOut ?? await mkdtemp(join(dirname(base), `${basename(base)}-converted-`));
          generatedDestination = !requestedOut;
          await publishOutput(out, destination);
          results.add(destination);
        }
        response = { before, after, previews, documentCount: documents.length, log: stdout.split(out).join(destination ?? '(미리보기)'), output: destination };
      } catch (error) {
        if (destination && generatedDestination) await rm(destination, { recursive: true, force: true });
        const failure = error as Error & { stderr?: string; killed?: boolean };
        throw new Error(failure.killed ? '변환 시간이 2분을 초과했습니다.' : failure.stderr?.trim() || message(error));
      } finally {
        try { if (out) await rm(out, { recursive: true, force: true }); }
        finally { busy = false; }
      }
      json(200, response);
    } catch (error) {
      if (!res.writableEnded) json(400, { error: message(error) });
    }
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4318, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('서버 주소를 찾지 못했습니다.')); return; }
      origin = `http://127.0.0.1:${address.port}`;
      done();
    });
  });
  return { server, url: origin };
}

export async function runWeb(argv: string[]) {
  const value = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const port = Number(value('--port') ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port는 1~65535 사이의 숫자여야 합니다.');
  const { url, server } = await startWeb({ start: value('--base'), port });
  console.log(`문서 웹: ${url}\n종료: Ctrl+C`);
  if (!argv.includes('--no-open')) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const child = spawn(command, [url], { stdio: 'ignore' });
    child.on('error', () => console.log(`브라우저에서 ${url} 을 열어 주세요.`));
    child.unref();
  }
  await new Promise<void>(done => server.once('close', done));
}
