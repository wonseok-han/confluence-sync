import { loadMapping } from './mapping.js';
import { mappingPath } from './metadata.js';
/** Stable space-root connection shared by the CLI and Web. */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '../confluence/client.js';
import type { Env } from '../confluence/config.js';
import { loadWorkspace, saveWorkspace, assertWorkspaceConnection, requireScope, type Workspace } from './workspace.js';

type Client = ReturnType<typeof createClient>;
export function scopeClient(env: Env): Client {
  if (!env.baseUrl || !env.email || !env.token || !env.spaceKey) throw new Error('사이트·계정·API 토큰·스페이스 설정이 필요합니다.');
  const url = new URL(env.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Confluence BASE_URL은 인증정보·쿼리가 없는 HTTPS 주소여야 합니다.');
  return createClient({baseUrl:env.baseUrl,email:env.email,token:env.token},{force:false,verify:false,requestTimeoutMs:20_000});
}
/** Bind a workspace to a space homepage without changing its documents or mapping. */
export async function connectWorkspace(base: string, env: Env): Promise<Workspace> {
  if(!existsSync(base)||!statSync(base).isDirectory())throw new Error('기준 폴더는 존재하는 폴더여야 합니다.');
  const prior=loadWorkspace(base);
  if(prior.connection)assertWorkspaceConnection(prior,env);
  if(prior.version===2&&prior.connection?.spaceId&&prior.connection.homepageId&&prior.remoteRoot){
    // Preserve the existing remote binding. Reconnecting never moves local or remote documents.
    const workspace: Workspace={version:2,connection:prior.connection,remoteRoot:prior.remoteRoot};
    saveWorkspace(base,workspace);return workspace;
  }
  const client=scopeClient(env),space=await client.getSpaceInfo(env.spaceKey!);
  if(!space.homepageId)throw new Error('스페이스 홈페이지를 찾을 수 없습니다.');
  const rootEntry=loadMapping(mappingPath(base))['README.md'];
  if(rootEntry&&rootEntry.pageId!==space.homepageId)throw new Error('루트 README가 다른 원격 페이지에 연결되어 있습니다. 스페이스 전체를 위한 별도 기준 폴더를 사용하세요.');
  const workspace: Workspace={version:2,connection:{baseUrl:env.baseUrl!,spaceKey:env.spaceKey!,spaceId:space.id,homepageId:space.homepageId},remoteRoot:{id:space.homepageId,type:'page',path:'/'}};
  saveWorkspace(base,workspace);return workspace;
}
export async function verifyScope(client: Client, workspace: Workspace): Promise<string> {
  const root = requireScope(workspace), connection = workspace.connection!;
  const space = await client.getSpaceInfo(connection.spaceKey);
  if (space.id !== connection.spaceId || space.homepageId !== connection.homepageId) throw new Error('스페이스 연결 기준이 변경되었습니다. 다시 설정하세요.');
  const info = await client.getContentInfo(root.id);
  if (info.spaceId !== space.id || info.type !== root.type) throw new Error('스페이스 루트 연결이 변경되었습니다.');
  return space.id;
}
