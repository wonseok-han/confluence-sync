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

/**
 * 부모 결정(base 상대):
 * - base 직계 파일 → null(루트: CONFLUENCE_PARENT_PAGE_ID)
 * - 폴더 대표 README → null(루트 바로 아래)
 * - 폴더 내 일반 파일 → 같은 폴더의 대표 README
 */
export function parentKeyOf(rel: string, folderIndex: Record<string, string>): string | null {
  const parts = rel.split('/');
  if (parts.length === 1) return null;
  if (isReadme(parts[parts.length - 1])) return null;
  return folderIndex[parts.slice(0, -1).join('/')] ?? null;
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

/** 선택된 문서의 부모 README 들을 재귀적으로 포함(부모 pageId 확보용) */
export function withParents(selected: string[], folderIndex: Record<string, string>): string[] {
  const out = new Set(selected);
  for (const rel of selected) {
    let pk = parentKeyOf(rel, folderIndex);
    while (pk && !out.has(pk)) { out.add(pk); pk = parentKeyOf(pk, folderIndex); }
  }
  return [...out];
}
