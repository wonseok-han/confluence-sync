/**
 * 문서 수집과 폴더=계층 구조 계산. 모든 키는 baseDir 기준 상대경로다.
 * 폴더의 README.md 가 대표 페이지가 되고 같은 폴더의 다른 문서는 그 자식이 된다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { splitTitleAndBody } from './markdown.js';

/** dir 이하의 모든 .md 절대경로를 재귀 수집 */
export function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** base 상대 경로 → 문서 제목(첫 H1) 인덱스 */
export function buildTitleIndex(rels: string[], baseDir: string): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const rel of rels) {
    const { title } = splitTitleAndBody(readFileSync(resolve(baseDir, rel), 'utf8'), rel);
    idx[rel] = title;
  }
  return idx;
}

const isReadme = (base: string) => /README\.md$/.test(base);

/** 폴더 경로 → 그 폴더의 대표 README(base 상대) 인덱스 */
export function buildFolderIndex(rels: string[]): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const p of rels) {
    const parts = p.split('/');
    if (isReadme(parts[parts.length - 1])) idx[parts.slice(0, -1).join('/')] = p;
  }
  return idx;
}

const parentDirOf = (dir: string) => (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');

/**
 * dir 의 직계 자식을 담는 "컨테이너"의 mapping 키.
 * - 루트('') → null (CONFLUENCE_PARENT_ID)
 * - README 가 있는 폴더 → 그 README 페이지 키
 * - README 가 없는 폴더 → 폴더 노드 키(`<dir>/`, 끝에 슬래시로 구분)
 */
export function containerKeyOf(dir: string, folderIndex: Record<string, string>): string | null {
  if (dir === '') return null;
  return folderIndex[dir] ?? `${dir}/`;
}

/**
 * 부모 결정(base 상대): 컨테이너 모델.
 * - 일반 파일 → 자신이 속한 dir 의 컨테이너
 * - 폴더 대표 README → 그 폴더의 "부모 dir" 컨테이너(README 는 자기 폴더를 대표하므로)
 */
export function parentKeyOf(rel: string, folderIndex: Record<string, string>): string | null {
  const parts = rel.split('/');
  const dir = parts.slice(0, -1).join('/');
  return isReadme(parts[parts.length - 1])
    ? containerKeyOf(parentDirOf(dir), folderIndex)
    : containerKeyOf(dir, folderIndex);
}

/** README 가 없어 Confluence 폴더로 만들어야 하는 dir 들(파일들의 모든 상위 dir 중 folderIndex 에 없는 것). */
export function neededFolderDirs(rels: string[], folderIndex: Record<string, string>): string[] {
  const set = new Set<string>();
  for (const rel of rels) {
    let dir = parentDirOf(rel);
    while (dir !== '') {
      if (!folderIndex[dir]) set.add(dir);
      dir = parentDirOf(dir);
    }
  }
  return [...set];
}

/** README(폴더 대표)를 폴더 맨 앞에, 나머지는 파일명순 → 부모가 자식보다 먼저 */
function sortKey(rel: string): string {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');
  const leaf = isReadme(base) ? '' : base;
  return dir === '' ? leaf : dir + '/' + leaf;
}

export function sortForSync(rels: string[]): string[] {
  return [...rels].sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** 선택 경로(positionals)를 base 상대 키 집합으로 확장(디렉토리는 하위 .md 전부) */
export function resolveSelection(rels: string[], positionals: string[], baseDir: string): string[] {
  const set = new Set<string>();
  for (const p of positionals) {
    const abs = resolve(baseDir, p);
    const relToBase = relative(baseDir, abs);
    if (relToBase.startsWith('..')) {
      console.error(`  ⚠ base 밖 경로 무시: ${p}`);
      continue;
    }
    const matched = rels.filter((r) => r === relToBase || r.startsWith(relToBase + '/'));
    if (matched.length === 0) console.error(`  ⚠ 매칭되는 문서 없음: ${p}`);
    matched.forEach((m) => set.add(m));
  }
  return [...set];
}

/** 선택된 문서의 상위 폴더 대표 README 들을 포함(부모 pageId 확보용). 폴더 노드는 neededFolderDirs 로 따로 생성. */
export function withParents(selected: string[], folderIndex: Record<string, string>): string[] {
  const out = new Set(selected);
  for (const rel of selected) {
    let dir = parentDirOf(rel);
    while (dir !== '') {
      if (folderIndex[dir]) out.add(folderIndex[dir]);
      dir = parentDirOf(dir);
    }
  }
  return [...out];
}
