/**
 * Confluence export_view(HTML) → Markdown 변환.
 * turndown(HTML→MD) + Confluence 특화 규칙(code 매크로·첨부 이미지·표).
 * storage/export_view 는 무손실 역변환이 아니므로 근사 결과다.
 */
import TurndownService from 'turndown';

export type Html2MdOpts = {
  /** 본문에서 참조된 로컬 첨부 파일명을 통지(다운로드 대상 수집용) */
  onImage?: (filename: string) => void;
};

export function htmlToMarkdown(html: string, opts: Html2MdOpts = {}): string {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    hr: '---',
    emDelimiter: '_',
  });

  // 코드블록: Confluence code 매크로는 export_view 에서 <pre ...syntaxhighlighter...> 로 렌더된다.
  td.addRule('confCode', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const el = node as unknown as HTMLElement;
      const params = el.getAttribute('data-syntaxhighlighter-params') || '';
      const m = params.match(/brush:\s*([^;]+)/i);
      const lang = m ? m[1].trim() : '';
      const code = (el.textContent || '').replace(/\n+$/, '');
      return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    },
  });

  // 이미지: 첨부 → 로컬 파일명으로, 외부 URL 이미지 → 절대 URL 유지.
  td.addRule('confImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as unknown as HTMLElement;
      const src = el.getAttribute('src') || '';
      const alt = el.getAttribute('alt') || '';
      const isAttachment =
        el.getAttribute('data-linked-resource-type') === 'attachment' ||
        /\/download\/(attachments|thumbnails)\//.test(src);
      if (!isAttachment && /^https?:\/\//i.test(src)) {
        return `![${alt}](${src})`;
      }
      const alias = el.getAttribute('data-linked-resource-default-alias') || '';
      const name = alias || decodeURIComponent((src.split('?')[0].split('/').pop() || '').trim());
      if (name) opts.onImage?.(name);
      return `![${alt || name}](${name})`;
    },
  });

  // 표 → GFM 마크다운 표(turndown 기본은 표 미지원).
  td.addRule('confTable', {
    filter: 'table',
    replacement: (_content, node) => {
      const cell = (c: Element) =>
        td.turndown((c as HTMLElement).innerHTML || '').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
      const trs = Array.from((node as unknown as HTMLElement).querySelectorAll('tr'));
      const matrix = trs.map((r) =>
        Array.from(r.children).filter((c) => c.nodeName === 'TD' || c.nodeName === 'TH').map(cell),
      );
      const rows = matrix.filter((r) => r.length);
      if (!rows.length) return '';
      const header = rows[0];
      const sep = header.map(() => '---');
      let out = `\n\n| ${header.join(' | ')} |\n| ${sep.join(' | ')} |\n`;
      for (const r of rows.slice(1)) out += `| ${r.join(' | ')} |\n`;
      return `${out}\n`;
    },
  });

  return td.turndown(html).trim() + '\n';
}
