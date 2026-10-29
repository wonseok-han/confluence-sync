/** Transport-independent workspace routes, shared by the Node server and browser worker. */
import { randomBytes, createHash } from 'node:crypto';
import { readdir, realpath, stat, lstat, readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join, relative } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { collectMarkdown } from '../documents/catalog.js';
import { createWebSync, type SyncRunner, type Imported } from './sync.js';
import { previewDocument } from './preview.js';
import { createTableFormatting } from './table-format.js';
import { within, canonical, publishOutput, OverwriteRequired } from './output.js';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createWorkspaceApi(options: {
  start: string; previewNonce?: string; syncRunner?: SyncRunner;
  connectionImports?: [string, Imported][];
  convert: (args: string[]) => Promise<{stdout: string}>;
  open: (path: string) => Promise<void>;
  pickFolder: (start: string, label: string) => Promise<string | null>;
}) {
  const start = options.start, previewNonce = options.previewNonce ?? randomBytes(24).toString('hex');
  const tableFormatting = createTableFormatting();
  const sync = createWebSync(options.syncRunner, options.connectionImports);
  const results = new Set<string>();
  let busy: string | null = null, picking = false;
  const conflictMessage = () => {
    if (busy) return `${busy} 작업이 진행 중입니다. 완료 후 다시 시도해 주세요.`;
    const job = sync.current();
    const name = job?.state === 'running' ? {restore:'문서 복구',pull:'가져오기(Pull)',push:'업로드(Push)',preview:'업로드 미리보기',fetch:'원격 변경 확인'}[job.kind] : 'Confluence 요청 처리';
    return `${name} 작업이 진행 중입니다. 완료 후 다시 시도해 주세요.`;
  };
  return {
    connectionImports: sync.connectionImports,
    isRunning: () => Boolean(busy || sync.running()),
    async request(method: string, url: URL, body?: any) {
      let response: {status: number; body: any} = {status: 404, body: {error: '없는 요청입니다.'}};
      const json = (status: number, body: any) => { response = {status, body}; };
      try { await (async () => {
      if (method === 'GET' && url.pathname === '/api/sync/job') { json(200, { job: sync.current() }); return; }
      if (method === 'GET' && url.pathname === '/api/browse') {
        const path = await realpath(url.searchParams.get('path') || start);
        const entries = (await readdir(path, { withFileTypes: true }))
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && !(e.isDirectory() && e.name.toLowerCase() === 'attachments') && (e.isDirectory() || (e.isFile() && /\.md$/i.test(e.name))))
          .map(e => ({ name: e.name, path: join(path, e.name), directory: e.isDirectory() }))
          .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'ko'));
        json(200, { path, parent: dirname(path), home: homedir(), entries }); return;
      }
      if (method === 'GET' && url.pathname === '/api/search') {
        const root = await realpath(url.searchParams.get('path') || start);
        const query = (url.searchParams.get('q') || '').trim().normalize('NFC').toLocaleLowerCase();
        if (!(await stat(root)).isDirectory()) throw new Error('검색 기준 폴더를 확인해 주세요.');
        const entries: { name: string; path: string; relativePath: string; directory: false }[] = [];
        let skipped = 0;
        const pending = query ? [root] : [];
        while (pending.length) {

          const dir = pending.pop()!;
          let children;
          try { children = await readdir(dir, { withFileTypes: true }); }
          catch (error) {
            if (dir === root) throw error;
            skipped++; continue;
          }
          for (const entry of children) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || (entry.isDirectory() && entry.name.toLowerCase() === 'attachments')) continue;
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
      if (method !== 'POST' || !['/api/document-format/preview', '/api/table-format/preview', '/api/table-format/save', '/api/document-preview', '/api/convert', '/api/open', '/api/pick-folder', '/api/sync/diff', '/api/sync/staging', '/api/sync/config', '/api/sync/env/import', '/api/sync/env/save', '/api/sync/connect', '/api/sync/preview', '/api/sync/push', '/api/sync/pull', '/api/sync/fetch', '/api/sync/restore'].includes(url.pathname)) {
        json(404, { error: '없는 요청입니다.' }); return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('요청 내용을 확인해 주세요.');
      if (url.pathname === '/api/document-preview') {
        if (typeof body.base !== 'string' || typeof body.file !== 'string') throw new Error('문서 경로를 확인해 주세요.');
        json(200, await previewDocument(body.base, body.file, previewNonce)); return;
      }
      if (url.pathname === '/api/document-format/preview') {
        if (busy || sync.running()) { json(409, { error: conflictMessage() }); return; }
        if (typeof body.base !== 'string' || typeof body.file !== 'string' || typeof body.hash !== 'string') throw new Error('문서 서식 요청을 확인해 주세요.');
        json(200, await tableFormatting.documentPreview(body.base, body.file, body.hash, body.basic, body.tables, body.changes)); return;
      }
      if (url.pathname.startsWith('/api/table-format/')) {
        if (busy || sync.running()) { json(409, { error: conflictMessage() }); return; }
        if (url.pathname.endsWith('/preview')) {
          if (typeof body.base !== 'string' || typeof body.file !== 'string' || typeof body.hash !== 'string'
            || !Number.isInteger(body.index) || !Array.isArray(body.widths)) throw new Error('표 서식 요청을 확인해 주세요.');
          json(200, await tableFormatting.preview(body.base, body.file, body.hash, body.index, body.widths, body.changes));
        } else {
          if (typeof body.planId !== 'string') throw new Error('변경 비교를 먼저 실행해 주세요.');
          busy = '표 서식 저장';
          try { json(200, await tableFormatting.save(body.planId)); }
          finally { busy = null; }
        }
        return;
      }
      if (url.pathname === '/api/sync/connect') {
        if (busy || sync.running()) { json(409, { error: conflictMessage() }); return; }
        busy = '스페이스 연결 저장';
        try { json(200, await sync.connect(body)); }
        finally { busy = null; }
        return;
      }
      if (url.pathname === '/api/sync/env/import' || url.pathname === '/api/sync/env/save') {
        if (busy || sync.running()) { json(409, { error: conflictMessage() }); return; }
        busy = url.pathname.endsWith('/import') ? '.env 가져오기' : '.env 저장';
        try { json(200, url.pathname.endsWith('/import') ? await sync.importEnv(body) : await sync.saveEnv(body)); }
        finally { busy = null; }
        return;
      }
      if (url.pathname === '/api/sync/diff') {
        if (busy || sync.running()) { json(409, { error: conflictMessage() }); return; }
        json(200, await sync.diff(body)); return;
      }
      if (url.pathname === '/api/sync/restore') {
        if (busy || sync.running()) { json(409, { error: conflictMessage() }); return; }
        const result = await sync.restore(body); json('job' in result ? 202 : 200,result); return;
      }
      if (url.pathname === '/api/sync/staging') {
        if (busy || sync.running()) { json(409, { error: conflictMessage() }); return; }
        json(200, await sync.staging(body)); return;
      }
      if (url.pathname === '/api/sync/config') {
        if (typeof body.base !== 'string' || typeof body.envId !== 'string') throw new Error('설정 경로를 확인해 주세요.');
        json(200, await sync.config(body.base, body.envId)); return;
      }
      if (url.pathname === '/api/sync/preview' || url.pathname === '/api/sync/push' || url.pathname === '/api/sync/pull' || url.pathname === '/api/sync/fetch') {
        if (busy || sync.running()) { json(409, { error: conflictMessage() }); return; }
        const job = url.pathname.endsWith('/preview') ? await sync.preview(body) : url.pathname.endsWith('/pull') ? await sync.pull(body) : url.pathname.endsWith('/fetch') ? await sync.fetch(body) : await sync.push(body.planId);
        json(202, { job }); return;
      }
      if (url.pathname === '/api/pick-folder') {
        if (picking) { json(409, { error: '이미 열린 폴더 다이얼로그를 먼저 닫아 주세요.' }); return; }
        if (body.kind !== 'base' && body.kind !== 'out' && body.kind !== 'reference') throw new Error('폴더 선택 용도를 확인해 주세요.');
        let initial = start;
        if (typeof body.start === 'string' && body.start) {
          try { const path = await realpath(body.start); if ((await stat(path)).isDirectory()) initial = path; } catch { /* Use initial folder for new paths. */ }
        }
        if (picking) { json(409, { error: '이미 열린 폴더 다이얼로그를 먼저 닫아 주세요.' }); return; }
        picking = true;
        try {
          const selected = await options.pickFolder(initial, body.kind === 'reference' ? '참조 문서의 동기화 폴더 선택' : body.kind === 'base' ? '문서의 기준 폴더 선택' : '변환 결과를 저장할 출력 폴더 선택');
          const path = selected ? await realpath(selected) : null;
          if (path && !(await stat(path)).isDirectory()) throw new Error('폴더를 선택해 주세요.');
          json(200, { path });
        } finally { picking = false; }
        return;
      }
      if (url.pathname === '/api/open') {
        if (typeof body.path !== 'string' || !results.has(body.path)) throw new Error('이번 실행에서 저장한 결과만 열 수 있습니다.');
        await options.open(body.path);
        json(200, { ok: true }); return;
      }
      if (busy || sync.running()) { json(409, { error: conflictMessage() }); return; }
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
      const approved = body.approvedOverwrites ?? {};
      if (!approved || typeof approved !== 'object' || Array.isArray(approved)
        || Object.values(approved).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw new Error('덮어쓰기 확인 정보를 확인해 주세요.');
      const requestedOut = body.out?.trim() ? await canonical(resolve(body.out.trim())) : null;
      const inPlace = requestedOut !== null && (requestedOut === browseBase || requestedOut === base);
      const effectiveOut = inPlace ? base : requestedOut;
      if (requestedOut && !inPlace && (within(base, requestedOut) || within(requestedOut, base))) {
        throw new Error('출력 폴더는 기준 폴더와 겹치지 않는 별도 경로로 지정해 주세요.');
      }
      // Validation above awaits filesystem reads; another request may have acquired the slot.
      if (busy || sync.running()) { json(409, { error: conflictMessage() }); return; }
      busy = '문서 변환';
      let out: string | undefined;
      let destination: string | null = null;
      let generatedDestination = false;
      let response: unknown;
      let responseStatus = 200;
      let saved: Awaited<ReturnType<typeof publishOutput>> | undefined;
      const verifySourceApproval = async () => {
        if (!inPlace) return;
        for (const [rel, hash] of Object.entries(approved)) {
          const path = resolve(base, rel);
          if (!within(base, path)) throw new Error('덮어쓰기 확인 경로를 확인하세요.');
          try {
            const info = await lstat(path);
            if (info.isFile() && !info.isSymbolicLink() && createHash('sha256').update(await readFile(path)).digest('hex') === hash) continue;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          throw Object.assign(new Error(`확인 이후 원본 파일이 변경되었거나 삭제되었습니다: ${rel}. 미리보기부터 다시 진행하세요.`), { code: 'SOURCE_CHANGED' });
        }
      };
      try {
        await verifySourceApproval();
        out = await mkdtemp(join(tmpdir(), 'csync-preview-'));
        const args = ['--base', base, file, '--out', out];
        if (body.to !== 'repair') args.push('--to', body.to);
        if (body.fix || body.to === 'repair') args.push('--fix');
        const { stdout } = await options.convert(args);
        const readPreview = async (path: string) => {
          if ((await stat(path)).size > 200_000) return '문서가 200KB를 넘어 본문 미리보기를 생략합니다.';
          return readFile(path, 'utf8');
        };
        const previews = await Promise.all(documents.slice(0, 20).map(async path => ({
          path: relative(base, path), before: await readPreview(path), after: await readPreview(join(out!, relative(base, path))),
        })));
        const { before, after } = previews[0];
        if (!body.preview) {
          await verifySourceApproval();
          destination = effectiveOut ?? await mkdtemp(join(dirname(base), `${basename(base)}-converted-`));
          generatedDestination = !effectiveOut;
          saved = await publishOutput(out, destination, approved);
          results.add(destination);
        }
        response = { before, after, previews, saved, inPlace, documentCount: documents.length, log: stdout.split(out).join(destination ?? '(미리보기)'), output: destination };
      } catch (error) {
        if (destination && generatedDestination) await rm(destination, { recursive: true, force: true });
        if ((error as {code?:string}).code === 'SOURCE_CHANGED') {
          responseStatus = 409;
          response = { error: message(error), code: 'SOURCE_CHANGED' };
        } else if (error instanceof OverwriteRequired) {
          responseStatus = 409;
          const stale = inPlace && error.conflicts.some(item => approved[item.path] && approved[item.path] !== item.hash);
          response = stale ? { error: '확인 이후 원본 파일이 변경되었습니다. 미리보기부터 다시 진행하세요.', code: 'SOURCE_CHANGED' }
            : { error: error.message, code: 'OVERWRITE_REQUIRED', conflicts: error.conflicts, inPlace, output: destination };
        } else {
          const failure = error as Error & { stderr?: string; killed?: boolean };
          throw new Error(failure.killed ? '변환 시간이 2분을 초과했습니다.' : failure.stderr?.trim() || message(error));
        }
      } finally {
        try { if (out) await rm(out, { recursive: true, force: true }); }
        finally { busy = null; }
      }
      json(responseStatus, response);
      })(); } catch (error) { json(400, {error: message(error)}); }
      return response;
    },
  };
}
