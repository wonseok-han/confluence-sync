import { readFile, realpath, stat, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createDocument } from '@mixmark-io/domino';
import { htmlTableMarkdown } from '../documents/html-tables.js';
import { splitFrontmatter } from '../documents/obsidian.js';
import { applyTableWidths, tableWidths } from '../documents/tables.js';
import { formatDocument } from '../documents/format.js';
import { readPreviewSource } from './document-source.js';

export const sourceHash = (source: string) => createHash('sha256').update(source).digest('hex');
type Target = { start: number; end: number; html: string; markdown: boolean } | null;
export type EditableTable = { index: number; widths: number[]; editable: boolean; contentWeights?: number[] };

/** Source ranges come from Markdown tokens, never from the preview's sanitized HTML. */
function targets(source: string): Target[] {
  const { body } = splitFrontmatter(source);
  const prefix = source.length - body.length;
  const lines = body.split('\n');
  const offsets = [prefix];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);
  const md = htmlTableMarkdown();
  const tokens = md.parse(body, {});
  const result: Target[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'table_open' && token.map) {
      let end = i;
      while (tokens[end]?.type !== 'table_close') end++;
      result.push(token.level === 0 ? { start: offsets[token.map[0]], end: Math.min(source.length, offsets[token.map[1]]), html: md.renderer.render(tokens.slice(i, end + 1), md.options, {}), markdown: true } : null);
      i = end;
    } else if (token.type === 'html_block' && token.map) {
      const count = createDocument(token.content).querySelectorAll('table').length;
      const start = offsets[token.map[0]];
      const raw = source.slice(start, Math.min(source.length, offsets[token.map[1]]));
      const opening = raw.match(/^\s*<table\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i);
      const close = raw.match(/<\/table\s*>/i);
      const target = count === 1 && token.level === 0 && opening && close
        ? { start: start + raw.indexOf('<'), end: start + close.index! + close[0].length, html: raw.slice(raw.indexOf('<'), close.index! + close[0].length), markdown: false } : null;
      for (let n = 0; n < count; n++) result.push(target);
    }
  }
  return result;
}

function columnCount(table: Element, visit?: (cell: Element, column: number, span: number) => void): number {
  const occupied: number[] = [];
  let count = 0;
  const rows = Array.from(table.querySelectorAll('tr'));
  rows.forEach((row, r) => {
    let column = 0;
    for (const cell of Array.from(row.children).filter(c => /^(TD|TH)$/.test(c.tagName))) {
      while ((occupied[column] ?? 0) > r) column++;
      const span = Math.max(1, Number(cell.getAttribute('colspan')) || 1);
      const rawRows = cell.getAttribute('rowspan');
      const rowSpan = rawRows === '0' ? rows.length - r : Math.max(1, Number(rawRows) || 1);
      if (!Number.isInteger(span) || span > 32 || !Number.isInteger(rowSpan)) return;
      visit?.(cell, column, span);
      for (let n = 0; n < span; n++) occupied[column + n] = r + rowSpan;
      column += span;
    }
    count = Math.max(count, column, occupied.length);
  });
  return count;
}

/** Visual-length estimate: wide characters count twice; row/column spans use logical columns. */
function contentWeights(table: Element, count: number): number[] {
  const samples: number[][] = Array.from({ length: count }, () => []);
  columnCount(table, (cell, column, span) => {
    const text = (cell.textContent ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
    let length = 0;
    for (const character of text) {
      if (/\p{Mark}|[\u200d\ufe0e\ufe0f]/u.test(character)) continue;
      length += /\p{Script=Hangul}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Extended_Pictographic}/u.test(character) ? 2 : 1;
    }
    for (let i = column; i < Math.min(count, column + span); i++) samples[i].push(length / span);
  });
  return samples.map(values => {
    values.sort((a, b) => a - b);
    const typical = values[Math.ceil((values.length - 1) * 0.75)] ?? 0;
    const longest = values.at(-1) ?? 0;
    // Compress long prose, and limit a single unusually long cell's influence.
    return Math.max(1, Math.sqrt(typical) * 0.8 + Math.sqrt(Math.min(longest, typical * 2)) * 0.2);
  });
}

export function editableTables(source: string): EditableTable[] {
  return targets(source).map((target, index) => {
    const table = target && createDocument(target.html).querySelector('table');
    const count = table ? columnCount(table) : 0;
    if (!table || count < 1 || count > 32) return { index, widths: [], editable: false };
    const dimensions = tableWidths(table);
    const total = Math.round(Math.max(count * 40, Math.min(3000, dimensions.width ?? 760)));
    const existing = dimensions.columns.length === count && dimensions.columns.every(w => w !== undefined) ? dimensions.columns as number[] : Array(count).fill(1);
    const sum = existing.reduce((a, b) => a + b, 0);
    const widths = existing.map(w => Math.max(40, Math.floor(w / sum * total)));
    let remaining = total - widths.reduce((a, b) => a + b, 0);
    while (remaining !== 0) {
      const column = remaining > 0 ? widths.indexOf(Math.min(...widths)) : widths.indexOf(Math.max(...widths));
      widths[column] += remaining > 0 ? 1 : -1;
      remaining += remaining > 0 ? -1 : 1;
    }
    return { index, widths, editable: true, contentWeights: contentWeights(table, count) };
  });
}

