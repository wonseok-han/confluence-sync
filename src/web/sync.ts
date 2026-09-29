import { referenceRoots } from '../sync/references.js';
/** Web adapter for the existing push CLI. Only preview and incremental push are exposed. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, stat, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { within } from './output.js';
import { collectMarkdown, resolveSelection } from '../documents/catalog.js';
import { buildIgnorer } from '../sync/ignore.js';

const keys = ['CONFLUENCE_BASE_URL', 'CONFLUENCE_EMAIL', 'CONFLUENCE_API_TOKEN', 'CONFLUENCE_SPACE_KEY', 'CONFLUENCE_PARENT_ID', 'CONFLUENCE_PARENT_PAGE_ID'] as const;
type Settings = Record<string, string>;
type Selection = { base: string; target: string; envFile: string; verify: boolean; referenceRoots: string[] };
type Prepared = { selection: Selection; env: Settings; config: ReturnType<typeof publicConfig>; fingerprint: string };
export type SyncRunner = (args: string[], env: Settings, log: (text: string) => void) => Promise<number>;
type Job = { id: string; kind: 'preview' | 'push'; state: 'running' | 'succeeded' | 'failed'; log: string; selection: Selection; config: ReturnType<typeof publicConfig>; planId: string | null; startedAt: string; finishedAt?: string };

async function settings(base: string, envFile: string) {
  let source = envFile ? resolve(envFile) : join(base, '.env');
  let values: NodeJS.ProcessEnv | Settings;
  try { source = await realpath(source); values = parse(await readFile(source)); }
  catch (error) {
    if (envFile || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('.env 파일을 읽을 수 없습니다. 경로와 권한을 확인해 주세요.');
    source = '웹 서버 실행 환경 (.env / 환경변수)'; values = process.env;
  }
  const env: Settings = {};
  for (const key of keys) env[key] = values[key]?.trim() ?? '';
  env.CONFLUENCE_PARENT_ID ||= env.CONFLUENCE_PARENT_PAGE_ID;
  return { env, source };
}
function publicConfig(env: Settings, source: string) {
  return { source, baseUrl: env.CONFLUENCE_BASE_URL, email: env.CONFLUENCE_EMAIL,
    spaceKey: env.CONFLUENCE_SPACE_KEY, parentId: env.CONFLUENCE_PARENT_ID,
    hasToken: !!env.CONFLUENCE_API_TOKEN,
    missing: keys.slice(0, 4).filter(key => !env[key]) };
}
// The preview is invalidated if documents, attachments, mapping, ignore rules or credentials change.
async function fingerprint(base: string, env: Settings) {
  const hash = createHash('sha256').update(JSON.stringify(env));
  const walk = async (dir: string) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules' || (entry.name.startsWith('.') && !['.confluence-sync.json', '.confluence-syncignore'].includes(entry.name))) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        hash.update(JSON.stringify([relative(base, path), info.size, info.mtimeMs, info.ctimeMs]));
        if (/\.md$/i.test(path) || entry.name.startsWith('.')) hash.update(await readFile(path));
      }
    }
  };
  await walk(base);
  return hash.digest('hex');
}
async function prepare(input: unknown): Promise<Prepared> {
  const body = input as Partial<Selection>;
  if (!body || typeof body.base !== 'string' || typeof body.target !== 'string'
    || typeof body.envFile !== 'string' || typeof body.verify !== 'boolean') throw new Error('동기화 옵션을 확인해 주세요.');
  const base = await realpath(resolve(body.base));
  if (dirname(base) === base || !(await stat(base)).isDirectory()) throw new Error('문서의 기준 폴더를 선택해 주세요.');
  if (body.referenceRoots !== undefined && (!Array.isArray(body.referenceRoots) || body.referenceRoots.some(value => typeof value !== 'string' || !value.trim()))) throw new Error('참조 폴더 목록을 확인해 주세요.');
  const refs = referenceRoots(base, body.referenceRoots ?? []);
  const target = body.target ? await realpath(resolve(body.target)) : base;
  if (!within(base, target)) throw new Error('동기화 대상은 기준 폴더 안에 있어야 합니다.');
  const ignorer = buildIgnorer(base, []);
  const docs = collectMarkdown(base).map(path => relative(base, path).split('\\').join('/')).filter(path => !ignorer.ignores(path));
  const picked = target === base ? docs : resolveSelection(docs, [target], base);
  if (!picked.length) throw new Error('동기화할 Markdown 문서가 없습니다. 선택 범위와 .confluence-syncignore를 확인해 주세요.');
  // A damaged mapping must not silently turn a whole document set into new pages.
  const mappingPath = join(base, '.confluence-sync.json');
  try {
    if (!(await lstat(mappingPath)).isFile()) throw new Error('invalid mapping');
    const mapping = JSON.parse(await readFile(mappingPath, 'utf8'));
    if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object'
      || Object.values(mapping).some(value => !value || typeof value !== 'object' || typeof (value as { pageId?: unknown }).pageId !== 'string')) throw new Error('invalid mapping');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('.confluence-sync.json 매핑 파일이 올바르지 않습니다. 기존 매핑을 확인해 주세요.');
  }
  const { env, source } = await settings(base, body.envFile);
  const selection = { base, target: target === base ? '' : target, envFile: body.envFile, verify: body.verify, referenceRoots: refs };
  const snapshots = await Promise.all([base, ...refs].map(async root => {
    const config = await readFile(join(root, '.env'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; throw error;
    });
    return [root, await fingerprint(root, env), createHash('sha256').update(config).digest('hex')];
  }));
  return { selection, env, config: publicConfig(env, source), fingerprint: JSON.stringify(snapshots) };
}

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

export function createWebSync(runner: SyncRunner = runSyncCLI) {
  let job: Job | null = null;
  let plan: { id: string; prepared: Prepared } | null = null;
  let locked = false;
  const running = () => locked || job?.state === 'running';
  const launch = (kind: Job['kind'], prepared: Prepared) => {
    const current: Job = { id: randomUUID(), kind, state: 'running', log: '', selection: prepared.selection, config: prepared.config, planId: null, startedAt: new Date().toISOString() };
    job = current; plan = null;
    const { base, target, verify } = prepared.selection;
    const args = ['--base', base];
    for (const root of prepared.selection.referenceRoots) args.push('--reference-root', root);
    if (target) args.push(target);
    if (kind === 'preview') args.push('--dry-run');
    else if (verify) args.push('--verify');
    let reportedFailure = false;
    const secrets = [prepared.env.CONFLUENCE_API_TOKEN, Buffer.from(`${prepared.env.CONFLUENCE_EMAIL}:${prepared.env.CONFLUENCE_API_TOKEN}`).toString('base64')].filter(Boolean);
    const log = (text: string) => {
      if (text.includes('✗') || text.includes('⚠ 이미지 없음')) reportedFailure = true; // CLI reports per-document / attachment failures without exiting.
      for (const secret of secrets) text = text.split(secret).join('[비공개]');
      current.log = (current.log + text).slice(-512_000);
    };
    void (async () => {
      try {
        const code = await runner(args, prepared.env, log);
        const succeeded = code === 0 && !reportedFailure;
        if (!succeeded) log('\n일부 작업이 실패했을 수 있습니다. 위 내역을 확인하고 다시 미리보기해 주세요.\n');
        if (kind === 'preview' && succeeded) {
          const updated = await prepare(prepared.selection);
          if (updated.fingerprint !== prepared.fingerprint) throw new Error('미리보기 중 문서나 설정이 바뀌었습니다. 다시 미리보기해 주세요.');
          plan = { id: randomUUID(), prepared }; current.planId = plan.id;
        }
        current.state = succeeded ? 'succeeded' : 'failed';
      } catch (error) { current.state = 'failed'; log((error instanceof Error ? error.message : String(error)) + '\n'); }
      finally { current.finishedAt = new Date().toISOString(); }
    })();
    return current;
  };
  return {
    running,
    current: () => job,
    config: async (base: string, envFile: string) => {
      const resolved = await realpath(resolve(base));
      const { env, source } = await settings(resolved, envFile);
      return publicConfig(env, source);
    },
    preview: async (input: unknown) => {
      if (running()) throw new Error('동기화 작업이 진행 중입니다.');
      locked = true; plan = null;
      try { return launch('preview', await prepare(input)); }
      finally { locked = false; }
    },
    push: async (id: unknown) => {
      if (running()) throw new Error('동기화 작업이 진행 중입니다.');
      if (typeof id !== 'string' || !plan || plan.id !== id) throw new Error('먼저 동기화 대상을 미리보기해 주세요.');
      locked = true;
      const approved = plan; plan = null;
      try {
        const updated = await prepare(approved.prepared.selection);
        if (updated.fingerprint !== approved.prepared.fingerprint) throw new Error('문서나 설정이 변경되었습니다. 다시 미리보기해 주세요.');
        if (updated.config.missing.length) throw new Error(`설정 누락: ${updated.config.missing.join(', ')}`);
        const url = new URL(updated.env.CONFLUENCE_BASE_URL);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Confluence BASE_URL은 인증정보·쿼리가 없는 HTTPS 주소여야 합니다.');
        return launch('push', updated);
      } finally { locked = false; }
    },
  };
}
