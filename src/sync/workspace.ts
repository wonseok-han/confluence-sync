/** Shared workspace identity and persistent sync boundaries. No network access. */
import { existsSync, readFileSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { parse } from 'dotenv';
import { workspacePath, hasMetadata } from './metadata.js';
import type { Env } from '../confluence/config.js';

export { WORKSPACE_FILE } from './metadata.js';
export type Workspace = {
  version: 1;
  syncPaths?: string[];
  connection?: { baseUrl: string; spaceKey: string };
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
  if (!value || value.version !== 1 ||
      (value.syncPaths !== undefined && (!Array.isArray(value.syncPaths) || !value.syncPaths.length || value.syncPaths.some((p: unknown) => typeof p !== 'string' || !p))) ||
      (value.root !== undefined && (!value.root || typeof value.root.id !== 'string' || !value.root.id || !['page', 'folder'].includes(value.root.type) || typeof value.root.baseUrl !== 'string' || typeof value.root.spaceKey !== 'string'))) {
    throw new Error(`잘못된 작업공간 설정: ${path}`);
  }
  for (const path of value.syncPaths ?? []) if (scopePath(base, path) !== path) throw new Error(`관리 범위는 정규화된 상대 경로여야 합니다: ${path}`);
  if (value.connection && (typeof value.connection.baseUrl !== 'string' || typeof value.connection.spaceKey !== 'string')) throw new Error('잘못된 연결 설정입니다.');
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
export function inScope(rel: string, workspace: Workspace): boolean {
  const key = rel.replace(/\/$/, '');
  return !workspace.syncPaths || workspace.syncPaths.some(path => path === '.' || key === path || key.startsWith(path + '/'));
}
export function assertWorkspaceConnection(workspace: Workspace, env: Env): void {
  const connection = workspace.connection ?? workspace.root;
  if (connection && (connection.baseUrl.replace(/\/$/, '') !== env.baseUrl?.replace(/\/$/, '') || connection.spaceKey !== env.spaceKey)) {
    throw new Error('작업공간의 Confluence 사이트·스페이스가 현재 설정과 다릅니다.');
  }
  if (workspace.root && env.parentId && env.parentId !== workspace.root.id) {
    throw new Error('CONFLUENCE_PARENT_ID가 저장된 작업공간 루트와 다릅니다.');
  }
}
/** Nested workspaces are independent; never traverse them from an outer sync. */
export function inNestedWorkspace(base: string, rel: string): boolean {
  for (let dir = dirname(resolve(base, rel)); dir !== base && within(base, dir); dir = dirname(dir)) {
    if (hasMetadata(dir)) return true;
  }
  return false;
}
