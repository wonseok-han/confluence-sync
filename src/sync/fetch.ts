import { progressStep } from '../shared/progress.js';
/** Read-only, batched remote observation. Never advances the synchronization baseline. */
import { bold, cyan, green, yellow, red, dim } from '../shared/colors.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readEnv, type Env } from '../confluence/config.js';
import { buildFolderIndex, parentKeyOf } from '../documents/catalog.js';
import { buildIgnorer } from './ignore.js';
import { loadMapping } from './mapping.js';
import { mappingPath, METADATA_DIR } from './metadata.js';
import { scopeClient } from './scope.js';
import { assertWorkspaceConnection, inNestedWorkspace, inScope, loadWorkspace, requireScope, resolveSyncBase, within } from './workspace.js';

export const FETCH_TTL_MS = 120_000;
const BATCH_SIZE = 100, MAX_REQUESTS = 20;
export type RemoteFolder = {path:string;pageId:string;title:string;previousPath?:string;parentId?:string};
type State = 'unchanged' | 'changed' | 'unavailable' | 'unknown' | 'new';
export type Observation = { path: string; pageId: string; state: State; baselineVersion?: number; remoteVersion?: number; title?: string; parentId?: string; reasons: string[] };
export type FetchSnapshot = { binding?:string; version: 1; key: string; checkedAt: string; scope: string; requests: number; items: Observation[]; foldersSkipped: number; folders?: RemoteFolder[] };
const folderUnavailableReason='원격 상위 폴더를 조회할 수 없습니다. 삭제·권한 변경 여부를 확인하세요.';
const folderMoveReason=(folder:RemoteFolder)=>`원격 상위 폴더 위치 변경${basename(folder.previousPath!.replace(/\/$/,''))!==basename(folder.path.replace(/\/$/,''))?' (폴더 이름 변경 포함)':''}: ${folder.previousPath} → ${folder.path}`;
const states = new Set<State>(['unchanged', 'changed', 'unavailable', 'unknown', 'new']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function cachePath(base: string) {
  mappingPath(base); // Validates the metadata directory, including symlinks.
  const path = join(base, METADATA_DIR, 'remote.json');
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('원격 조회 캐시는 일반 파일이어야 합니다.');
  return path;
}

function fetchContext(baseInput: string, env: Env, options: {mappingFile?:string} = {}) {
  const base = realpathSync.native?.(baseInput) ?? realpathSync(baseInput), workspace = loadWorkspace(base), root = requireScope(workspace);
  assertWorkspaceConnection(workspace, env);
  const mapping = loadMapping(options.mappingFile ?? mappingPath(base)), ignore = buildIgnorer(base, []);
  const scoped = Object.entries(mapping).filter(([path]) => inScope(path.replace(/\/$/, ''), workspace) && !ignore.ignores(path) && !inNestedWorkspace(base, path));
  const pages = scoped.filter(([path, entry]) => entry.type !== 'folder' && /\.md$/i.test(path)).sort(([a],[b]) => a.localeCompare(b));
  if (pages.some(([, entry]) => !/^\d+$/.test(entry.pageId))) throw new Error('매핑의 페이지 ID가 숫자가 아닙니다. 매핑을 확인하세요.');
  const folderIndex = buildFolderIndex(Object.keys(mapping).filter(path => /\.md$/i.test(path)));
  const expectedParents = new Map(pages.map(([path]) => { const parent = parentKeyOf(path, folderIndex); return [path, path === 'README.md' && mapping[path].pageId === root.id ? undefined : mapping[path].remoteParentId ?? (parent ? mapping[parent]?.pageId : root.id)]; }));
  const key = digest(['discovery-v3', base, workspace, env.baseUrl, env.spaceKey, digest([env.email, env.token]), pages, [...expectedParents], scoped.filter(([,e])=>e.type==='folder')]);
  const binding=digest([base,workspace,env.baseUrl,env.spaceKey,digest([env.email,env.token])]);
  const path = cachePath(base), now = Date.now();
  return {base, workspace, root, mapping, pages, scoped, expectedParents, key, path, now, binding};
}
function cachedSnapshot(context: ReturnType<typeof fetchContext>, allowExpired = false): FetchSnapshot | null {
  try {
    const value: FetchSnapshot = JSON.parse(readFileSync(context.path,'utf8'));
    const age=context.now-Date.parse(value?.checkedAt);
    if(value?.version!==1 || value.key!==context.key || age<0 || !Number.isFinite(age) || !allowExpired&&age>=FETCH_TTL_MS || !Array.isArray(value.items))return null;
    if(value.folders!==undefined&&(!Array.isArray(value.folders)||value.folders.some(folder=>!folder||typeof folder.path!=='string'||!folder.path.endsWith('/')||!/^\d+$/.test(folder.pageId)||typeof folder.title!=='string'||folder.previousPath!==undefined&&(typeof folder.previousPath!=='string'||!folder.previousPath.endsWith('/')||!within(context.base,resolve(context.base,folder.previousPath)))||!within(context.base,resolve(context.base,folder.path)))))return null;
    const ids=new Set<string>();
    for(const item of value.items){
      if(!item || typeof item.path!=='string' || !within(context.base,resolve(context.base,item.path)) || !/\.md$/i.test(item.path) || !/^\d+$/.test(item.pageId) || ids.has(item.pageId) || !states.has(item.state) || !Array.isArray(item.reasons) || item.reasons.some(r=>typeof r!=='string'))return null;
      ids.add(item.pageId);
    }
    if(context.pages.some(([,entry])=>!ids.has(entry.pageId)))return null;
    return value;
  } catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
}
/** Reclassify saved metadata against current baselines without API calls. */
export function readFetchSnapshot(base:string,env:Env): FetchSnapshot | null {
  const context=fetchContext(base,env),strict=cachedSnapshot(context,true);
  if(strict)return strict;
  let prior:FetchSnapshot;
  try{prior=JSON.parse(readFileSync(context.path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
  if(prior?.binding!==context.binding || !cachedSnapshot({...context,key:prior.key},true))return null;
  const byId=new Map(context.pages.map(([path,entry])=>[entry.pageId,{path,entry}]));
  return {...prior,key:context.key,items:prior.items.map(item=>{
    const mapped=byId.get(item.pageId);if(!mapped)return item;
    const {path,entry}=mapped,reasons:string[]=[];
    if(item.state==='unavailable'||item.state==='unknown'&&item.reasons.includes(folderUnavailableReason))return {...item,path,baselineVersion:entry.remoteVersion};
    if(!entry.remoteVersion||!item.remoteVersion||item.remoteVersion<entry.remoteVersion)return {...item,path,baselineVersion:entry.remoteVersion,state:'unknown' as const,reasons:['원격 버전 기준을 확인할 수 없습니다. Fetch로 갱신하세요.']};
    if(item.remoteVersion!==entry.remoteVersion)reasons.push(`버전 v${entry.remoteVersion} → v${item.remoteVersion}`);
    if(entry.title&&item.title&&entry.title!==item.title)reasons.push('제목 변경');
    const parent=context.expectedParents.get(path);if(parent&&item.parentId&&parent!==item.parentId)reasons.push('원격 부모 위치 변경');
    for(const folder of prior.folders??[])if(folder.previousPath&&path.startsWith(folder.previousPath)&&context.mapping[folder.previousPath]?.pageId===folder.pageId)reasons.push(folderMoveReason(folder));
    return {...item,path,baselineVersion:entry.remoteVersion,state:reasons.length?'changed' as const:'unchanged' as const,reasons};
  })};
}
export async function fetchRemote(baseInput: string, env: Env, options: { mappingFile?: string; refresh?: boolean } = {}) {
  const context=fetchContext(baseInput,env,options);
  const {base,workspace,pages,scoped,key,path,now,expectedParents,binding}=context;
  const cached=options.refresh ? null : cachedSnapshot(context);
  if(cached)return {snapshot:cached,cached:true,requests:0};
  const client=scopeClient({...env,baseUrl:env.baseUrl?.replace(/\/$/,'')});
  const remote = new Map<string, any>();
  let requests = 0;
  const query=new URLSearchParams({'space-id':workspace.connection!.spaceId!,status:'current',limit:String(BATCH_SIZE)});
  let cursor='',seen=new Set<string>();
  do {
    if(requests>=MAX_REQUESTS)throw new Error('원격 조회가 최대 20회에 도달했습니다. 기존 캐시는 유지합니다.');
    progressStep(`스페이스 원격 메타데이터 확인 · ${remote.size}개 발견`);
    const params=new URLSearchParams(query);if(cursor)params.set('cursor',cursor);
    let link='';requests++;
    const data=await client.api('/api/v2/pages?'+params,undefined,headers=>{link=headers.get('link')??'';});
    if(!data||!Array.isArray(data.results))throw new Error('원격 페이지 목록 응답이 올바르지 않습니다.');
    for(const page of data.results){
      if(!page || !/^\d+$/.test(String(page.id)) || page.parentId!=null&&!/^\d+$/.test(String(page.parentId)) || String(page.spaceId)!==workspace.connection!.spaceId || remote.has(String(page.id)))throw new Error('원격 페이지 목록의 ID·스페이스 또는 중복 응답을 확인하세요.');
      remote.set(String(page.id),{...page,id:String(page.id),parentId:page.parentId==null?undefined:String(page.parentId)});
    }
    const next=data._links?.next || link.split(',').find(part=>/rel\s*=\s*"?next"?/i.test(part))?.match(/<([^>]+)>/)?.[1];
    cursor='';
    if(next){const url=new URL(next,env.baseUrl!.replace(/\/$/,'')+'/api/v2/pages');
      if(url.origin!==new URL(env.baseUrl!).origin || !/\/api\/v2\/pages$/.test(url.pathname) || !url.searchParams.get('cursor'))throw new Error('원격 페이지 목록의 다음 페이지 주소가 올바르지 않습니다.');
      cursor=url.searchParams.get('cursor')!;if(seen.has(cursor))throw new Error('원격 페이지 목록의 페이지네이션이 반복됩니다.');seen.add(cursor);
    }
  }while(cursor);
  const items: Observation[] = pages.map(([path, entry]) => {
    const page = remote.get(entry.pageId), item: Observation = { path, pageId: entry.pageId, baselineVersion: entry.remoteVersion, state: 'unknown', reasons: [] };
    if (!page) return { ...item, state: 'unavailable', reasons: ['조회 결과에 없음 — 삭제·권한 변경·보관 여부는 확인되지 않았습니다.'] };
    if (typeof page.title === 'string') item.title = page.title;
    if (typeof page.parentId === 'string') item.parentId = page.parentId;
    if (Number.isInteger(page.version?.number) && page.version.number > 0) item.remoteVersion = page.version.number;
    if (!entry.remoteVersion || !item.remoteVersion || item.remoteVersion < entry.remoteVersion) item.reasons.push('비교할 기준 버전 또는 원격 버전을 확인할 수 없습니다.');
    else {
      item.state = 'unchanged';
      if (item.remoteVersion !== entry.remoteVersion) item.reasons.push(`버전 v${entry.remoteVersion} → v${item.remoteVersion}`);
      if (entry.title && item.title && entry.title !== item.title) item.reasons.push('제목 변경');
      const parent = expectedParents.get(path);
      if (parent && item.parentId && parent !== item.parentId) item.reasons.push('원격 부모 위치 변경');
      if (item.reasons.length) item.state = 'changed';
    }
    return item;
  });
  // Batch only unresolved parents of unmapped pages; expanded ancestry is shared.
  const mappingById=new Map(Object.entries(context.mapping).map(([path,entry])=>[entry.pageId,{path,entry}]));
  const folders=new Map<string,RemoteFolder>();
  const slug=(title:string)=>{const value=title.replace(/[\/\\:*?"<>|]/g,'-').replace(/\s+/g,' ').trim();return !value||/^\.+$/.test(value)?'untitled':value.startsWith('.')||['attachments','node_modules'].includes(value)?'_'+value:value;};
  const nodes=new Map(remote);
  const unavailableFolders=new Set<string>();
  const trackedFolders=context.scoped.filter(([path,entry])=>entry.type==='folder'&&pages.some(([page])=>page.startsWith(path))).map(([,entry])=>entry.pageId);
  const missingParents=[...new Set([...trackedFolders,...[...remote].filter(([id])=>!mappingById.has(id)).map(([,page])=>String(page.parentId??'')).filter(id=>id&&id!==context.root.id&&!nodes.has(id)&&!mappingById.has(id))])];
  for(let offset=0;offset<missingParents.length;offset+=BATCH_SIZE){
    const ids=missingParents.slice(offset,offset+BATCH_SIZE),remaining=new Set(ids),seenStarts=new Set<string>();
    let start='';
    do{
      if(requests>=MAX_REQUESTS)throw new Error('원격 조회가 최대 20회에 도달했습니다. 기존 캐시는 유지합니다.');
      const params=new URLSearchParams({cql:`id in (${ids.join(',')})`,expand:'ancestors,space',limit:String(BATCH_SIZE)});if(start)params.set('start',start);
      requests++;progressStep(`원격 폴더 메타데이터 조회 · ${offset+1}–${offset+ids.length}`);
      const data=await client.api('/rest/api/content/search?'+params);
      if(!Array.isArray(data?.results))throw new Error('원격 부모 폴더 목록을 확인할 수 없습니다.');
      for(const info of data.results){
        const id=String(info?.id);
        if(!remaining.has(id)||info.type!=='folder'||String(info.space?.id)!==workspace.connection!.spaceId||!Array.isArray(info.ancestors))throw new Error('원격 부모 폴더의 ID·스페이스·유형을 확인하세요.');
        remaining.delete(id);
        for(let i=0;i<info.ancestors.length;i++){const a=info.ancestors[i];if(!/^\d+$/.test(String(a.id))||typeof a.title!=='string')throw new Error('원격 상위 폴더 정보를 확인할 수 없습니다.');if(!nodes.has(String(a.id)))nodes.set(String(a.id),{id:String(a.id),title:a.title,type:'folder',parentId:info.ancestors[i-1]?.id});}
        nodes.set(id,{id,title:info.title,type:'folder',parentId:info.ancestors.at(-1)?.id});
      }
      start='';if(data._links?.next){const url=new URL(data._links.next,env.baseUrl!);
        if(url.origin!==new URL(env.baseUrl!).origin||!/\/rest\/api\/content\/search$/.test(url.pathname)||!/^\d+$/.test(url.searchParams.get('start')??''))throw new Error('부모 폴더 목록의 다음 페이지 주소가 올바르지 않습니다.');
        start=url.searchParams.get('start')!;if(seenStarts.has(start))throw new Error('부모 폴더 페이지네이션이 반복됩니다.');seenStarts.add(start);
      }
    }while(start);
    if([...remaining].some(id=>!trackedFolders.includes(id)))throw new Error('신규 원격 문서의 부모 폴더를 찾을 수 없습니다. 기존 캐시는 유지합니다.');
    for(const id of remaining)unavailableFolders.add(id);
  }
  async function container(id:string,visiting=new Set<string>()):Promise<string>{
    if(id===context.root.id)return '';
    if(visiting.has(id))throw new Error('원격 부모 관계가 순환합니다.');
    visiting.add(id);
    const mapped=mappingById.get(id);
    if(mapped){
      if(mapped.entry.type!=='folder')return dirname(mapped.path)==='.'?'':dirname(mapped.path);
      const prior=mapped.path.replace(/\/$/,''),node=nodes.get(id);
      if(!node)return prior;
      if(typeof node.title!=='string'||!node.title.trim())throw new Error(`원격 폴더 제목을 확인할 수 없습니다: #${id}`);
      const parent=node.parentId?await container(String(node.parentId),visiting):'';
      const renamed=slug(node.title)!==slug(mapped.entry.title??basename(prior));
      const path=[parent,renamed?slug(node.title):basename(prior)].filter(Boolean).join('/');
      if(path!==prior)folders.set(id,{path:path+'/',previousPath:prior+'/',pageId:id,title:node.title,parentId:node.parentId?String(node.parentId):undefined});
      return path;
    }
    const node=nodes.get(id);
    if(!node)throw new Error(`원격 부모 정보를 확인할 수 없습니다: #${id}`);
    if(typeof node.title!=='string'||!node.title.trim())throw new Error(`원격 제목을 확인할 수 없습니다: #${id}`);
    const parent=node.parentId?await container(String(node.parentId),visiting):'';
    const path=[parent,slug(node.title)].filter(Boolean).join('/');
    if(!remote.has(id))folders.set(id,{path:path+'/',pageId:id,title:node.title});
    return path;
  }
  for(const id of trackedFolders)await container(id);
  for(const item of items){
    if(item.state==='unavailable'||item.state==='unknown')continue;
    // A deleted historical local folder is not necessarily a current ancestor:
    // its documents may already have moved elsewhere without changing local paths.
    let parent=item.parentId,missingAncestor=false;const seenParents=new Set<string>();
    while(parent&&parent!==context.root.id){
      if(unavailableFolders.has(parent)||seenParents.has(parent)){missingAncestor=true;break;}
      seenParents.add(parent);const node=nodes.get(parent);parent=node?.parentId?String(node.parentId):undefined;
    }
    if(missingAncestor){item.state='unknown';item.reasons.push(folderUnavailableReason);continue;}
    for(const folder of folders.values())if(folder.previousPath&&item.path.startsWith(folder.previousPath)){
      item.state='changed';item.reasons.push(folderMoveReason(folder));
    }
  }
  const mappedIds=new Set(Object.values(context.mapping).map(entry=>entry.pageId));
  for(const [id,page]of remote)if(!mappedIds.has(id)&&page.parentId)await container(String(page.parentId));
  for(const [id,page]of remote){
    if(mappedIds.has(id))continue;
    if(typeof page.title!=='string'||!Number.isInteger(page.version?.number)||page.version.number<1)throw new Error(`신규 원격 문서의 제목·버전을 확인할 수 없습니다: #${id}`);
    const parent=page.parentId?await container(String(page.parentId)):'';
    const hasChildren=[...nodes.values()].some(node=>String(node.parentId)===id);
    const path=id===context.root.id?'README.md':[parent,slug(page.title)+(hasChildren?'/README.md':'.md')].filter(Boolean).join('/');
    if(!inScope(path,workspace)||buildIgnorer(base,[]).ignores(path)||inNestedWorkspace(base,path))continue;
    items.push({path,pageId:id,title:page.title,parentId:page.parentId,remoteVersion:page.version.number,state:'new',reasons:['아직 로컬에 받지 않은 원격 문서']});
  }
  const snapshot: FetchSnapshot = { version: 1, key, binding, checkedAt: new Date(now).toISOString(), scope: '.', requests, items, folders:[...folders.values()], foldersSkipped: scoped.filter(([,e])=>e.type==='folder').length };
  // Publish only a complete observation. Never replace a good cache with partial results.
  cachePath(base); mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.remote-${randomUUID()}.tmp`);
  try { writeFileSync(temp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
  return { snapshot, cached: false, requests };
}

export async function runFetch(argv: string[]) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') { if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--base에 기준 폴더를 지정하세요.'); i++; }
    else if (!['fetch','--no-color','--refresh'].includes(argv[i])) throw new Error('fetch는 연결된 작업공간을 사용합니다. 옵션은 --base와 --refresh만 지정하세요.');
  }
  const i = argv.indexOf('--base'), base = resolveSyncBase(i >= 0 ? argv[i + 1] : undefined);
  if (!base) throw new Error('작업공간이 없습니다. --base로 기준 폴더를 지정하세요.');
  const { snapshot, cached, requests } = await fetchRemote(base, readEnv(base), {refresh: argv.includes('--refresh')});
  const counts = Object.fromEntries([...states].map(state => [state, snapshot.items.filter(item => item.state === state).length]));
  console.log(`${bold(cyan('원격 변경 확인 · 스페이스 작업공간'))}\n${dim(`조회 시각: ${snapshot.checkedAt}${cached ? ' · 2분 이내 캐시 사용' : ''}`)}\n이번 API 요청: ${cyan(`${requests}회`)} · 대상 ${snapshot.items.length}건`);
  const tones = {new:cyan,changed: cyan, unavailable: red, unknown: yellow, unchanged: green};
  for (const item of snapshot.items.filter(item => item.state !== 'unchanged')) console.log(`  ${tones[item.state](`[${({new:'원격 신규',changed:'원격 변경',unavailable:'조회 불가',unknown:'확인 필요',unchanged:'버전 동일'})[item.state]}]`)} ${item.path} ${dim(`(#${item.pageId})`)} · ${item.reasons.join(', ')}`);
  console.log(`${green(`버전 동일 ${counts.unchanged}`)} · ${cyan(`원격 신규 ${counts.new}`)} · ${cyan(`원격 변경 ${counts.changed}`)} · ${counts.unavailable ? red(`조회 불가 ${counts.unavailable}`) : dim('조회 불가 0')} · ${counts.unknown ? yellow(`확인 필요 ${counts.unknown}`) : dim('확인 필요 0')}`);
  if (!snapshot.items.length) console.log(dim('스페이스에서 가져올 문서가 없습니다.'));
  console.log(dim('문서·동기화 기준은 유지합니다. 스페이스의 새 문서와 버전·위치 변경을 확인했습니다. 가져오기: csync pull'));
}
