/** Local edit detection is independent of rendered storage and incoming anchor links. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Rendered } from '../documents/markdown.js';
export function localStateHash(base: string, rel: string, rendered: Rendered): string {
  const hash = createHash('sha256').update(readFileSync(resolve(base, rel)));
  for (const asset of [...rendered.attachments].sort((a, b) => a.filename.localeCompare(b.filename))) {
    hash.update('\0' + asset.filename + '\0');
    hash.update(createHash('sha256').update(readFileSync(asset.abs)).digest());
  }
  return hash.digest('hex');
}
