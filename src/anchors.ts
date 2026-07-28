/**
 * 헤딩 앵커 — 마크다운과 Confluence 의 서로 다른 "섹션 가리키기" 표기를 잇는다.
 *
 *   마크다운(GitHub·Obsidian·VS Code)   [§1](#1-신뢰--trust-registry----블록-01)   ← 슬러그
 *   Obsidian wikilink                   [[문서#1. 신뢰 — Trust Registry  ·  블록 01]]  ← 헤딩 텍스트
 *
 * **Confluence 가 헤딩에 자동으로 붙이는 id 에는 기대지 않는다.** 그 규칙은 Cloud 와 Data Center 가
 * 서로 다르고(‑ Cloud 는 공백만 하이픈으로 바꾸고, DC 는 `페이지제목-헤딩` 형태다) 예고 없이 바뀐다.
 * 대신 링크 대상이 되는 헤딩 앞에 **Anchor 매크로로 이름을 직접 심고**, 링크는 그 이름을 가리킨다.
 * 이름은 마크다운 슬러그를 그대로 쓰므로 왕복도 정확해진다 — 양쪽 다 우리가 정한 값이다.
 */

const FENCE = /^\s*(?:```|~~~)/;

/** 인라인 마크다운 표기를 벗긴다 — 슬러그는 렌더된 텍스트 기준이다. */
function plainText(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) → label
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => a ?? t)
    .replace(/`+/g, '')
    .replace(/\*\*|~~|\*/g, '') // _ 는 남긴다: 슬러그가 밑줄을 보존하므로(foo_bar → foo_bar)
    .trim();
}

/**
 * GitHub 호환 헤딩 슬러그: 소문자 → 문자·숫자·공백·하이픈·밑줄 외 제거 → 공백 하나당 하이픈 하나.
 * 공백을 **접지 않는** 것이 핵심이다 — `제목  ·  블록` 처럼 구두점이 빠지면 하이픈이 여러 개 남는다.
 */
export function slugifyHeading(text: string): string {
  return plainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export type Heading = { text: string; slug: string; level: number };

/** 본문의 ATX 헤딩 목록(코드블록 안은 제외). 슬러그가 겹치면 GitHub 처럼 -1·-2 를 붙인다. */
export function collectHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  const used = new Map<string, number>();
  let inFence = false;
  for (const line of md.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 닫는 # 는 앞에 공백이 있을 때만 장식이다(`## C#` 의 # 를 지우지 않도록)
    const m = line.match(/^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    const base = slugifyHeading(text);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    out.push({ text, slug: n ? `${base}-${n}` : base, level: m[1].length });
  }
  return out;
}

/** 슬러그 → 헤딩 텍스트. 먼저 나온 헤딩이 이긴다. */
export function buildAnchorIndex(md: string): Map<string, string> {
  const idx = new Map<string, string>();
  for (const h of collectHeadings(md)) if (!idx.has(h.slug)) idx.set(h.slug, h.text);
  return idx;
}

/** 퍼센트 인코딩된 앵커를 되돌린다(실패하면 원문). */
export const decodeAnchor = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Confluence 앵커 비교용 키 — 공백·구두점을 모두 지운 소문자.
 * Confluence 는 헤딩 앵커 id 를 만들 때 공백을 지우고 구두점 처리도 버전마다 달라서,
 * 남는 글자(문자·숫자)만으로 맞춰야 안정적이다.
 */
export const anchorKey = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Confluence 가 만든 앵커 fragment 를 이 문서의 헤딩에 맞춘다.
 * id 는 보통 `<페이지제목><헤딩텍스트>`(공백 제거) 형태라 제목 접두사를 허용하고,
 * 그래도 안 맞으면 "헤딩으로 끝나는가"로 한 번 더 시도한다(가장 긴 헤딩이 이긴다).
 */
export function matchConfluenceAnchor(
  fragment: string,
  headings: Heading[],
  pageTitle: string,
): Heading | null {
  const frag = anchorKey(decodeAnchor(fragment));
  if (!frag) return null;
  const titleKey = anchorKey(pageTitle);

  let loose: Heading | null = null;
  let looseLen = 0;
  for (const h of headings) {
    const hk = anchorKey(h.text);
    if (!hk) continue;
    if (frag === hk || frag === titleKey + hk) return h; // 정확히 맞으면 바로
    if (frag.endsWith(hk) && hk.length > looseLen) {
      loose = h;
      looseLen = hk.length;
    }
  }
  return loose;
}

/**
 * Obsidian wikilink 의 앵커(`[[문서#헤딩 텍스트]]`)를 마크다운 슬러그로.
 * 중첩 헤딩(`#상위#하위`)은 마지막 것이 실제 목적지고, 블록 참조(`#^id`)는 마크다운에 대응물이 없다.
 */
export function wikilinkAnchorToSlug(anchor: string): string | null {
  const last = anchor.split('#').filter(Boolean).pop();
  if (!last || last.startsWith('^')) return null;
  return slugifyHeading(last) || null;
}

/** 본문이 섹션을 가리키는 링크 하나. `dest` 가 비면 같은 문서다. */
export type LinkAnchor = { dest: string; fragment: string; wiki: boolean };

const MD_LINK = /\[([^\]]*)\]\((<[^>]+>|[^()\s]+)\)/g;
const WIKILINK = /(!?)\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;

/**
 * 본문에서 **앵커가 붙은 링크만** 훑는다 — 어느 문서의 어느 헤딩에 앵커를 심어야 하는지 알아내기 위해서다.
 * 전체 렌더보다 훨씬 싸고, 코드블록·인라인 코드·이미지는 제외한다.
 */
export function collectLinkAnchors(md: string): LinkAnchor[] {
  const out: LinkAnchor[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 홀수 인덱스 = 인라인 코드 → 링크로 치지 않는다
    const prose = line.split(/(`+[^`]*`+)/).filter((_, i) => i % 2 === 0).join('');

    for (const m of prose.matchAll(MD_LINK)) {
      if (prose[m.index - 1] === '!') continue; // 이미지
      const d = decodeAnchor(m[2].replace(/^<(.*)>$/, '$1'));
      const i = d.indexOf('#');
      if (i < 0 || i === d.length - 1) continue;
      if (/^(https?:|mailto:)/i.test(d)) continue;
      out.push({ dest: d.slice(0, i), fragment: d.slice(i + 1), wiki: false });
    }
    for (const m of prose.matchAll(WIKILINK)) {
      if (m[1] === '!' || !m[3]) continue; // 임베드·앵커 없는 wikilink
      out.push({ dest: m[2].trim(), fragment: m[3].slice(1), wiki: true });
    }
  }
  return out;
}

/** Anchor 매크로 — 링크 대상 헤딩 바로 앞에 심어 이름을 고정한다. */
export function anchorMacro(name: string): string {
  const safe = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">${safe}</ac:parameter></ac:structured-macro>`;
}
