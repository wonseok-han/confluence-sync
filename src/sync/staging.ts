import { green, cyan } from '../shared/colors.js';
import { reconcilePages } from './reconcile.js';
import { localStateHash } from './local-state.js';
import { buildTreeRenderer } from './render.js';
/** Document-level upload selection. Source files are never copied into the index. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { collectMarkdown } from '../documents/catalog.js';
import { docHash } from '../documents/markdown.js';
import { buildIgnorer } from './ignore.js';
import { preparePushTree } from './prepare.js';
import { loadMapping } from './mapping.js';
import { mappingPath, workspacePath } from './metadata.js';
import { loadWorkspace, requireScope, inScope, inNestedWorkspace, resolveSyncBase } from './workspace.js';
import { readEnv } from '../confluence/config.js';
import { positionalArgs } from '../cli/args.js';

type Entry = { source: string; hash: string; reviewRequired?: boolean };
export type StagingRow = { renamed?: boolean; unmapped?: boolean; recoverable?: boolean;path:string;status:string;staged:boolean;stale:boolean;entry:Entry;pageId?:string};
type Index = { version: 2; binding: string; entries: Record<string, Entry> };
type Options = { referenceRoots?: string[]; baseUrl?: string };
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const sourceHash = (base: string, rel: string) => digest(readFileSync(resolve(base, rel)));
function location(base: string) {
  workspacePath(base); // Shared metadata-directory validation, including symlinks.
  const path = join(base, '.csync/index.json');
  try { if (!lstatSync(path).isFile()) throw new Error('업로드 대상 파일은 일반 파일이어야 합니다.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return path;
}
function binding(base: string) {
  const workspace = loadWorkspace(base); requireScope(workspace);
  const identity=[workspace.connection?.baseUrl, workspace.connection?.spaceKey, workspace.connection?.spaceId, workspace.remoteRoot?.id, workspace.remoteRoot?.type];
  return {portable:digest(JSON.stringify(identity)),legacy:digest(JSON.stringify([realpathSync(base),...identity]))};
}
function validPath(rel: string) { return !!rel && !rel.startsWith('/') && !rel.includes('\\') && rel.split('/').every(p => p && p !== '.' && p !== '..') && /\.md$/i.test(rel); }
export function loadIndex(base: string): Index {
  const path = location(base), expected = binding(base);
  if (!existsSync(path)) return { version: 2, binding: expected.portable, entries: {} };
  const index = JSON.parse(readFileSync(path, 'utf8')) as Omit<Index,'version'> & {version:1|2};
  if (![1,2].includes(index?.version) || typeof index.binding!=='string' || !/^[a-f0-9]{64}$/.test(index.binding) || !index.entries || Array.isArray(index.entries) || typeof index.entries !== 'object'
    || Object.entries(index.entries).some(([rel, entry]) => !validPath(rel) || !entry || !/^[a-f0-9]{64}$/.test(entry.source) || !/^[a-f0-9]{64}$/.test(entry.hash) || entry.reviewRequired!==undefined&&typeof entry.reviewRequired!=='boolean')) throw new Error('.csync/index.json이 손상되었습니다. 업로드 선택 정보를 확인하세요.');
  const verified=index.binding===(index.version===1?expected.legacy:expected.portable);
  // Reading never rewrites the index. An unverifiable old selection remains
  // visible, but requires an explicit add before it can authorize any upload.
  const entries=Object.fromEntries(Object.entries(index.entries).map(([rel,entry])=>[rel,verified?entry:{...entry,reviewRequired:true}]));
  return {version:2,binding:expected.portable,entries};
}
function saveIndex(base: string, index: Index) {
  const path = location(base); mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(index, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function stagedPaths(base: string) {
  const index = loadIndex(base), workspace = loadWorkspace(base);
  const paths = Object.keys(index.entries);
  if (!paths.length) throw new Error('업로드 대상이 없습니다. csync add <파일·폴더>로 문서를 추가하세요.');
  if(paths.some(path=>index.entries[path].reviewRequired))throw new Error('작업공간 연결 또는 이전 업로드 선택을 다시 확인해야 합니다. csync add로 문서를 다시 추가하세요.');
  for (const rel of paths) if (!inScope(rel, workspace)) throw new Error(`업로드 대상이 작업공간 밖입니다: ${rel}. unstage로 해제하고 기준 폴더를 확인하세요.`);
  return paths;
}
export function assertStaged(base: string, rel: string, hash: string, entry: Entry) {
  if(entry.reviewRequired)throw new Error(`업로드 선택을 다시 확인해야 합니다: ${rel}. csync add로 다시 추가하세요.`);
  if (sourceHash(base, rel) !== entry.source || hash !== entry.hash) throw new Error(`추가 후 문서·첨부·링크가 변경되었습니다: ${rel}. csync add로 다시 추가하세요.`);
}
export function completeStaged(base: string, rel: string, expected?: Entry) {
  if (!expected) return;
  const index = loadIndex(base);
  if (JSON.stringify(index.entries[rel]) !== JSON.stringify(expected)) return;
  delete index.entries[rel]; saveIndex(base, index);
}
export async function inspectStaging(base: string, options: Options = {}, only?: string[]): Promise<StagingRow[]> {
  const workspace = loadWorkspace(base); requireScope(workspace);
  const index = loadIndex(base), ignorer = buildIgnorer(base, []);
  const all = collectMarkdown(base).map(p => relative(base, p).split('\\').join('/')).filter(p => !ignorer.ignores(p) && !inNestedWorkspace(base, p));
  const selected = all.filter(p => inScope(p, workspace) && (!only || only.some(key => !key || p === key || p.startsWith(key + '/'))));
  const sources = Object.fromEntries(selected.map(rel => [rel, sourceHash(base, rel)]));
  const prepared = await preparePushTree(base, all, selected, { referenceRoots: options.referenceRoots ?? [], baseUrl: options.baseUrl });
  try {
    const originalMapping = loadMapping(mappingPath(base));
    const mapping = reconcilePages(base, originalMapping, all, selected, requireScope(workspace));
    const legacy = buildTreeRenderer(base, all);
    const rows: StagingRow[] = selected.map(path => {
      const doc = prepared.docs[path], rendered = prepared.render(path, doc.body, doc.title), hash = docHash(doc.title, rendered);
      if (sourceHash(base, path) !== sources[path]) throw new Error('조회 중 문서가 변경되었습니다. 다시 시도하세요.');
      const oldPath = doc.fm.pageId && Object.keys(originalMapping).find(key => originalMapping[key].pageId === doc.fm.pageId && !key.endsWith('/'));
      const prior = originalMapping[path] ?? (oldPath ? originalMapping[oldPath] : undefined);
      const reconciled = mapping[path];
      const clean = prior?.localHash ? prior.localHash === localStateHash(base, path, rendered) : !!prior?.hash && (prior.hash === hash || prior.hash === docHash(legacy.docs[path].title, legacy.render(path, legacy.docs[path].body, legacy.docs[path].title))
        || prior.hash === docHash(doc.title, prepared.render(path, doc.body, doc.title, 'panels'))
        || prior.hash === docHash(doc.title, prepared.render(path, doc.body, doc.title, true))
        || prior.hash === docHash(legacy.docs[path].title, legacy.render(path, legacy.docs[path].body, legacy.docs[path].title, 'panels'))
        || prior.hash === docHash(legacy.docs[path].title, legacy.render(path, legacy.docs[path].body, legacy.docs[path].title, true)));
      const renamed = !!prior?.pageId && !reconciled?.pendingMove && !!oldPath && oldPath !== path;
      const status = !prior?.pageId ? 'new' : reconciled?.pendingMove ? 'moved' : renamed || !clean ? 'changed' : 'same';
      const entry = { source: sources[path], hash };
      const unmapped=!prior?.pageId&&!!doc.fm.pageId;
      const staged = !!index.entries[path], stale = staged && (unmapped || !!index.entries[path].reviewRequired || JSON.stringify(index.entries[path]) !== JSON.stringify(entry));
      return { path, status, staged, stale, entry, ...(renamed && clean ? {renamed:true} : {}), pageId: prior?.pageId ?? doc.fm.pageId, ...(!prior?.pageId && doc.fm.pageId ? {unmapped:true,recoverable:doc.fm.spaceKey===workspace.connection?.spaceKey} : {}) };
    });
    for (const path of Object.keys(index.entries)) if (!rows.some(row => row.path === path)) rows.push({ path, status: 'unavailable', staged: true, stale: true, entry: index.entries[path], pageId: mapping[path]?.pageId });
    return rows;
  } finally { prepared.dispose(); }
}
export async function changeStaging(base: string, paths: string[], action: 'add' | 'remove', options: Options = {}) {
  if (!paths.length) throw new Error('파일 또는 폴더를 지정하세요. 전체 범위는 . 으로 지정하세요.');
  const index = loadIndex(base);
  const keys = paths.map(path => {
    const key = relative(base, resolve(base, path)).split('\\').join('/');
    if (key === '..' || key.startsWith('../')) throw new Error('기준 폴더 밖의 경로는 추가할 수 없습니다.');
    return key;
  });
  const rows = action === 'add' ? await inspectStaging(base, options, keys) : Object.keys(index.entries).map(path => ({path, status:'', entry:index.entries[path]}));
  const touched: typeof rows = [];
  for (const key of keys) {
    const matches = rows.filter(row => (!key || row.path === key || row.path.startsWith(key + '/')) && (action !== 'add' || row.status !== 'unavailable'));
    if (!matches.length) throw new Error(`작업공간에서 선택할 문서가 없습니다: ${key || '.'}`);
    touched.push(...matches);
    for (const row of matches) if (action === 'add') index.entries[row.path] = row.entry; else delete index.entries[row.path];
  }
  // Do not overwrite selections changed by another process while conversion was running.
  const current = loadIndex(base);
  for (const path of new Set([...Object.keys(current.entries), ...Object.keys(index.entries)])) {
    if (keys.some(key => !key || path === key || path.startsWith(key + '/'))) {
      if (index.entries[path]) current.entries[path] = index.entries[path]; else delete current.entries[path];
    }
  }
  saveIndex(base, current);
  return touched;
}
export async function runStaging(argv: string[]) {
  const command = positionalArgs(argv)[0];
  if (command !== 'add' && command !== 'unstage') throw new Error('문서 선택 명령은 add 또는 unstage를 사용하세요.');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' || argv[i] === '--reference-root') {
      const option = argv[i], value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error(`${option} 뒤에 폴더를 지정하세요.`);
    } else if (argv[i].startsWith('-') && argv[i] !== '--no-color') throw new Error(`지원하지 않는 ${command} 옵션: ${argv[i]}. csync ${command} --help를 확인하세요.`);
  }
  const at = argv.indexOf('--base'), base = resolveSyncBase(at < 0 ? undefined : argv[at + 1]);
  if (!base) throw new Error('작업공간을 지정하세요: --base <dir>');
  const refs: string[] = []; for (let i = 0; i < argv.length; i++) if (argv[i] === '--reference-root') refs.push(argv[++i]);
  const options = {referenceRoots: refs, baseUrl: readEnv(base).baseUrl};
  await changeStaging(base, positionalArgs(argv).slice(1), command === 'add' ? 'add' : 'remove', options);
  console.log((command === 'add' ? green : cyan)(`업로드 대상 ${Object.keys(loadIndex(base).entries).length}개 저장됨`));
}
