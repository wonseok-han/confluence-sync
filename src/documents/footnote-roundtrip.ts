/** Footnote restoration metadata uses native invisible Confluence anchors. */
import { createDocument } from '@mixmark-io/domino';
import type TurndownService from 'turndown';
import { anchorMacro, matchConfluenceAnchor } from './anchors.js';
import { decodeFootnote } from '../conversion/footnotes.js';

const prefix = 'csync-footnote-v1-';
const startComment = (encoded: string) => `<!-- csync-footnote:v1 ${encoded} -->`;
const endComment = '<!-- /csync-footnote -->';
const markerName = (encoded: string, end: boolean) => prefix + (end ? 'end-' : 'start-') + Buffer.from(encoded, 'base64').toString('base64url');

/** CDATA code examples and unrelated comments are never rewritten. */
export function footnotesToStorage(storage: string): string {
  let current: string | undefined;
  return storage.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!-- csync-footnote:v1 ([A-Za-z0-9+/=]+) -->|<!-- \/csync-footnote -->/g, (whole, encoded?: string) => {
    if (encoded) {
      if (!decodeFootnote(encoded)) return whole;
      current = encoded;
      return anchorMacro(markerName(encoded, false));
    }
    if (whole === endComment && current) {
      const end = anchorMacro(markerName(current, true)); current = undefined; return end;
    }
    return whole;
  });
}

/** Keep pre-metadata document hashes stable; the visible body is still hashed. */
export function footnoteStorageComments(storage: string): string {
  return storage.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">csync-footnote-v1-(start|end)-([A-Za-z0-9_-]+)<\/ac:parameter><\/ac:structured-macro>/g, (whole, kind?: string, encoded?: string) => {
    if (!kind || !encoded) return whole;
    const base64 = Buffer.from(encoded, 'base64url').toString('base64');
    return decodeFootnote(base64) ? kind === 'start' ? startComment(base64) : endComment : whole;
  });
}

export function restoreFootnoteAnchors(html: string, storage?: string, pageId?: string): string {
  const doc = createDocument(html);
  for (const node of Array.from(doc.querySelectorAll('[data-csync-footnote]'))) node.removeAttribute('data-csync-footnote');
  if (!storage?.includes(prefix)) return doc.body.innerHTML;
  const names = new Map<string, {encoded: string; end: boolean}>();
  // Only accept markers paired in storage, not look-alike anchors in the rendered body.
  const starts = new Set<string>(), ends = new Set<string>();
  for (const match of storage.matchAll(/<ac:structured-macro\b[^>]*ac:name="anchor"[^>]*>\s*<ac:parameter\b[^>]*ac:name=""[^>]*>csync-footnote-v1-(start|end)-([A-Za-z0-9_-]+)<\/ac:parameter>\s*<\/ac:structured-macro>/g)) {
    const encoded = Buffer.from(match[2], 'base64url').toString('base64');
    if (decodeFootnote(encoded)) (match[1] === 'start' ? starts : ends).add(encoded);
  }
  for (const encoded of starts) if (ends.has(encoded)) {
    names.set(markerName(encoded, false), {encoded, end:false});
    names.set(markerName(encoded, true), {encoded, end:true});
  }
  if (!names.size) return doc.body.innerHTML;
  const found = new Map<string, Element[]>();
  for (const node of Array.from(doc.querySelectorAll('[id], [name]'))) {
    const id = node.getAttribute('id') ?? node.getAttribute('name') ?? '';
    const entry = [...names].find(([name]) => id.endsWith(name));
    if (entry) { const nodes = found.get(entry[0]) ?? []; nodes.push(node); found.set(entry[0], nodes); }
  }
  const active = [...starts].filter(encoded => found.get(markerName(encoded,false))?.length === 1 && found.get(markerName(encoded,true))?.length === 1);
  const headings = active.map(encoded => { const meta = decodeFootnote(encoded)!; return {text:meta.anchor, slug:meta.anchor, level:6}; });
  for (const link of Array.from(doc.querySelectorAll('sup a[href]'))) {
    const href = link.getAttribute('href')!;
    const target = href.match(/\/pages\/(\d+)/)?.[1] ?? href.match(/[?&]pageId=(\d+)/)?.[1];
    if (!href.startsWith('#') && (!pageId || target !== pageId)) continue;
    const fragment = href.split('#').slice(1).join('#');
    const match = matchConfluenceAnchor(fragment, headings, '');
    if (match) link.setAttribute('href', `#${match.slug}`);
  }
  for (const encoded of active) for (const end of [false,true]) {
    const node = found.get(markerName(encoded,end))![0];
    node.setAttribute('data-csync-footnote', JSON.stringify({encoded,end}));
    node.textContent = 'csync-footnote-marker';
  }
  return doc.body.innerHTML;
}

export function installFootnoteRules(td: TurndownService): void {
  td.addRule('confluenceFootnoteMetadata', {
    filter: node => !!(node as unknown as Element).hasAttribute?.('data-csync-footnote'),
    replacement: (_content, node) => {
      const {encoded,end} = JSON.parse((node as unknown as Element).getAttribute('data-csync-footnote')!);
      return `\n\n${end ? endComment : startComment(encoded)}\n\n`;
    },
  });
  td.addRule('superscript', {filter:'sup', replacement:content => `<sup>${content}</sup>`});
}
