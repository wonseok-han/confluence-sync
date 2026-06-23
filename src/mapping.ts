/**
 * 매핑(파일 경로 ↔ pageId ↔ hash) 영속화.
 * 기본 위치는 <base>/.confluence-sync.json 이며 문서셋과 함께 버전관리된다.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export type Mapping = Record<string, { pageId: string; title?: string; hash?: string; type?: 'page' | 'folder' }>;

export function loadMapping(path: string): Mapping {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function saveMapping(path: string, m: Mapping): void {
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
}
