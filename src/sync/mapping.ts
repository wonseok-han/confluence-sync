/**
 * 매핑(파일 경로 ↔ pageId ↔ hash) 영속화.
 * 기본 위치는 <base>/.csync/mapping.json 이며 문서셋과 함께 버전관리된다.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';

import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
export { MAPPING_FILE } from './metadata.js';

export type Mapping = Record<string, { pageId: string; title?: string; hash?: string; localHash?: string; sourceObject?: string; type?: 'page' | 'folder'; remoteVersion?: number; remoteParentId?: string; pendingMove?: { parentKey: string | null } }>;

export function loadMapping(path: string): Mapping {
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error(`매핑 파일을 읽을 수 없습니다: ${path}`); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(entry =>
    !entry || typeof entry.pageId !== 'string' || !entry.pageId ||
    (entry.sourceObject !== undefined && (typeof entry.sourceObject !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sourceObject))) ||
    (entry.localHash !== undefined && (typeof entry.localHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.localHash))) ||
    (entry.remoteParentId !== undefined && (typeof entry.remoteParentId !== 'string' || !entry.remoteParentId)) ||
    (entry.remoteVersion !== undefined && (!Number.isInteger(entry.remoteVersion) || entry.remoteVersion < 1)))) {
    throw new Error(`잘못된 매핑 파일: ${path}`);
  }
  const ids = Object.values(data).map(entry => entry.pageId);
  if (new Set(ids).size !== ids.length) throw new Error(`매핑 pageId 중복: ${path}`);
  return data as Mapping;
}

export function saveMapping(path: string, m: Mapping): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(m, null, 2) + '\n', {flag:'wx',mode:0o600});
    renameSync(temporary,path);
  } finally {rmSync(temporary,{force:true});}
}
