import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 설치된 패키지(package.json)의 버전을 읽는다(dist·src 어느 쪽에서 실행해도 ../../package.json). */
export function readPkgVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

