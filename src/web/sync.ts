import { validateRestorePaths } from '../sync/pull.js';
import { observeChanges } from '../sync/changes.js';
import { documentDiff } from '../sync/diff.js';
import { inspectStaging, changeStaging, stagedPaths, loadIndex } from '../sync/staging.js';
import { connectionKeys, importConnection, mergeConnection } from '../confluence/env-file.js';
import { loadWorkspace, inScope, inNestedWorkspace, requireScope, type Workspace } from '../sync/workspace.js';
import { mappingPath as defaultMappingPath, METADATA_DIR } from '../sync/metadata.js';
import { connectWorkspace } from '../sync/scope.js';
import type { Env } from '../confluence/config.js';
import { referenceRoots } from '../sync/references.js';
/** Web adapter for the existing push CLI. Only preview and incremental push are exposed. */
import { runSyncCLI } from './node-runner.js';
export { runSyncCLI };
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, stat, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'dotenv';
import { within } from './output.js';
import { collectMarkdown } from '../documents/catalog.js';
import { buildIgnorer } from '../sync/ignore.js';

const keys = connectionKeys;
export type Imported = { env: Settings; content: string; source: string };
type Imports = Map<string, Imported>;
type Settings = Record<string, string>;
type ReceiveFormat='markdown'|'obsidian';
function receiveFormat(input:unknown):ReceiveFormat{
  const format=(input as {format?:unknown})?.format;
  if(format!==undefined&&format!=='markdown'&&format!=='obsidian')throw new Error('내부 링크 형식을 확인하세요. Markdown 또는 Obsidian을 선택하세요.');
  return format??'markdown';
}
type Selection = { format?:ReceiveFormat; restorePaths?: string[]; restoreOverwrite?: boolean; remoteOnly?: boolean; full?: boolean; base: string; target: string; envId: string; verify: boolean; referenceRoots: string[] };
type Prepared = { selection: Selection; env: Settings; config: ReturnType<typeof publicConfig>; fingerprint: string };
export type SyncRunner = (args: string[], env: Settings, log: (text: string) => void) => Promise<number>;
type Job = { phase?: 'fetch'; refreshFailed?: boolean; warningCount?: number; id: string; kind: 'preview' | 'push' | 'pull' | 'fetch' | 'restore'; state: 'running' | 'succeeded' | 'failed'; log: string; selection: Selection; config: ReturnType<typeof publicConfig>; planId: string | null; startedAt: string; finishedAt?: string };

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
    spaceKey: env.CONFLUENCE_SPACE_KEY, connected: workspace?.version === 2 && !!workspace.remoteRoot && workspace.connection?.baseUrl.replace(/\/$/, '') === env.CONFLUENCE_BASE_URL?.replace(/\/$/, '') && workspace.connection?.spaceKey === env.CONFLUENCE_SPACE_KEY,
    rootPath: workspace?.remoteRoot?.path ?? null, hasToken: !!env.CONFLUENCE_API_TOKEN,
    missing: keys.slice(0, 4).filter(key => !env[key]) };
}
// The preview is invalidated if documents, attachments, mapping, ignore rules or credentials change.
async function fingerprint(base: string, env: Settings, skipIndex = false) {
  const hash = createHash('sha256').update(JSON.stringify(env));
  const walk = async (dir: string) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules' || (entry.name.startsWith('.') && ![METADATA_DIR, '.confluence-sync.json', '.confluence-syncignore', '.confluence-workspace.json'].includes(entry.name))) continue;
      const path = join(dir, entry.name);
      if (relative(base, path).split('\\').join('/') === `${METADATA_DIR}/remote.json` || skipIndex && relative(base, path).split('\\').join('/') === `${METADATA_DIR}/index.json`) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        if (skipIndex) {
          // Background local scans keep the lightweight metadata shortcut.
          const info = await stat(path);
          hash.update(JSON.stringify([relative(base, path), info.size, info.mtimeMs, info.ctimeMs]));
          if (/\.md$/i.test(path) || entry.name.startsWith('.') || relative(base, path).split(/[\\/]/).includes(METADATA_DIR)) hash.update(await readFile(path));
        } else {
          // Approval follows bytes, not OneDrive hydration/timestamp changes.
          const content = createHash('sha256');
          for await (const chunk of createReadStream(path)) content.update(chunk);
          hash.update(JSON.stringify([relative(base, path), content.digest('hex')]));
        }
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
  stagedPaths(base);
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


export function createWebSync(runner: SyncRunner = runSyncCLI, initialImports: [string, Imported][] = []) {
  const imports: Imports = new Map(initialImports);
  let job: Job | null = null;
  let plan: { id: string; prepared: Prepared } | null = null;
  let locked = false;
  let restorePlan: {id:string; prepared:Prepared} | null = null;
  let stagingCache: {key:string; rows: Awaited<ReturnType<typeof inspectStaging>>; revision:string} | undefined;
  const connectionSettings = async (input: unknown) => {
    const body = input as { base?: string; envId?: string;  };
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
    const args = [kind === 'pull' ? 'pull' : kind === 'fetch' ? 'fetch' : kind === 'restore' ? 'restore' : 'push', '--base', base];
    for (const root of kind === 'pull' || kind === 'fetch' || kind === 'restore' ? [] : prepared.selection.referenceRoots) args.push('--reference-root', root);
    if (target && kind !== 'pull') args.push(target);
    if (kind === 'preview') args.push('--dry-run');
    if (kind === 'fetch') args.push('--refresh');
    if (kind === 'restore') {args.push(...prepared.selection.restorePaths!); if(prepared.selection.restoreOverwrite)args.push('--overwrite');}
    if (['pull','restore'].includes(kind) && prepared.selection.format==='obsidian') args.push('--obsidian');
    if (kind === 'pull' && prepared.selection.full) args.push('--full');
    if (kind === 'pull' && prepared.selection.remoteOnly) args.push('--remote-only');
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
        if (succeeded && ['push', 'pull'].includes(kind)) {
          current.phase = 'fetch';
          log('\n[자동 Fetch] 최신 원격 상태를 다시 확인합니다.\n');
          reportedFailure = false;
          try {
            const refreshCode = await runner(['fetch', '--base', base, '--refresh'], prepared.env, log);
            if (refreshCode !== 0 || reportedFailure) throw new Error('후속 Fetch가 완료되지 않았습니다.');
          } catch (error) {
            current.refreshFailed = true;
            log(`[후속 Fetch 실패] ${error instanceof Error ? error.message : String(error)} 이미 완료된 ${kind === 'push' ? '업로드' : '가져오기'}는 유지됩니다. Fetch를 다시 실행하세요.\n`);
          } finally { delete current.phase; }
        }
        current.warningCount = Number(current.log.match(/(?:^|\n)\[경고 요약\] 원격 첨부 (\d+)개/)?.[1] ?? 0);
        current.state = succeeded ? 'succeeded' : 'failed';
      } catch (error) { current.state = 'failed'; log((error instanceof Error ? error.message : String(error)) + '\n'); }
      finally { current.finishedAt = new Date().toISOString(); }
    })();
    return current;
  };
  return {
    connectionImports: () => [...imports] as [string, Imported][],
    running,
    diff: async (input: unknown) => {
      if(running())throw new Error('다른 작업이 진행 중입니다.');
      locked=true;
      try {
        const {base,config}=await connectionSettings(input);
        const body=input as {path?:unknown;remote?:unknown};
        if(typeof body.path!=='string'||body.remote!==undefined&&typeof body.remote!=='boolean')throw new Error('비교할 문서를 선택하세요.');
        return await documentDiff(base,body.path,{remote:body.remote as boolean|undefined,env:config});
      }finally{locked=false;}
    },
    staging: async (input: unknown) => {
      if (running()) throw new Error('다른 작업이 진행 중입니다.');
      locked = true;
      try {
        const { base, config } = await connectionSettings(input);
        const body = input as { paths?: unknown; action?: unknown; referenceRoots?: unknown; remoteOnly?: unknown };
        if(body.remoteOnly!==undefined&&typeof body.remoteOnly!=='boolean')throw new Error('원격 목록 조회 옵션을 확인하세요.');
        if(body.remoteOnly){
          if(body.action!==undefined)throw new Error('원격 목록 조회에서는 업로드 선택을 변경할 수 없습니다.');
          const view=observeChanges(base,[],config);
          const rows=view.rows.filter(row=>row.remoteState&&row.remoteState!=='unchanged').map(row=>({...row,localUnverified:!(row.remoteState==='new'&&row.status==='unavailable')}));
          return {...view,rows,revision:JSON.stringify([view.remoteCheckedAt,rows])};
        }
        if (body.referenceRoots !== undefined && (!Array.isArray(body.referenceRoots) || body.referenceRoots.some(p => typeof p !== 'string'))) throw new Error('참조 폴더를 확인하세요.');
        const options = {referenceRoots: body.referenceRoots as string[] ?? [], baseUrl:config.baseUrl};
        const cacheKey=JSON.stringify([base,options,loadWorkspace(base)]);
        const revision = async () => JSON.stringify(await Promise.all([base,...referenceRoots(base,options.referenceRoots)].map(root=>fingerprint(root,{connection:JSON.stringify(config)},true))));
        let currentRevision=await revision();
        let rows: Awaited<ReturnType<typeof inspectStaging>>;
        const cacheMatched=stagingCache?.key===cacheKey && stagingCache.revision===currentRevision;
        if (body.action !== undefined) {
          if (!['add','remove'].includes(String(body.action)) || !Array.isArray(body.paths) || body.paths.some(p => typeof p !== 'string')) throw new Error('문서 선택을 확인하세요.');
          plan = null;
          const touched=await changeStaging(base, body.paths as string[], body.action as 'add'|'remove', options);
          const prior=stagingCache?.key===cacheKey?stagingCache.rows:[];
          const merged=new Map(prior.map(row=>[row.path,row]));
          if(body.action==='add')for(const row of touched)merged.set(row.path,{...row,pageId:(row as {pageId?:string}).pageId,staged:true,stale:false});
          const entries=loadIndex(base).entries;
          rows=[...merged.values()].map(row=>({...row,staged:!!entries[row.path],stale:!!entries[row.path]&&(!!row.unmapped||JSON.stringify(entries[row.path])!==JSON.stringify(row.entry))}));
          if(!cacheMatched)currentRevision='';
        } else rows = stagingCache?.key===cacheKey && stagingCache.revision===currentRevision ? stagingCache.rows : await inspectStaging(base, options);
        const activeEntries=loadIndex(base).entries;
        rows=rows.map(row=>({...row,staged:!!activeEntries[row.path],stale:!!activeEntries[row.path]&&(!!row.unmapped||JSON.stringify(activeEntries[row.path])!==JSON.stringify(row.entry))}));
        for(const [path,entry] of Object.entries(activeEntries))if(!rows.some(row=>row.path===path))rows.push({path,status:'unavailable',staged:true,stale:true,entry});
        stagingCache={key:cacheKey,rows,revision:currentRevision};
        const view = observeChanges(base, rows, config);
        return {...view, revision:JSON.stringify([currentRevision,activeEntries,view.remoteCheckedAt,view.rows])};
      } finally { locked = false; }
    },
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
    connect: async (input: unknown) => {
      if (running()) throw new Error('다른 Confluence 작업이 진행 중입니다.');
      locked = true; plan = null;
      try {
        const { base, config, body } = await connectionSettings(input);
        await connectWorkspace(base,config);
        const {env,source} = await settings(base,body.envId!,imports);
        return publicConfig(env,source,loadWorkspace(base));
      } finally { locked = false; }
    },
    current: () => job,
    config: async (base: string, envId: string) => {
      const resolved = await realpath(resolve(base));
      const { env, source } = await settings(resolved, envId, imports);
      return publicConfig(env, source, loadWorkspace(resolved));
    },
    fetch: async (input: unknown) => {
      if (running()) throw new Error('다른 작업이 진행 중입니다.');
      locked = true; plan = null;
      try {
        const { base, config, body } = await connectionSettings(input);
        const workspace = loadWorkspace(base); requireScope(workspace);
        const { env, source } = await settings(base, body.envId!, imports);
        const visible = publicConfig(env, source, workspace);
        if (visible.missing.length) throw new Error(`설정 누락: ${visible.missing.join(', ')}`);
        const url = new URL(config.baseUrl!);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Confluence BASE_URL은 인증정보·쿼리가 없는 HTTPS 주소여야 합니다.');
        return launch('fetch', { selection: { base, target: '', envId: body.envId!, verify: false, referenceRoots: [] }, env, config: visible, fingerprint: '' });
      } finally { locked = false; }
    },
    restore: async (input: unknown) => {
      if (running()) throw new Error('다른 작업이 진행 중입니다.');
      locked = true;
      try {
        const {base, body} = await connectionSettings(input);
        const request = input as {path?:unknown; overwrite?:unknown; confirmationId?:unknown};
        const format=receiveFormat(input);
        const workspace = loadWorkspace(base); requireScope(workspace);
        const {env,source} = await settings(base, body.envId!, imports);
        const config = publicConfig(env,source,workspace);
        if (!config.connected || config.missing.length) throw new Error('스페이스 연결과 .env 설정을 확인하세요.');
        const url = new URL(config.baseUrl!);
        if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash)throw new Error('Confluence BASE_URL은 인증정보·쿼리가 없는 HTTPS 주소여야 합니다.');
        if (request.confirmationId !== undefined) {
          const approved = restorePlan; restorePlan = null;
          if (!approved || request.confirmationId !== approved.id || approved.prepared.selection.base !== base || approved.prepared.selection.envId !== body.envId || approved.prepared.selection.format !== format) throw new Error('복구 대상을 다시 확인하세요.');
          if (await fingerprint(base,env) !== approved.prepared.fingerprint) throw new Error('확인 이후 로컬 문서나 설정이 바뀌었습니다. 복구 대상을 다시 확인하세요.');
          validateRestorePaths(base,approved.prepared.selection.restorePaths!,approved.prepared.selection.restoreOverwrite);
          return {job:launch('restore',approved.prepared)};
        }
        if (typeof request.path !== 'string' || typeof request.overwrite !== 'boolean') throw new Error('복구할 문서와 덮어쓰기 여부를 확인하세요.');
        const paths = validateRestorePaths(base,[request.path],request.overwrite);
        const id = randomUUID();
        restorePlan = {id,prepared:{selection:{base,target:'',envId:body.envId!,verify:false,referenceRoots:[],format,restorePaths:paths,restoreOverwrite:request.overwrite},env,config,fingerprint:await fingerprint(base,env)}};
        return {confirmationId:id,path:paths[0],overwrite:request.overwrite,format};
      } finally {locked=false;}
    },
    pull: async (input: unknown) => {
      if (running()) throw new Error('다른 작업이 진행 중입니다.');
      locked = true; plan = null;
      try {
        const { base, config, body } = await connectionSettings(input);
        const format=receiveFormat(input);
        const full = (body as { full?: unknown }).full;
        const remoteOnly=(body as {remoteOnly?:unknown}).remoteOnly;
        if(remoteOnly!==undefined&&typeof remoteOnly!=='boolean'||remoteOnly&&full)throw new Error('원격 변경 가져오기 옵션을 확인하세요.');
        if (full !== undefined && typeof full !== 'boolean') throw new Error('전체 탐색 설정을 확인하세요.');
        const workspace = loadWorkspace(base); requireScope(workspace);
        const { env, source } = await settings(base, body.envId!, imports);
        const visible = publicConfig(env, source, workspace);
        if (visible.missing.length) throw new Error(`설정 누락: ${visible.missing.join(', ')}`);
        const url = new URL(config.baseUrl!);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Confluence BASE_URL은 인증정보·쿼리가 없는 HTTPS 주소여야 합니다.');
        return launch('pull', { selection: { base, target: '', envId: body.envId!, verify: false, referenceRoots: [], format, ...(full ? {full: true} : {}),...(remoteOnly?{remoteOnly:true}:{}) }, env, config: visible, fingerprint: '' });
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
