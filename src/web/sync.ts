import { connectionKeys, importConnection, mergeConnection } from '../confluence/env-file.js';
import { loadWorkspace, inScope, inNestedWorkspace, requireScope, type Workspace } from '../sync/workspace.js';
import { mappingPath as defaultMappingPath, METADATA_DIR } from '../sync/metadata.js';
import { configureScope, scopeTree, ScopeReviewRequired } from '../sync/scope.js';
import type { Env } from '../confluence/config.js';
import { referenceRoots } from '../sync/references.js';
/** Web adapter for the existing push CLI. Only preview and incremental push are exposed. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, stat, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { within } from './output.js';
import { collectMarkdown } from '../documents/catalog.js';
import { buildIgnorer } from '../sync/ignore.js';

const keys = connectionKeys;
type Imported = { env: Settings; content: string; source: string };
type Imports = Map<string, Imported>;
type Settings = Record<string, string>;
type Selection = { base: string; target: string; envId: string; verify: boolean; referenceRoots: string[] };
type Prepared = { selection: Selection; env: Settings; config: ReturnType<typeof publicConfig>; fingerprint: string };
export type SyncRunner = (args: string[], env: Settings, log: (text: string) => void) => Promise<number>;
type Job = { id: string; kind: 'preview' | 'push' | 'pull'; state: 'running' | 'succeeded' | 'failed'; log: string; selection: Selection; config: ReturnType<typeof publicConfig>; planId: string | null; startedAt: string; finishedAt?: string };

async function settings(base: string, envId: string, imports: Imports) {
  if (envId) {
    const imported = imports.get(envId);
    if (!imported) throw new Error('가져온 .env 설정이 만료되었습니다. 파일을 다시 가져오세요.');
    return { env: imported.env, source: imported.source };
  }
  const source = join(base, '.env');
  let values: Settings = {};
  try { values = parse(await readFile(source)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('기준 폴더의 .env 파일을 읽을 수 없습니다.'); }
  const env: Settings = {};
  for (const key of keys) env[key] = values[key]?.trim() ?? '';
  return { env, source };
}

function publicConfig(env: Settings, source: string, workspace?: Workspace) {
  return { source, baseUrl: env.CONFLUENCE_BASE_URL, email: env.CONFLUENCE_EMAIL,
    spaceKey: env.CONFLUENCE_SPACE_KEY, scope: workspace?.version === 2 ? workspace.scope ?? null : null,
    hasToken: !!env.CONFLUENCE_API_TOKEN, scopeCheckRequired: !!workspace?.scopeCheckRequired,
    missing: keys.slice(0, 4).filter(key => !env[key]) };
}
// The preview is invalidated if documents, attachments, mapping, ignore rules or credentials change.
async function fingerprint(base: string, env: Settings) {
  const hash = createHash('sha256').update(JSON.stringify(env));
  const walk = async (dir: string) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules' || (entry.name.startsWith('.') && ![METADATA_DIR, '.confluence-sync.json', '.confluence-syncignore', '.confluence-workspace.json'].includes(entry.name))) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        hash.update(JSON.stringify([relative(base, path), info.size, info.mtimeMs, info.ctimeMs]));
        if (/\.md$/i.test(path) || entry.name.startsWith('.') || relative(base, path).split(/[\\/]/).includes(METADATA_DIR)) hash.update(await readFile(path));
      }
    }
  };
  await walk(base);
  return hash.digest('hex');
}
async function prepare(input: unknown, imports: Imports): Promise<Prepared> {
  const body = input as Partial<Selection>;
  if (!body || typeof body.base !== 'string' || typeof body.target !== 'string'
    || typeof body.envId !== 'string' || typeof body.verify !== 'boolean') throw new Error('동기화 옵션을 확인해 주세요.');
  const base = await realpath(resolve(body.base));
  if (dirname(base) === base || !(await stat(base)).isDirectory()) throw new Error('문서의 기준 폴더를 선택해 주세요.');
  if (body.referenceRoots !== undefined && (!Array.isArray(body.referenceRoots) || body.referenceRoots.some(value => typeof value !== 'string' || !value.trim()))) throw new Error('참조 폴더 목록을 확인해 주세요.');
  const refs = referenceRoots(base, body.referenceRoots ?? []);
  const target = body.target ? await realpath(resolve(body.target)) : base;
  if (!within(base, target)) throw new Error('동기화 대상은 기준 폴더 안에 있어야 합니다.');
  if (target !== base) throw new Error('웹 Push는 기준 폴더 전체를 대상으로 합니다. 개별 파일은 csync push <파일>을 사용하세요.');
  const ignorer = buildIgnorer(base, []);
  const docs = collectMarkdown(base).map(path => relative(base, path).split('\\').join('/')).filter(path => !ignorer.ignores(path));
  const workspace = loadWorkspace(base);
  requireScope(workspace);
  const picked = docs.filter(rel => inScope(rel, workspace) && !inNestedWorkspace(base, rel));
  if (!picked.length) throw new Error('동기화할 Markdown 문서가 없습니다. 선택 범위와 .csync/ignore(또는 기존 제외 파일)를 확인해 주세요.');
  // A damaged mapping must not silently turn a whole document set into new pages.
  const mappingPath = defaultMappingPath(base);
  try {
    if (!(await lstat(mappingPath)).isFile()) throw new Error('invalid mapping');
    const mapping = JSON.parse(await readFile(mappingPath, 'utf8'));
    if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object'
      || Object.values(mapping).some(value => !value || typeof value !== 'object' || typeof (value as { pageId?: unknown }).pageId !== 'string')) throw new Error('invalid mapping');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('페이지 매핑 파일이 올바르지 않습니다. .csync/mapping.json 또는 기존 매핑을 확인해 주세요.');
  }
  const { env, source } = await settings(base, body.envId, imports);
  const selection = { base, target: target === base ? '' : target, envId: body.envId, verify: body.verify, referenceRoots: refs };
  const snapshots = await Promise.all([base, ...refs].map(async root => {
    const config = await readFile(join(root, '.env'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; throw error;
    });
    return [root, await fingerprint(root, env), createHash('sha256').update(config).digest('hex')];
  }));
  return { selection, env, config: publicConfig(env, source, workspace), fingerprint: JSON.stringify(snapshots) };
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
  const imports: Imports = new Map();
  let job: Job | null = null;
  let plan: { id: string; prepared: Prepared } | null = null;
  let locked = false;
  const scopedSettings = async (input: unknown) => {
    const body = input as { base?: string; envId?: string; parentId?: string; scopeId?: string; confirmation?: string };
    if (!body || typeof body.base !== 'string' || typeof body.envId !== 'string') throw new Error('설정 경로를 확인하세요.');
    const base = await realpath(resolve(body.base));
    if (!(await stat(base)).isDirectory() || dirname(base) === base) throw new Error('로컬 기준 폴더를 선택하세요.');
    const { env } = await settings(base, body.envId, imports);
    const config: Env = { baseUrl: env.CONFLUENCE_BASE_URL, email: env.CONFLUENCE_EMAIL, token: env.CONFLUENCE_API_TOKEN, spaceKey: env.CONFLUENCE_SPACE_KEY };
    return { base, config, body };
  };
  const running = () => locked || job?.state === 'running';
  const launch = (kind: Job['kind'], prepared: Prepared) => {
    const current: Job = { id: randomUUID(), kind, state: 'running', log: '', selection: prepared.selection, config: prepared.config, planId: null, startedAt: new Date().toISOString() };
    job = current; plan = null;
    const { base, target, verify } = prepared.selection;
    const args = [kind === 'pull' ? 'pull' : 'push', '--base', base];
    for (const root of kind === 'pull' ? [] : prepared.selection.referenceRoots) args.push('--reference-root', root);
    if (target && kind !== 'pull') args.push(target);
    if (kind === 'preview') args.push('--dry-run');
    if (verify && kind !== 'pull') args.push('--verify');
    let reportedFailure = false;
    const secrets = [prepared.env.CONFLUENCE_API_TOKEN, Buffer.from(`${prepared.env.CONFLUENCE_EMAIL}:${prepared.env.CONFLUENCE_API_TOKEN}`).toString('base64')].filter(Boolean);
    const log = (text: string) => {
      if (text.includes('✗') || text.includes('⚠ 이미지 없음') || text.includes('⚠ 첨부 없음')) reportedFailure = true; // CLI reports per-document / attachment failures without exiting.
      for (const secret of secrets) text = text.split(secret).join('[비공개]');
      current.log = (current.log + text).slice(-512_000);
    };
    void (async () => {
      try {
        const code = await runner(args, prepared.env, log);
        const succeeded = code === 0 && !reportedFailure;
        if (!succeeded) log('\n일부 작업이 실패했을 수 있습니다. 위 내역을 확인하고 다시 미리보기해 주세요.\n');
        if (kind === 'preview' && succeeded) {
          const updated = await prepare(prepared.selection, imports);
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
    importEnv: async (input: unknown) => {
      if (running()) throw new Error('다른 Confluence 작업이 진행 중입니다.');
      const body = input as { base?: string; text?: string; name?: string };
      if (!body || typeof body.base !== 'string' || typeof body.text !== 'string' || typeof body.name !== 'string' || body.name.length > 255) throw new Error('.env 파일을 선택해 주세요.');
      const base = await realpath(resolve(body.base));
      if (!(await stat(base)).isDirectory() || dirname(base) === base) throw new Error('로컬 기준 폴더를 선택하세요.');
      const imported = { ...importConnection(body.text), source: `가져온 파일 · ${body.name}` };
      const envId = randomUUID(); imports.set(envId, imported); plan = null;
      if (imports.size > 20) imports.delete(imports.keys().next().value!);
      return { envId, config: publicConfig(imported.env, imported.source, loadWorkspace(base)) };
    },
    saveEnv: async (input: unknown) => {
      if (running()) throw new Error('다른 Confluence 작업이 진행 중입니다.');
      locked = true;
      let temp: string | undefined;
      try {
        const body = input as { base?: string; envId?: string; expectedHash?: string | null };
        if (!body || typeof body.base !== 'string' || typeof body.envId !== 'string') throw new Error('가져온 .env 설정을 확인하세요.');
        const imported = imports.get(body.envId);
        if (!imported || keys.some(key => !imported.env[key])) throw new Error('필수 연결 설정을 모두 포함한 .env를 가져오세요.');
        const base = await realpath(resolve(body.base));
        if (!(await stat(base)).isDirectory() || dirname(base) === base) throw new Error('로컬 기준 폴더를 선택하세요.');
        const path = join(base, '.env');
        const snapshot = async () => {
          try {
            if (!(await lstat(path)).isFile()) throw new Error('.env는 일반 파일이어야 합니다. 심볼릭 링크는 저장할 수 없습니다.');
            const content = await readFile(path, 'utf8');
            return { content, hash: createHash('sha256').update(content).digest('hex') as string | null };
          } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', hash: null }; throw error; }
        };
        const before = await snapshot();
        if (!Object.hasOwn(body, 'expectedHash')) return { needsConfirmation: before.hash !== null, expectedHash: before.hash, path };
        if (body.expectedHash !== before.hash) throw new Error('.env가 변경되었습니다. 저장을 다시 시도해 주세요.');
        temp = join(base, `.csync-env-${randomUUID()}.tmp`);
        await writeFile(temp, mergeConnection(before.content, imported.content), { mode: 0o600, flag: 'wx' });
        if ((await snapshot()).hash !== before.hash) throw new Error('.env가 변경되었습니다. 저장을 다시 시도해 주세요.');
        await rename(temp, path); temp = undefined; plan = null;
        const { env, source } = await settings(base, '', imports);
        return { saved: true, config: publicConfig(env, source, loadWorkspace(base)) };
      } finally { if (temp) await unlink(temp).catch(() => {}); locked = false; }
    },
    scopes: async (input: unknown) => {
      if (running()) throw new Error('다른 Confluence 작업이 진행 중입니다.');
      const { config, body } = await scopedSettings(input);
      if (body.parentId !== undefined && (typeof body.parentId !== 'string' || !/^\d+$/.test(body.parentId))) throw new Error('스코프 탐색 ID를 확인하세요.');
      return scopeTree(config, body.parentId);
    },
    setScope: async (input: unknown) => {
      if (running()) throw new Error('다른 Confluence 작업이 진행 중입니다.');
      locked = true; plan = null;
      try {
        const { base, config, body } = await scopedSettings(input);
        if (typeof body.scopeId !== 'string' || !/^\d+$/.test(body.scopeId)) throw new Error('스코프를 직접 선택하세요.');
        if (body.confirmation !== undefined && (typeof body.confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(body.confirmation))) throw new Error('변경 영향을 다시 확인하세요.');
        try { await configureScope(base, config, `id:${body.scopeId}`, body.confirmation); }
        catch (error) { if (error instanceof ScopeReviewRequired) return { confirmationRequired: true as const, review: error.review }; throw error; }
        const { env, source } = await settings(base, body.envId!, imports);
        return publicConfig(env, source, loadWorkspace(base));
      } finally { locked = false; }
    },
    current: () => job,
    config: async (base: string, envId: string) => {
      const resolved = await realpath(resolve(base));
      const { env, source } = await settings(resolved, envId, imports);
      return publicConfig(env, source, loadWorkspace(resolved));
    },
    pull: async (input: unknown) => {
      if (running()) throw new Error('다른 작업이 진행 중입니다.');
      locked = true; plan = null;
      try {
        const { base, config, body } = await scopedSettings(input);
        const workspace = loadWorkspace(base); requireScope(workspace);
        const { env, source } = await settings(base, body.envId!, imports);
        const visible = publicConfig(env, source, workspace);
        if (visible.missing.length) throw new Error(`설정 누락: ${visible.missing.join(', ')}`);
        const url = new URL(config.baseUrl!);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Confluence BASE_URL은 인증정보·쿼리가 없는 HTTPS 주소여야 합니다.');
        return launch('pull', { selection: { base, target: '', envId: body.envId!, verify: false, referenceRoots: [] }, env, config: visible, fingerprint: '' });
      } finally { locked = false; }
    },
    preview: async (input: unknown) => {
      if (running()) throw new Error('다른 Confluence 작업이 진행 중입니다.');
      locked = true; plan = null;
      try { return launch('preview', await prepare(input, imports)); }
      finally { locked = false; }
    },
    push: async (id: unknown) => {
      if (running()) throw new Error('다른 Confluence 작업이 진행 중입니다.');
      if (typeof id !== 'string' || !plan || plan.id !== id) throw new Error('먼저 업로드 대상을 미리보기해 주세요.');
      locked = true;
      const approved = plan; plan = null;
      try {
        const updated = await prepare(approved.prepared.selection, imports);
        if (updated.fingerprint !== approved.prepared.fingerprint) throw new Error('문서나 설정이 변경되었습니다. 다시 미리보기해 주세요.');
        if (updated.config.missing.length) throw new Error(`설정 누락: ${updated.config.missing.join(', ')}`);
        const url = new URL(updated.env.CONFLUENCE_BASE_URL);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Confluence BASE_URL은 인증정보·쿼리가 없는 HTTPS 주소여야 합니다.');
        return launch('push', updated);
      } finally { locked = false; }
    },
  };
}
