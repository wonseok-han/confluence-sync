import { basename, dirname, join, relative } from 'node:path';

/** Pull and converted documents keep attachments beside their owning Markdown file. */
export function documentAttachmentDir(file: string, base: string): string {
  return join(dirname(relative(base, file)), 'attachments', basename(file).replace(/\.md$/i, '')).split('\\').join('/');
}
