import { isMap, isScalar, parseDocument, Scalar, stringify } from 'yaml';

export type Frontmatter = Record<string, string>;

const OPEN = /^\uFEFF?---\r?\n/;
const PAIR = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/;
const GENERATED = new Set(['title', 'pageId', 'spaceKey', 'source', 'updated']);
const YAML_STYLE = { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 } as const;

function readBlock(raw: string) {
  const open = OPEN.exec(raw);
  if (!open) return;
  const rest = raw.slice(open[0].length);
  const end = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (end) return { yaml: rest.slice(0, end.index), body: rest.slice(end.index + end[0].length) };
}

export function markdownBody(raw: string): string {
  return readBlock(raw)?.body ?? raw;
}

/** Keep legacy flat values, including the original spelling of numeric page IDs. */
export function splitFrontmatter(raw: string): { data: Frontmatter; body: string } {
  const block = readBlock(raw);
  if (!block) return { data: {}, body: raw };

  const data = new Map<string, string>();
  for (const line of block.yaml.split(/\r?\n/)) {
    const pair = PAIR.exec(line);
    if (pair) data.set(pair[1], pair[2].trim().replace(/^["'](.*)["']$/, '$1'));
  }
  const doc = parseDocument(block.yaml, { prettyErrors: false });
  if (!doc.errors.length && isMap(doc.contents)) {
    for (const { key, value } of doc.contents.items) {
      if (isScalar(key) && typeof key.value === 'string' && isScalar(value) && typeof value.value === 'string') {
        data.set(key.value, value.value);
      }
    }
  }
  return { data: Object.fromEntries(data), body: block.body };
}

function wrap(yaml: string): string {
  return `---\n${yaml}---\n\n`;
}

/** Write generated values as strings for both YAML 1.1 and YAML 1.2 readers. */
export function buildFrontmatter(data: Frontmatter): string {
  const values = Object.entries(data).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return values.length ? wrap(stringify(Object.fromEntries(values), YAML_STYLE)) : '';
}

/** Refresh managed fields and retain the existing YAML nodes for local properties. */
export function mergePullFrontmatter(original: string, data: Frontmatter): string {
  const block = readBlock(original);
  if (!block) {
    if (OPEN.test(original)) throw new Error('기존 프론트매터의 닫는 구분선을 확인할 수 없습니다.');
    return buildFrontmatter(data);
  }

  let doc = parseDocument(block.yaml, { prettyErrors: false });
  if (doc.errors.length) {
    // Older Pull wrote some generated strings unquoted. Repair only those malformed flat lines.
    const repaired = block.yaml.split(/\r?\n/).map(line => {
      const pair = PAIR.exec(line);
      if (!pair || !GENERATED.has(pair[1]) || !parseDocument(line, { prettyErrors: false }).errors.length) return line;
      return stringify({ [pair[1]]: pair[2] }, YAML_STYLE).trimEnd();
    }).join('\n');
    doc = parseDocument(repaired, { prettyErrors: false });
  }
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) {
    throw new Error('기존 프론트매터가 올바른 YAML 매핑이 아닙니다. 로컬 속성을 확인한 뒤 다시 가져오세요.');
  }
  for (const [key, value] of Object.entries(data)) {
    if (!value) continue;
    const old = doc.get(key, true);
    if (isScalar(old)) {
      if (old.anchor && old.value !== value) throw new Error('기존 프론트매터의 생성 필드에 연결된 YAML 앵커를 확인하세요.');
      old.value = value;
      delete old.tag;
      old.type = 'QUOTE_DOUBLE';
    } else {
      const scalar = new Scalar(value);
      scalar.type = 'QUOTE_DOUBLE';
      doc.set(key, scalar);
    }
  }
  return wrap(doc.toString({ lineWidth: 0 }));
}
