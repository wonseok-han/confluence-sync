/**
 * docs/*.md → Confluence Cloud 단방향 동기화 (수동 실행)
 *
 *   npm run sync           실제 생성/업데이트 (계층 구조 유지)
 *   npm run sync:dry       호출 없이 대상·제목·부모·링크·이미지 수 출력(--dry-run)
 *   npm run sync -- --rebuild   기존 매핑 페이지 전부 삭제 후 처음부터 재생성
 *
 * 폴더 = 계층: 하위 폴더의 README.md 가 그 폴더의 대표 페이지가 되고,
 * 같은 폴더의 다른 문서는 그 README 의 자식으로 생성된다.
 * - 내부 .md 링크는 Confluence 페이지 링크(ri:page content-title)로 자동 변환된다.
 * - 로컬 이미지는 페이지 첨부(attachment)로 업로드되고 ri:attachment 로 참조된다.
 * git 이 원천(SoT)이며 Confluence 는 미러다. 양방향 동기화는 하지 않는다.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname, basename } from 'node:path';
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

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- Markdown → Confluence storage format ----
const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

/** 렌더 컨텍스트: 파일별로 toStorage()가 설정한다. */
type RenderCtx = {
  fileDir: string;                       // REPO_ROOT 기준 현재 파일의 디렉토리
  titleIndex: Record<string, string>;    // 내부 .md 경로 → 페이지 제목(H1)
  images: { filename: string; abs: string }[]; // 업로드할 로컬 이미지
  internalLinks: number;                 // 내부 페이지 링크로 변환된 수
  linkStack: boolean[];                  // link_open/close 매칭(내부=true)
};
let ctx: RenderCtx = { fileDir: '', titleIndex: {}, images: [], internalLinks: 0, linkStack: [] };

