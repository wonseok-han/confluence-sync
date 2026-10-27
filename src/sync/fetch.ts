/** Read-only, batched remote observation. Never advances the synchronization baseline. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readEnv, type Env } from '../confluence/config.js';
import { buildFolderIndex, parentKeyOf } from '../documents/catalog.js';
import { buildIgnorer } from './ignore.js';
import { loadMapping } from './mapping.js';
import { mappingPath, METADATA_DIR } from './metadata.js';
import { scopeClient } from './scope.js';
import { assertWorkspaceConnection, inNestedWorkspace, inScope, loadWorkspace, requireScope, resolveSyncBase } from './workspace.js';

export const FETCH_TTL_MS = 120_000;
const BATCH_SIZE = 100, MAX_REQUESTS = 20;
type State = 'unchanged' | 'changed' | 'unavailable' | 'unknown';
type Observation = { path: string; pageId: string; state: State; baselineVersion?: number; remoteVersion?: number; title?: string; parentId?: string; reasons: string[] };
export type FetchSnapshot = { version: 1; key: string; checkedAt: string; scope: string; requests: number; items: Observation[]; foldersSkipped: number };
const states = new Set<State>(['unchanged', 'changed', 'unavailable', 'unknown']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function cachePath(base: string) {
  mappingPath(base); // Validates the metadata directory, including symlinks.
  const path = join(base, METADATA_DIR, 'remote.json');
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('원격 조회 캐시는 일반 파일이어야 합니다.');
  return path;
}

export async function fetchRemote(baseInput: string, env: Env) {
  const base = realpathSync(baseInput), workspace = loadWorkspace(base), root = requireScope(workspace);
  assertWorkspaceConnection(workspace, env);
  const client = scopeClient({...env, baseUrl:env.baseUrl?.replace(/\/$/, '')}), mapping = loadMapping(mappingPath(base)), ignore = buildIgnorer(base, []);
  const scoped = Object.entries(mapping).filter(([path]) => inScope(path.replace(/\/$/, ''), workspace) && !ignore.ignores(path) && !inNestedWorkspace(base, path));
  const pages = scoped.filter(([path, entry]) => entry.type !== 'folder' && /\.md$/i.test(path)).sort(([a],[b]) => a.localeCompare(b));
  if (pages.some(([, entry]) => !/^\d+$/.test(entry.pageId))) throw new Error('매핑의 페이지 ID가 숫자가 아닙니다. 매핑을 확인하세요.');
  if (Math.ceil(pages.length / BATCH_SIZE) > MAX_REQUESTS) throw new Error('원격 조회는 한 번에 최대 20회로 제한합니다. 작업 스코프를 좁혀 다시 확인하세요.');
  const folderIndex = buildFolderIndex(Object.keys(mapping).filter(path => /\.md$/i.test(path)));
  const expectedParents = new Map(pages.map(([path]) => { const parent = parentKeyOf(path, folderIndex); return [path, path === 'README.md' && mapping[path].pageId === root.id ? undefined : parent ? mapping[parent]?.pageId : root.id]; }));
  const key = digest([base, workspace, env.baseUrl, env.spaceKey, digest([env.email, env.token]), pages, [...expectedParents], scoped.filter(([,e])=>e.type==='folder')]);
  const path = cachePath(base), now = Date.now();
  try {
    const cached: FetchSnapshot = JSON.parse(readFileSync(path, 'utf8'));
    const age = now - Date.parse(cached?.checkedAt);
    if (!cached || typeof cached !== 'object') throw new SyntaxError('Invalid cache');
    if (cached.version === 1 && cached.key === key && age >= 0 && age < FETCH_TTL_MS && Array.isArray(cached.items) && cached.items.length === pages.length && cached.items.every((item,i) => item && item.path === pages[i][0] && item.pageId === pages[i][1].pageId && states.has(item.state) && Array.isArray(item.reasons) && item.reasons.every(reason => typeof reason === 'string'))) return { snapshot: cached, cached: true, requests: 0 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const remote = new Map<string, any>();
  let requests = 0;
  for (let offset = 0; offset < pages.length; offset += BATCH_SIZE) {
    const ids = pages.slice(offset, offset + BATCH_SIZE).map(([, entry]) => entry.pageId), allowed = new Set(ids), seen = new Set<string>();
    const query = new URLSearchParams({ 'space-id': workspace.connection!.spaceId!, status: 'current', limit: String(BATCH_SIZE) });
    query.set('id', ids.join(','));
    let cursor = '';
    do {
      if (requests >= MAX_REQUESTS) throw new Error('원격 조회가 최대 20회에 도달했습니다. 스코프를 좁혀 다시 확인하세요. 기존 캐시는 유지합니다.');
      const params = new URLSearchParams(query); if (cursor) params.set('cursor', cursor);
      let link = ''; requests++;
      const data = await client.api('/api/v2/pages?' + params, undefined, headers => { link = headers.get('link') ?? ''; });
      if (!data || !Array.isArray(data.results)) throw new Error('원격 페이지 목록 응답이 올바르지 않습니다.');
      for (const page of data.results) {
        if (!page || !allowed.has(String(page.id)) || String(page.spaceId) !== workspace.connection!.spaceId || remote.has(String(page.id))) throw new Error('원격 페이지 목록의 ID·스페이스 또는 중복 응답을 확인하세요.');
        remote.set(String(page.id), page);
      }
      const next = data._links?.next || link.split(',').find(part => /rel\s*=\s*"?next"?/i.test(part))?.match(/<([^>]+)>/)?.[1];
      cursor = '';
      if (next) {
        const url = new URL(next, env.baseUrl!.replace(/\/$/, '') + '/api/v2/pages');
        if (url.origin !== new URL(env.baseUrl!).origin || !/\/api\/v2\/pages$/.test(url.pathname) || !url.searchParams.get('cursor')) throw new Error('원격 페이지 목록의 다음 페이지 주소가 올바르지 않습니다.');
        cursor = url.searchParams.get('cursor')!;
        if (seen.has(cursor)) throw new Error('원격 페이지 목록의 페이지네이션이 반복됩니다.');
        seen.add(cursor);
      }
    } while (cursor);
  }
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
      if (parent && item.parentId && parent !== item.parentId) item.reasons.push('부모 위치 변경 또는 로컬 이동 대기');
      if (item.reasons.length) item.state = 'changed';
    }
    return item;
  });
  const snapshot: FetchSnapshot = { version: 1, key, checkedAt: new Date(now).toISOString(), scope: workspace.scope!.path, requests, items, foldersSkipped: scoped.filter(([,e])=>e.type==='folder').length };
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
    else if (!['fetch','--no-color'].includes(argv[i])) throw new Error('fetch는 저장된 스코프를 사용합니다. 옵션은 --base만 지정하세요.');
  }
  const i = argv.indexOf('--base'), base = resolveSyncBase(i >= 0 ? argv[i + 1] : undefined);
  if (!base) throw new Error('작업공간이 없습니다. --base로 기준 폴더를 지정하세요.');
  const { snapshot, cached, requests } = await fetchRemote(base, readEnv(base));
  const counts = Object.fromEntries([...states].map(state => [state, snapshot.items.filter(item => item.state === state).length]));
  console.log(`원격 변경 확인 · 스코프 ${snapshot.scope === '.' ? '/' : snapshot.scope}\n조회 시각: ${snapshot.checkedAt}${cached ? ' · 2분 이내 캐시 사용' : ''}\n이번 API 요청: ${requests}회 · 대상 ${snapshot.items.length}건`);
  for (const item of snapshot.items.filter(item => item.state !== 'unchanged')) console.log(`  [${({changed:'원격 변경',unavailable:'조회 불가',unknown:'확인 필요',unchanged:'버전 동일'})[item.state]}] ${item.path} (#${item.pageId}) · ${item.reasons.join(', ')}`);
  console.log(`버전 동일 ${counts.unchanged} · 원격 변경 ${counts.changed} · 조회 불가 ${counts.unavailable} · 확인 필요 ${counts.unknown}`);
  if (!snapshot.items.length) console.log('스코프에 매핑된 페이지가 없습니다. 먼저 Pull 또는 Push로 연결하세요.');
  console.log('문서·동기화 기준은 유지합니다. 새 원격 문서·폴더·첨부 단독 변경은 검사하지 않습니다.');
}
