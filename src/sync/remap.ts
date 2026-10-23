/** Local-only pageId-based mapping reconciliation. Never contacts Confluence. */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { positionalArgs } from '../cli/args.js';
import { collectMarkdown, readDoc, buildFolderIndex, parentKeyOf } from '../documents/catalog.js';
import { buildIgnorer } from './ignore.js';
import { resolveSyncBase, loadWorkspace, inScope, inNestedWorkspace, requireScope } from './workspace.js';
import { mappingPath } from './metadata.js';
import { saveMapping, type Mapping } from './mapping.js';

function readMapping(path: string): Mapping {
  if (!existsSync(path)) return {};
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`잘못된 매핑: ${path}`);
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object' || typeof (value as any).pageId !== 'string') {
      throw new Error(`잘못된 매핑 항목: ${key}`);
    }
    const id = (value as Mapping[string]).pageId;
    if (ids.has(id)) throw new Error(`매핑 pageId 중복: ${id}`);
    ids.add(id);
  }
  return data;
}

export async function runRemap(argv: string[]): Promise<void> {
  const values = new Set(['--base', '--mapping', '--from-mapping', '--exclude']);
  const opts: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (values.has(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다.`);
      (opts[arg] ??= []).push(value);
    } else if (arg !== 'remap' && arg !== '--dry-run') throw new Error(`remap: 지원하지 않는 인자 ${arg}`);
  }
  if (positionalArgs(argv).length !== 1) throw new Error('remap은 --base 전체를 대상으로 실행합니다.');
  const baseInput = resolveSyncBase(opts['--base']?.[0]);
  if (!baseInput) throw new Error('remap: --base <dir> 또는 CONFLUENCE_SYNC_BASE가 필요합니다.');
  const base = resolve(baseInput);
  const workspace = loadWorkspace(base);
  const scope = requireScope(workspace);
  const output = resolve(opts['--mapping']?.[0] ?? mappingPath(base));
  const source = opts['--from-mapping']?.[0];
  if (source && !existsSync(resolve(source))) throw new Error(`원본 매핑이 없습니다: ${source}`);
  const mapping = readMapping(output);
  if (source) for (const [key, entry] of Object.entries(readMapping(resolve(source)))) {
    if (Object.values(mapping).some(e => e.pageId === entry.pageId)) continue;
    if (mapping[key] && mapping[key].pageId !== entry.pageId) throw new Error(`매핑 충돌: ${key}`);
    mapping[key] ??= entry;
  }
  const ignorer = buildIgnorer(base, opts['--exclude'] ?? []);
  const files = collectMarkdown(base).map(f => relative(base, f).split('\\').join('/')).filter(f => !ignorer.ignores(f) && inScope(f, workspace) && !inNestedWorkspace(base, f)).sort();
  const folders = buildFolderIndex(files);
  const byId = new Map<string, [string, Mapping[string]]>();
  for (const [key, entry] of Object.entries(mapping)) {
    if (byId.has(entry.pageId)) throw new Error(`매핑 pageId 중복: ${entry.pageId}`);
    byId.set(entry.pageId, [key, entry]);
  }
  const docs = files.map(key => ({ key, doc: readDoc(base, key) }));
  const seen = new Set<string>();
  const next: Mapping = structuredClone(mapping);
  const updates: [string, Mapping[string]][] = [];
  for (const { key, doc } of docs) {
    const id = doc.fm.pageId ?? mapping[key]?.pageId;
    if (!id) { console.log(`미연결: ${key} (pageId 없음)`); continue; }
    if (seen.has(id)) throw new Error(`문서 pageId 중복: ${id}`);
    seen.add(id);
    if (mapping[key] && mapping[key].pageId !== id) throw new Error(`pageId 충돌: ${key}`);
    const prior = byId.get(id);
    if (prior?.[1].type === 'folder') throw new Error(`폴더 ID를 문서에 사용할 수 없습니다: ${key}`);
    if (id === scope.id && (scope.type !== 'page' || key !== 'README.md')) throw new Error('스코프 루트의 매핑 경로는 README.md로 유지해야 합니다.');
    if (scope.type === 'page' && key === 'README.md') {
      if (id !== scope.id) throw new Error('루트 README.md의 pageId가 선택한 스코프와 다릅니다.');
      console.log('스코프 루트 유지: README.md'); continue;
    }
    if (prior) delete next[prior[0]];
    const entry = { ...(prior?.[1] ?? { pageId: id, title: doc.title }), pendingMove: { parentKey: parentKeyOf(key, folders) } };
    updates.push([key, entry]);
    console.log(`${prior?.[0] ?? `#${id}`} → ${key} (부모: ${entry.pendingMove.parentKey ?? 'ROOT'})${entry.hash ? '' : ' — 기존 해시 없음: sync 시 본문 갱신 대상'}`);
  }
  for (const [key, entry] of updates) next[key] = entry;
  if (!argv.includes('--dry-run')) saveMapping(output, next);
  console.log(`${argv.includes('--dry-run') ? '미리보기' : '매핑 저장'}: ${output} (${updates.length}건). Confluence 호출 없음.`);
}
