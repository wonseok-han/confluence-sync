/**
 * docs/*.md → Confluence Cloud 단방향 동기화 (수동 실행)
 *
 *   npm run sync           실제 생성/업데이트 (계층 구조 유지)
 *   npm run sync:dry       호출 없이 대상·제목·부모만 출력(--dry-run)
 *   npm run sync -- --rebuild   기존 매핑 페이지 전부 삭제 후 처음부터 재생성
 *
 * 폴더 = 계층: 하위 폴더의 README.md 가 그 폴더의 대표 페이지가 되고,
 * 같은 폴더의 다른 문서는 그 README 의 자식으로 생성된다.
 * git 이 원천(SoT)이며 Confluence 는 미러다. 양방향 동기화는 하지 않는다.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const DOCS_DIR = resolve(REPO_ROOT, 'docs');
const MAPPING_PATH = resolve(__dirname, '../mapping.json');
const DRY_RUN = process.argv.includes('--dry-run');
const REBUILD = process.argv.includes('--rebuild');

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

// ---- Markdown → Confluence storage format ----
const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

// 코드펜스는 Confluence code 매크로로 변환
md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = (t.info || '').trim().split(/\s+/)[0];
  // CDATA 안에 ']]>' 가 있으면 분할(표준 회피 트릭)
  const safe = t.content.split(']]>').join(']]]]><![CDATA[>');
  const langParam = lang ? `<ac:parameter ac:name="language">${lang}</ac:parameter>` : '';
  return `<ac:structured-macro ac:name="code">${langParam}<ac:plain-text-body><![CDATA[${safe}]]></ac:plain-text-body></ac:structured-macro>\n`;
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

function toStorage(markdown: string): string {
  return md.render(markdown);
}

// ---- 문서 수집 ----
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** 파일명이 (넘버링 prefix 포함) README 인지 — 폴더 대표 페이지 판정 */
const isReadme = (base: string) => /README\.md$/.test(base);

/** 폴더(dir) → 그 폴더의 대표 README 경로 맵 */
function buildFolderIndex(relPaths: string[]): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const p of relPaths) {
    const parts = p.split('/');
    const base = parts[parts.length - 1];
    if (isReadme(base)) idx[parts.slice(0, -1).join('/')] = p;
  }
  return idx;
}

/**
 * 폴더=계층 매핑의 부모 결정.
 * - docs 직계 파일(docs/X.md) → null(루트: CONFLUENCE_PARENT_PAGE_ID)
 * - 하위 폴더의 대표 README(00-README.md 등) → null(루트 바로 아래)
 * - 하위 폴더의 일반 파일 → 같은 폴더의 대표 README (그 폴더 대표 페이지의 자식)
 * 반환은 mapping 의 key(레포 상대경로)이거나 null.
 */
function parentKeyOf(relPath: string, folderIndex: Record<string, string>): string | null {
  const parts = relPath.split('/'); // 예: ['docs','20-design','01-item-04-design.md']
  if (parts.length <= 2) return null; // docs/X.md
  const base = parts[parts.length - 1];
  if (isReadme(base)) return null; // 폴더 대표는 루트 아래
  return folderIndex[parts.slice(0, -1).join('/')] ?? null; // 같은 폴더 대표 README
}

/**
 * 정렬 키: 같은 폴더 안에서 README(폴더 대표, prefix 무관)를 맨 앞에 두고,
 * 나머지는 파일명순으로 정렬한다. 결과는 트리 순서이며, 폴더 README가 그 폴더의
 * 자식보다 항상 먼저 오므로 부모 페이지 생성 순서도 자동 보장된다.
 */
function sortKey(relPath: string): string {
  const parts = relPath.split('/');
  const base = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');
  return dir + '/' + (isReadme(base) ? '' : base);
}

function sortForSync(relPaths: string[]): string[] {
  return [...relPaths].sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// ---- 매핑 ----
type Mapping = Record<string, { pageId: string; title?: string }>;
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

/** --rebuild: 매핑에 기록된 모든 페이지를 삭제(휴지통)하고 매핑을 비운다. (delete:page:confluence 스코프 필요) */
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

async function upsertPage(
  spaceId: string,
  mapping: Mapping,
  key: string,
  title: string,
  storage: string,
  parentId: string | undefined,
): Promise<'created' | 'updated'> {
  const existing = mapping[key];
  if (existing?.pageId) {
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
    mapping[key] = { pageId: existing.pageId, title };
    return 'updated';
  }
  const body: Record<string, unknown> = {
    spaceId,
    status: 'current',
    title,
    body: { representation: 'storage', value: storage },
  };
  if (parentId) body.parentId = parentId;
  const created = await api(`/api/v2/pages`, { method: 'POST', body: JSON.stringify(body) });
  mapping[key] = { pageId: created.id, title };
  return 'created';
}

async function main() {
  if (!DRY_RUN) requireEnv();
  const relPaths = collectMarkdown(DOCS_DIR).map((f) => relative(REPO_ROOT, f));
  const folderIndex = buildFolderIndex(relPaths);
  const files = sortForSync(relPaths);
  console.log(`문서 ${files.length}건 (${relative(REPO_ROOT, DOCS_DIR)}/)`);

  if (DRY_RUN) {
    for (const rel of files) {
      const { title } = splitTitleAndBody(readFileSync(resolve(REPO_ROOT, rel), 'utf8'), rel);
      const pk = parentKeyOf(rel, folderIndex);
      console.log(`  [dry] ${rel}  →  "${title}"  (부모: ${pk ?? 'ROOT'})`);
    }
    console.log('\n--dry-run: 실제 호출 없음.');
    return;
  }

  const spaceId = await getSpaceId(CONFLUENCE_SPACE_KEY!);
  const mapping = loadMapping();

  if (REBUILD) await deleteAll(mapping);
  // deleteAll 이 mapping 을 비웠으므로 메모리상 객체도 초기화
  const work: Mapping = REBUILD ? {} : mapping;

  let created = 0, updated = 0;
  for (const rel of files) {
    const raw = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    const { title, body } = splitTitleAndBody(raw, rel);
    const storage = toStorage(body);
    const pk = parentKeyOf(rel, folderIndex);
    const parentId = pk ? work[pk]?.pageId : CONFLUENCE_PARENT_PAGE_ID;
    if (pk && !parentId) {
      console.error(`  ✗ 건너뜀  ${rel}  (부모 '${pk}' 페이지가 아직 없음)`);
      continue;
    }
    try {
      const result = await upsertPage(spaceId, work, rel, title, storage, parentId);
      saveMapping(work); // 건별 저장 — 중간 실패해도 진행분 보존
      console.log(`  ${result === 'created' ? '＋ 생성' : '↻ 갱신'}  ${rel}  →  "${title}"  (부모: ${pk ?? 'ROOT'})`);
      result === 'created' ? created++ : updated++;
    } catch (e) {
      console.error(`  ✗ 실패  ${rel}\n${(e as Error).message}`);
    }
  }
  console.log(`\n완료: 생성 ${created}, 갱신 ${updated}, 전체 ${files.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
