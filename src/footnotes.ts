import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { collectHeadings } from './anchors.js';
import { mapMarkdownText, replaceGeneratedBlocks } from './pdf-pages.js';

/** 각주 확장을 일반 제목 앵커 + 위첨자 Markdown 링크로 내보낸다. */
export function footnotesToLinks(source: string): string {
  if (!source.includes('[^')) return source;
  const md = new MarkdownIt({ html: true }).use(footnote);
  const definitions: { start: number; end: number; label: string; body: string }[] = [];
  const lines = source.split('\n');
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const defRule = md.block.ruler.getRules('').find((r) => r.name === 'footnote_def')!;
  md.block.ruler.at('footnote_def', (state, start, end, silent) => {
    const ok = defRule(state, start, end, silent);
    if (ok && !silent) {
      const first = lines[start].match(/^ {0,3}\[\^([^\]]+)\]:\s*(.*)$/);
      if (first) definitions.push({
        start: offsets[start], end: Math.min(offsets[state.line], source.length), label: first[1],
        body: [first[2], ...lines.slice(start + 1, state.line).map((l) => l.replace(/^(?: {4}|\t)/, ''))].join('\n').trimEnd(),
      });
    }
    return ok;
  }, { alt: ['paragraph', 'reference'] });
  const env = {};
  const tokens = md.parse(source, env);
  if (!definitions.length) return source;

  const used = new Set(collectHeadings(source).map((h) => h.slug));
  const labels = new Set(definitions.map((d) => d.label));
  const notes = new Map<string, { number: number; heading: string; anchor: string }>();
  const edits: { start: number; end: number; text: string }[] = [];
  const refRule = md.inline.ruler.getRules('').find((r) => r.name === 'footnote_ref')!;
  let localEdits: typeof edits = [];
  md.inline.ruler.at('footnote_ref', (state, silent) => {
    const start = state.pos;
    const ok = refRule(state, silent);
    if (ok && !silent) {
      const label = state.src.slice(start + 2, state.pos - 1);
      if (!labels.has(label)) return ok; // 지원 범위 밖의 중첩 정의는 원문으로 남긴다.
      let note = notes.get(label);
      if (!note) {
        const number = notes.size + 1;
        let heading = `각주 ${number}`, anchor = `각주-${number}`, suffix = 0;
        while (used.has(anchor)) { heading = `각주 ${number}-${++suffix}`; anchor = `각주-${number}-${suffix}`; }
        used.add(anchor);
        note = { number, heading, anchor };
        notes.set(label, note);
      }
      localEdits.push({ start, end: state.pos, text: `<sup>[${note.number}](#${note.anchor})</sup>` });
    }
    return ok;
  });
  // 인라인 각주(^[...])는 이 변환의 대상이 아니다.
  md.inline.ruler.disable('footnote_inline');
  const replaceRefs = (text: string): string => {
    localEdits = [];
    md.inline.parse(text, md, env, []);
    for (const e of localEdits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    return text;
  };

  // 코드블록과 정의를 제외한 원문 구간을 그대로 보존한다.
  const excluded = [
    ...definitions.map((d) => ({ start: d.start, end: d.end, definition: true })),
    ...tokens.filter((t) => (t.type === 'fence' || t.type === 'code_block' || t.type === 'html_block') && t.map)
      .map((t) => ({ start: offsets[t.map![0]], end: Math.min(offsets[t.map![1]], source.length), definition: false })),
  ].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const span of excluded) {
    if (span.start < cursor) continue;
    edits.push({ start: cursor, end: span.start, text: replaceRefs(source.slice(cursor, span.start)) });
    if (span.definition) edits.push({ start: span.start, end: span.end, text: '' });
    cursor = span.end;
  }
  edits.push({ start: cursor, end: source.length, text: replaceRefs(source.slice(cursor)) });
  // 참조하지 않은 정의도 버리지 않는다.
  for (const d of definitions) if (!notes.has(d.label)) replaceRefs(`[^${d.label}]`);
  let result = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, e.start) + e.text + result.slice(e.end);
  const bodies = new Map(definitions.map((d) => [d.label, d.body]));
  return result.trimEnd() + '\n\n' + [...notes].map(([label, note]) =>
    `<!-- csync-footnote:v1 ${Buffer.from(JSON.stringify({ label, anchor: note.anchor })).toString('base64')} -->\n###### ${note.heading}\n\n${replaceRefs(bodies.get(label) ?? '')}\n<!-- /csync-footnote -->`,
  ).join('\n\n') + '\n';
}

/** 생성 표식이 있는 각주만 복원한다. 설명의 사용자 수정은 유지한다. */
export function linksToFootnotes(source: string): string {
  const refs = new Map<string, string>();
  const definitions: string[] = [];
  const text = replaceGeneratedBlocks(source,
    /<!-- csync-footnote:v1 ([A-Za-z0-9+/=]+) -->\n#{1,6} [^\n]+\n\n([\s\S]*?)\n<!-- \/csync-footnote -->/g,
    (_all, encoded, body) => {
      const { label, anchor } = JSON.parse(Buffer.from(encoded, 'base64').toString()) as { label: string; anchor: string };
      refs.set(anchor, label);
      definitions.push(`[^${label}]: ${body.trimEnd().split('\n').join('\n    ')}`);
      return '';
    });
  if (!refs.size) return source;
  const replace = (s: string) => mapMarkdownText(s, p => p.replace(/<sup>\[\d+\]\(#([^\s)]+)\)<\/sup>/g,
    (all, anchor) => refs.has(decodeURIComponent(anchor)) ? `[^${refs.get(decodeURIComponent(anchor))}]` : all));
  return replace(text).trimEnd() + '\n\n' + definitions.map(replace).join('\n\n') + '\n';
}
