import { lstat, realpath, readdir, mkdir, copyFile, unlink, rmdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path';

export const within = (base: string, file: string) => {
  const rel = relative(base, file);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!missing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}

async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export class OverwriteRequired extends Error {
  constructor(public conflicts: { path: string; hash: string }[]) {
    super(`내용이 다른 기존 파일 ${conflicts.length}개가 있습니다. 덮어쓰기를 확인해 주세요.`);
  }
}

/** Reuse identical files; approved replacements are backed up until the export completes. */
export async function publishOutput(stage: string, output: string, approved: Record<string, string> = {}) {
  const files: string[] = [];
  const collect = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const abs = join(path, entry.name);
      if (entry.isDirectory()) await collect(abs);
      else if (entry.isFile()) files.push(relative(stage, abs));
      else throw new Error('출력에 지원하지 않는 파일 형식이 있습니다.');
    }
  };
  await collect(stage);
  const reusable = new Set<string>(), replace = new Set<string>();
  const conflicts: { path: string; hash: string }[] = [];
  // Check all destinations before writing, including directory symlinks.
  for (const rel of files) {
    const target = join(output, rel);
    let cursor = target;
    while (within(output, cursor)) {
      try {
        const info = await lstat(cursor);
        if (cursor === target && info.isFile() && !info.isSymbolicLink()) {
          const hash = await digest(cursor);
          if (info.size === (await lstat(join(stage, rel))).size && hash === await digest(join(stage, rel))) reusable.add(rel);
          else {
            replace.add(rel);
            if (approved[rel] !== hash) conflicts.push({ path: rel, hash });
          }
        } else if (cursor === target || info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error(`출력 경로가 이미 사용 중입니다: ${cursor}\n다른 출력 폴더를 지정해 주세요.`);
        }
      } catch (error) { if (!missing(error)) throw error; }
      if (cursor === output) break;
      cursor = dirname(cursor);
    }
  }
  if (conflicts.length) throw new OverwriteRequired(conflicts);
  let backup: string | undefined;
  const replaced: { target: string; backup: string }[] = [];
  const createdDirs: string[] = [], copied: string[] = [];
  const ensureDir = async (path: string): Promise<void> => {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`출력 폴더를 확인해 주세요: ${path}`);
    } catch (error) {
      if (!missing(error)) throw error;
      await ensureDir(dirname(path));
      await mkdir(path); createdDirs.push(path);
    }
  };
  try {
    for (const rel of files) {
      if (reusable.has(rel)) continue;
      const target = resolve(output, rel);
      await ensureDir(dirname(target));
      if (replace.has(rel)) {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`출력 파일이 변경되었습니다: ${target}`);
        const hash = await digest(target);
        if (approved[rel] !== hash) throw new OverwriteRequired([{ path: rel, hash }]);
        backup ??= await mkdtemp(join(output, '.csync-backup-'));
        const saved = join(backup, String(replaced.length));
        await rename(target, saved);
        replaced.push({ target, backup: saved });
      }
      await copyFile(join(stage, rel), target, constants.COPYFILE_EXCL);
      copied.push(target);
    }
  } catch (error) {
    for (const path of copied.reverse()) await unlink(path);
    for (const entry of replaced.reverse()) {
      await copyFile(entry.backup, entry.target, constants.COPYFILE_EXCL);
    }
    if (backup) await rm(backup, { recursive: true, force: true });
    for (const path of createdDirs.reverse()) await rmdir(path);
    throw error;
  }
  if (backup) await rm(backup, { recursive: true, force: true });
  return { created: copied.length - replaced.length, overwritten: replaced.length, reused: reusable.size };
}