export function formatTable(source: string, index: number, widths: number[]): string {
  const list = targets(source);
  const target = list[index];
  const info = editableTables(source)[index];
  if (!target || !info?.editable || !Number.isInteger(index)) throw new Error('이 표는 너비 편집을 지원하지 않습니다.');
  if (!Array.isArray(widths) || widths.length !== info.widths.length || widths.some(w => !Number.isInteger(w) || w < 40 || w > 3000)
    || widths.reduce((a, b) => a + b, 0) > 3000) throw new Error('열 너비는 40px 이상, 전체 너비는 3000px 이하여야 합니다.');
  const table = createDocument(target.html).querySelector('table')!;
  const signature = (el: Element) => Array.from(el.querySelectorAll('th, td')).map(c => [c.innerHTML, c.getAttribute('colspan'), c.getAttribute('rowspan')]);
  const before = signature(table);
  const total = widths.reduce((a, b) => a + b, 0);
  applyTableWidths(table, { width: total, columns: widths });
  if (table.hasAttribute('data-table-width')) table.setAttribute('data-table-width', String(total));
  let html: string;
  if (target.markdown) html = table.outerHTML + '\n';
  else {
    const opening = table.cloneNode(false) as Element;
    const startTag = opening.outerHTML.slice(0, -'</table>'.length);
    const group = table.querySelector('colgroup')!.outerHTML;
    const original = target.html.replace(/^<table\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i, startTag);
    html = /<colgroup\b/i.test(original)
      ? original.replace(/<colgroup\b[^>]*>[\s\S]*?<\/colgroup\s*>/i, group)
      : original.replace(startTag, startTag + '\n' + group);
  }
  const checked = createDocument(html).querySelector('table')!;
  if (JSON.stringify(signature(checked)) !== JSON.stringify(before)
    || tableWidths(checked).width !== total
    || JSON.stringify(tableWidths(checked).columns) !== JSON.stringify(widths)) throw new Error('표 내용을 보존할 수 없어 변경하지 않았습니다.');
  return source.slice(0, target.start) + html + source.slice(target.end);
}

export function formatAllTables(source: string, mode: 'fit' | 'equal'): string {
  let after = source;
  for (const table of editableTables(source).filter(t => t.editable)) {
    const total = table.widths.reduce((a, b) => a + b, 0), count = table.widths.length;
    const weights = mode === 'fit' ? table.contentWeights! : Array(count).fill(1);
    const extra = total - count * 40, sum = weights.reduce((a, b) => a + b, 0);
    const shares = weights.map(w => w / sum * extra), widths = shares.map(w => 40 + Math.floor(w));
    const order = shares.map((w, i) => ({ i, fraction: w - Math.floor(w) })).sort((a, b) => b.fraction - a.fraction);
    const rest = total - widths.reduce((a, b) => a + b, 0);
    for (let i = 0; i < rest; i++) widths[order[i].i]++;
    after = formatTable(after, table.index, widths);
  }
  return after;
}

export function createTableFormatting() {
  const plans = new Map<string, { base: string; file: string; before: string; after: string }>();
  const plan = (base: string, file: string, before: string, after: string) => {
    if (Buffer.byteLength(after) > 1_000_000) throw new Error('변경 결과가 미리보기 지원 크기인 1MB를 넘습니다.');
    const planId = randomUUID();
    if (plans.size >= 20) plans.delete(plans.keys().next().value!);
    plans.set(planId, { base, file, before, after });
    return { planId, before, after };
  };
  return {
    async documentPreview(base: string, file: string, hash: string, basic: boolean, tables: string, changes: { index: number; widths: number[] }[] = []) {
      if (typeof basic !== 'boolean' || !['keep', 'fit', 'equal'].includes(tables)) throw new Error('문서 서식 옵션을 확인해 주세요.');
      const { source, path } = await readPreviewSource(base, file);
      if (sourceHash(source) !== hash) throw new Error('파일이 변경되었습니다. 문서 미리보기를 새로고침해 주세요.');
      if (!Array.isArray(changes) || changes.length > 100 || new Set(changes.map(e => e?.index)).size !== changes.length) throw new Error('표 변경 목록을 확인해 주세요.');
      let after = source;
      for (const edit of changes) after = formatTable(after, edit?.index, edit?.widths);
      if (basic) after = formatDocument(after);
      if (tables !== 'keep') after = formatAllTables(after, tables as 'fit' | 'equal');
      return plan(base, path, source, after);
    },
    async preview(base: string, file: string, hash: string, index: number, widths: number[], changes?: { index: number; widths: number[] }[]) {
      const { source, path } = await readPreviewSource(base, file);
      if (sourceHash(source) !== hash) throw new Error('파일이 변경되었습니다. 문서 미리보기를 새로고침해 주세요.');
      const edits = changes ?? [{ index, widths }];
      if (!Array.isArray(edits) || !edits.length || edits.length > 100 || new Set(edits.map(e => e?.index)).size !== edits.length) throw new Error('표 변경 목록을 확인해 주세요.');
      let after = source;
      for (const edit of edits) after = formatTable(after, edit?.index, edit?.widths);
      return plan(base, path, source, after);
    },
    async save(planId: string) {
      const plan = plans.get(planId);
      if (!plan) throw new Error('변경 비교를 다시 실행해 주세요.');
      const { source, path } = await readPreviewSource(plan.base, plan.file);
      if (source !== plan.before || path !== plan.file) throw new Error('파일이 변경되어 저장하지 않았습니다. 새로고침 후 다시 비교해 주세요.');
      const mode = (await stat(path)).mode & 0o777;
      const stage = await mkdtemp(join(dirname(path), '.csync-table-'));
      try {
        const candidate = join(stage, 'document.md');
        await writeFile(candidate, plan.after, { mode });
        if (await realpath(plan.file) !== path || await readFile(path, 'utf8') !== plan.before) throw new Error('파일이 변경되어 저장하지 않았습니다.');
        await rename(candidate, path);
        plans.delete(planId);
      } finally { await rm(stage, { recursive: true, force: true }); }
      return { saved: path };
    },
  };
}
