import { progressStep } from '../shared/progress.js';
import {connectWorkspace} from './scope.js';
import { storeBaseline } from './baseline.js';
import { localStateHash } from './local-state.js';
import { buildTreeRenderer } from './render.js';
/**
 * `confluence-sync pull <pageId|url> [--out <dir>] (하위 항목 포함)`
 * Confluence 페이지를 읽어 Markdown(.md) 으로 생성한다(역방향).
 * 자식이 있는 페이지는 push 관례를 역으로 적용해 <slug>/README.md 폴더로 펼친다.
 * 첨부는 attachments/<문서명>/ 하위에 내려받고 이미지 링크를 그 경로로 재작성한다.
 *
 * 함께 받은 페이지끼리의 내부 링크는 마지막에 상대 .md 경로로 이어 붙인다(Obsidian 그래프·백링크가 살아난다).
 * 각 문서 머리에 pageId 를 담은 frontmatter 를 남겨, 매핑 파일 없이도 push 가 원본 페이지를 다시 찾아간다.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, copyFileSync, lstatSync, realpathSync, rmdirSync, constants } from 'node:fs';
import { resolve, join, dirname, basename, relative } from 'node:path';
import { fetchRemote } from './fetch.js';
import { verifyScope } from './scope.js';
import { positionalArgs } from '../cli/args.js';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadWorkspace, findSyncBase, resolveSyncBase, inScope, inNestedWorkspace, within, assertWorkspaceConnection, requireScope, scopePath, type Workspace } from './workspace.js';
import { readEnv, requireEnv } from '../confluence/config.js';
import { createClient, ConfluenceDownloadError, type ContentNode } from '../confluence/client.js';
import { htmlToMarkdown, codeLanguagesFromStorage } from '../documents/html-to-markdown.js';
import { buildFrontmatter, splitFrontmatter, wikilinkDisplayText } from '../documents/obsidian.js';
import { collectHeadings, matchConfluenceAnchor, type Heading } from '../documents/anchors.js';
import { collectMarkdown } from '../documents/catalog.js';
import { preparePushTree } from './prepare.js';
import { docHash } from '../documents/markdown.js';
import { rewriteTableLinks } from '../documents/tables.js';
import { buildIgnorer } from './ignore.js';
import { mappingPath as defaultMappingPath, metadataFiles, METADATA_DIR } from './metadata.js';
import { loadMapping, saveMapping } from './mapping.js';
import { cyan, dim, green } from '../shared/colors.js';

type Client = ReturnType<typeof createClient>;
class PullError extends Error {}

// 첨부 이미지는 항상 <md위치>/attachments/<문서명>/ 하위에 저장한다.
const ASSETS_DIR = 'attachments';

/** 마크다운 링크 중 Confluence 페이지를 가리키는 것: [text](https://.../pages/<id>/...) */
const PAGE_LINK = /\[([^\]]*)\]\(<?(https?:\/\/[^\s)<>]*?\/pages\/(\d+)[^\s)<>]*?)>?\)/g;