/** 링크 href 가 docs 내부 .md 면 그 페이지 제목을 반환, 아니면 null */
function resolveInternalLink(href: string): string | null {
  if (!href || /^(https?:|mailto:|#)/i.test(href)) return null;
  const pathPart = href.split('#')[0];
  if (!pathPart || !/\.md$/i.test(pathPart)) return null;
  const rel = relative(REPO_ROOT, resolve(REPO_ROOT, ctx.fileDir, pathPart));
  return ctx.titleIndex[rel] ?? null;
}

// 코드펜스 → code 매크로
md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = (t.info || '').trim().split(/\s+/)[0];
  const safe = t.content.split(']]>').join(']]]]><![CDATA[>'); // CDATA 안 ']]>' 회피
  const langParam = lang ? `<ac:parameter ac:name="language">${lang}</ac:parameter>` : '';
  return `<ac:structured-macro ac:name="code">${langParam}<ac:plain-text-body><![CDATA[${safe}]]></ac:plain-text-body></ac:structured-macro>\n`;
};

// 내부 .md 링크 → Confluence 페이지 링크 (ri:page content-title)
md.renderer.rules.link_open = (tokens, idx, _opts, _env, self) => {
  const href = tokens[idx].attrGet('href') || '';
  const targetTitle = resolveInternalLink(href);
  if (targetTitle) {
    ctx.linkStack.push(true);
    ctx.internalLinks++;
    return `<ac:link><ri:page ri:content-title="${escapeXml(targetTitle)}" /><ac:link-body>`;
  }
  ctx.linkStack.push(false);
  return self.renderToken(tokens, idx, _opts); // 외부/일반 링크는 기본 <a>
};
md.renderer.rules.link_close = (tokens, idx, _opts, _env, self) =>
  ctx.linkStack.pop() ? '</ac:link-body></ac:link>' : self.renderToken(tokens, idx, _opts);

// 이미지 → 로컬은 첨부(ri:attachment), 외부 URL 은 ri:url
md.renderer.rules.image = (tokens, idx) => {
  const src = tokens[idx].attrGet('src') || '';
  if (/^https?:\/\//i.test(src)) {
    return `<ac:image><ri:url ri:value="${escapeXml(src)}" /></ac:image>`;
  }
  const abs = resolve(REPO_ROOT, ctx.fileDir, src.split('#')[0]);
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
function toStorage(markdown: string, relPath: string, titleIndex: Record<string, string>): Rendered {
  ctx = { fileDir: dirname(relPath), titleIndex, images: [], internalLinks: 0, linkStack: [] };
  const storage = md.render(markdown);
  return { storage, images: ctx.images, internalLinks: ctx.internalLinks };
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

/** 모든 문서의 경로 → 제목(H1) 맵 (내부 링크 변환용) */
function buildTitleIndex(relPaths: string[]): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const rel of relPaths) {
    const { title } = splitTitleAndBody(readFileSync(resolve(REPO_ROOT, rel), 'utf8'), rel);
    idx[rel] = title;
  }
  return idx;
}

/** 파일명이 (넘버링 prefix 포함) README 인지 — 폴더 대표 페이지 판정 */
const isReadme = (base: string) => /README\.md$/.test(base);

/** 폴더(dir) → 그 폴더의 대표 README 경로 맵 */
function buildFolderIndex(relPaths: string[]): Record<string, string> {
  const idx: Record<string, string> = {};
  for (const p of relPaths) {
    const parts = p.split('/');
    if (isReadme(parts[parts.length - 1])) idx[parts.slice(0, -1).join('/')] = p;
  }
  return idx;
}

/**
 * 폴더=계층 매핑의 부모 결정.
 * - docs 직계 파일 → null(루트: CONFLUENCE_PARENT_PAGE_ID)
 * - 하위 폴더의 대표 README → null(루트 바로 아래)
 * - 하위 폴더의 일반 파일 → 같은 폴더의 대표 README
 */
function parentKeyOf(relPath: string, folderIndex: Record<string, string>): string | null {
  const parts = relPath.split('/');
  if (parts.length <= 2) return null;
  if (isReadme(parts[parts.length - 1])) return null;
  return folderIndex[parts.slice(0, -1).join('/')] ?? null;
}

/** README(폴더 대표)를 폴더 맨 앞에, 나머지는 파일명순 → 부모가 자식보다 먼저 */
function sortKey(relPath: string): string {
  const parts = relPath.split('/');
  const base = parts[parts.length - 1];
  return parts.slice(0, -1).join('/') + '/' + (isReadme(base) ? '' : base);
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

/** --rebuild: 매핑에 기록된 모든 페이지를 삭제(휴지통)하고 매핑을 비운다. (delete:page:confluence 필요) */
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

/**
 * 로컬 이미지를 페이지 첨부로 업로드(v1, multipart).
 * POST /child/attachment 는 첨부를 추가하며, 같은 파일명이 이미 있으면 새 버전으로 갱신한다(멱등).
 * (write:attachment:confluence 스코프 필요)
 */
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
  if (!res.ok) {
    throw new Error(`attachment ${res.status} ${res.statusText}\n${await res.text()}`);
  }
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
  const titleIndex = buildTitleIndex(relPaths);
  const files = sortForSync(relPaths);
  console.log(`문서 ${files.length}건 (${relative(REPO_ROOT, DOCS_DIR)}/)`);

  if (DRY_RUN) {
    for (const rel of files) {
      const { title, body } = splitTitleAndBody(readFileSync(resolve(REPO_ROOT, rel), 'utf8'), rel);
      const { images, internalLinks } = toStorage(body, rel, titleIndex);
      const pk = parentKeyOf(rel, folderIndex);
      console.log(`  [dry] ${rel}  →  "${title}"  (부모: ${pk ?? 'ROOT'}, 내부링크: ${internalLinks}, 이미지: ${images.length})`);
    }
    console.log('\n--dry-run: 실제 호출 없음.');
    return;
  }

  const spaceId = await getSpaceId(CONFLUENCE_SPACE_KEY!);
  const mapping = loadMapping();

  if (REBUILD) await deleteAll(mapping);
  const work: Mapping = REBUILD ? {} : mapping;

  let created = 0, updated = 0;
  for (const rel of files) {
    const raw = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    const { title, body } = splitTitleAndBody(raw, rel);
    const { storage, images } = toStorage(body, rel, titleIndex);
    const pk = parentKeyOf(rel, folderIndex);
    const parentId = pk ? work[pk]?.pageId : CONFLUENCE_PARENT_PAGE_ID;
    if (pk && !parentId) {
      console.error(`  ✗ 건너뜀  ${rel}  (부모 '${pk}' 페이지가 아직 없음)`);
      continue;
    }
    try {
      const result = await upsertPage(spaceId, work, rel, title, storage, parentId);
      saveMapping(work); // 건별 저장 — 중간 실패해도 진행분 보존
      const pageId = work[rel].pageId;

      // 이미지 첨부 업로드
      let imgOk = 0;
      for (const img of images) {
        if (!existsSync(img.abs)) {
          console.error(`    ⚠ 이미지 없음: ${relative(REPO_ROOT, img.abs)}`);
          continue;
        }
        try {
          await uploadAttachment(pageId, img.filename, img.abs);
          imgOk++;
        } catch (e) {
          console.error(`    ✗ 이미지 업로드 실패 ${img.filename}\n${(e as Error).message}`);
        }
      }
      const imgNote = images.length ? `, 이미지 ${imgOk}/${images.length}` : '';
      console.log(`  ${result === 'created' ? '＋ 생성' : '↻ 갱신'}  ${rel}  →  "${title}"  (부모: ${pk ?? 'ROOT'}${imgNote})`);
      result === 'created' ? created++ : updated++;
    } catch (e) {
      console.error(`  ✗ 실패  ${rel}\n${(e as Error).message}`);
    }
  }
  console.log(`\n완료: 생성 ${created}, 갱신 ${updated}, 전체 ${files.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
