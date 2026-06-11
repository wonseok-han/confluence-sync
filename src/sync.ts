/**
 * docs/*.md → Confluence Cloud 단방향 동기화 (수동 실행)
 *
 *   npm run sync         실제 생성/업데이트
 *   npm run sync:dry     호출 없이 대상·제목만 출력(--dry-run)
 *
 * 매핑(파일 경로 ↔ pageId)은 mapping.json 에 저장되어 재실행 시 같은 페이지를 갱신한다.
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

async function upsertPage(
  spaceId: string,
  mapping: Mapping,
  key: string,
  title: string,
  storage: string,
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
  if (CONFLUENCE_PARENT_PAGE_ID) body.parentId = CONFLUENCE_PARENT_PAGE_ID;
  const created = await api(`/api/v2/pages`, { method: 'POST', body: JSON.stringify(body) });
  mapping[key] = { pageId: created.id, title };
  return 'created';
}

async function main() {
  if (!DRY_RUN) requireEnv();
  const files = collectMarkdown(DOCS_DIR).sort();
  console.log(`문서 ${files.length}건 (${relative(REPO_ROOT, DOCS_DIR)}/)`);

  if (DRY_RUN) {
    for (const f of files) {
      const rel = relative(REPO_ROOT, f);
      const { title } = splitTitleAndBody(readFileSync(f, 'utf8'), rel);
      console.log(`  [dry] ${rel}  →  "${title}"`);
    }
    console.log('\n--dry-run: 실제 호출 없음.');
    return;
  }

  const spaceId = await getSpaceId(CONFLUENCE_SPACE_KEY!);
  const mapping = loadMapping();
  let created = 0, updated = 0;

  for (const f of files) {
    const rel = relative(REPO_ROOT, f);
    const raw = readFileSync(f, 'utf8');
    const { title, body } = splitTitleAndBody(raw, rel);
    const storage = toStorage(body);
    try {
      const result = await upsertPage(spaceId, mapping, rel, title, storage);
      saveMapping(mapping); // 건별 저장 — 중간 실패해도 진행분 보존
      console.log(`  ${result === 'created' ? '＋ 생성' : '↻ 갱신'}  ${rel}  →  "${title}"`);
      result === 'created' ? created++ : updated++;
    } catch (e) {
      console.error(`  ✗ 실패  ${rel}\n${(e as Error).message}`);
    }
  }
  console.log(`\n완료: 생성 ${created}, 갱신 ${updated}, 전체 ${files.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