/** 같은 문서 안의 앵커: [text](#앵커) */
const SELF_ANCHOR = /\[([^\]]*)\]\(#([^)\s]+)\)/g;

/** 다른 페이지의 섹션: [text](https://.../pages/<id>/제목#앵커) — 앵커만 따로 잡는다 */
const PAGE_ANCHOR = /(\[[^\]]*\]\(<?https?:\/\/[^\s)<>]*?\/pages\/(\d+)[^\s)<>#]*)#([^\s)<>]+?)(>?\))/g;

type Opts = {
  /** Obsidian vault 로 받는다: 내부 링크를 [[wikilink]] 로 쓴다(기본은 어디서나 열리는 상대 .md 링크). */
  obsidian: boolean;
  spaceKey: string;
};

type Ctx = Opts & {
  client: Client;
  remoteBaseUrl: string;
  missingAttachments: number;
  incremental: boolean;
  expectedVersions: Map<string, number>;
  /** 이번 실행에서 만든 .md 절대경로 (링크 재작성 대상) */
  written: string[];
  /** pageId → .md 절대경로 (내부 링크를 상대경로로 바꾸는 데 쓴다) */
  pathById: Map<string, string>;
  /** 이번 실행에서 만든 폴더: 절대 디렉토리 경로 → 폴더 노드 id */
  folderIds: Map<string, string>;
  versions: Map<string, number>;
  parents: Map<string, string>;
  assetOwners: Map<string, string>;
  knownPaths: Map<string, string>;
  stageBase: string;
  baseDir: string;
  workspace: Workspace;
  rootId?: string;
  claimed: Map<string, string>;
  visited: Set<string>;
};

function claim(ctx: Ctx, path: string, id: string, directory = false): void {
  const rel = relative(ctx.stageBase, path).split('\\').join('/');
  if (!within(ctx.stageBase, path) || !inScope(rel || '.', ctx.workspace) || inNestedWorkspace(ctx.baseDir, directory ? `${rel}/.boundary` : rel)) throw new Error(`관리 범위 밖 pull 대상: ${rel}`);
  const prior = ctx.claimed.get(path);
  if (prior && prior !== id) throw new Error(`같은 로컬 경로에 여러 원격 항목이 대응합니다: ${rel}`);
  ctx.claimed.set(path, id);
}

type Counts = { pages: number; folders: number };

function optVal(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** URL/숫자/쿼리에서 콘텐츠 ID 추출(page·folder URL 모두) */
function parseContentId(input: string): string | null {
  if (/^\d+$/.test(input)) return input;
  return (
    input.match(/\/(?:pages|folder)\/(\d+)/)?.[1] ??
    input.match(/[?&]pageId=(\d+)/)?.[1] ??
    null
  );
}

/** 제목 → 파일/폴더명(파일시스템 금지문자 치환, 한글 유지) */
function slug(title: string): string {
  const value = title.replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  return !value || /^\.+$/.test(value) ? 'untitled' : value;
}

/** 공백이 있으면 <...> 로 감싼 마크다운 링크 목적지 */
const dest = (p: string) => (/\s/.test(p) ? `<${p}>` : p);

/** 페이지 1건을 .md 로 생성(자식 페이지/폴더가 있으면 <slug>/README.md 폴더로). */
async function pullPage(ctx: Ctx, node: ContentNode, destDir: string): Promise<Counts> {
  const { client } = ctx;
  const { id, title, html, storage } = node;
  // 페이지도 하위 페이지 + 하위 폴더를 모두 가질 수 있다(폴더가 페이지 밑에 올 수 있음).
  const childFolders = ctx.incremental ? [] : await client.getChildFolders(id);
  const childPages = ctx.incremental ? [] : await client.getChildPages(id);
  const hasChildren = childFolders.length + childPages.length > 0;

  const rooted = id === ctx.rootId;
  const known = ctx.knownPaths.get(id);
  const filePath = known ?? (rooted ? join(destDir, 'README.md') : hasChildren ? join(destDir, slug(title), 'README.md') : join(destDir, `${slug(title)}.md`));
  const folder = dirname(filePath);
  claim(ctx, filePath, id);
  if (node.version !== undefined) ctx.versions.set(id, node.version);
  mkdirSync(dirname(filePath), { recursive: true });

  // 첨부는 항상 <md위치>/attachments/<문서명>/이미지 에 저장
  const mdBase = basename(filePath).replace(/\.md$/, '');
  const assetPrefix = `${ASSETS_DIR}/${mdBase}`;

  const referenced = new Set<string>();
  let body = htmlToMarkdown(html, {
    obsidian: ctx.obsidian, pageId: id,
    onImage: (f) => referenced.add(f),
    assetPrefix,
    codeLangs: codeLanguagesFromStorage(storage), // 코드블록 언어는 storage 가 진짜
    storage,
  });

  if (referenced.size) {
    const attachments = await client.listAttachments(id);
    const byName = new Map(attachments.map((a) => [a.filename, a.downloadPath]));
    const saveDir = join(dirname(filePath), assetPrefix), unavailable = new Set<string>();
    const missing = (name: string, reason: string) => {
      unavailable.add(name); ctx.missingAttachments++;
      console.log(`[경고] 원격 첨부 누락 #${id}: ${name} (${reason}). 원격 참조를 유지하고 계속합니다.`);
    };
    for (const name of referenced) {
      if (basename(name) !== name || name === '.' || name === '..' || name.includes('\\')) throw new Error(`잘못된 첨부 파일명: ${name}`);
      const dp = byName.get(name);
      if (!dp) { missing(name, '이 페이지 첨부 목록에 없음'); continue; }
      let bytes: Buffer;
      try { bytes = await client.downloadAttachment(dp); }
      catch (error) {
        if (error instanceof ConfluenceDownloadError && error.status === 404) { missing(name, '다운로드 404'); continue; }
        throw error;
      }
      mkdirSync(saveDir, { recursive: true });
      const assetPath = join(saveDir, name);
      ctx.assetOwners.set(assetPath, id);
      writeFileSync(assetPath, bytes);
    }
    if (unavailable.size) body = htmlToMarkdown(html, {
      obsidian: ctx.obsidian, pageId: id, assetPrefix, codeLangs: codeLanguagesFromStorage(storage), storage,
      attachmentDestination: (name, source) => {
        if (!unavailable.has(name)) return `${assetPrefix}/${name}`;
        if (/^https?:\/\//i.test(source)) return source;
        const base = ctx.remoteBaseUrl.replace(/\/$/, '');
        if (source.startsWith('/wiki/')) return base.replace(/\/wiki$/, '') + source;
        if (source.startsWith('/')) return base + source;
        return `${base}/download/attachments/${id}/${encodeURIComponent(name)}`;
      },
    });
  }

  // frontmatter 의 pageId 는 push 왕복의 앵커다(매핑 파일이 없어도 원본 페이지를 찾아간다).
  // 취향 옵션이 아니라 중복 페이지 생성을 막는 장치이므로 항상 쓴다. Obsidian 은 이를 속성으로 보여준다.
  const fm = buildFrontmatter({
    title,
    pageId: id,
    spaceKey: ctx.spaceKey,
    source: node.url ?? '',
    updated: node.updated ?? '',
  });

  // 제목은 frontmatter 의 title 하나로 충분하다. 본문에 `# 제목` 을 또 넣으면
  // 제목을 따로 표시하는 뷰어(Obsidian 등)에서 두 번 보인다. push 도 title 속성을 먼저 읽는다.
  writeFileSync(filePath, fm ? `${fm}${body}` : `# ${title}\n\n${body}`);
  ctx.written.push(filePath);
  ctx.pathById.set(id, filePath);

  const imgNote = referenced.size ? `, 이미지 ${referenced.size}` : '';
  console.log(`  ${cyan('↓ 다운로드 준비')}  ${join(ctx.baseDir, relative(ctx.stageBase, filePath))}  ${dim(`(#${id}${imgNote}, 검증 후 저장)`)}`);

  const counts: Counts = { pages: 1, folders: 0 };
  for (const f of childFolders) add(counts, await pullNode(ctx, f.id, folder));
  for (const c of childPages) add(counts, await pullNode(ctx, c.id, folder));
  return counts;
}

function add(acc: Counts, c: Counts) { acc.pages += c.pages; acc.folders += c.folders; }

/** 노드(페이지/폴더)를 재귀적으로 가져온다. 폴더는 디렉토리(본문 없음)로 만든다. 노드 하나라도 실패하면 임시 다운로드 전체를 폐기. */
async function pullNode(ctx: Ctx, id: string, destDir: string): Promise<Counts> {
  const { client } = ctx;
  if (ctx.visited.has(id)) return {pages:0,folders:0};
  const known = ctx.knownPaths.get(id);
  if (known && !inScope(relative(ctx.stageBase,known).split('\\').join('/'),ctx.workspace)) return {pages:0,folders:0};
  ctx.visited.add(id);
  progressStep(`원격 문서·폴더 #${id} 가져오기 · ${ctx.visited.size}번째 항목`);
  try {
    const location = await client.assertInScope(id);
    if (location?.parentId) ctx.parents.set(id, location.parentId);
    const node = await client.getNode(id);
    if (ctx.incremental && (String(node.id) !== id || node.type !== 'page')) throw new Error(`매핑된 원격 페이지가 아닙니다: #${id}`);
    const expected = ctx.expectedVersions.get(id);
    if (ctx.incremental && (!Number.isInteger(node.version) || !node.version || (expected !== undefined && node.version < expected))) throw new Error(`원격 버전을 확인할 수 없거나 Fetch보다 이전 버전입니다: #${id}. 다시 Fetch한 후 Pull하세요.`);

    if (node.type === 'folder') {
      const dir = ctx.knownPaths.get(id) ?? (id === ctx.rootId ? destDir : join(destDir, slug(node.title)));
      claim(ctx, dir, id, true);
      mkdirSync(dir, { recursive: true });
      ctx.folderIds.set(dir, id);
      console.log(`  ${cyan('📁 폴더 준비')}  ${join(ctx.baseDir, relative(ctx.stageBase, dir))}  ${dim(`(#${id}, 검증 후 저장)`)}`);
      const counts: Counts = { pages: 0, folders: 1 };
      for (const f of await client.getChildFolders(id)) add(counts, await pullNode(ctx, f.id, dir));
      for (const p of await client.getChildPages(id)) add(counts, await pullNode(ctx, p.id, dir));
      return counts;
    }

    // page: getNode 결과(html + storage) 그대로 사용
    return await pullPage(ctx, node, destDir);
  } catch (e) {
    if (e instanceof PullError) throw e;
    throw new PullError(`pull 실패 #${id}: ${(e as Error).message}`);
  }
}

/** 앵커 해석에 필요한 문서 정보(제목 + 헤딩 목록). 내려받은 .md 에서 읽는다. */
type DocInfo = { title: string; headings: Heading[]; textBySlug: Map<string, string> };

function readDocInfo(file: string): DocInfo {
  const { data, body } = splitFrontmatter(readFileSync(file, 'utf8'));
  const headings = collectHeadings(body);
  return {
    title: data.title ?? '',
    headings,
    textBySlug: new Map(headings.map((h) => [h.slug, h.text])),
  };
}

/**
 * Confluence 가 만든 헤딩 앵커를 마크다운 슬러그로 바꾼다.
 *
 * Confluence 의 앵커 id 는 `<페이지제목><헤딩텍스트>`(공백 제거) 라서 Obsidian·GitHub 에서는
 * 아무 데도 가리키지 못한다. 실제 헤딩을 찾아 그 문서의 슬러그로 바꿔 줘야 링크가 산다.
 * relinkPass 보다 **먼저** 돈다 — 아직 링크가 절대 URL 이라 어느 페이지인지 id 로 알 수 있기 때문이다.
 */
export function anchorPass(
  written: string[],
  pathById: Map<string, string>,
  references: Map<string, DocInfo> = new Map(),
): { count: number; info: Map<string, DocInfo> } {
  const info = new Map<string, DocInfo>(references);
  for (const f of written) info.set(f, readDocInfo(f));

  let count = 0;
  for (const file of written) {
    const self = info.get(file)!;
    const before = readFileSync(file, 'utf8');

    // 우리가 올린 페이지는 Anchor 매크로 이름이 이미 마크다운 슬러그라 그대로 두면 된다.
    // Confluence 에서 직접 쓴 페이지만 헤딩을 찾아 맞춘다.
    const toSlug = (frag: string, d: DocInfo): string | null => {
      if (d.textBySlug.has(frag)) return null; // 이미 올바른 슬러그
      return matchConfluenceAnchor(frag, d.headings, d.title)?.slug ?? null;
    };

    let after = before.replace(SELF_ANCHOR, (whole, label: string, frag: string) => {
      const slug = toSlug(frag, self);
      if (!slug) return whole; // 이미 맞거나 못 찾음 → 손대지 않는다(엉뚱한 곳으로 보내지 않기 위해)
      count++;
      return `[${label}](#${slug})`;
    });

    after = after.replace(PAGE_ANCHOR, (whole, head: string, id: string, frag: string, tail: string) => {
      const target = pathById.get(id);
      const ti = target && info.get(target);
      if (!ti) return whole; // 이번에 안 받은 페이지 → 원본 URL 이 살아 있어야 한다
      const slug = toSlug(frag, ti);
      if (!slug) return whole;
      count++;
      return `${head}#${slug}${tail}`;
    });

    after = rewriteTableLinks(after, href => {
      const match = href.match(/^(https?:\/\/[^\s]*?\/pages\/(\d+)[^#]*)#(.+)$/);
      const target = match ? pathById.get(match[2]) : undefined;
      const targetInfo = href.startsWith('#') ? self : target ? info.get(target) : undefined;
      const fragment = href.startsWith('#') ? href.slice(1) : match?.[3];
      const slug = targetInfo && fragment ? toSlug(fragment, targetInfo) : null;
      if (!slug) return href;
      count++;
      return href.startsWith('#') ? `#${slug}` : `${match![1]}#${slug}`;
    });

    if (after !== before) writeFileSync(file, after);
  }
  return { count, info };
}

/**
 * 함께 받은 페이지를 가리키는 절대 Confluence URL 을 상대 .md 링크(또는 [[wikilink]])로 바꾼다.
 * 이번에 받지 않은 페이지의 링크는 절대 URL 그대로 둔다(깨진 링크를 만들지 않는다).
 * 반환값은 재작성한 링크 수.
 */
export function relinkPass(
  written: string[],
  pathById: Map<string, string>,
  wikilinks: boolean,
  info?: Map<string, DocInfo>,
): number {
  const noExt = (p: string) => basename(p).replace(/\.md$/i, '');
  // wikilink 는 vault 어디서든 "이름"으로 찾으므로, 파일명이 유일할 때만 안전하게 쓸 수 있다.
  const nameCount = new Map<string, number>();
  for (const p of pathById.values()) nameCount.set(noExt(p), (nameCount.get(noExt(p)) ?? 0) + 1);

  let count = 0;
  for (const file of written) {
    const before = readFileSync(file, 'utf8');
    let after = before.replace(PAGE_LINK, (whole, text: string, url: string, id: string) => {
      const target = pathById.get(id);
      if (!target || target === file) return whole; // 못 받은 페이지·자기 자신 → 원본 URL 유지
      count++;
      const name = noExt(target);
      const label = (text || name).trim();
      const slug = url.includes('#') ? url.split('#').slice(1).join('#') : '';

      if (wikilinks && nameCount.get(name) === 1) {
        // Obsidian 은 슬러그가 아니라 헤딩 텍스트로 섹션을 가리킨다: [[문서#헤딩 텍스트]]
        const heading = slug ? info?.get(target)?.textBySlug.get(slug) : undefined;
        const display = wikilinkDisplayText(label);
        if (!heading) return display === name ? `[[${name}]]` : `[[${name}|${display}]]`;
        return `[[${name}#${heading}|${display}]]`;
      }
      const rel = relative(dirname(file), target).split('\\').join('/');
      return `[${label}](${dest(rel + (slug ? `#${slug}` : ''))})`;
    });

    // HTML cells retain HTML links even with --obsidian (wikilinks do not render there).
    after = rewriteTableLinks(after, href => {
      const match = href.match(/^https?:\/\/[^\s]*?\/pages\/(\d+)[^#]*(#.*)?$/);
      const target = match ? pathById.get(match[1]) : undefined;
      if (!target || target === file) return href;
      count++;
      return relative(dirname(file), target).split('\\').join('/') + (match![2] ?? '');
    });

    // 같은 문서 섹션도 vault 표기로: [§4](#슬러그) → [[#헤딩 텍스트|§4]]
    if (wikilinks) {
      after = after.replace(SELF_ANCHOR, (whole, text: string, frag: string) => {
        const heading = info?.get(file)?.textBySlug.get(frag);
        if (!heading) return whole;
        count++;
        const label = wikilinkDisplayText(text.trim());
        return label && label !== heading ? `[[#${heading}|${label}]]` : `[[#${heading}]]`;
      });
    }

    if (after !== before) writeFileSync(file, after);
  }
  return count;
}

/**
 * 받아온 문서를 매핑 파일에 기록한다.
 *
 * 이게 없으면 pull 직후의 push 가 모든 문서를 "변경"으로 본다 — 매핑에 해시가 없으니
 * 방금 받아온 내용을 그대로 되올려 보내려 한다. 해시는 push 가 쓰는 것과 **같은 렌더러**로
 * 계산해야 하므로(buildTreeRenderer) 트리 전체를 한 번 훑는다.
 *
 * 반환값은 기록한 항목 수.
 */
export async function mappingPass(
  baseDir: string,
  mappingPath: string,
  pathById: Map<string, string>,
  folderIds: Map<string, string>,
  versions: Map<string, number> = new Map(),
  parents: Map<string, string> = new Map(),
  validate?: () => void,
): Promise<number> {
  const posix = (p: string) => p.split('\\').join('/');
  const ignorer = buildIgnorer(baseDir, []);
  const rels = collectMarkdown(baseDir)
    .map((f) => posix(relative(baseDir, f)))
    .filter((r) => !ignorer.ignores(r));
  progressStep('가져온 문서의 동기화 기준 계산');
  const before=existsSync(mappingPath)?readFileSync(mappingPath,'utf8'):undefined;
  const m=loadMapping(mappingPath);
  const createdObjects:string[]=[];
  const prepared = await preparePushTree(baseDir, rels, [...pathById.values()].map(path => posix(relative(baseDir, path))).filter(rel => rels.includes(rel)));
  try {
    const { docs, render } = prepared;

    const pending:{rel:string;text:string}[]=[];
    // 같은 페이지가 다른 키에 남아 있으면(문서가 옮겨졌으면) 중복 항목이 된다 → 옛 키를 걷어낸다
    const ids = new Set([...pathById.keys(), ...folderIds.values()]);
    for (const [k, v] of Object.entries(m)) if (ids.has(v.pageId)) delete m[k];

    let n = 0;
    for (const [id, abs] of pathById) {
      const rel = posix(relative(baseDir, abs));
      const doc = rel.startsWith('..') ? undefined : docs[rel];
      if (!doc) continue; // base 밖으로 받았거나 제외 규칙에 걸린 문서는 기록하지 않는다
      m[rel] = { pageId: id, title: doc.title, hash: docHash(doc.title, render(rel, doc.body, doc.title)), localHash: localStateHash(baseDir, rel, render(rel, doc.body, doc.title)), ...(versions.has(id) ? { remoteVersion: versions.get(id) } : {}), ...(parents.has(id) ? {remoteParentId: parents.get(id)} : {}) };
      pending.push({rel,text:readFileSync(abs,'utf8')});
      n++;
    }
    for (const [dir, id] of folderIds) {
      const rel = posix(relative(baseDir, dir));
      if (!rel || rel.startsWith('..')) continue;
      m[`${rel}/`] = { pageId: id, title: basename(dir), type: 'folder' };
      n++;
    }

    validate?.();
    for(const {rel,text} of pending){
      const id=createHash('sha256').update(text).digest('hex');
      const object=join(baseDir,METADATA_DIR,'objects',id+'.md');
      if(!existsSync(object))createdObjects.push(object);
      m[rel].sourceObject=storeBaseline(baseDir,text);
    }
    validate?.();
    if((existsSync(mappingPath)?readFileSync(mappingPath,'utf8'):undefined)!==before)throw new Error('기준 계산 중 매핑이 변경되었습니다. 다시 가져오세요.');
    saveMapping(mappingPath, m);
    return n;
  } catch(error){
    let retained=new Set<string>();
    try{retained=new Set(Object.values(loadMapping(mappingPath)).map(entry=>entry.sourceObject??''));}catch{throw error;}
    for(const object of createdObjects)if(!retained.has(basename(object,'.md'))&&existsSync(object))rmSync(object,{force:true});
    throw error;
  } finally { prepared.dispose(); }
}

/** Explicit remote recovery only accepts mapped Markdown files; replacement needs opt-in. */
export function validateRestorePaths(base: string, paths: string[], overwrite = false): string[] {
  if (!paths.length) throw new Error('복구할 파일을 직접 지정하세요: csync restore README.md');
  requireScope(loadWorkspace(base));
  const mapping = loadMapping(defaultMappingPath(base)), ignore = buildIgnorer(base, []);
  const selected = [...new Set(paths.map(path => scopePath(base, path)))];
  for (const rel of selected) {
    const entry = mapping[rel];
    if (!/\.md$/i.test(rel) || !entry || entry.type === 'folder') throw new Error(`매핑된 Markdown 파일만 복구할 수 있습니다: ${rel}`);
    if (ignore.ignores(rel) || inNestedWorkspace(base, rel)) throw new Error(`제외되었거나 독립 작업공간에 속한 파일입니다: ${rel}`);
    if (entry.pendingMove) throw new Error(`이동 대기 중인 파일은 복구할 수 없습니다: ${rel}`);
    try {
      const info = lstatSync(resolve(base, rel));
      if (overwrite && info.isFile() && !info.isSymbolicLink()) {
        const id = splitFrontmatter(readFileSync(resolve(base, rel), 'utf8')).data.pageId;
        if (id && id !== entry.pageId) throw new Error(`매핑과 로컬 pageId가 다릅니다: ${rel}`);
        continue;
      }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new Error(`이미 존재하는 로컬 파일은 복구로 덮어쓰지 않습니다: ${rel}. 일반 파일의 수정을 버리려면 --overwrite를 지정하세요.`);
  }
  const requestedIds = new Set(selected.map(rel => mapping[rel].pageId));
  for (const file of collectMarkdown(base)) {
    const rel = relative(base, file).split('\\').join('/');
    if (inNestedWorkspace(base, rel)) continue;
    const id = splitFrontmatter(readFileSync(file, 'utf8')).data.pageId;
    if (id && requestedIds.has(id) && !(overwrite && selected.includes(rel) && mapping[rel].pageId === id)) throw new Error(`같은 pageId의 로컬 문서가 이미 있습니다: ${rel}. 파일 이동 여부를 확인하세요.`);
  }
  return selected;
}

export async function runPull(argv: string[], options: {restorePaths?: string[]; restoreOverwrite?: boolean} = {}): Promise<void> {
  const restoring = options.restorePaths !== undefined;
  const restoreOverwrite = restoring && options.restoreOverwrite === true;
  if (argv.includes('--scope')) throw new Error('--scope는 제거되었습니다. Pull은 스페이스 작업공간을 기준으로 실행합니다.');
  if(argv.includes('--no-mapping'))throw new Error('Pull은 매핑을 유지해야 합니다.');
  if(argv.includes('--root'))throw new Error('--root는 제거되었습니다. 기준 폴더는 스페이스 루트에 연결됩니다.');
  const explicitRemoteOnly=argv.includes('--remote-only');
  const legacyTraversal = !restoring && (argv.includes('--full') || argv.includes('--space') || positionalArgs(argv).length>1);
  const remoteOnly = !restoring && !legacyTraversal;
  if(explicitRemoteOnly && (argv.includes('--full') || argv.includes('--space') || positionalArgs(argv).length > 1)) throw new Error('--remote-only는 전체 탐색·개별 페이지 지정과 함께 사용할 수 없습니다.');
  const explicitBase = optVal(argv, '--base');
  const outDir = resolve(optVal(argv, '--out') ?? resolveSyncBase(explicitBase) ?? process.cwd());
  const baseDir = resolve(explicitBase ?? findSyncBase(outDir) ?? outDir);
  if (!within(baseDir, outDir)) throw new Error(`--out 이 base 밖입니다: ${outDir}`);
  if (baseDir !== outDir) throw new Error('Pull은 기준 폴더 안의 원래 경로에 저장합니다. --base와 --out은 같아야 합니다.');
  const mappingPath = resolve(optVal(argv, '--mapping') ?? defaultMappingPath(baseDir));
  const restorePaths = restoring ? validateRestorePaths(baseDir, options.restorePaths!, restoreOverwrite) : undefined;
  let workspace = loadWorkspace(baseDir);
  const env = readEnv(baseDir);
  requireEnv(env);
  if(workspace.version!==2){
    mkdirSync(baseDir,{recursive:true});
    workspace=await connectWorkspace(baseDir,env);
  }
  const scope = requireScope(workspace);
  const oldMapping = loadMapping(mappingPath);
  const stamp = (file: string) => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : undefined;
  const metadataBefore = new Map([mappingPath, join(baseDir, '.env'), ...metadataFiles(baseDir)].map(path => [path, stamp(path)]));
  const assertMetadataUnchanged = () => { for (const [path, hash] of metadataBefore) if (stamp(path) !== hash) throw new Error('pull 도중 설정·매핑이 변경되었습니다.'); };

  assertWorkspaceConnection(workspace, env);
  const client = createClient({ baseUrl: env.baseUrl!, email: env.email!, token: env.token! }, { force: false, verify: false, scope: { id: scope.id, spaceId: workspace.connection!.spaceId!, spaceOnly: !legacyTraversal } });
  const target = positionalArgs(argv)[1];
  const knownById = new Map(Object.entries(oldMapping).map(([rel, entry]) => [entry.pageId, rel]));
  let ids: string[];
  if (target) {
    const id = parseContentId(target);
    if (!id || !((id === scope.id) || (knownById.has(id) && inScope(knownById.get(id)!.replace(/\/$/, ''), workspace)))) throw new Error('가져올 페이지가 작업공간에 매핑되지 않았습니다.');
    ids = [id];
  } else ids = [scope.id];
  // A complete Fetch observation selects existing pages; it never authorizes a baseline advance.
  let incremental = !legacyTraversal, skipped = 0;
  let discovered: Awaited<ReturnType<typeof fetchRemote>>['snapshot'] | undefined;
  const newPaths=new Set<string>();
  const recoveringPaths=new Set<string>();
  const expectedVersions = new Map<string, number>();
  if (restorePaths) {
    ids = restorePaths.map(rel => oldMapping[rel].pageId);
    for (const rel of restorePaths) if (oldMapping[rel].remoteVersion) expectedVersions.set(oldMapping[rel].pageId, oldMapping[rel].remoteVersion!);
    console.log(`원격에서 ${restoreOverwrite ? '선택 문서 원복(로컬 수정 덮어쓰기)' : '누락 문서 복구'} · ${restorePaths.length}개 · 하위 항목 탐색 없음`);
  } else if(legacyTraversal) {
    console.log('기존 전체 탐색 옵션 호환 실행 · 일반 가져오기는 csync pull을 사용하세요.');
  } else {
    const {snapshot,cached,requests}=await fetchRemote(baseDir,env,{mappingFile:mappingPath});
    discovered=snapshot;
    const localIds=new Map<string,string[]>();
    for(const file of collectMarkdown(baseDir)){
      const rel=relative(baseDir,file).split('\\').join('/');if(inNestedWorkspace(baseDir,rel))continue;
      const id=splitFrontmatter(readFileSync(file,'utf8')).data.pageId;if(id)localIds.set(id,[...(localIds.get(id)??[]),rel]);
    }
    ids=snapshot.items.filter(item=>{
      if(target && !ids.includes(item.pageId))return false;
      if(item.state!=='changed'&&item.state!=='new'){skipped++;return false;}
      if(item.remoteVersion!==undefined)expectedVersions.set(item.pageId,item.remoteVersion);
      if(item.state==='new'){
        if(localIds.get(item.pageId)?.some(path=>path!==item.path)){console.log(`같은 pageId의 다른 로컬 문서가 있어 보존: ${item.path}`);skipped++;return false;}
        try {
          const info=lstatSync(resolve(baseDir,item.path));
          const fm=info.isFile()&&!info.isSymbolicLink()?splitFrontmatter(readFileSync(resolve(baseDir,item.path),'utf8')).data:{};
          if(fm.pageId===item.pageId&&fm.spaceKey===env.spaceKey){recoveringPaths.add(item.path);console.log(`받기 미완료 문서 재검증: ${item.path}`);}
          else {console.log(`기존 로컬 경로가 있어 보존: ${item.path}`);skipped++;return false;}
        }
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(inNestedWorkspace(baseDir,item.path)||buildIgnorer(baseDir,[]).ignores(item.path))return false;
        knownById.set(item.pageId,item.path);if(!recoveringPaths.has(item.path))newPaths.add(item.path);
      }
      return true;
    }).map(item=>item.pageId);
    console.log(`Fetch 기반 Pull · 조회 시각 ${snapshot.checkedAt}${cached?' (캐시)':''} · 메타데이터 요청 ${requests}회`);
    console.log(`가져올 원격 신규·변경 ${ids.length}건 · 건너뜀 ${skipped}건`);
    const unavailable=snapshot.items.filter(item=>item.state==='unavailable');
    if(unavailable.length)console.log(`[경고] 원격 조회 불가 ${unavailable.length}건은 문서와 매핑을 유지합니다.`);
  }
  assertMetadataUnchanged();
  let rootId = ids.includes(scope.id) ? scope.id : undefined;
  if (rootId && knownById.has(rootId) && knownById.get(rootId) !== 'README.md') throw new Error('스페이스 루트 매핑은 README.md여야 합니다. 기존 매핑을 확인하세요.');
  if (incremental && !ids.length) { console.log('완료 · Fetch 기준 내려받을 원격 변경이 없습니다. 문서·매핑을 유지합니다.'); return; }
  await verifyScope(client, workspace);
  assertMetadataUnchanged();
  // Stage everything first. Any download/conversion/scope failure leaves local sources untouched.
  const originals = new Map<string, string | undefined>();
  const remember = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') remember(path);
      else if (entry.isFile()) originals.set(path, stamp(path));
    }
  };
  remember(baseDir);
  for (const path of [mappingPath, join(baseDir, '.env'), ...metadataFiles(baseDir)]) originals.set(path, stamp(path));
  const ignore = buildIgnorer(baseDir, []);
  const rels = (existsSync(baseDir) ? collectMarkdown(baseDir) : []).map(file => relative(baseDir, file).split('\\').join('/')).filter(rel => !inNestedWorkspace(baseDir, rel) && !ignore.ignores(rel));
  const requestedIds = new Set(ids);
  const scoped = rels.filter(rel => inScope(rel, workspace) && (!incremental || requestedIds.has(oldMapping[rel]?.pageId)));
  progressStep('덮어쓰기 전 로컬 변경·첨부 확인');
  const tree = await preparePushTree(baseDir, rels, scoped);
  const localClean = new Set<string>();
  try {
    // Old releases stored the unprepared renderer hash. Accept only an exact match
    // with that baseline, never a fresh hash inferred from the current file alone.
    const legacy = buildTreeRenderer(baseDir, rels);
    for (const rel of scoped) {
      const doc = tree.docs[rel], rendered = tree.render(rel, doc.body, doc.title), entry = oldMapping[rel];
      const clean = entry?.localHash
        ? entry.localHash === localStateHash(baseDir, rel, rendered)
        : !!entry?.hash && (entry.hash === docHash(doc.title, rendered)
          || entry.hash === docHash(legacy.docs[rel].title, legacy.render(rel, legacy.docs[rel].body, legacy.docs[rel].title))
          || entry.hash === docHash(doc.title, tree.render(rel, doc.body, doc.title, 'panels'))
          || entry.hash === docHash(doc.title, tree.render(rel, doc.body, doc.title, true))
          || entry.hash === docHash(legacy.docs[rel].title, legacy.render(rel, legacy.docs[rel].body, legacy.docs[rel].title, 'panels'))
          || entry.hash === docHash(legacy.docs[rel].title, legacy.render(rel, legacy.docs[rel].body, legacy.docs[rel].title, true)));
      if (clean) localClean.add(rel);
    }
  } finally { tree.dispose(); }
  if(remoteOnly&&incremental){
    ids=ids.filter(id=>{const rel=knownById.get(id);const clean=!!rel&&(newPaths.has(rel)||recoveringPaths.has(rel)||localClean.has(rel))&&!oldMapping[rel]?.pendingMove;if(!clean){skipped++;console.log(`로컬 변경·확인 필요로 보존: ${rel??id}`);}return clean;});
    rootId=ids.includes(scope.id)?scope.id:undefined;
    if(!ids.length){console.log('완료 · 안전하게 가져올 원격 전용 변경이 없습니다. 로컬 변경은 유지합니다.');return;}
  }
  const stage = mkdtempSync(join(tmpdir(), 'csync-pull-'));
  const stageOut = join(stage, relative(baseDir, outDir));
  const ctx: Ctx = {
    client, remoteBaseUrl: env.baseUrl!, missingAttachments: 0, incremental, expectedVersions,
    obsidian: argv.includes('--obsidian'), spaceKey: env.spaceKey!, written: [], pathById: new Map(), folderIds: new Map(),
    versions: new Map(), parents: new Map(), assetOwners: new Map(), knownPaths: new Map([...knownById].map(([id, rel]) => [id, resolve(stage, rel)])),
    stageBase: stage, baseDir, workspace, rootId, claimed: new Map(), visited: new Set(),
  };
  try {
    if(discovered?.folders)for(const folder of discovered.folders){
      if(![...newPaths,...recoveringPaths].some(path=>path.startsWith(folder.path)))continue;
      const prior=oldMapping[folder.path];if(prior&&prior.pageId!==folder.pageId)throw new Error(`원격 폴더 경로 충돌: ${folder.path}`);
      const path=resolve(stage,folder.path);claim(ctx,path,folder.pageId,true);mkdirSync(path,{recursive:true});ctx.folderIds.set(path,folder.pageId);
    }
    // Reuse page IDs and local paths even when a remote title has changed.
    if (rootId) ctx.knownPaths.delete(rootId);
    const counts: Counts = { pages: 0, folders: 0 };
    for (const id of [...new Set(ids)]) {
      if (rootId === id && oldMapping['README.md'] && oldMapping['README.md'].pageId !== id) throw new Error('루트 README.md가 다른 페이지에 연결되어 있습니다.');
      add(counts, await pullNode(ctx, id, stageOut));
    }
    // Link changed pages to unchanged local pages without rewriting or re-baselining them.
    const linkPaths = new Map(ctx.pathById), referenceInfo = new Map<string, DocInfo>();
    if (incremental) for (const [id, rel] of knownById) {
      if (linkPaths.has(id) || !/\.md$/i.test(rel) || ignore.ignores(rel) || inNestedWorkspace(baseDir, rel)) continue;
      const original = resolve(baseDir, rel), staged = resolve(stage, rel);
      if (!within(baseDir, original) || !within(stage, staged) || !existsSync(original) || !lstatSync(original).isFile() || lstatSync(original).isSymbolicLink() || !within(realpathSync(baseDir), realpathSync(original))) continue;
      linkPaths.set(id, staged); referenceInfo.set(staged, readDocInfo(original));
    }
    const { count: anchors, info } = anchorPass(ctx.written, linkPaths, referenceInfo);
    const relinked = relinkPass(ctx.written, linkPaths, ctx.obsidian, info);
    const stagedFiles: string[] = [];
    const stagedDirs: string[] = [];
    const gather = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { stagedDirs.push(path); gather(path); } else stagedFiles.push(path);
      }
    };
    gather(stage);
    const stagedDocuments = new Set(ctx.written);
    const checkDestination = (rel: string, directory: boolean) => {
      const dest = resolve(baseDir, rel);
      for (let path = dest; within(baseDir, path); path = dirname(path)) {
        if (existsSync(path)) {
          const info = lstatSync(path);
          if (info.isSymbolicLink() || !within(realpathSync(baseDir), realpathSync(path))) throw new Error(`심볼릭 링크 pull 대상은 지원하지 않습니다: ${rel}`);
          if ((path === dest && !directory) ? !info.isFile() : !info.isDirectory()) throw new Error(`파일·폴더 경로 충돌: ${rel}`);
        }
        if (path === baseDir) break;
      }
    };
    for (const dir of stagedDirs) checkDestination(relative(stage, dir), true);
    // Validate all destinations before the first replacement, including attachment collisions.
    for (const file of stagedFiles) {
      const rel = relative(stage, file).split('\\').join('/');
      const dest = resolve(baseDir, rel);
      if (ignore.ignores(rel)) throw new Error(`제외된 pull 대상: ${rel}`);
      checkDestination(rel, false);
      if (stamp(dest) !== originals.get(dest)) throw new Error(`pull 도중 로컬 파일이 변경되었습니다: ${rel}`);
      if (!existsSync(dest)) continue;
      if (stagedDocuments.has(file)) {
        const entry = oldMapping[rel];
        if(recoveringPaths.has(rel)){
          if(!readFileSync(file).equals(readFileSync(dest)))throw new Error(`받기 미완료 문서가 원격과 다릅니다: ${rel}. 로컬 수정은 유지합니다. 원격과 비교하고 필요한 변경을 보관한 뒤 다시 시도하세요.`);
          continue;
        }
        if (!entry || (!localClean.has(rel) && !(restoreOverwrite && restorePaths?.includes(rel))) || entry.pendingMove) throw new Error(`로컬 변경 충돌: ${rel}. 변경을 보관하거나 비교한 뒤 다시 pull하세요.`);
      } else if (stamp(file) !== stamp(dest)) {
        const owner = ctx.assetOwners.get(file);
        const ownerRel = owner ? knownById.get(owner) : undefined;
        if (!ownerRel || (!localClean.has(ownerRel) && !(restoreOverwrite && restorePaths?.includes(ownerRel)))) throw new Error(`첨부 파일 충돌: ${rel}. 별도 --out으로 받아 비교하세요.`);
      }
    }
    for (const path of [mappingPath, join(baseDir, '.env'), ...metadataFiles(baseDir)]) if (stamp(path) !== originals.get(path)) throw new Error('pull 도중 설정·매핑이 변경되었습니다.');
    if (restorePaths) validateRestorePaths(baseDir, restorePaths, restoreOverwrite);
    const backup=mkdtempSync(join(tmpdir(),'csync-pull-backup-'));
    const applied:{dest:string; prior?:string; hash?:string}[]=[],createdDirs:string[]=[];
    let mapped:number,keepBackup=false;
    const ensureDirectory=(dir:string)=>{
      if(existsSync(dir))return;
      const absent:string[]=[];for(let p=dir;within(baseDir,p)&&!existsSync(p);p=dirname(p))absent.push(p);
      mkdirSync(dir,{recursive:true});createdDirs.push(...absent.reverse());
    };
    try {
      ensureDirectory(baseDir);
      for(const dir of stagedDirs)ensureDirectory(join(baseDir,relative(stage,dir)));
      for(const file of stagedFiles){
        const rel=relative(stage,file).split('\\').join('/'),dest=join(baseDir,relative(stage,file));
        if(recoveringPaths.has(rel)&&stagedDocuments.has(file))continue;
        if(restorePaths&&existsSync(dest)&&!stagedDocuments.has(file)&&stamp(dest)===stamp(file))continue;
        if(stamp(dest)!==originals.get(dest))throw new Error(`pull 도중 로컬 파일이 변경되었습니다: ${rel}`);
        ensureDirectory(dirname(dest));
        const record:{dest:string;prior?:string;hash?:string}={dest,hash:stamp(file)};
        if(existsSync(dest)){record.prior=join(backup,String(applied.length));copyFileSync(dest,record.prior);}
        applied.push(record);
        try {copyFileSync(file,dest,(restorePaths&&!restoreOverwrite||newPaths.has(rel))?constants.COPYFILE_EXCL:0);}
        catch(error){
          if((error as NodeJS.ErrnoException).code==='EEXIST'&&(restorePaths&&!restoreOverwrite||newPaths.has(rel))){applied.pop();throw error;}
          record.hash=stamp(dest);throw error;
        }
      }
      const paths=new Map([...ctx.pathById].map(([id,path])=>[id,join(baseDir,relative(stage,path))]));
      const folders=new Map([...ctx.folderIds].map(([path,id])=>[join(baseDir,relative(stage,path)),id]));
      mapped=await mappingPass(baseDir,mappingPath,paths,folders,ctx.versions,ctx.parents,()=>{
        for(const file of ctx.written)if(stamp(join(baseDir,relative(stage,file)))!==stamp(file))throw new Error('기준 계산 중 로컬 문서가 변경되었습니다. 추가 수정은 보존합니다.');
        for(const record of applied)if(stamp(record.dest)!==record.hash)throw new Error('기준 계산 중 로컬 문서·첨부가 변경되었습니다. 추가 수정은 보존합니다.');
      });
    }catch(error){
      let preserved=0;
      for(const record of applied.reverse()){
        if(stamp(record.dest)!==record.hash){preserved++;continue;}
        try{if(record.prior)copyFileSync(record.prior,record.dest);else rmSync(record.dest,{force:true});}
        catch{keepBackup=true;}
      }
      for(const dir of [...new Set(createdDirs)].reverse())try{rmdirSync(dir);}catch{/* Keep non-empty directories and concurrent local additions. */}
      console.log(preserved?`[경고] 적용 실패로 저장을 취소했습니다. 도중 추가 수정된 ${preserved}개 파일은 보존했습니다.`:'적용 실패로 문서·첨부 저장을 취소했습니다. 기존 로컬 파일은 복원했습니다.');
      if(keepBackup)throw new Error(`${(error as Error).message} · 일부 파일 복원 실패. 복구용 백업: ${backup}`);
      throw error;
    }finally{if(!keepBackup)rmSync(backup,{recursive:true,force:true});}
    console.log(`\n${green('완료')}  페이지 ${counts.pages}개, 폴더 ${counts.folders}개${incremental ? `, 건너뜀 ${skipped}개` : ''}  매핑 ${mapped}건  내부링크 ${relinked}개, 앵커 ${anchors}개`);
    console.log(dim(`  base: ${baseDir}`));
    if (ctx.missingAttachments) console.log(`[경고 요약] 원격 첨부 ${ctx.missingAttachments}개를 로컬로 저장하지 못했습니다. 문서는 저장했으며 원격 참조를 유지했습니다.`);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
