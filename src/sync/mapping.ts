/**
 * 매핑(파일 경로 ↔ pageId ↔ hash) 영속화.
 * 기본 위치는 <base>/.confluence-sync.json 이며 문서셋과 함께 버전관리된다.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** base 루트에 놓이는 매핑 파일 이름. 이 파일이 있는 곳이 곧 동기화 루트다. */
export const MAPPING_FILE = '.confluence-sync.json';

export type Mapping = Record<string, { pageId: string; title?: string; hash?: string; type?: 'page' | 'folder'; remoteVersion?: number; pendingMove?: { parentKey: string | null } }>;

export function loadMapping(path: string): Mapping {
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error(`매핑 파일을 읽을 수 없습니다: ${path}`); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(entry =>
    !entry || typeof entry.pageId !== 'string' || !entry.pageId ||
    (entry.remoteVersion !== undefined && (!Number.isInteger(entry.remoteVersion) || entry.remoteVersion < 1)))) {
    throw new Error(`잘못된 매핑 파일: ${path}`);
  }
  const ids = Object.values(data).map(entry => entry.pageId);
  if (new Set(ids).size !== ids.length) throw new Error(`매핑 pageId 중복: ${path}`);
  return data as Mapping;
}

export function saveMapping(path: string, m: Mapping): void {
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
}
