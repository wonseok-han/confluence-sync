/**
 * Confluence export_view(HTML) → Markdown 변환.
 * turndown(HTML→MD) + Confluence 특화 규칙(code 매크로·첨부 이미지·표).
 * storage/export_view 는 무손실 역변환이 아니므로 근사 결과다.
 */
import TurndownService from 'turndown';

export type Html2MdOpts = {
  /** 본문에서 참조된 로컬 첨부 파일명을 통지(다운로드 대상 수집용) */
  onImage?: (filename: string) => void;
  /** 로컬 첨부 이미지 링크에 붙일 상대 경로 접두사(예: 'attachments/문서명'). 없으면 파일명만 */
  assetPrefix?: string;
  /**
   * storage 에서 뽑은 코드블록 언어 목록(문서 순서, 미지정은 '').
   * export_view 의 `brush:` 는 언어 미지정 시 Confluence 가 java 를 기본으로 넣어 신뢰할 수 없다.
   */
  codeLangs?: string[];
};

/** storage(XHTML)의 code 매크로들에서 language 파라미터를 문서 순서대로 추출(미지정은 ''). */
export function codeLanguagesFromStorage(storage: string): string[] {
  const out: string[] = [];
  const macro = /<ac:structured-macro[^>]*ac:name="code"[\s\S]*?<\/ac:structured-macro>/g;
  let m: RegExpExecArray | null;
  while ((m = macro.exec(storage)) !== null) {
    const lang = m[0].match(/ac:name="language"[^>]*>([^<]*)</);
    out.push(lang ? lang[1].trim() : '');
  }
  return out;
}

/** 공백이 있으면 <...> 로 감싼 마크다운 링크 목적지(공백 있는 경로도 안전하게 파싱되도록) */
const linkDest = (p: string) => (/\s/.test(p) ? `<${p}>` : p);

/**
 * turndown 은 텍스트 노드 단위로 이스케이프해서, 줄 중간인데도 마커로 오인해 \- \+ \. 을 남긴다.
 * (예: `**7️⃣**\-**1️⃣**` — 두 굵은 글씨 사이 텍스트 노드가 "-" 하나라 노드 시작으로 취급)
 * 줄 맨 앞의 진짜 마커 이스케이프는 보존하고, 그 뒤(줄 중간)의 것만 되돌린다. 코드블록은 건드리지 않는다.
 */
function relaxEscapes(md: string): string {
  let inFence = false;
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // 들여쓰기 + (줄 맨 앞의 이스케이프된 마커) 까지는 그대로 두고 이후만 완화
      const head = line.match(/^\s*(?:\\[-+>#]|\d+\\\.)?/)?.[0] ?? '';
      const rest = line
        .slice(head.length)
        // 줄 중간의 - + . > 는 마커가 아니므로 이스케이프 불필요
        .replace(/\\([-+.>])/g, '$1')
        // 링크가 아닌 대괄호 쌍(뒤에 ( 나 [ 가 오지 않음)은 이스케이프 불필요
        .replace(/\\\[([^[\]\n]*)\\\](?!\s*[([])/g, '[$1]');
      return head + rest;
    })
    .join('\n');
}

export function htmlToMarkdown(html: string, opts: Html2MdOpts = {}): string {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    hr: '---',
    emDelimiter: '_',
  });

  // Confluence export_view 는 색상 텍스트용 인라인 <style> 을 본문(제목 안까지) 끼워 넣는다.
  // turndown 은 기본적으로 이런 요소의 텍스트를 그대로 뱉으므로 통째로 제거한다.
  td.remove(['style', 'script', 'noscript', 'head', 'meta', 'link']);

  // turndown 은 _ 를 강조로 오인할까봐 전부 \_ 로 이스케이프한다.
  // 그러나 단어 내부 밑줄은 CommonMark 에서 강조가 아니므로(:11_eleven_square_blue: 같은 이모지 코드)
  // 양쪽이 단어 문자인 경우만 이스케이프를 되돌린다.
  const baseEscape = td.escape.bind(td);
  td.escape = (s: string) => baseEscape(s).replace(/(\w)\\_(?=\w)/g, '$1_');

  // Confluence 는 리스트 항목 내용을 <li><p>…</p></li> 로 감싼다.
  // 기본 규칙대로면 문단으로 취급돼 항목마다 빈 줄이 생기므로(loose list),
  // li 안의 첫 문단은 빈 줄 없이 붙인다(두 번째 이후 문단은 기존대로 분리).
  td.addRule('liParagraph', {
    filter: (node) => node.nodeName === 'P' && (node.parentNode as { nodeName?: string } | null)?.nodeName === 'LI',
    replacement: (content, node) => {
      const el = node as unknown as HTMLElement;
      return el.previousElementSibling ? `\n\n${content}` : content;
    },
  });

  // 코드블록: Confluence code 매크로는 export_view 에서 <pre ...syntaxhighlighter...> 로 렌더된다.
  // 언어는 storage 기반 codeLangs 를 우선 사용(개수가 맞을 때). 없으면 brush 로 폴백.
  const preCount = (html.match(/<pre[\s>]/gi) || []).length;
  const langs = opts.codeLangs && opts.codeLangs.length === preCount ? opts.codeLangs : undefined;
  let preIdx = 0;

  td.addRule('confCode', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const el = node as unknown as HTMLElement;
      const i = preIdx++;
      let lang: string;
      if (langs) {
        lang = langs[i] ?? '';
      } else {
        const params = el.getAttribute('data-syntaxhighlighter-params') || '';
        const m = params.match(/brush:\s*([^;]+)/i);
        lang = m ? m[1].trim() : '';
      }
      // 원본에 줄 끝 공백이 잔뜩 붙어 있는 경우가 많아 트림(코드 의미는 불변)
      const code = (el.textContent || '').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
      return `\n\n\`\`\`${lang || 'plaintext'}\n${code}\n\`\`\`\n\n`;
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
        return `![${alt}](${linkDest(src)})`;
      }
      const alias = el.getAttribute('data-linked-resource-default-alias') || '';
      const name = alias || decodeURIComponent((src.split('?')[0].split('/').pop() || '').trim());
      if (name) opts.onImage?.(name);
      const dest = opts.assetPrefix ? `${opts.assetPrefix}/${name}` : name;
      return `![${alt || name}](${linkDest(dest)})`;
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

  return relaxEscapes(td.turndown(html)).trim() + '\n';
}
