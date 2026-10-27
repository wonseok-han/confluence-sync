/** Local work selection with a stable space-root connection. */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '../confluence/client.js';
import type { Env } from '../confluence/config.js';
import { loadWorkspace, saveWorkspace, scopePath, assertWorkspaceConnection, requireScope, inNestedWorkspace, type Workspace } from './workspace.js';

type Client = ReturnType<typeof createClient>;
export function scopeClient(env: Env): Client {
  if (!env.baseUrl || !env.email || !env.token || !env.spaceKey) throw new Error('사이트·계정·API 토큰·스페이스 설정이 필요합니다.');
  const url = new URL(env.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Confluence BASE_URL은 인증정보·쿼리가 없는 HTTPS 주소여야 합니다.');
  return createClient({baseUrl:env.baseUrl,email:env.email,token:env.token},{force:false,verify:false,requestTimeoutMs:20_000});
}
export async function configureScope(base: string, env: Env, input: string): Promise<Workspace> {
  if (!input?.trim()) throw new Error('스코프를 직접 선택하세요. 전체는 / 입니다.');
  const path = input === '/' ? '.' : scopePath(base, input);
  const target = resolve(base, path);
  if (!existsSync(target)) throw new Error('기준 폴더 안에 존재하는 파일·폴더를 스코프로 선택하세요. 처음 Pull할 때는 /를 선택하세요.');
  const info = statSync(target);
  if (!info.isFile() && !info.isDirectory()) throw new Error('일반 파일·폴더만 스코프로 선택할 수 있습니다.');
  const type = info.isDirectory() ? 'folder' : 'file';
  if (type === 'file' && !/\.md$/i.test(target)) throw new Error('파일 스코프는 Markdown 파일이어야 합니다.');
  if (inNestedWorkspace(base, type === 'folder' ? path + '/.boundary' : path)) throw new Error('독립된 하위 작업공간은 해당 기준 폴더에서 관리하세요.');
  const prior = loadWorkspace(base);
  if (prior.connection) assertWorkspaceConnection(prior,env);
  let connection = prior.connection;
  if (!connection?.spaceId || !connection.homepageId) {
    const client = scopeClient(env), space = await client.getSpaceInfo(env.spaceKey!);
    if (!space.homepageId) throw new Error('스페이스 홈페이지를 찾을 수 없습니다.');
    connection = {baseUrl:env.baseUrl!,spaceKey:env.spaceKey!,spaceId:space.id,homepageId:space.homepageId};
  }
  const workspace: Workspace = {version:2,connection,remoteRoot:{id:connection.homepageId!,type:'page',path:'/'},scope:{path,type}};
  saveWorkspace(base,workspace);
  return workspace;
}
export async function verifyScope(client: Client, workspace: Workspace): Promise<string> {
  const root = requireScope(workspace), connection = workspace.connection!;
  const space = await client.getSpaceInfo(connection.spaceKey);
  if (space.id !== connection.spaceId || space.homepageId !== connection.homepageId) throw new Error('스페이스 연결 기준이 변경되었습니다. 다시 설정하세요.');
  const info = await client.getContentInfo(root.id);
  if (info.spaceId !== space.id || info.type !== root.type) throw new Error('스페이스 루트 연결이 변경되었습니다.');
  return space.id;
}
