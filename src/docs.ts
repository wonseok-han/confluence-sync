/**
 * 문서 수집과 폴더=계층 구조 계산. 모든 키는 baseDir 기준 상대경로다.
 * 폴더의 README.md 가 대표 페이지가 되고 같은 폴더의 다른 문서는 그 자식이 된다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative, basename, dirname } from 'node:path';
import { splitTitleAndBody } from './markdown.js';
import { splitFrontmatter, type Frontmatter } from './obsidian.js';
import {
  buildAnchorIndex, collectHeadings, collectLinkAnchors, wikilinkAnchorToSlug,
  decodeAnchor, type LinkAnchor,
} from './anchors.js';

/**
 * 숨김 디렉토리는 문서가 아니다. Obsidian vault 의 `.obsidian/`(설정)·`.trash/`(휴지통) 과
 * `.git/`·`node_modules/` 가 여기서 걸러진다.
 */
const skipDir = (name: string) => name.startsWith('.') || name === 'node_modules';

/** dir 이하의 파일 절대경로를 재귀 수집(pick 이 true 인 것만). */
function walk(dir: string, pick: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDir(entry.name)) out.push(...walk(full, pick));
    } else if (entry.isFile() && pick(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const isMd = (name: string) => name.toLowerCase().endsWith('.md');

/** dir 이하의 모든 .md 절대경로를 재귀 수집 */
export function collectMarkdown(dir: string): string[] {
  return walk(dir, isMd);
}

/** dir 이하의 .md 가 아닌 파일(이미지 등 첨부 후보) 절대경로를 재귀 수집 */
export function collectAssets(dir: string): string[] {
  return walk(dir, (n) => !isMd(n));
}

/**
 * 문서 1건을 읽어 제목·본문·frontmatter 로 분해한다.
 * 제목 우선순위: frontmatter `title` > 첫 H1 > 파일명. H1 은 어느 경우든 본문에서 제거된다
 * (Confluence 는 페이지 제목을 따로 가지므로 본문에 남으면 제목이 두 번 보인다).
 */
export type Doc = {
  title: string;
  body: string;
  fm: Frontmatter;
  /** 슬러그 → 헤딩 텍스트 */
  anchors: Map<string, string>;
  /** 본문(H1 제거 후) 헤딩들의 슬러그, 문서 순서대로 — 렌더 중 헤딩과 1:1로 맞춘다 */
  bodySlugs: string[];
  /** 이 문서가 섹션을 가리키는 링크들 */
  linkAnchors: LinkAnchor[];
};

export function readDoc(baseDir: string, rel: string): Doc {
  const { data, body: afterFm } = splitFrontmatter(readFileSync(resolve(baseDir, rel), 'utf8'));
  // 앵커 사전은 H1 을 **포함해** 만든다 — GitHub 이 중복 슬러그에 -1·-2 를 붙이는 순서와 맞추기 위해서다.
  // (H1 자체를 가리키는 링크는 Confluence 에서 페이지 최상단이 된다)
  const all = collectHeadings(afterFm);
  const anchors = buildAnchorIndex(afterFm);
  const { title, body } = splitTitleAndBody(afterFm, basename(rel).replace(/\.md$/i, ''));
  // splitTitleAndBody 가 본문에서 첫 H1 을 지우므로 슬러그 목록에서도 같은 것을 뺀다
  const dropped = all.findIndex((h) => h.level === 1);
  return {
    title: (data.title || title).trim(),
    body,
    fm: data,
    anchors,
    bodySlugs: all.filter((_, i) => i !== dropped).map((h) => h.slug),
    linkAnchors: collectLinkAnchors(afterFm),
  };
}

/** base 상대 경로 → 제목·앵커 인덱스(링크와 섹션 링크를 해석하는 데 둘 다 필요하다) */
export function buildDocIndex(
  rels: string[],
  baseDir: string,
): {
  titles: Record<string, string>;
  anchors: Record<string, Map<string, string>>;
  docs: Record<string, Doc>;
} {
  const titles: Record<string, string> = {};
  const anchors: Record<string, Map<string, string>> = {};
  const docs: Record<string, Doc> = {};
  for (const rel of rels) {
    const doc = readDoc(baseDir, rel);
    titles[rel] = doc.title;
    anchors[rel] = doc.anchors;
    docs[rel] = doc;
  }
  return { titles, anchors, docs };
}

/** `a/b/../c.md` 같은 상대 이동을 정리해 base 상대 경로로 만든다. */
function normalizeRel(dir: string, dest: string): string | null {
  const parts = (dir ? `${dir}/${dest}` : dest).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (!out.length) return null; // base 밖
      out.pop();
    } else out.push(p);
  }
  return out.join('/');
}

