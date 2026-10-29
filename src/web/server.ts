import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { webPage } from './views/workspace.js';
import type { SyncRunner } from './sync.js';
import { createWorkspaceApi } from './workspace-api.js';

import { chooseFolder } from './folder-dialog.js';
import { readPkgVersion } from '../shared/version.js';
const execute = promisify(execFile);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function deployedUi(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))) throw new Error('--ui에는 경로·쿼리 없는 HTTPS 웹 주소를 지정하세요. 로컬 개발 주소는 HTTP도 가능합니다.');
  return url;
}
export async function startWeb(options: { start?: string; port?: number; ui?: string; pickFolder?: typeof chooseFolder; syncRunner?: SyncRunner } = {}) {
  const ui = options.ui ? deployedUi(options.ui) : undefined;
  const remoteToken = ui ? randomBytes(32).toString('hex') : undefined;
  const start = await realpath(resolve(options.start ?? homedir()));
  if (!(await stat(start)).isDirectory()) throw new Error('시작 경로가 폴더가 아닙니다.');
  const token = randomBytes(32).toString('hex');
  const previewNonce = randomBytes(24).toString('hex');
  let origin = '';
  const allowedHosts = new Set<string>();
  const assetsRoot = fileURLToPath(new URL('../../dist/web/assets/', import.meta.url));
  const api = createWorkspaceApi({start, previewNonce, syncRunner: options.syncRunner,
    pickFolder: options.pickFolder ?? chooseFolder,
    open: async path => { const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'; await execute(command, [path], {timeout: 10_000}); },
    convert: async args => {
      const source = import.meta.url.endsWith('.ts');
      const worker = fileURLToPath(new URL(source ? '../conversion/worker.ts' : '../conversion/worker.js', import.meta.url));
      return execute(process.execPath, [...(source ? process.execArgv : []), worker, ...args], {env: {...process.env, NO_COLOR:'1'}, timeout:120_000, maxBuffer:2*1024*1024});
    },
  });
  const server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${previewNonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; font-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    const remote = !!req.headers.origin && req.headers.origin === ui?.origin;
    if (!req.headers.host || !allowedHosts.has(req.headers.host)
      || (req.headers.origin && !remote && req.headers.origin !== `http://${req.headers.host}`)) {
      json(403, { error: '이 웹 화면에서만 요청할 수 있습니다.' }); return;
    }
    if (remote) {
      res.setHeader('Access-Control-Allow-Origin', ui!.origin);
      res.setHeader('Vary', 'Origin');
      if (!req.url?.startsWith('/api/')) { json(403, {error:'로컬 API만 연결할 수 있습니다.'}); return; }
      if (req.method === 'OPTIONS') {
        const headers = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
        if (!['GET','POST'].includes(String(req.headers['access-control-request-method'])) || headers.some(h=>!['x-csync-token','content-type'].includes(h))) { json(403, {error:'허용되지 않은 연결 요청입니다.'}); return; }
        res.setHeader('Access-Control-Allow-Methods','GET, POST');
        res.setHeader('Access-Control-Allow-Headers','X-Csync-Token, Content-Type');
        if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network','true');
        res.writeHead(204); res.end(); return;
      }
      if (req.headers['x-csync-token'] !== remoteToken) { json(403, {error:'로컬 실행기 연결이 만료되었습니다. 실행기의 연결 링크로 다시 연결하세요.'}); return; }
    }
    try {
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(webPage(token)); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const path = resolve(assetsRoot, decodeURIComponent(url.pathname.slice('/assets/'.length)));
        if (!path.startsWith(assetsRoot)) { json(403, { error: '잘못된 파일 경로입니다.' }); return; }
        const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
        if (!types[extname(path)]) { json(404, { error: '없는 파일입니다.' }); return; }
        res.setHeader('Content-Type', types[extname(path)]);
        res.end(await readFile(path)); return;
      }
      if (!remote && req.headers['x-csync-token'] !== token) { json(403, { error: '페이지를 새로고침해 주세요.' }); return; }
      if (req.method === 'GET' && url.pathname === '/api/connection') { json(200, {version:readPkgVersion(), mode:remote?'connector':'local'}); return; }
      let body;
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) { json(415, {error: 'JSON 요청이 필요합니다.'}); return; }
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16_384) { json(413, {error:'요청이 너무 큽니다.'}); return; } }
        body = JSON.parse(raw);
      }
      const response = await api.request(req.method ?? 'GET', url, body);
      json(response.status, response.body);
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
      for (const host of ['127.0.0.1', 'localhost', '[::1]']) allowedHosts.add(new URL(`http://${host}:${address.port}`).host);
      done();
    });
  });
  // localhost may resolve to ::1 first. Bind both loopback addresses, never all interfaces.
  const ipv6 = createServer((req, res) => { server.emit('request', req, res); });
  server.once('close', () => { ipv6.close(); ipv6.closeAllConnections(); });
  try {
    await new Promise<void>((done, reject) => {
      ipv6.once('error', reject);
      ipv6.listen({ port: Number(new URL(origin).port || 80), host: '::1', ipv6Only: true }, done);
    });
  } catch (error) {
    if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      server.close(); throw error;
    }
  }
  if (ui) ui.hash = new URLSearchParams({csyncEndpoint:origin, csyncToken:remoteToken!}).toString();
  return { server, url: origin, token, isRunning:api.isRunning, connectUrl:ui?.href };
}

export async function runWeb(argv: string[]) {
  if(argv.includes('--hosted')){const {runHostedWeb}=await import('./hosted.js');return runHostedWeb(argv);}
  const value = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const port = Number(value('--port') ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port는 1~65535 사이의 숫자여야 합니다.');
  const ui = value('--ui');
  if (argv.includes('--ui') && !ui) throw new Error('--ui 뒤에 배포 웹 주소를 지정하세요.');
  const { url, server, connectUrl } = await startWeb({ start: value('--base'), port, ui });
  console.log(`문서 웹: ${url}\n로컬 주소: ${url.replace('127.0.0.1', 'localhost')}\n종료: Ctrl+C`);
  if (connectUrl) console.log(`배포 웹 연결: ${connectUrl}\n이 웹에 로컬 파일 작업 권한을 부여합니다. 연결 링크는 공유하지 마세요. csync 종료 시 연결 권한도 만료됩니다.`);
  if (!argv.includes('--no-open')) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const child = spawn(command, [connectUrl ?? url], { stdio: 'ignore' });
    child.on('error', () => console.log('브라우저 자동 열기에 실패했습니다. 위 주소로 접속해 주세요.'));
    child.unref();
  }
  await new Promise<void>(done => server.once('close', done));
}
