/**
 * Markdown → Confluence storage format 변환.
 * - 코드블록 → code 매크로
 * - 내부 .md 링크 → 페이지 링크(ri:page, 대상 제목 기반)
 * - 로컬 이미지 → 첨부 참조(ri:attachment), 외부 URL 이미지는 그대로
 * 모든 경로는 baseDir 기준 상대경로로 해석한다.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import { resolveWikilinks, type LinkResolver } from './obsidian.js';

export const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');

/** markdown-it 이 퍼센트 인코딩한 링크/이미지 경로를 실제 경로로 디코드(실패 시 원본). */
const decodePath = (s: string) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

type RenderCtx = {
  fileDir: string; // baseDir 기준 현재 파일 디렉토리
  titleIndex: Record<string, string>; // 내부 .md(base 상대) → 제목
  images: { filename: string; abs: string }[];
  internalLinks: number;
  linkStack: boolean[];
  linkedTitles: Set<string>; // 이 문서가 내부 링크로 가리키는 대상 제목들
};

const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

// 렌더 규칙은 md 인스턴스에 한 번만 등록되므로, 현재 변환 컨텍스트를 모듈 변수로 공유한다.
let ctx: RenderCtx = { fileDir: '', titleIndex: {}, images: [], internalLinks: 0, linkStack: [], linkedTitles: new Set() };
let baseDir = '';

/** 링크 href 가 base 내부 .md 면 그 페이지 제목 반환 */
function resolveInternalLink(href: string): string | null {
  if (!href || /^(https?:|mailto:|#)/i.test(href)) return null;
  const pathPart = href.split('#')[0];
  if (!pathPart || !/\.md$/i.test(pathPart)) return null;
  const rel = relative(baseDir, resolve(baseDir, ctx.fileDir, decodePath(pathPart)));
  return ctx.titleIndex[rel] ?? null;
}

md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = (t.info || '').trim().split(/\s+/)[0];
  const safe = t.content.split(']]>').join(']]]]><![CDATA[>');
  const langParam = lang ? `<ac:parameter ac:name="language">${lang}</ac:parameter>` : '';
  return `<ac:structured-macro ac:name="code">${langParam}<ac:plain-text-body><![CDATA[${safe}]]></ac:plain-text-body></ac:structured-macro>\n`;
};

md.renderer.rules.link_open = (tokens, idx, opts, _env, self) => {
  const href = tokens[idx].attrGet('href') || '';
  const targetTitle = resolveInternalLink(href);
  if (targetTitle) {
    ctx.linkStack.push(true);
    ctx.internalLinks++;
    ctx.linkedTitles.add(targetTitle);
    return `<ac:link><ri:page ri:content-title="${escapeXml(targetTitle)}" /><ac:link-body>`;
  }
  ctx.linkStack.push(false);
  return self.renderToken(tokens, idx, opts);
};
md.renderer.rules.link_close = (tokens, idx, opts, _env, self) =>
  ctx.linkStack.pop() ? '</ac:link-body></ac:link>' : self.renderToken(tokens, idx, opts);

// 이미지 기본 최대 표시 폭(px). Confluence 본문 폭을 넘는 큰 원본이 영역을 벗어나는 것을 막는다.
// 개별 이미지는 markdown title 로 덮어쓴다: ![alt](src "width=900")
const DEFAULT_IMAGE_WIDTH = 760;

md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const src = token.attrGet('src') || '';
  const title = token.attrGet('title') || '';
  const m = title.match(/width\s*=\s*(\d+)/i);
  const width = m ? m[1] : String(DEFAULT_IMAGE_WIDTH);
  const widthAttr = width ? ` ac:width="${escapeXml(width)}"` : '';
  if (/^https?:\/\//i.test(src)) {
    return `<ac:image${widthAttr}><ri:url ri:value="${escapeXml(src)}" /></ac:image>`;
  }
  // markdown-it 이 링크 경로를 퍼센트 인코딩하므로 디코드해서 실제 파일명/경로로 복원(한글·공백 대응)
  const abs = resolve(baseDir, ctx.fileDir, decodePath(src.split('#')[0]));
  const filename = basename(abs);
  ctx.images.push({ filename, abs });
  return `<ac:image${widthAttr}><ri:attachment ri:filename="${escapeXml(filename)}" /></ac:image>`;
};

/** 첫 H1(`# 제목`)을 제목으로 추출하고 본문에서 제거 */
export function splitTitleAndBody(markdown: string, fallback: string): { title: string; body: string } {
  const lines = markdown.split('\n');
  const i = lines.findIndex((l) => /^#\s+/.test(l));
  if (i === -1) return { title: fallback, body: markdown };
  const title = lines[i].replace(/^#\s+/, '').trim();
  lines.splice(i, 1);
  return { title, body: lines.join('\n') };
}

export type Rendered = {
  storage: string;
  images: { filename: string; abs: string }[];
  internalLinks: number;
  linkedTitles: string[];
};

/**
 * 본문 markdown 을 storage format 으로 변환(base 기준 상대경로로 링크·이미지 해석).
 * resolveLink 를 주면 Obsidian 의 [[wikilink]]·![[embed]] 를 먼저 표준 링크로 정규화한다.
 */
export function toStorage(
  markdown: string,
  rel: string,
  titleIndex: Record<string, string>,
  base: string,
  resolveLink?: LinkResolver,
): Rendered {
  baseDir = base;
  ctx = { fileDir: dirname(rel) === '.' ? '' : dirname(rel), titleIndex, images: [], internalLinks: 0, linkStack: [], linkedTitles: new Set() };
  const src = resolveLink ? resolveWikilinks(markdown, resolveLink) : markdown;
  const storage = md.render(src);
  return { storage, images: ctx.images, internalLinks: ctx.internalLinks, linkedTitles: [...ctx.linkedTitles] };
}

/**
 * 변경 감지용 문서 해시: 제목 + storage + 참조 로컬 이미지의 내용 해시.
 * 이미지 내용을 포함하므로, 같은 파일명으로 이미지만 교체해도 해시가 바뀌어 재동기화 대상이 된다.
 * 이미지가 없으면 hashOf(title + '\0' + storage) 와 동일(이미지 없는 문서는 기존 해시 유지).
 */
export function docHash(title: string, r: Rendered): string {
  const parts = [title, r.storage];
  for (const img of r.images) {
    let digest = 'missing';
    try {
      if (existsSync(img.abs)) digest = createHash('sha256').update(readFileSync(img.abs)).digest('hex');
    } catch {
      /* 읽기 실패 시 'missing' 으로 둔다 */
    }
    parts.push(`${img.filename}:${digest}`);
  }
  return hashOf(parts.join('\0'));
}
