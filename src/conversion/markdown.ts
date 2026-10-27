/** Shared Obsidian → Markdown preparation for convert and publishing. */
import { relative, dirname, resolve } from 'node:path';
import { vaultResolver, type Vault } from '../documents/catalog.js';
import { resolveWikilinks } from '../documents/obsidian.js';
import { attachmentMapper } from './attachments.js';
import { footnotesToLinks } from './footnotes.js';
import { extractPdfPages, mapMarkdownText } from './pdf-pages.js';

export async function prepareMarkdown(text: string, file: string, base: string, vault: Vault, output: string, dryRun: boolean, attachments = attachmentMapper(file, base), restoreAssets = true) {
  const slash = (path: string) => path.split('\\').join('/');
  const rel = slash(relative(base, file)), lookup = vaultResolver(rel, vault);
  text = attachments.rewrite(text);
  text = resolveWikilinks(text, (target, embed) => {
    const imported = resolve(base, target);
    if (attachments.copies.has(slash(relative(base, imported)))) return slash(relative(dirname(file), imported));
    return lookup(target, embed);
  });
  text = footnotesToLinks(attachments.rewrite(text));
  mapMarkdownText(text, part => {
    if (/\[\[[^\]\n]*\.pdf#page=[^\]\n]*\]\]/i.test(part)) throw new Error(`PDF 위키링크를 해석하지 못했습니다 (${rel}). --base에 PDF가 포함되는지 확인하세요.`);
    return part;
  });
  const pdf = await extractPdfPages(text, file, base, output, dryRun, attachments.source, restoreAssets);
  return { ...pdf, copies: attachments.copies };
}
