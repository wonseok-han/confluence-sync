import { createDocument } from '@mixmark-io/domino';
import { createHash } from 'node:crypto';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, relative, dirname, basename, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentAttachmentDir } from './asset-paths.js';
import { mapMarkdownText } from './pdf-pages.js';

/** 출력 트리의 경로와 실제 입력 파일을 연결한다. dry-run에서도 파일 복사 없이 사용한다. */
export function attachmentMapper(file: string, base: string) {
  const copies = new Map<string, string>(); // base 상대 출력 경로 → 입력 절대경로
  function localPath(raw: string): string | null {
    if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null;
    if (/^file:/i.test(raw)) return fileURLToPath(raw);
    if (!isAbsolute(raw) && /^[a-z][a-z\d+.-]*:/i.test(raw)) return null;
    try { return resolve(dirname(file), decodeURIComponent(raw)); } catch { return null; }
  }
  function relocate(raw: string, wiki = false): string | null {
    const hash = raw.indexOf('#');
    const path = hash < 0 ? raw : raw.slice(0, hash), fragment = hash < 0 ? '' : raw.slice(hash);
    const abs = wiki && !path.startsWith('/') && !path.startsWith('.') && !/^file:/i.test(path)
      ? resolve(base, path) : localPath(path);
    if (!abs || /\.md$/i.test(abs)) return null;
    // 일반 외부 URL 및 없는 링크는 그대로 남긴다.
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    const folder = documentAttachmentDir(file, base), name = basename(abs);
    let rel = `${folder}/${name}`;
    const previous = copies.get(rel) ?? resolve(base, rel);
    if (previous !== abs && existsSync(previous) && statSync(previous).isFile() && !readFileSync(previous).equals(readFileSync(abs))) {
      const hash = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 24);
      const extension = extname(name);
      rel = `${folder}/${basename(name, extension)}-${hash}${extension}`;
    }
    copies.set(rel, abs);
    const target = wiki ? rel : relative(dirname(file), resolve(base, rel)).split('\\').join('/');
    return target + fragment;
  }
  function rewriteHtml(part: string): string {
    return part.replace(/<!--[\s\S]*?-->|<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>|<(img|a)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (tag, excluded, type) => {
      if (!type) return tag;
      const attribute = type.toLowerCase() === 'img' ? 'src' : 'href';
      const raw = createDocument(tag).querySelector(type)?.getAttribute(attribute);
      if (!raw) return tag;
      const target = relocate(raw);
      if (target === null) return tag;
      const value = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return tag.replace(new RegExp(`(\\s${attribute}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)`, 'i'), (_all: string, prefix: string) => `${prefix}"${value}"`);
    });
  }
  function rewrite(text: string): string {
    return mapMarkdownText(text, part => {
      const md = part.replace(/(?<!!)(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^()\s]+)\)/g,
        (all, bang, label, raw, offset) => {
          if ((part.slice(0, offset).match(/\\+$/)?.[0].length ?? 0) % 2) return all;
          const dest = relocate(raw.replace(/^<(.*)>$/, '$1'));
          return dest === null ? all : `${bang}[${label}](<${dest.replace(/</g, '%3C').replace(/>/g, '%3E')}>)`;
        });
      const wiki = md.replace(/(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (all, bang, target, label, offset) => {
        if ((md.slice(0, offset).match(/\\+$/)?.[0].length ?? 0) % 2) return all;
        const dest = relocate(target, true);
        return dest === null ? all : `${bang}[[${dest}${label === undefined ? '' : '|' + label}]]`;
      });
      return rewriteHtml(wiki);
    }, rewriteHtml);
  }
  return { copies, rewrite, source: (abs: string) => copies.get(relative(base, abs).split('\\').join('/')) ?? abs };
}
