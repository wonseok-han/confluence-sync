import { readFile, realpath, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { within } from './output.js';

export const hiddenDocumentPath = (base: string, path: string) => relative(base, path).split(/[\\/]/).some(p => p.startsWith('.') || p === 'node_modules');

export async function readPreviewSource(basePath: string, filePath: string) {
  const base = await realpath(basePath);
  const path = await realpath(filePath);
  if (!(await stat(base)).isDirectory() || !within(base, path) || hiddenDocumentPath(base, path)
    || !/\.md$/i.test(path) || !(await stat(path)).isFile()) throw new Error('선택한 폴더 안의 Markdown 파일을 선택해 주세요.');
  if ((await stat(path)).size > 1_000_000) throw new Error('문서 미리보기는 1MB 이하 파일을 지원합니다.');
  return { source: await readFile(path, 'utf8'), base, path };
}
