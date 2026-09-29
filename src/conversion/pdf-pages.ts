import { createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { renderPdfPages, type PdfPageJob } from './pdf-renderer.js';
import MarkdownIt from 'markdown-it';
import { collectHeadings } from '../documents/anchors.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = <T>(value: string): T => JSON.parse(Buffer.from(value, 'base64').toString());
const parser = new MarkdownIt({ html: true });

/** 소스 위치를 유지하면서 코드·HTML 블록을 제외한 일반 텍스트를 처리한다. */
export function mapMarkdownText(text: string, fn: (part: string) => string): string {
  const lines = text.split('\n'), offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const spans = parser.parse(text, {}).filter(t => ['fence', 'code_block', 'html_block'].includes(t.type) && t.map)
    .map(t => [offsets[t.map![0]], Math.min(offsets[t.map![1]], text.length)]);
  let cursor = 0, result = '';
  const prose = (s: string) => protectInline(s, fn);
  for (const [start, end] of spans) {
    if (start < cursor) continue;
    result += prose(text.slice(cursor, start)) + text.slice(start, end); cursor = end;
  }
  return result + prose(text.slice(cursor));
}
function protectInline(text: string, fn: (part: string) => string): string {
  const re = /(`+)([\s\S]*?)(?<!`)\1(?!`)/g;
  let cursor = 0, out = '';
  for (const m of text.matchAll(re)) { out += fn(text.slice(cursor, m.index)) + m[0]; cursor = m.index! + m[0].length; }
  return out + fn(text.slice(cursor));
}

type PdfRef = { path: string; page: number; label: string; embed: boolean };
export type PdfResult = { text: string; assets: string[]; pages: number };
const REF = /\[([^\]\n]*)\]\(#[^\s)]+\)<!-- csync-pdf:v1 ([A-Za-z0-9+/=]+) -->/g;
const INLINE_REF = /!\[([^\]\n]*)\]\((?:<[^>\n]+>|[^()\s]+)\)<!-- csync-pdf-inline:v1 ([A-Za-z0-9+/=]+) -->/g;
const GALLERY = /\n*<!-- csync-pdf-pages:v1 -->\n[\s\S]*?<!-- \/csync-pdf-pages -->\n*/g;

/** 자동 생성한 참조만 복원한다. 일반 이미지·제목은 유지한다. */
export function restorePdfReferences(text: string, file: string, base: string): PdfResult {
  const assets: string[] = [];
  // 매크로 표식은 코드 예제에서 복원하지 않도록 실제 HTML 토큰만 검사한다.
  const restore = (_all: string, currentLabel: string, data: string) => {
    const ref = decode<PdfRef>(data);
    if (typeof ref.path !== 'string' || !/\.pdf$/i.test(ref.path) || !Number.isSafeInteger(ref.page) || ref.page < 1) {
      throw new Error('PDF 역변환 정보의 경로 또는 쪽 번호가 올바르지 않습니다.');
    }
    const abs = resolve(dirname(file), ref.path);
    requireLocal(abs, base);
    if (!existsSync(abs)) throw new Error(`역변환에 필요한 원본 PDF가 없습니다: ${abs}`);
    assets.push(abs);
    const path = relative(base, abs).split('\\').join('/');
    return `${ref.embed ? '!' : ''}[[${path}#page=${ref.page}|${currentLabel || ref.label}]]`;
  };
  const restored = replaceGeneratedBlocks(replaceGeneratedBlocks(text, INLINE_REF, restore), REF, restore);
  return { text: replaceGeneratedBlocks(restored, GALLERY, () => '\n\n'), assets: [...new Set(assets)], pages: 0 };
}

/** 생성 표식을 처리하되 fenced/indented code는 그대로 보존한다. */
export function replaceGeneratedBlocks(text: string, re: RegExp, fn: (...args: any[]) => string): string {
  const lines = text.split('\n'), offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const spans = parser.parse(text, {}).filter(t => ['fence', 'code_block'].includes(t.type) && t.map)
    .map(t => [offsets[t.map![0]], Math.min(offsets[t.map![1]], text.length)]);
  for (const m of text.matchAll(/(`+)([\s\S]*?)(?<!`)\1(?!`)/g)) spans.push([m.index!, m.index! + m[0].length]);
  return text.replace(re, (...args) => {
    const offset = args[args.length - 2] as number;
    const markerOffset = offset + (args[0] as string).search(/\S/);
    return spans.some(([s, e]) => markerOffset >= s && markerOffset < e) ? args[0] : fn(...args);
  });
}

function requireLocal(abs: string, base: string): void {
  const rel = relative(realpathSync(base), existsSync(abs) ? realpathSync(abs) : abs);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error(`PDF는 --base 안에 있어야 합니다: ${abs}`);
}

export async function extractPdfPages(text: string, file: string, base: string, output: string, dryRun: boolean, source: (path: string) => string = p => p): Promise<PdfResult> {
  const assets = new Set<string>(), headings = new Set(collectHeadings(text).map(h => h.slug));
  const pages = new Map<string, { heading: string; anchor: string; image: string; gallery: boolean }>();
  const hashes = new Map<string, string>();
  const jobs: PdfPageJob[] = [];
  const link = /(?<!!)(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^()\s]+)\)/g;
  const convertLinks = (input: string, inline: boolean) => mapMarkdownText(input, part => part.replace(link, (all, bang, label, raw, offset) => {
    // 홀수 개의 백슬래시로 이스케이프한 링크는 예제 텍스트다.
    if ((part.slice(0, offset).match(/\\+$/)?.[0].length ?? 0) % 2) return all;
    let dest: string;
    try { dest = decodeURIComponent(raw.replace(/^<(.*)>$/, '$1')); } catch { return all; }
    if (/^[a-z][a-z\d+.-]*:/i.test(dest)) return all;
    const m = dest.match(/^(.*\.pdf)#page=(\d+)$/i);
    if (!m) return all;
    const local = resolve(dirname(file), m[1]);
    const abs = source(local);
    if (abs === local) requireLocal(local, base);
    if (!existsSync(abs)) throw new Error(`PDF 파일을 찾을 수 없습니다: ${abs}`);
    const page = Number(m[2]);
    if (!Number.isSafeInteger(page) || page < 1) throw new Error(`잘못된 PDF 쪽 번호: ${dest}`);
    assets.add(abs);
    let hash = hashes.get(abs);
    if (!hash) { hash = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 24); hashes.set(abs, hash); }
    const key = `${hash}-${page}`;
    let entry = pages.get(key);
    if (!entry) {
      let heading = `PDF 원문 ${pages.size + 1} - ${page}쪽`;
      let anchor = `pdf-원문-${pages.size + 1}---${page}쪽`, suffix = 0;
      const initialHeading = heading, initialAnchor = anchor;
      while (headings.has(anchor)) { heading = `${initialHeading}-${++suffix}`; anchor = `${initialAnchor}-${suffix}`; }
      headings.add(anchor);
      const assetRel = `attachments/pdf-pages/pdfjs-${key}.png`;
      const target = resolve(output, assetRel);
      jobs.push({ file: abs, page, target });
      const outputFile = resolve(output, relative(base, file));
      const image = relative(dirname(outputFile), target).split('\\').join('/');
      entry = { heading, anchor, image, gallery: false }; pages.set(key, entry);
    }
    const ref: PdfRef = { path: m[1], page, label, embed: bang === '!' };
    if (inline) return `![${label || `PDF ${page}쪽`}](<${entry.image}>)<!-- csync-pdf-inline:v1 ${encode(ref)} -->`;
    entry.gallery = true;
    return `[${label || `PDF ${page}쪽`}](#${entry.anchor})<!-- csync-pdf:v1 ${encode(ref)} -->`;
  }));
  const withInlineImages = replaceGeneratedBlocks(text,
    /<!-- csync-footnote:v1 [A-Za-z0-9+/=]+ -->\n[\s\S]*?<!-- \/csync-footnote -->/g,
    block => convertLinks(block, true));
  const converted = convertLinks(withInlineImages, false);
  if (!pages.size) return { text, assets: restorePdfReferences(text, file, base).assets, pages: 0 };
  await renderPdfPages(jobs, dryRun);
  const gallery = [...pages.values()].filter(p => p.gallery).map(p => `### ${p.heading}\n\n![${p.heading}](<${p.image}>)`).join('\n\n');
  return { text: converted.trimEnd() + (gallery ? `\n\n<!-- csync-pdf-pages:v1 -->\n${gallery}\n<!-- /csync-pdf-pages -->\n` : '\n'), assets: [...assets], pages: pages.size };
}
