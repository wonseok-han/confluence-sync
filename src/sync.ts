/**
 * Markdown 디렉토리 → Confluence Cloud 단방향 동기화 (수동 실행)
 *
 *   npm run sync                       base 전체 중 "변경된" 문서만 갱신(+신규)
 *   npm run sync -- <경로...>          지정한 파일/폴더만 동기화(부모 README 자동 포함)
 *   npm run sync -- --base <dir>       동기화 루트 지정(필수, 또는 env CONFLUENCE_SYNC_BASE)
 *   npm run sync -- --force            변경 감지 무시, 전체 강제 갱신
 *   npm run sync:dry                   호출 없이 대상·상태(신규/변경/동일)·링크·이미지 출력
 *   npm run sync:rebuild               매핑된 페이지 전부 삭제 후 재생성
 *   npm run list                       base에서 인식된 문서·제목·계층만 출력(인증 불필요)
 *
 * 폴더 = 계층: 폴더의 README.md 가 대표 페이지가 되고 같은 폴더 문서는 그 자식이 된다.
 * 내부 .md 링크는 페이지 링크(ri:page)로, 로컬 이미지는 첨부로 변환된다.
 * 모든 경로(mapping 키·링크·계층)는 base 기준 상대경로다.
 * git 이 원천(SoT)이며 Confluence 는 미러다. 양방향 동기화는 하지 않는다.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAPPING_PATH = resolve(__dirname, '../mapping.json');

// ---- CLI 인자 ----
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const LIST = argv.includes('--list');
const REBUILD = argv.includes('--rebuild');
const FORCE = argv.includes('--force');
function optVal(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const baseInput = optVal('--base') ?? process.env.CONFLUENCE_SYNC_BASE;
if (!baseInput) {
  console.error(
    '✗ 동기화 루트가 지정되지 않았습니다.\n' +
    '  --base <dir> 인자 또는 env CONFLUENCE_SYNC_BASE 로 동기화할 디렉토리를 지정하세요.\n' +
    '  예) npm run sync -- --base ./docs',
  );
  process.exit(1);
}
const BASE_DIR = resolve(baseInput);
// 위치 인자(선택 경로): 플래그·옵션값 제외
const positionals: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--base') { i++; continue; }
  if (argv[i].startsWith('--')) continue;
  positionals.push(argv[i]);
}

// ---- 환경변수 ----
const {
  CONFLUENCE_BASE_URL,
  CONFLUENCE_EMAIL,
  CONFLUENCE_API_TOKEN,
  CONFLUENCE_SPACE_KEY,
  CONFLUENCE_PARENT_PAGE_ID,
} = process.env;

function requireEnv() {
  const missing = [
    ['CONFLUENCE_BASE_URL', CONFLUENCE_BASE_URL],
    ['CONFLUENCE_EMAIL', CONFLUENCE_EMAIL],
    ['CONFLUENCE_API_TOKEN', CONFLUENCE_API_TOKEN],
    ['CONFLUENCE_SPACE_KEY', CONFLUENCE_SPACE_KEY],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`환경변수 누락: ${missing.join(', ')}\n.env.example 을 참고해 .env 를 채우세요.`);
    process.exit(1);
  }
}

const authHeader = () =>
  'Basic ' + Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString('base64');

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${CONFLUENCE_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Confluence API ${res.status} ${res.statusText}\n${path}\n${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');

// ---- Markdown → Confluence storage format ----
const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

type RenderCtx = {
  fileDir: string;                       // BASE_DIR 기준 현재 파일 디렉토리
  titleIndex: Record<string, string>;    // 내부 .md(base 상대) → 제목
  images: { filename: string; abs: string }[];
  internalLinks: number;
  linkStack: boolean[];
};
let ctx: RenderCtx = { fileDir: '', titleIndex: {}, images: [], internalLinks: 0, linkStack: [] };

/** 링크 href 가 base 내부 .md 면 그 페이지 제목 반환 */
function resolveInternalLink(href: string): string | null {
  if (!href || /^(https?:|mailto:|#)/i.test(href)) return null;
  const pathPart = href.split('#')[0];
  if (!pathPart || !/\.md$/i.test(pathPart)) return null;
  const rel = relative(BASE_DIR, resolve(BASE_DIR, ctx.fileDir, pathPart));
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
    return `<ac:link><ri:page ri:content-title="${escapeXml(targetTitle)}" /><ac:link-body>`;
  }
  ctx.linkStack.push(false);
  return self.renderToken(tokens, idx, opts);
};
md.renderer.rules.link_close = (tokens, idx, opts, _env, self) =>
  ctx.linkStack.pop() ? '</ac:link-body></ac:link>' : self.renderToken(tokens, idx, opts);

md.renderer.rules.image = (tokens, idx) => {
  const src = tokens[idx].attrGet('src') || '';
  if (/^https?:\/\//i.test(src)) {
    return `<ac:image><ri:url ri:value="${escapeXml(src)}" /></ac:image>`;
  }
  const abs = resolve(BASE_DIR, ctx.fileDir, src.split('#')[0]);
  const filename = basename(abs);
  ctx.images.push({ filename, abs });
  return `<ac:image><ri:attachment ri:filename="${escapeXml(filename)}" /></ac:image>`;
};

/** 첫 H1(`# 제목`)을 제목으로 추출하고 본문에서 제거 */
function splitTitleAndBody(markdown: string, fallback: string): { title: string; body: string } {
  const lines = markdown.split('\n');
  const i = lines.findIndex((l) => /^#\s+/.test(l));
  if (i === -1) return { title: fallback, body: markdown };
  const title = lines[i].replace(/^#\s+/, '').trim();
  lines.splice(i, 1);
  return { title, body: lines.join('\n') };
}

type Rendered = { storage: string; images: { filename: string; abs: string }[]; internalLinks: number };
function toStorage(markdown: string, rel: string, titleIndex: Record<string, string>): Rendered {
  ctx = { fileDir: dirname(rel) === '.' ? '' : dirname(rel), titleIndex, images: [], internalLinks: 0, linkStack: [] };
  const storage = md.render(markdown);
  return { storage, images: ctx.images, internalLinks: ctx.internalLinks };
}

// ---- 문서 수집 (base 상대 경로 반환) ----
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function buildTitleIndex(rels: string[]): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const rel of rels) {
    const { title } = splitTitleAndBody(readFileSync(resolve(BASE_DIR, rel), 'utf8'), rel);
    idx[rel] = title;
  }
  return idx;
}

const isReadme = (base: string) => /README\.md$/.test(base);

function buildFolderIndex(rels: string[]): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const p of rels) {
    const parts = p.split('/');
    if (isReadme(parts[parts.length - 1])) idx[parts.slice(0, -1).join('/')] = p;
  }
  return idx;
}

