import { lstat, realpath, readdir, mkdir, copyFile, unlink, rmdir } from 'node:fs/promises';
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

/** Reuse identical files and copy only new files; a failed export rolls back only paths created by this request. */
export async function publishOutput(stage: string, output: string) {
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
  const reusable = new Set<string>();
  // Check all destinations before writing, including directory symlinks.
  for (const rel of files) {
    const target = join(output, rel);
    let cursor = target;
    while (within(output, cursor)) {
      try {
        const info = await lstat(cursor);
        if (cursor === target && info.isFile() && !info.isSymbolicLink()
          && info.size === (await lstat(join(stage, rel))).size
          && await digest(cursor) === await digest(join(stage, rel))) {
          reusable.add(rel);
        } else if (cursor === target || info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error(`출력 경로가 이미 사용 중입니다: ${cursor}\n다른 출력 폴더를 지정해 주세요.`);
        }
      } catch (error) { if (!missing(error)) throw error; }
      if (cursor === output) break;
      cursor = dirname(cursor);
    }
  }
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
      await copyFile(join(stage, rel), target, constants.COPYFILE_EXCL);
      copied.push(target);
    }
  } catch (error) {
    for (const path of copied.reverse()) await unlink(path);
    for (const path of createdDirs.reverse()) await rmdir(path);
    throw error;
  }
}