/**
 * 어느 문서의 어느 헤딩이 **실제로 링크 대상인지** 모은다.
 * Confluence 가 헤딩에 붙이는 id 에 기대지 않고 Anchor 매크로로 이름을 심을 것이므로,
 * 심을 곳을 알아야 한다. 아무도 가리키지 않는 헤딩에는 매크로를 넣지 않는다(페이지를 깨끗하게 유지).
 */
export function resolveAnchorTargets(
  docs: Record<string, Doc>,
  vault: Vault,
): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const [rel, doc] of Object.entries(docs)) {
    const dir = dirname(rel) === '.' ? '' : dirname(rel);
    for (const la of doc.linkAnchors) {
      let target: string | null;
      let slug: string | null;

      if (la.wiki) {
        target = vault.notes[la.dest.toLowerCase().replace(/\.md$/i, '')] ?? null;
        slug = wikilinkAnchorToSlug(la.fragment);
      } else {
        target = la.dest === '' ? rel : normalizeRel(dir, decodeAnchor(la.dest));
        if (target && !/\.md$/i.test(target)) target = null;
        slug = decodeAnchor(la.fragment).toLowerCase();
      }

      if (!target || !slug) continue;
      // 실제로 존재하는 헤딩만 — 없는 앵커는 markdown.ts 가 경고로 잡는다
      if (!docs[target]?.anchors.has(slug)) continue;
      (out[target] ??= new Set()).add(slug);
    }
  }
  return out;
}

/** vault 안에서 [[wikilink]] 대상을 찾기 위한 이름 인덱스. */
export type Vault = { notes: Record<string, string>; assets: Record<string, string> };

/**
 * wikilink 대상 이름 → base 상대 경로 인덱스.
 * Obsidian 은 `[[파일명]]`(짧은 이름)과 `[[폴더/파일명]]`(경로) 을 모두 허용하므로 둘 다 등록한다.
 * 짧은 이름이 겹치면 경로가 사전순으로 앞서는 쪽이 이긴다(Obsidian 의 "가장 가까운 것" 규칙과는 다르지만 결정적이다).
 */
export function buildVault(mdRels: string[], assetRels: string[]): Vault {
  const index = (rels: string[], stripExt: boolean): Record<string, string> => {
    const idx: Record<string, string> = {};
    for (const rel of [...rels].sort()) {
      const withoutExt = stripExt ? rel.replace(/\.md$/i, '') : rel;
      for (const key of [withoutExt, basename(withoutExt)]) {
        const k = key.toLowerCase();
        if (!(k in idx)) idx[k] = rel; // 먼저 등록된(사전순 앞선) 것이 이긴다
      }
    }
    return idx;
  };
  return { notes: index(mdRels, true), assets: index(assetRels, false) };
}

/** 파일(rel) 기준으로 wikilink 대상을 상대경로로 풀어주는 resolver. */
export function vaultResolver(rel: string, vault: Vault) {
  const dir = dirname(rel) === '.' ? '' : dirname(rel);
  return (target: string, embed: boolean): string | null => {
    const key = target.toLowerCase().replace(/\.md$/i, '');
    // 임베드(![[...]])는 대개 이미지, 링크([[...]])는 대개 노트 → 각자 먼저 찾아본다
    const hit = embed
      ? (vault.assets[target.toLowerCase()] ?? vault.notes[key])
      : (vault.notes[key] ?? vault.assets[target.toLowerCase()]);
    if (!hit) return null;
    const r = relative(dir || '.', hit).split('\\').join('/');
    return r || null;
  };
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