/**
 * 부모 결정(base 상대):
 * - base 직계 파일 → null(루트: CONFLUENCE_PARENT_PAGE_ID)
 * - 폴더 대표 README → null(루트 바로 아래)
 * - 폴더 내 일반 파일 → 같은 폴더의 대표 README
 */
function parentKeyOf(rel: string, folderIndex: Record<string, string>): string | null {
  const parts = rel.split('/');
  if (parts.length === 1) return null;
  if (isReadme(parts[parts.length - 1])) return null;
  return folderIndex[parts.slice(0, -1).join('/')] ?? null;
}

/** README(폴더 대표)를 폴더 맨 앞에, 나머지는 파일명순 → 부모가 자식보다 먼저 */
function sortKey(rel: string): string {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');
  const leaf = isReadme(base) ? '' : base;
  return dir === '' ? leaf : dir + '/' + leaf;
}
function sortForSync(rels: string[]): string[] {
  return [...rels].sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** 선택 경로(positionals)를 base 상대 키 집합으로 확장(디렉토리는 하위 .md 전부) */
function resolveSelection(rels: string[]): string[] {
  const set = new Set<string>();
  const allSet = new Set(rels);
  for (const p of positionals) {
    const abs = resolve(BASE_DIR, p);
    const relToBase = relative(BASE_DIR, abs);
    if (relToBase.startsWith('..')) {
      console.error(`  ⚠ base 밖 경로 무시: ${p}`);
      continue;
    }
    const matched = rels.filter((r) => r === relToBase || r.startsWith(relToBase + '/'));
    if (matched.length === 0) console.error(`  ⚠ 매칭되는 문서 없음: ${p}`);
    matched.forEach((m) => set.add(m));
  }
  return [...set];
}

/** 선택된 문서의 부모 README 들을 재귀적으로 포함(부모 pageId 확보용) */
function withParents(selected: string[], folderIndex: Record<string, string>): string[] {
  const out = new Set(selected);
  for (const rel of selected) {
    let pk = parentKeyOf(rel, folderIndex);
    while (pk && !out.has(pk)) { out.add(pk); pk = parentKeyOf(pk, folderIndex); }
  }
  return [...out];
}

// ---- 매핑 ----
type Mapping = Record<string, { pageId: string; title?: string; hash?: string }>;
function loadMapping(): Mapping {
  try { return JSON.parse(readFileSync(MAPPING_PATH, 'utf8')); } catch { return {}; }
}
function saveMapping(m: Mapping) {
  writeFileSync(MAPPING_PATH, JSON.stringify(m, null, 2) + '\n');
}

async function getSpaceId(key: string): Promise<string> {
  const data = await api(`/api/v2/spaces?keys=${encodeURIComponent(key)}`);
  const space = data.results?.[0];
  if (!space) throw new Error(`Space key '${key}' 를 찾을 수 없습니다.`);
  return space.id;
}

async function deleteAll(mapping: Mapping) {
  const entries = Object.entries(mapping);
  console.log(`--rebuild: 기존 페이지 ${entries.length}건 삭제`);
  for (const [key, { pageId }] of entries) {
    try {
      await api(`/api/v2/pages/${pageId}`, { method: 'DELETE' });
      console.log(`  🗑  삭제 ${key} (#${pageId})`);
    } catch (e) {
      console.error(`  ✗ 삭제 실패 ${key}\n${(e as Error).message}`);
    }
  }
  saveMapping({});
}

/** 로컬 이미지를 페이지 첨부로 업로드(v1 POST, multipart). 같은 파일명은 새 버전으로 갱신. */
async function uploadAttachment(pageId: string, filename: string, abs: string) {
  const buf = readFileSync(abs);
  const form = new FormData();
  form.append('file', new Blob([buf]), filename);
  form.append('minorEdit', 'true');
  const res = await fetch(`${CONFLUENCE_BASE_URL}/rest/api/content/${pageId}/child/attachment`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'X-Atlassian-Token': 'nocheck' },
    body: form as any,
  });
  if (!res.ok) throw new Error(`attachment ${res.status} ${res.statusText}\n${await res.text()}`);
}

