/**
 * 동기화 제외 규칙. base 루트의 .confluence-syncignore(.gitignore 방식) + --exclude 옵션.
 * 매칭은 npm `ignore`(gitignore 스펙) 사용. 경로는 base 기준 상대(POSIX).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ignore from 'ignore';

export const IGNORE_FILE = '.confluence-syncignore';

export type Ignorer = {
  ignores: (rel: string) => boolean;
  /** 패턴 소스가 하나라도 있으면 true(없으면 제외 없음) */
  active: boolean;
};

export function buildIgnorer(baseDir: string, excludes: string[]): Ignorer {
  const ig = ignore();
  let active = false;
  const file = join(baseDir, IGNORE_FILE);
  if (existsSync(file)) { ig.add(readFileSync(file, 'utf8')); active = true; }
  if (excludes.length) { ig.add(excludes); active = true; }
  return {
    ignores: (rel) => active && ig.ignores(rel),
    active,
  };
}
