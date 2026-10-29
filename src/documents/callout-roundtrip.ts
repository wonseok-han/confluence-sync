/** Recover panel structure using rendered bodies and storage-only callout metadata. */
import { createDocument } from '@mixmark-io/domino';
import type TurndownService from 'turndown';
import { calloutMarker, calloutStyle, inferCallout } from './callouts.js';

type Metadata = { type: string; fold: string; explicit: boolean };
const direct = (el: Element, name: string) => Array.from(el.children).find(child => child.nodeName.toLowerCase() === name);
function metadata(panel: Element): Metadata | undefined {
  const body = direct(panel, 'ac:rich-text-body');
  const anchor = body && direct(body, 'ac:structured-macro');
  if (anchor?.getAttribute('ac:name') !== 'anchor') return;
  const value = direct(anchor, 'ac:parameter')?.textContent ?? '';
  if (!value.startsWith(calloutMarker) || value.length > 2000) return;
  try {
    const data = JSON.parse(Buffer.from(value.slice(calloutMarker.length), 'base64url').toString('utf8'));
    if (typeof data.type === 'string' && /^[a-z\d_-]+$/i.test(data.type) && ['', '+', '-'].includes(data.fold) && typeof data.explicit === 'boolean') return data;
  } catch { /* Older or edited metadata is handled as an ordinary panel. */ }
}
function panelParts(panel: Element) {
  const children = Array.from(panel.children);
  return { header: children.find(el => el.classList.contains('panelHeader')), body: children.find(el => el.classList.contains('panelContent')) };
}

export function restoreCalloutPanels(html: string, storage?: string): string {
  const doc = createDocument(html);
  for (const el of Array.from(doc.querySelectorAll('[data-csync-callout]'))) el.removeAttribute('data-csync-callout');
  const panels = Array.from(doc.querySelectorAll('div.panel')).filter(panel => !!panelParts(panel).body);
  // Storage is XML; protect code CDATA before parsing its macro hierarchy as HTML.
  const safeStorage = storage?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_all, text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const stored = safeStorage ? Array.from(createDocument(safeStorage).querySelectorAll('*')).filter(el => el.nodeName.toLowerCase() === 'ac:structured-macro' && el.getAttribute('ac:name') === 'panel') : [];
  // Never shift metadata onto another panel if export_view omitted or added a panel.
  const aligned = panels.length === stored.length;
  panels.forEach((panel, i) => {
    const {header, body} = panelParts(panel);
    const title = header?.textContent?.trim() ?? '';
    const source = aligned ? stored[i] : undefined;
    const parameter = (name: string) => source && Array.from(source.children).find(el => el.nodeName.toLowerCase() === 'ac:parameter' && el.getAttribute('ac:name') === name)?.textContent?.trim();
    const data = source && parameter('title') === title ? metadata(source) : undefined;
    const background = parameter('bgColor') ?? '';
    panel.setAttribute('data-csync-callout', JSON.stringify({ type: data?.type ?? inferCallout(title, background), fold: data?.fold ?? '', explicit: data?.explicit ?? true, title }));
    // Our invisible anchor is metadata, never a Markdown link target or body text.
    for (const anchor of Array.from(body!.querySelectorAll('[id], [name]'))) {
      if ((anchor.getAttribute('id') ?? '').includes(calloutMarker) || (anchor.getAttribute('name') ?? '').includes(calloutMarker)) anchor.remove();
    }
    for (const anchor of Array.from(body!.querySelectorAll('*'))) {
      if (anchor.nodeName.toLowerCase() === 'ac:structured-macro' && anchor.getAttribute('ac:name') === 'anchor' && direct(anchor, 'ac:parameter')?.textContent?.startsWith(calloutMarker)) anchor.remove();
    }
  });
  return doc.body.innerHTML;
}

export function installPanelRule(td: TurndownService, obsidian: boolean): void {
  // Keep the header in the DOM until conversion so title-only panels are not blank.
  td.addRule('confluencePanelTitle', {
    filter: node => {
      const el = node as unknown as Element;
      return !!el.classList?.contains('panelHeader') && !!el.parentElement?.hasAttribute('data-csync-callout');
    },
    replacement: () => '',
  });
  td.addRule('confluencePanel', {
    filter: node => (node as unknown as Element).hasAttribute?.('data-csync-callout') ?? false,
    replacement: (content, node) => {
      const {type, fold, explicit, title} = JSON.parse((node as unknown as Element).getAttribute('data-csync-callout')!);
      const textTitle = String(title).replace(/[\r\n]+/g, ' ').trim();
      const quote = (text: string) => text.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
      const head = obsidian
        ? `[!${type}]${fold}${textTitle && (explicit || textTitle !== calloutStyle(type).title) ? ` ${textTitle}` : ''}`
        : textTitle ? `**${td.escape(textTitle)}**` : '';
      return `\n\n${quote([head, content.trim()].filter(Boolean).join(obsidian ? '\n' : '\n\n'))}\n\n`;
    },
  });
}