type UpsertResult = 'created' | 'updated' | 'skipped';
async function upsertPage(
  mapping: Mapping, spaceId: string, key: string,
  title: string, storage: string, hash: string, parentId: string | undefined,
): Promise<UpsertResult> {
  const existing = mapping[key];
  if (existing?.pageId) {
    if (existing.hash === hash && !FORCE) return 'skipped'; // 변경 없음 → 건드리지 않음
    const cur = await api(`/api/v2/pages/${existing.pageId}`);
    const nextVersion = (cur.version?.number ?? 1) + 1;
    await api(`/api/v2/pages/${existing.pageId}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: existing.pageId,
        status: 'current',
        title,
        body: { representation: 'storage', value: storage },
        version: { number: nextVersion, message: `sync from git: ${key}` },
      }),
    });
    mapping[key] = { pageId: existing.pageId, title, hash };
    return 'updated';
  }
  const body: Record<string, unknown> = {
    spaceId, status: 'current', title,
    body: { representation: 'storage', value: storage },
  };
  if (parentId) body.parentId = parentId;
  const created = await api(`/api/v2/pages`, { method: 'POST', body: JSON.stringify(body) });
  mapping[key] = { pageId: created.id, title, hash };
  return 'created';
}

async function main() {
  if (!existsSync(BASE_DIR) || !statSync(BASE_DIR).isDirectory()) {
    console.error(`동기화 루트가 디렉토리가 아닙니다: ${BASE_DIR}`);
    process.exit(1);
  }
  if (!DRY_RUN && !LIST) requireEnv(); // list/dry 는 Confluence 호출이 없어 인증 불필요

  const allRel = collectMarkdown(BASE_DIR).map((f) => relative(BASE_DIR, f));
  const folderIndex = buildFolderIndex(allRel);
  const titleIndex = buildTitleIndex(allRel); // 링크 변환은 항상 전체 기준

  const selected = positionals.length ? withParents(resolveSelection(allRel), folderIndex) : allRel;
  const files = sortForSync(selected);
  const scope = positionals.length ? `선택 ${files.length}/${allRel.length}건` : `${files.length}건`;
  console.log(`base: ${BASE_DIR}\n대상: ${scope}`);

  // --list: base에서 인식된 문서·제목·계층만 출력(Confluence 호출 없음)
  if (LIST) {
    for (const rel of files) {
      let depth = 0;
      for (let pk = parentKeyOf(rel, folderIndex); pk; pk = parentKeyOf(pk, folderIndex)) depth++;
      console.log(`  ${'  '.repeat(depth)}${rel}  —  "${titleIndex[rel]}"`);
    }
    return;
  }

  const mapping = loadMapping();

  if (DRY_RUN) {
    for (const rel of files) {
      const { title, body } = splitTitleAndBody(readFileSync(resolve(BASE_DIR, rel), 'utf8'), rel);
      const { storage, images, internalLinks } = toStorage(body, rel, titleIndex);
      const hash = hashOf(title + '\0' + storage);
      const ex = mapping[rel];
      const status = !ex?.pageId ? '신규' : ex.hash === hash ? '동일' : '변경';
      const pk = parentKeyOf(rel, folderIndex);
      console.log(`  [${status}] ${rel}  →  "${title}"  (부모: ${pk ?? 'ROOT'}, 내부링크: ${internalLinks}, 이미지: ${images.length})`);
    }
    console.log('\n--dry-run: 실제 호출 없음.');
    return;
  }

  const spaceId = await getSpaceId(CONFLUENCE_SPACE_KEY!);
  if (REBUILD) await deleteAll(mapping);
  const work: Mapping = REBUILD ? {} : mapping;

  let created = 0, updated = 0, skipped = 0;
  for (const rel of files) {
    const { title, body } = splitTitleAndBody(readFileSync(resolve(BASE_DIR, rel), 'utf8'), rel);
    const { storage, images } = toStorage(body, rel, titleIndex);
    const hash = hashOf(title + '\0' + storage);
    const pk = parentKeyOf(rel, folderIndex);
    const parentId = pk ? work[pk]?.pageId : CONFLUENCE_PARENT_PAGE_ID;
    if (pk && !parentId) {
      console.error(`  ✗ 건너뜀  ${rel}  (부모 '${pk}' 페이지가 아직 없음)`);
      continue;
    }
    try {
      const result = await upsertPage(work, spaceId, rel, title, storage, hash, parentId);
      saveMapping(work);
      if (result === 'skipped') {
        console.log(`  =  변경없음  ${rel}`);
        skipped++;
        continue;
      }
      let imgOk = 0;
      for (const img of images) {
        if (!existsSync(img.abs)) { console.error(`    ⚠ 이미지 없음: ${relative(BASE_DIR, img.abs)}`); continue; }
        try { await uploadAttachment(work[rel].pageId, img.filename, img.abs); imgOk++; }
        catch (e) { console.error(`    ✗ 이미지 업로드 실패 ${img.filename}\n${(e as Error).message}`); }
      }
      const imgNote = images.length ? `, 이미지 ${imgOk}/${images.length}` : '';
      console.log(`  ${result === 'created' ? '＋ 생성' : '↻ 갱신'}  ${rel}  →  "${title}"  (부모: ${pk ?? 'ROOT'}${imgNote})`);
      result === 'created' ? created++ : updated++;
    } catch (e) {
      console.error(`  ✗ 실패  ${rel}\n${(e as Error).message}`);
    }
  }
  console.log(`\n완료: 생성 ${created}, 갱신 ${updated}, 변경없음 ${skipped}, 대상 ${files.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
