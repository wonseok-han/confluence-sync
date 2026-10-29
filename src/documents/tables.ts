import { createDocument } from '@mixmark-io/domino';
import { htmlTableMarkdown } from './html-tables.js';

/** Only explicit pixel widths are portable to Confluence storage. */
export function pixelWidth(value: string | null): number | undefined {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  const width = match ? Number(match[1]) : 0;
  return Number.isFinite(width) && width > 0 ? width : undefined;
}

function styleWidth(el: Element): number | undefined {
  const value = el.getAttribute('style')?.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i)?.[1];
  return pixelWidth(value ?? null);
}

export type TableWidths = { width?: number; columns: (number | undefined)[] };

export function tableWidths(table: Element): TableWidths {
  const columns = Array.from(table.children)
    .filter(el => el.tagName === 'COLGROUP')
    .flatMap(group => Array.from(group.children).filter(el => el.tagName === 'COL'))
    .map(col => styleWidth(col) ?? pixelWidth(col.getAttribute('width')));
  const width = pixelWidth(table.getAttribute('data-table-width')) ?? styleWidth(table)
    ?? pixelWidth(table.getAttribute('width'))
    ?? (columns.length && columns.every(w => w !== undefined) ? columns.reduce<number>((sum, w) => sum + w!, 0) : undefined);
  return { width, columns };
}

export function hasWidths(widths: TableWidths): boolean {
  return widths.width !== undefined || widths.columns.some(w => w !== undefined);
}

export function applyTableWidths(table: Element, widths: TableWidths, storage = false): void {
  if (widths.width !== undefined) {
    const style = (table.getAttribute('style') ?? '').split(';')
      .map(s => s.trim()).filter(s => s && !/^(?:width|table-layout)\s*:/i.test(s)).join('; ');
    table.setAttribute('style', `${style ? style + '; ' : ''}width: ${widths.width}px; table-layout: fixed;`);
    if (storage) {
      table.setAttribute('data-table-width', String(widths.width));
      if (!table.hasAttribute('data-layout')) table.setAttribute('data-layout', 'default');
    }
  }
  if (widths.columns.length) {
    for (const group of Array.from(table.children).filter(el => el.tagName === 'COLGROUP')) group.remove();
    const group = table.ownerDocument!.createElement('colgroup');
    for (const width of widths.columns) {
      const col = table.ownerDocument!.createElement('col');
      if (width !== undefined) col.setAttribute('style', `width: ${width}px;`);
      group.appendChild(col);
    }
    table.insertBefore(group, table.firstChild);
  }
}

/** Read layout from storage, while retaining export_view's rendered cell contents. */
export function restoreTableWidths(html: string, storage?: string): string {
  if (!storage) return html;
  const candidates = Array.from(createDocument(storage).querySelectorAll('table')).map(tableWidths);
  if (!candidates.some(hasWidths)) return html;
  const doc = createDocument(html);
  const tables = Array.from(doc.querySelectorAll('table'));
  // Macro-generated tables may change the count; avoid assigning unrelated metadata.
  if (tables.length !== candidates.length) return html;
  tables.forEach((table, i) => { if (hasWidths(candidates[i])) applyTableWidths(table, candidates[i]); });
  return doc.body.innerHTML;
}

/** Rewrite real HTML table links, leaving fenced code examples intact. */
export function rewriteTableLinks(markdown: string, rewrite: (href: string) => string): string {
  if (!/<table[\s>]/i.test(markdown)) return markdown;
  const tokens = htmlTableMarkdown().parse(markdown, {});
  const lines = markdown.split('\n');
  for (const token of tokens.reverse()) {
    if (token.type !== 'html_block' || !token.map || !/<table[\s>]/i.test(token.content)) continue;
    const doc = createDocument(token.content);
    let changed = false;
    for (const anchor of Array.from(doc.querySelectorAll('table a[href]'))) {
      const href = anchor.getAttribute('href')!;
      const next = rewrite(href);
      if (next !== href) { anchor.setAttribute('href', next); changed = true; }
    }
    if (changed) lines.splice(token.map[0], token.map[1] - token.map[0], doc.body.innerHTML.trimEnd());
  }
  return lines.join('\n');
}
