/** Metadata locations shared by CLI, references and the web adapter. */
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export const METADATA_DIR = '.csync';
export const MAPPING_FILE = '.csync/mapping.json';
export const WORKSPACE_FILE = '.csync/workspace.json';
export const IGNORE_FILE = '.csync/ignore';
const files = {
  mapping: [MAPPING_FILE, '.confluence-sync.json'],
  workspace: [WORKSPACE_FILE, '.confluence-workspace.json'],
  ignore: [IGNORE_FILE, '.confluence-syncignore'],
} as const;
type Kind = keyof typeof files;

export function metadataPath(base: string, kind: Kind): string {
  const directory = join(base, METADATA_DIR);
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error(`메타데이터 폴더가 올바르지 않습니다: ${directory}`);
  const [current, legacy] = files[kind].map(name => join(base, name));
  for (const path of [current, legacy]) if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error(`메타데이터 파일이 올바르지 않습니다: ${path}`);
  if (existsSync(current) && existsSync(legacy) && !readFileSync(current).equals(readFileSync(legacy))) {
    throw new Error(`기존·새 메타데이터가 충돌합니다: ${legacy}, ${current}. 사용할 기준을 먼저 정리하세요.`);
  }
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}
export const mappingPath = (base: string) => metadataPath(base, 'mapping');
export const workspacePath = (base: string) => metadataPath(base, 'workspace');
export const ignorePath = (base: string) => metadataPath(base, 'ignore');
export function hasMetadata(base: string): boolean {
  return existsSync(join(base, METADATA_DIR)) || ['mapping', 'workspace'].some(kind => existsSync(join(base, files[kind as Kind][1])));
}
/** Include absent locations too, so creating a competing legacy file invalidates a plan. */
export function metadataFiles(base: string): string[] {
  return Object.values(files).flatMap(names => names.map(name => join(base, name)));
}
/** Explicit, offline migration. Copy and verify every destination before removing any source. */
export function migrateMetadata(base: string, dryRun = false): number {
  const plan = Object.keys(files).map(kind => {
    metadataPath(base, kind as Kind); // Validate every pair before any mutation.
    const [next, prior] = files[kind as Kind];
    return { source: join(base, prior), target: join(base, next) };
  }).filter(item => existsSync(item.source)).map(item => ({ ...item, bytes: readFileSync(item.source) }));
  for (const item of plan) console.log(`${item.source} → ${item.target}`);
  if (!dryRun && plan.length) {
    mkdirSync(join(base, METADATA_DIR), { recursive: true });
    for (const item of plan) if (!existsSync(item.target)) writeFileSync(item.target, item.bytes, { flag: 'wx' });
    for (const item of plan) if (!readFileSync(item.target).equals(item.bytes) || !readFileSync(item.source).equals(item.bytes)) throw new Error('이전 중 메타데이터가 변경되었습니다. 원본은 제거하지 않았습니다.');
    for (const item of plan) unlinkSync(item.source);
  }
  return plan.length;
}
