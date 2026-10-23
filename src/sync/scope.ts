/** Explicit remote scope selection, shared by CLI and web. Reads metadata, never content bodies. */
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import { createHash } from 'node:crypto';
import { collectMarkdown, buildFolderIndex, parentKeyOf, containerKeyOf } from '../documents/catalog.js';
import type { Mapping } from './mapping.js';
import { workspacePath } from './metadata.js';
import { createClient } from '../confluence/client.js';
import type { Env } from '../confluence/config.js';
import { loadMapping } from './mapping.js';
import { mappingPath } from './metadata.js';
import { loadWorkspace, requireScope, saveWorkspace, type Workspace } from './workspace.js';

type Client = ReturnType<typeof createClient>;
export function scopeClient(env: Env, workspace?: Workspace): Client {
  if (!env.baseUrl || !env.email || !env.token || !env.spaceKey) throw new Error('스코프 조회에 사이트·계정·API 토큰·스페이스 설정이 필요합니다.');
  const url = new URL(env.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Confluence BASE_URL은 인증정보·쿼리가 없는 HTTPS 주소여야 합니다.');
  return createClient({ baseUrl: env.baseUrl, email: env.email, token: env.token }, { force: false, verify: false,
    ...(workspace?.scope ? { scope: { id: workspace.scope.id, spaceId: workspace.connection!.spaceId! } } : {}) });
}
async function spaceRoot(client: Client, key: string) {
  const space = await client.getSpaceInfo(key);
  if (!space.homepageId) throw new Error('스페이스 홈페이지를 찾을 수 없습니다.');
  return { ...space, homepageId: space.homepageId };
}
function member(info: Awaited<ReturnType<Client['getContentInfo']>>, space: { id: string; homepageId: string }) {
  if (info.spaceId !== space.id || (info.id !== space.homepageId && !info.ancestors.some(a => a.id === space.homepageId))) throw new Error('선택한 항목이 스페이스 홈페이지 하위 트리 밖입니다.');
}
function pathOf(info: Awaited<ReturnType<Client['getContentInfo']>>, homepageId: string) {
  if (info.id === homepageId) return '/';
  const index = info.ancestors.findIndex(a => a.id === homepageId);
  return '/' + [...info.ancestors.slice(index + 1).map(a => a.title), info.title].join('/');
}
export type ScopeImpact = { path: string; pageId: string; status: 'outside' | 'rootConflict' | 'pageMove' | 'folderConflict' | 'aligned'; remotePath: string; expectedParent: string | null };
export type ScopeReview = { token: string; previous: Workspace['scope'] | null; next: NonNullable<Workspace['scope']>; workspace: Workspace; summary: { total: number; outside: number; rootConflict: number; pageMove: number; folderConflict: number; aligned: number }; entries: ScopeImpact[]; requiresConfirmation: boolean };
export class ScopeReviewRequired extends Error {
  constructor(public review: ScopeReview) { super('스코프 변경 영향 확인 후 저장이 필요합니다.'); }
}
export async function inspectScopeMapping(client: Client, workspace: Workspace, mapping: Mapping, localFiles: string[], parentMapping: Mapping = mapping): Promise<ScopeImpact[]> {
  const scope = requireScope(workspace), folders = buildFolderIndex(localFiles), entries: ScopeImpact[] = [];
  for (const [key, entry] of Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b))) {
    const info = await client.getContentInfo(entry.pageId);
    const inside = info.spaceId === workspace.connection!.spaceId && (info.id === scope.id || info.ancestors.some(a => a.id === scope.id));
    const dir = key.replace(/\/$/, ''), parentDir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    const parentKey = entry.type === 'folder' ? containerKeyOf(parentDir, folders) : parentKeyOf(key, folders);
    const expectedParent = parentKey ? parentMapping[parentKey]?.pageId ?? null : scope.id;
    let status: ScopeImpact['status'] = !inside ? 'outside' : 'aligned';
    if (info.id === scope.id && (scope.type !== 'page' || key !== 'README.md') || scope.type === 'page' && key === 'README.md' && info.id !== scope.id) status = 'rootConflict';
    else if (inside && info.id !== scope.id && (expectedParent === null || info.ancestors.at(-1)?.id !== expectedParent)) status = entry.type === 'folder' ? 'folderConflict' : 'pageMove';
    entries.push({ path: key, pageId: info.id, status, remotePath: info.spaceId === workspace.connection!.spaceId ? pathOf(info, workspace.connection!.homepageId!) : '(다른 스페이스)', expectedParent });
  }
  return entries;
}
export async function configureScope(base: string, env: Env, input: string, confirmation?: string): Promise<Workspace> {
  const review = await previewScope(base, env, input);
  if (confirmation !== undefined && confirmation !== review.token) throw new Error('스코프나 매핑·폴더 구조가 변경되었습니다. 변경 영향을 다시 확인하세요.');
  if (review.requiresConfirmation && confirmation === undefined) throw new ScopeReviewRequired(review);
  saveWorkspace(base, review.workspace);
  return review.workspace;
}
export async function previewScope(base: string, env: Env, input: string): Promise<ScopeReview> {
  if (!input?.trim() || input.trim() === '.') throw new Error('스코프를 명시적으로 선택하세요. 전체 스페이스는 / 입니다.');
  const client = scopeClient(env);
  const space = await spaceRoot(client, env.spaceKey!);
  let id = space.homepageId;
  if (input.startsWith('id:')) {
    id = input.slice(3);
    if (!/^\d+$/.test(id)) throw new Error('스코프 ID가 올바르지 않습니다.');
  } else if (input !== '/') {
    const segments = input.replace(/^\//, '').split('/');
    if (segments.some(s => !s || s === '.' || s === '..')) throw new Error('스코프는 스페이스 기준 경로여야 합니다.');
    for (const title of segments) {
      const children = [...await client.getChildFolders(id), ...await client.getChildPages(id)].filter(node => node.title === title);
      if (children.length !== 1) throw new Error(`스코프 경로를 유일하게 찾을 수 없습니다: ${title}. id:ID로 선택하세요.`);
      id = children[0].id;
    }
  }
  const info = await client.getContentInfo(id);
  member(info, space);
  const localSnapshot = () => [workspacePath(base), mappingPath(base)].map(path => existsSync(path) ? readFileSync(path, 'utf8') : null);
  const snapshot = localSnapshot();
  const prior = loadWorkspace(base);
  const mapping = loadMapping(mappingPath(base));
  if (Object.keys(mapping).length && prior.connection && (prior.connection.baseUrl.replace(/\/$/, '') !== env.baseUrl!.replace(/\/$/, '') || prior.connection.spaceKey !== env.spaceKey || (prior.connection.spaceId && prior.connection.spaceId !== space.id))) throw new Error('기존 매핑을 다른 사이트·스페이스로 재연결할 수 없습니다. 새 로컬 폴더를 사용하세요.');
  const workspace: Workspace = { version: 2, connection: { baseUrl: env.baseUrl!, spaceKey: env.spaceKey!, spaceId: space.id, homepageId: space.homepageId }, scope: { id, type: info.type, path: pathOf(info, space.homepageId) }, ...(Object.keys(mapping).length ? { scopeCheckRequired: true } : {}) };
  const localFiles = collectMarkdown(base).map(path => relative(base, path).split('\\').join('/')).sort();
  const entries = await inspectScopeMapping(client, workspace, mapping, localFiles);
  const changed = !!prior.scope && prior.scope.id !== id;
  const summary = { total: entries.length, outside: 0, rootConflict: 0, pageMove: 0, folderConflict: 0, aligned: 0 };
  for (const entry of entries) summary[entry.status]++;
  const latestFiles = collectMarkdown(base).map(path => relative(base, path).split('\\').join('/')).sort();
  if (JSON.stringify(snapshot) !== JSON.stringify(localSnapshot()) || JSON.stringify(localFiles) !== JSON.stringify(latestFiles)) throw new Error('검사 중 매핑·폴더 구조가 변경되었습니다. 다시 확인하세요.');
  const token = createHash('sha256').update(JSON.stringify({ base, workspace, prior, snapshot, localFiles, entries })).digest('hex');
  return { token, previous: prior.scope ?? null, next: workspace.scope!, workspace, summary, entries, requiresConfirmation: changed || entries.some(entry => entry.status !== 'aligned') };

}
export async function verifyScope(client: Client, workspace: Workspace): Promise<string> {
  const scope = requireScope(workspace), connection = workspace.connection!;
  const space = await spaceRoot(client, connection.spaceKey);
  if (space.id !== connection.spaceId || space.homepageId !== connection.homepageId) throw new Error('스코프의 스페이스 기준이 변경되었습니다. 다시 설정하세요.');
  const info = await client.getContentInfo(scope.id);
  member(info, space);
  if (info.type !== scope.type) throw new Error('원격 스코프 유형이 변경되었습니다.');
  return space.id;
}
export async function scopeTree(env: Env, parentId?: string) {
  const client = scopeClient(env), space = await spaceRoot(client, env.spaceKey!);
  const parent = await client.getContentInfo(parentId || space.homepageId);
  member(parent, space);
  const children = [...(await client.getChildFolders(parent.id)).map(node => ({ ...node, type: 'folder' as const })), ...(await client.getChildPages(parent.id)).map(node => ({ ...node, type: 'page' as const }))];
  return { parent: { id: parent.id, title: parent.title, type: parent.type, path: pathOf(parent, space.homepageId), parentId: parent.id === space.homepageId ? null : parent.ancestors.at(-1)?.id ?? null }, children: children.map(node => ({ ...node, path: (parent.id === space.homepageId ? '' : pathOf(parent, space.homepageId)) + '/' + node.title })) };
}
