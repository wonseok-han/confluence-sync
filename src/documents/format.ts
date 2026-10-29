/** Conservative source formatting: preserve code, HTML, frontmatter and link targets. */
import MarkdownIt from 'markdown-it';
import { splitFrontmatter } from './obsidian.js';
import { relaxEscapes } from './html-to-markdown.js';
const parser = new MarkdownIt({ html: true });
const width = (s: string) => Array.from(s).reduce((n, c) => n + (/\p{Script=Hangul}|\p{Script=Han}/u.test(c) ? 2 : 1), 0);
function cells(line: string): string[] {
  const result: string[] = []; let part = '', slashes = 0, ticks = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '`' && slashes % 2 === 0) {
      let end = i; while (line[end] === '`') end++;
      const size = end - i; ticks = ticks === size ? 0 : ticks || size;
      part += line.slice(i, end); i = end - 1; slashes = 0; continue;
    }
    if (c === '|' && !ticks && slashes % 2 === 0) { result.push(part.trim()); part = ''; }
    else part += c;
    slashes = c === '\\' ? slashes + 1 : 0;
  }
  result.push(part.trim());
  if (line.trimStart().startsWith('|')) result.shift();
  if (line.trimEnd().endsWith('|') && !result.at(-1)) result.pop();
  return result;
}
export function formatDocument(source: string): string {
  const { body } = splitFrontmatter(source);
  const frontmatter = source.slice(0, source.length - body.length);
  const separator = frontmatter ? body.match(/^(?:[ \t]*\r?\n)*/)?.[0] ?? '' : '';
  const prefix = frontmatter + separator;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const text = body.slice(separator.length).replace(/\r\n/g, '\n'), lines = text.split('\n'), tokens = parser.parse(text, {});
  const protectedLines = new Set<number>(), rawHtmlLines = new Set<number>(), headings = new Set<number>();
  // Raw HTML tables can contain blank lines that end a Markdown HTML token.
  let tableStart = -1, tableDepth = 0;
  for (const tag of text.matchAll(/<\/?table\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    if (!tag[0].startsWith('</')) { if (tableDepth++ === 0) tableStart = tag.index!; }
    else if (tableDepth && --tableDepth === 0) {
      const start = text.slice(0, tableStart).split('\n').length - 1;
      const end = text.slice(0, tag.index! + tag[0].length).split('\n').length;
      for (let i = start; i < end; i++) { protectedLines.add(i); rawHtmlLines.add(i); }
    }
  }
  // Inline code may span lines; keep its entire source lines untouched.
  for (const match of text.matchAll(/(`+)([\s\S]*?)(?<!`)\1(?!`)/g)) {
    const start = text.slice(0, match.index).split('\n').length - 1;
    const end = start + match[0].split('\n').length;
    for (let i = start; i < end; i++) protectedLines.add(i);
  }
  for (const token of tokens) {
    if (!token.map) continue;
    const [start, end] = token.map;
    if (['fence', 'code_block', 'html_block', 'table_open'].includes(token.type)) {
      for (let i = start; i < end; i++) protectedLines.add(i);
    }
    if (token.type === 'heading_open' && !protectedLines.has(start) && token.level === 0 && end === start + 1 && /^ {0,3}#{1,6}\s/.test(lines[start])) {
      headings.add(start);
      lines[start] = lines[start].replace(/^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/, '$1 $2');
    }
    if (token.type === 'list_item_open' && !protectedLines.has(start)) lines[start] = lines[start].replace(/^(\s*)(?:[-+*](\s+)|(\d+)[.)](\s+))/, (_m, indent, space, number, orderedSpace) => indent + (number ? number + '.' + orderedSpace : '-' + space));
    if (token.type === 'table_open' && !rawHtmlLines.has(start) && token.level === 0) {
      const rows = lines.slice(start, end).map(cells), count = rows[0]?.length;
      if (count && rows.every(row => row.length === count)) {
        const sizes = Array.from({ length: count }, (_, i) => Math.max(3, ...rows.map(row => width(row[i]))));
        const formatted = rows.map((row, r) => '| ' + row.map((cell, i) => r === 1
          ? (cell.startsWith(':') ? ':' : '') + '-'.repeat(Math.max(3, sizes[i] - Number(cell.startsWith(':')) - Number(cell.endsWith(':')))) + (cell.endsWith(':') ? ':' : '')
          : cell + ' '.repeat(sizes[i] - width(cell))).join(' | ') + ' |');
        if (parser.render(formatted.join('\n')) === parser.render(lines.slice(start, end).join('\n'))) lines.splice(start, end - start, ...formatted);
      }
    }
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (protectedLines.has(i)) { out.push(lines[i]); continue; }
    let line = lines[i].replace(/[\t ]+$/, m => / {2,}$/.test(m) && lines[i].trim() ? '  ' : '');
    // Keep Markdown hard breaks; avoid link destinations, wiki targets and inline HTML.
    if (!/[\[\]<>`]/.test(line) && !/^ {0,3}(?:>|[-+*]\s|\d+[.)]\s)/.test(line)) line = relaxEscapes(line);
    if (!line.trim() && !out.at(-1)?.trim()) continue;
    if (headings.has(i) && out.length && out.at(-1)?.trim()) out.push('');
    out.push(line);
    if (headings.has(i) && i + 1 < lines.length && lines[i + 1].trim()) out.push('');
  }
  while (out.length && !out.at(-1)?.trim()) out.pop();
  return prefix + (out.length ? out.join(eol) + eol : '');
}
