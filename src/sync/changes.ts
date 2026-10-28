/** Shared local/last-observed-remote view. Reading this view never calls Confluence. */
import { readFetchSnapshot, FETCH_TTL_MS } from './fetch.js';
import { loadMapping } from './mapping.js';
import { mappingPath } from './metadata.js';
import { buildIgnorer } from './ignore.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { inNestedWorkspace } from './workspace.js';
import type { Env } from '../confluence/config.js';
import type { StagingRow } from './staging.js';

type Observation = NonNullable<ReturnType<typeof readFetchSnapshot>>['items'][number];
export type ChangeRow = Omit<StagingRow, 'entry'> & {
  remoteState?: Observation['state'];
  remoteVersion?: number;
  baselineVersion?: number;
  remoteReasons?: string[];
};
export function observeChanges(base: string, rows: StagingRow[], env: Env) {
  let snapshot: ReturnType<typeof readFetchSnapshot> = null, remoteError: string | undefined;
  try { snapshot = readFetchSnapshot(base, env); }
  catch { remoteError = '원격 조회 캐시를 사용할 수 없습니다. 연결 설정을 확인하고 csync fetch로 다시 조회하세요.'; }
  const remoteById = new Map(snapshot?.items.map(item => [item.pageId, item]) ?? []);
  const observed: ChangeRow[] = rows.map(({entry, ...row}) => {
    const remote = remoteById.get(row.pageId ?? '');
    return {...row, ...(row.unmapped?{recoverable:!!row.recoverable&&remote?.state==='new'&&remote.path===row.path}:{}), remoteState: remote?.state, remoteVersion: remote?.remoteVersion, baselineVersion: remote?.baselineVersion, remoteReasons: remote?.reasons};
  });
  const seen = new Set(observed.map(row => row.pageId));
  const ignore = buildIgnorer(base, []);
  for (const [path, entry] of Object.entries(loadMapping(mappingPath(base)))) {
    if (!/\.md$/i.test(path) || entry.type === 'folder' || ignore.ignores(path) || inNestedWorkspace(base, path) || seen.has(entry.pageId)) continue;
    const remote = remoteById.get(entry.pageId);
    seen.add(entry.pageId);
    observed.push({path, pageId: entry.pageId, status: 'unavailable', staged: false, stale: false, remoteState: remote?.state, remoteVersion: remote?.remoteVersion, baselineVersion: entry.remoteVersion, remoteReasons: remote?.reasons});
  }
  for(const item of snapshot?.items??[]){
    if(item.state!=='new'||seen.has(item.pageId)||ignore.ignores(item.path)||inNestedWorkspace(base,item.path))continue;
    observed.push({path:item.path,pageId:item.pageId,status:existsSync(resolve(base,item.path))?'new':'unavailable',staged:false,stale:false,remoteState:'new',remoteVersion:item.remoteVersion,remoteReasons:item.reasons});seen.add(item.pageId);
  }
  return {rows: observed, remoteCheckedAt: snapshot?.checkedAt ?? null, remoteExpired: !!snapshot && Date.now() - Date.parse(snapshot.checkedAt) >= FETCH_TTL_MS, remoteError};
}
export type ChangeGroup = 'receive' | 'conflict' | 'attention' | 'send' | 'same';
export function changeGroup(row: ChangeRow): ChangeGroup {
  if(row.remoteState==='new')return row.recoverable||row.status==='unavailable'?'receive':'conflict';
  if(row.unmapped)return 'attention';
  if (row.remoteState === 'changed' && ['new', 'changed', 'moved'].includes(row.status)) return 'conflict';
  if (row.status === 'unavailable' || row.stale || ['unknown', 'unavailable'].includes(row.remoteState ?? '')) return 'attention';
  if (row.status === 'same' && row.remoteState === 'changed') return 'receive';
  return row.status !== 'same' || row.staged ? 'send' : 'same';
}
