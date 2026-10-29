/** Shared workspace identity and persistent sync boundaries. No network access. */
import { existsSync, readFileSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { parse } from 'dotenv';
import { workspacePath, hasMetadata } from './metadata.js';
import type { Env } from '../confluence/config.js';

export { WORKSPACE_FILE } from './metadata.js';
export type Workspace = {
  version: 1 | 2;
  scope?: { path: string; type: 'file' | 'folder' };
  remoteRoot?: { id: string; type: 'page' | 'folder'; path: string };
  scopeCheckRequired?: boolean;
  syncPaths?: string[];
  connection?: { baseUrl: string; spaceKey: string; spaceId?: string; homepageId?: string };
  root?: { id: string; type: 'page' | 'folder'; baseUrl: string; spaceKey: string };
};

export function within(base: string, path: string): boolean {
  const rel = relative(base, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}
export function findSyncBase(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (hasMetadata(dir)) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}
export function resolveSyncBase(explicit?: string): string | undefined {
  if (explicit) return resolve(explicit);
  if (process.env.CONFLUENCE_SYNC_BASE) return resolve(process.env.CONFLUENCE_SYNC_BASE);
  const found = findSyncBase(process.cwd());
  if (found) return found;
  const envPath = join(process.cwd(), '.env');
  const value = existsSync(envPath) ? parse(readFileSync(envPath)).CONFLUENCE_SYNC_BASE : undefined;
  return value ? resolve(value) : undefined;
}
export function loadWorkspace(base: string): Workspace {
  const path = workspacePath(base);
  if (!existsSync(path)) return { version: 1 };
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || ![1, 2].includes(value.version) ||
      (value.syncPaths !== undefined && (!Array.isArray(value.syncPaths) || !value.syncPaths.length || value.syncPaths.some((p: unknown) => typeof p !== 'string' || !p))) ||
      (value.root !== undefined && (!value.root || typeof value.root.id !== 'string' || !value.root.id || !['page', 'folder'].includes(value.root.type) || typeof value.root.baseUrl !== 'string' || typeof value.root.spaceKey !== 'string'))) {
    throw new Error(`잘못된 작업공간 설정: ${path}`);
  }
  // Read the old remote-scope shape without treating it as a selected local range.
  if (value.scope?.id) { value.remoteRoot = value.scope; delete value.scope; }
  for (const path of value.syncPaths ?? []) if (scopePath(base, path) !== path) throw new Error(`관리 범위는 정규화된 상대 경로여야 합니다: ${path}`);
  if (value.scopeCheckRequired !== undefined && typeof value.scopeCheckRequired !== 'boolean') throw new Error('잘못된 스코프 검증 설정입니다.');
  if (value.connection && (typeof value.connection.baseUrl !== 'string' || typeof value.connection.spaceKey !== 'string')) throw new Error('잘못된 연결 설정입니다.');
  if (value.scope && (!['file', 'folder'].includes(value.scope.type) || typeof value.scope.path !== 'string' || scopePath(base, value.scope.path) !== value.scope.path)) throw new Error('로컬 스코프가 올바르지 않습니다. 기준 폴더 안의 파일·폴더를 지정하세요.');
  if (value.version === 2 && (!value.remoteRoot || typeof value.remoteRoot.id !== 'string' || !value.remoteRoot.id || !['page','folder'].includes(value.remoteRoot.type) || typeof value.remoteRoot.path !== 'string' || !value.remoteRoot.path.startsWith('/') ||
      !value.connection?.baseUrl || !value.connection.spaceKey || !value.connection.spaceId || !value.connection.homepageId)) throw new Error('스페이스 연결이 올바르지 않습니다. csync init --connect로 다시 연결하세요.');
  delete value.scope;
  delete value.syncPaths;
  return value;
}
export function saveWorkspace(base: string, value: Workspace): void {
  const path = workspacePath(base);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
export function scopePath(base: string, path: string): string {
  const abs = resolve(base, path);
  if (!within(base, abs)) throw new Error(`관리 범위가 작업공간 밖입니다: ${path}`);
  let ancestor = abs;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  if (existsSync(base) && !within(realpathSync(base), realpathSync(ancestor))) throw new Error(`관리 범위가 작업공간 밖입니다: ${path}`);
  return relative(base, abs).split('\\').join('/') || '.';
}
/** The workspace root is the whole managed space; individual Push selection is separate. */
export function inScope(_rel: string, workspace: Workspace): boolean {
  return workspace.version === 2 && !!workspace.remoteRoot && !!workspace.connection;
}
export function requireScope(workspace: Workspace): NonNullable<Workspace['remoteRoot']> {
  if (workspace.version !== 2 || !workspace.remoteRoot || !workspace.connection) throw new Error('스페이스 연결이 없습니다. csync init --connect로 기준 폴더를 연결하거나 최초 Pull을 실행하세요.');
  return workspace.remoteRoot;
}
export function assertWorkspaceConnection(workspace: Workspace, env: Env): void {
  const connection = workspace.connection;
  if (connection && (connection.baseUrl.replace(/\/$/, '') !== env.baseUrl?.replace(/\/$/, '') || connection.spaceKey !== env.spaceKey)) {
    throw new Error('작업공간의 Confluence 사이트·스페이스가 현재 설정과 다릅니다.');
  }
}
/** Nested workspaces are independent; never traverse them from an outer sync. */
export function inNestedWorkspace(base: string, rel: string): boolean {
  for (let dir = dirname(resolve(base, rel)); dir !== base && within(base, dir); dir = dirname(dir)) {
    if (hasMetadata(dir)) return true;
  }
  return false;
}
