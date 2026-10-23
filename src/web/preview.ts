import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { createDocument } from '@mixmark-io/domino';
import { htmlTableMarkdown } from '../documents/html-tables.js';
import { splitFrontmatter } from '../documents/obsidian.js';
import { within } from './output.js';
import { readPreviewSource, hiddenDocumentPath as hidden } from './document-source.js';
import { editableTables, sourceHash } from './table-format.js';
import { tableEditorBridge } from './table-editor-script.js';
import { randomBytes } from 'node:crypto';

const elements = new Set('h1 h2 h3 h4 h5 h6 p a img ul ol li dl dt dd blockquote pre code em strong s del b i u sub sup br hr table caption colgroup col thead tbody tfoot tr th td span div details summary'.split(' '));
const discard = new Set('SCRIPT STYLE IFRAME OBJECT EMBED FORM INPUT BUTTON TEXTAREA SELECT META LINK BASE SVG MATH TEMPLATE'.split(' '));
const attributes = new Set(['alt', 'title', 'colspan', 'rowspan', 'span', 'start', 'scope', 'id']);
const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
const allowedStyle = /^(?:width|max-width|height|text-align|vertical-align|table-layout|color|background-color|white-space|font-weight|font-style|text-decoration)$/i;

/** Return a self-contained, inert document. No file writes or external requests. */
export async function previewDocument(basePath: string, filePath: string, nonce?: string) {
  const { source: original, base, path: file } = await readPreviewSource(basePath, filePath);
  const { body } = splitFrontmatter(original);
  const doc = createDocument(htmlTableMarkdown().render(body));
  for (const element of Array.from(doc.body.querySelectorAll('*'))) {
    if (discard.has(element.tagName)) { element.remove(); continue; }
    if (!elements.has(element.tagName.toLowerCase())) {
      while (element.firstChild) element.parentNode?.insertBefore(element.firstChild, element);
      element.remove(); continue;
    }
    const source = element.tagName === 'IMG' ? element.getAttribute('src') : null;
    for (const attr of Array.from(element.attributes)) {
      if (attr.name === 'style') {
        const safe = attr.value.split(';').filter(declaration => {
          const colon = declaration.indexOf(':');
          return colon > 0 && allowedStyle.test(declaration.slice(0, colon).trim())
            && !/url\s*\(|expression|@|\\|[<>]/i.test(declaration.slice(colon + 1));
        }).join(';');
        element.setAttribute('style', safe);
      } else if (!(attributes.has(attr.name) || (attr.name === 'href' && attr.value.startsWith('#')))) element.removeAttribute(attr.name);
    }
    if (source) {
      try {
        if (/^[a-z][a-z\d+.-]*:|^[/\\]/i.test(source)) continue;
        const image = await realpath(resolve(dirname(file), decodeURIComponent(source.split(/[?#]/)[0])));
        const type = imageTypes[extname(image).toLowerCase()];
        if (!type || !within(base, image) || hidden(base, image)) continue;
        const info = await stat(image);
        if (!info.isFile() || info.size > 5_000_000) continue;
        element.setAttribute('src', `data:${type};base64,${(await readFile(image)).toString('base64')}`);
      } catch { /* Missing/out-of-root images remain as their alt text. */ }
    }
  }
  const tables = editableTables(original);
  const rendered = Array.from(doc.querySelectorAll('table'));
  if (rendered.length !== tables.length) tables.forEach(t => { t.editable = false; });
  tables.forEach((t, i) => { if (t.editable) rendered[i]?.setAttribute('data-csync-table', String(t.index)); });
  const channel = randomBytes(24).toString('hex');
  const script = nonce ? `<script nonce="${nonce}" data-channel="${channel}">(${tableEditorBridge.toString()})()</script>` : '';
  return { hash: sourceHash(original), channel, tables, html: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    *{box-sizing:border-box}body{margin:0;padding:24px;color:#172b4d;background:white;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:760px;margin:auto}h1,h2,h3,h4{line-height:1.4}h1{font-size:26px}h2{font-size:22px}h3{font-size:18px}table{border-collapse:collapse;margin:16px 0}th,td{border:1px solid #c7cfdb;padding:8px;vertical-align:top;overflow-wrap:anywhere}th{background:#f0f3f8}td p,th p{margin:0}img{max-width:100%;height:auto}pre{padding:14px;background:#f4f6f9;overflow:auto}code{font-size:.88em;overflow-wrap:anywhere}blockquote{border-left:3px solid #c7cfdb;margin-left:0;padding-left:16px;color:#526078}a{color:#315fd8}hr{border:0;border-top:1px solid #dde3ec}
    .csync-editing table[data-csync-table]{cursor:pointer}.csync-editing table[data-csync-table]:hover{outline:2px dashed #8192e3}.csync-selected{outline:3px solid #5466d8!important}.csync-resize{position:absolute;width:10px;cursor:col-resize;z-index:10;touch-action:none;border-left:2px solid #5466d8;background:#5466d82a}
  </style></head><body><main>${doc.body.innerHTML}</main>${script}</body></html>` };
}
