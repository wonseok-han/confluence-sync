/**
 * Obsidian 브릿지 — vault 관례와 이 도구의 표준 마크다운 사이를 잇는다.
 *
 * 원칙: **표준을 내보내고, 방언을 받아들인다.**
 *  - push: vault 에서 쓴 YAML frontmatter · [[wikilink]] · ![[embed]] 를 이해해 그대로 발행한다.
 *  - pull: Obsidian·GitHub·VS Code 어디서나 열리는 표준 상대 링크로 내보낸다
 *          (frontmatter 의 pageId 가 왕복 동기화의 앵커가 된다).
 *
 * frontmatter 는 평면 `key: value` 만 다룬다. 중첩·리스트가 필요할 만큼 복잡한 메타데이터는
 * 이 도구의 관심사가 아니며, 알 수 없는 키는 건드리지 않고 보존한다.
 */

export type Frontmatter = Record<string, string>;

const FENCE = /^\s*(?:```|~~~)/;
// [[대상]] · [[대상|별칭]] · [[대상#헤딩]] · ![[임베드]]
const WIKILINK = /(!?)\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;

/**
 * 문서 맨 앞의 YAML frontmatter 를 분리한다. 없으면 data 는 빈 객체.
 * `key: value` 한 줄짜리만 인식하고, 값의 감싼 따옴표는 벗긴다.
 */
export function splitFrontmatter(raw: string): { data: Frontmatter; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: raw };

  const data: Frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue; // 중첩/리스트 등 평면이 아닌 줄은 무시(보존은 하지 않음)
    data[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return { data, body: raw.slice(m[0].length) };
}

/** 평면 frontmatter 블록 생성. 값이 비면 그 키는 생략한다. */
export function buildFrontmatter(data: Frontmatter): string {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    // 콜론·따옴표·선행 특수문자가 있으면 YAML 이 깨지므로 인용한다
    .map(([k, v]) => `${k}: ${/[:#"'\n]|^\s|\s$/.test(v) ? JSON.stringify(v) : v}`);
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
}

/** 대상 이름 → 링크 목적지(현재 파일 기준 상대경로). 못 찾으면 null. */
export type LinkResolver = (target: string, embed: boolean) => string | null;

/** 공백이 있으면 <...> 로 감싼다(markdown-it 이 목적지를 통째로 파싱하도록). */
const dest = (p: string) => (/\s/.test(p) ? `<${p}>` : p);

/**
 * 마크다운 본문에서 "산문" 부분에만 변환을 적용한다.
 * 코드블록(``` / ~~~)과 인라인 코드(`...`) 안은 그대로 둔다 — 링크처럼 생긴 예제 코드를
 * 망가뜨리지 않기 위해서다.
 */
function mapProse(md: string, fn: (segment: string) => string): string {
  let inFence = false;
  return md
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // 홀수 인덱스 = 인라인 코드 스팬 → 원문 유지
      return line
        .split(/(`+[^`]*`+)/)
        .map((seg, i) => (i % 2 ? seg : fn(seg)))
        .join('');
    })
    .join('\n');
}

/**
 * [[wikilink]] · ![[embed]] → 표준 마크다운 링크.
 * 해석에 실패한 링크는 원문 그대로 남겨 (조용히 사라지지 않고) 눈에 띄게 한다.
 */
export function resolveWikilinks(md: string, resolve: LinkResolver): string {
  return mapProse(md, (s) =>
    s.replace(WIKILINK, (whole, bang: string, target: string, hash: string | undefined, alias: string | undefined) => {
      const embed = bang === '!';
      const found = resolve(target.trim(), embed);
      if (!found) return whole; // 해석 실패 → 원문 보존
      const label = (alias ?? target).trim();
      return embed ? `![${label}](${dest(found)})` : `[${label}](${dest(found + (hash ?? ''))})`;
    }),
  );
}

// [text](dest) — dest 는 <...> 로 감싸였을 수 있다. 앞의 ! 는 이미지 임베드.
const MD_LINK = /(!?)\[([^\]]*)\]\((<[^>]+>|[^()\s]+)\)/g;

/**
 * 표준 마크다운 링크 → [[wikilink]] (resolveWikilinks 의 역변환).
 * toWikilink 가 null 을 주면(= 외부 URL·이미지·대상 불명) 그 링크는 그대로 둔다.
 * 이미지 임베드(`![...]()`)는 건드리지 않는다 — 표준 문법이 Obsidian 에서도 그대로 렌더된다.
 */
export function linksToWikilinks(
  md: string,
  toWikilink: (dest: string, label: string) => string | null,
): string {
  return mapProse(md, (s) =>
    s.replace(MD_LINK, (whole, bang: string, label: string, rawDest: string) => {
      if (bang === '!') return whole; // 이미지는 표준 링크 유지
      const d = rawDest.replace(/^<(.*)>$/, '$1');
      return toWikilink(d, label) ?? whole;
    }),
  );
}
