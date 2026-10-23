/** Explicit remote scope selection, shared by CLI and web. Reads metadata, never content bodies. */
import { mkdirSync } from 'node:fs';
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
export async function configureScope(base: string, env: Env, input: string): Promise<Workspace> {
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
  const prior = loadWorkspace(base);
  const mapping = loadMapping(mappingPath(base));
  if (info.type === 'page' && mapping['README.md'] && mapping['README.md'].pageId !== id) throw new Error('루트 README.md가 선택한 스코프 페이지와 다릅니다. 기존 파일과 매핑을 먼저 확인하거나 새 로컬 폴더를 사용하세요.');
  if (Object.keys(mapping).length && prior.connection && (prior.connection.baseUrl.replace(/\/$/, '') !== env.baseUrl!.replace(/\/$/, '') || prior.connection.spaceKey !== env.spaceKey)) throw new Error('기존 매핑을 다른 사이트·스페이스로 재연결할 수 없습니다. 새 로컬 폴더를 사용하세요.');
  if (prior.scope && prior.scope.id !== id && Object.keys(mapping).length) throw new Error('기존 매핑이 있는 작업공간의 스코프는 변경할 수 없습니다. 별도 로컬 폴더를 사용하세요.');
  const checker = createClient({ baseUrl: env.baseUrl!, email: env.email!, token: env.token! }, { force: false, verify: false, scope: { id, spaceId: space.id } });
  for (const [key, entry] of Object.entries(mapping)) {
    await checker.assertInScope(entry.pageId);
    if (entry.pageId === id && (info.type !== 'page' || key !== 'README.md')) throw new Error('스코프 루트의 기존 로컬 매핑 경로를 먼저 확인하세요.');
  }
  const workspace: Workspace = { version: 2, connection: { baseUrl: env.baseUrl!, spaceKey: env.spaceKey!, spaceId: space.id, homepageId: space.homepageId }, scope: { id, type: info.type, path: pathOf(info, space.homepageId) } };
  mkdirSync(base, { recursive: true }); saveWorkspace(base, workspace);
  return workspace;
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
