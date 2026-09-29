/** Read-only link lookup across independently synchronized document roots. */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'dotenv';
import { collectMarkdown } from '../documents/catalog.js';
import { buildIgnorer } from './ignore.js';
import { MAPPING_FILE, type Mapping } from './mapping.js';

const key = (s: string) => s.normalize('NFC').toLowerCase();
const slash = (s: string) => s.split('\\').join('/');
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
type Candidate = { root: string; rel: string; local: boolean; pageId?: string };
export function referenceRoots(base: string, roots: string[]): string[] {
  const own = realpathSync(base);
  return [...new Set(roots.map(root => {
    const path = realpathSync(resolve(root));
    if (!statSync(path).isDirectory() || dirname(path) === path) throw new Error('참조 문서 폴더를 확인하세요: ' + root);
    const rel = slash(relative(own, path));
    if (rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) throw new Error('참조 폴더는 업로드 기준 폴더 밖에 있어야 합니다: ' + root);
    return path;
  }))].filter(root => root !== own);
}
export function buildReferenceLookup(base: string, rels: string[], roots: string[], baseUrl?: string) {
  const candidates: Candidate[] = rels.map(rel => ({ root: base, rel, local: true }));
  const server = baseUrl?.replace(/\/$/, '');
  for (const root of referenceRoots(base, roots)) {
    const envPath = join(root, '.env');
    const configured = existsSync(envPath) ? parse(readFileSync(envPath)).CONFLUENCE_BASE_URL?.replace(/\/$/, '') : undefined;
    if (configured && configured !== server) throw new Error('참조 폴더의 Confluence 서버가 현재 설정과 다릅니다: ' + root);
    let mapping: Mapping = {};
    const path = join(root, MAPPING_FILE);
    if (existsSync(path)) {
      mapping = JSON.parse(readFileSync(path, 'utf8'));
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
        || Object.values(mapping).some(v => !v || typeof v.pageId !== 'string')) throw new Error('참조 페이지 매핑이 올바르지 않습니다: ' + path);
    }
    const ignorer = buildIgnorer(root, []);
    for (const file of collectMarkdown(root)) {
      // Overlapping roots must not create duplicate candidates or export ignored local documents.
      const fromBase = slash(relative(realpathSync(base), file));
      if (fromBase !== '..' && !fromBase.startsWith('../') && !isAbsolute(fromBase)) continue;
      const rel = slash(relative(root, file));
      if (!ignorer.ignores(rel)) candidates.push({ root, rel, local: false, pageId: mapping[rel]?.pageId });
    }
  }
  const unique = [...new Map(candidates.map(c => [realpathSync(join(c.root, c.rel)), c])).values()];
  function find(from: string, raw: string, wiki: boolean): Candidate[] {
    const target = decode(raw).replace(/\.md$/i, '') + '.md';
    const exact = wiki ? target : slash(relative(base, resolve(base, dirname(from), target)));
    const local = unique.filter(c => c.local && key(c.rel) === key(exact));
    if (local.length) return local;
    const refs = unique.filter(c => !c.local && key(c.rel) === key(target));
    if (refs.length) return refs;
    return unique.filter(c => key(basename(c.rel)) === key(basename(slash(target))));
  }
  return {
    localTarget(from: string, target: string, wiki: boolean) {
      const hits = find(from, target, wiki);
      return hits.length === 1 && hits[0].local ? hits[0].rel : null;
    },
    resolve(from: string, target: string, wiki: boolean, warn: (message: string) => void, linked: (message: string) => void = () => {}): string | null {
      const hits = find(from, target, wiki);
      if (hits.length !== 1) {
        warn(hits.length ? `중복 문서 링크: ${target} → ${hits.map(c => join(c.root, c.rel)).join(', ')}` : `대상 없는 문서 링크: ${target}`);
        return null;
      }
      const hit = hits[0];
      if (hit.local) return slash(relative(dirname(from), hit.rel));
      if (!hit.pageId || !/^\d+$/.test(hit.pageId)) { warn(`게시 매핑 없는 문서 링크: ${target} → ${join(hit.root, hit.rel)}`); return null; }
      if (!server || !/^https?:\/\//i.test(server)) { warn(`참조 링크에 CONFLUENCE_BASE_URL이 필요합니다: ${target}`); return null; }
      linked(`${target} → pageId ${hit.pageId} (${join(hit.root, hit.rel)})`);
      return `${server}/pages/viewpage.action?pageId=${encodeURIComponent(hit.pageId)}`;
    },
  };
}
