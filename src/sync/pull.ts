/**
 * `confluence-sync pull <pageId|url> [--out <dir>] [--children]`
 * Confluence 페이지를 읽어 Markdown(.md) 으로 생성한다(역방향).
 * 자식이 있는 페이지는 push 관례를 역으로 적용해 <slug>/README.md 폴더로 펼친다.
 * 첨부는 attachments/<문서명>/ 하위에 내려받고 이미지 링크를 그 경로로 재작성한다.
 *
 * 함께 받은 페이지끼리의 내부 링크는 마지막에 상대 .md 경로로 이어 붙인다(Obsidian 그래프·백링크가 살아난다).
 * 각 문서 머리에 pageId 를 담은 frontmatter 를 남겨, 매핑 파일 없이도 push 가 원본 페이지를 다시 찾아간다.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, copyFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename, relative } from 'node:path';
import { positionalArgs } from '../cli/args.js';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadWorkspace, saveWorkspace, findSyncBase, resolveSyncBase, inScope, inNestedWorkspace, within, assertWorkspaceConnection, type Workspace } from './workspace.js';
import { readEnv, requireEnv } from '../confluence/config.js';
import { createClient, type ContentNode } from '../confluence/client.js';
import { htmlToMarkdown, codeLanguagesFromStorage } from '../documents/html-to-markdown.js';
import { buildFrontmatter, splitFrontmatter } from '../documents/obsidian.js';
import { collectHeadings, matchConfluenceAnchor, type Heading } from '../documents/anchors.js';
import { collectMarkdown } from '../documents/catalog.js';
import { buildTreeRenderer } from './render.js';
import { docHash } from '../documents/markdown.js';
import { rewriteTableLinks } from '../documents/tables.js';
import { buildIgnorer } from './ignore.js';
import { mappingPath as defaultMappingPath, metadataFiles } from './metadata.js';
import { loadMapping, saveMapping } from './mapping.js';
import { cyan, dim, green } from '../shared/colors.js';

type Client = ReturnType<typeof createClient>;

// 첨부 이미지는 항상 <md위치>/attachments/<문서명>/ 하위에 저장한다.
const ASSETS_DIR = 'attachments';

/** 마크다운 링크 중 Confluence 페이지를 가리키는 것: [text](https://.../pages/<id>/...) */
const PAGE_LINK = /\[([^\]]*)\]\(<?(https?:\/\/[^\s)<>]*?\/pages\/(\d+)[^\s)<>]*?)>?\)/g;

/** 같은 문서 안의 앵커: [text](#앵커) */
const SELF_ANCHOR = /\[([^\]]*)\]\(#([^)\s]+)\)/g;

/** 다른 페이지의 섹션: [text](https://.../pages/<id>/제목#앵커) — 앵커만 따로 잡는다 */
const PAGE_ANCHOR = /(\[[^\]]*\]\(<?https?:\/\/[^\s)<>]*?\/pages\/(\d+)[^\s)<>#]*)#([^\s)<>]+?)(>?\))/g;

type Opts = {
  withChildren: boolean;
  /** Obsidian vault 로 받는다: 내부 링크를 [[wikilink]] 로 쓴다(기본은 어디서나 열리는 상대 .md 링크). */
  obsidian: boolean;
  spaceKey: string;
};

type Ctx = Opts & {
  client: Client;
  /** 이번 실행에서 만든 .md 절대경로 (링크 재작성 대상) */
  written: string[];
  /** pageId → .md 절대경로 (내부 링크를 상대경로로 바꾸는 데 쓴다) */
  pathById: Map<string, string>;
  /** 이번 실행에서 만든 폴더: 절대 디렉토리 경로 → 폴더 노드 id */
  folderIds: Map<string, string>;
  versions: Map<string, number>;
  assetOwners: Map<string, string>;
  knownPaths: Map<string, string>;
  stageBase: string;
  baseDir: string;
  workspace: Workspace;
  rootId?: string;
  claimed: Map<string, string>;
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
  const { client, withChildren } = ctx;
  const { id, title, html, storage } = node;
  // 페이지도 하위 페이지 + 하위 폴더를 모두 가질 수 있다(폴더가 페이지 밑에 올 수 있음).
  const childFolders = withChildren ? await client.getChildFolders(id) : [];
  const childPages = withChildren ? await client.getChildPages(id) : [];
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
  const body = htmlToMarkdown(html, {
    onImage: (f) => referenced.add(f),
    assetPrefix,
    codeLangs: codeLanguagesFromStorage(storage), // 코드블록 언어는 storage 가 진짜
    storage,
  });

  if (referenced.size) {
    const attachments = await client.listAttachments(id);
    const byName = new Map(attachments.map((a) => [a.filename, a.downloadPath]));
    const saveDir = join(dirname(filePath), assetPrefix);
    for (const name of referenced) {
      const dp = byName.get(name);
      if (!dp) throw new Error(`원격 첨부를 찾을 수 없습니다: ${name}`);
      if (basename(name) !== name || name === '.' || name === '..' || name.includes('\\')) throw new Error(`잘못된 첨부 파일명: ${name}`);
      mkdirSync(saveDir, { recursive: true });
      const assetPath = join(saveDir, name);
      ctx.assetOwners.set(assetPath, id);
      writeFileSync(assetPath, await client.downloadAttachment(dp));
    }
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
  console.log(`  ${green('＋ 생성')}  ${filePath}  ${dim(`(#${id}${imgNote})`)}`);

  const counts: Counts = { pages: 1, folders: 0 };
  for (const f of childFolders) add(counts, await pullNode(ctx, f.id, folder));
  for (const c of childPages) add(counts, await pullNode(ctx, c.id, folder));
  return counts;
}

function add(acc: Counts, c: Counts) { acc.pages += c.pages; acc.folders += c.folders; }

/** 노드(페이지/폴더)를 재귀적으로 가져온다. 폴더는 디렉토리(본문 없음)로 만든다. 노드 하나라도 실패하면 임시 다운로드 전체를 폐기. */
async function pullNode(ctx: Ctx, id: string, destDir: string): Promise<Counts> {
  const { client, withChildren } = ctx;
  try {
    const node = await client.getNode(id);

    if (node.type === 'folder') {
      const dir = ctx.knownPaths.get(id) ?? (id === ctx.rootId ? destDir : join(destDir, slug(node.title)));
      claim(ctx, dir, id, true);
      mkdirSync(dir, { recursive: true });
      ctx.folderIds.set(dir, id);
      console.log(`  ${cyan('📁 폴더')}  ${dir}  ${dim(`(#${id})`)}`);
      const counts: Counts = { pages: 0, folders: 1 };
      if (withChildren) {
        for (const f of await client.getChildFolders(id)) add(counts, await pullNode(ctx, f.id, dir));
        for (const p of await client.getChildPages(id)) add(counts, await pullNode(ctx, p.id, dir));
      } else {
        console.log(dim('     (하위 내용은 --children 으로 가져옵니다)'));
      }
      return counts;
    }

    // page: getNode 결과(html + storage) 그대로 사용
    return await pullPage(ctx, node, destDir);
  } catch (e) {
    throw new Error(`pull 실패 #${id}: ${(e as Error).message}`);
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
): { count: number; info: Map<string, DocInfo> } {
  const info = new Map<string, DocInfo>();
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
        if (!heading) return label === name ? `[[${name}]]` : `[[${name}|${label}]]`;
        return `[[${name}#${heading}|${label}]]`;
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
        const label = text.trim();
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
export function mappingPass(
  baseDir: string,
  mappingPath: string,
  pathById: Map<string, string>,
  folderIds: Map<string, string>,
  versions: Map<string, number> = new Map(),
): number {
  const posix = (p: string) => p.split('\\').join('/');
  const ignorer = buildIgnorer(baseDir, []);
  const rels = collectMarkdown(baseDir)
    .map((f) => posix(relative(baseDir, f)))
    .filter((r) => !ignorer.ignores(r));
  const { docs, render } = buildTreeRenderer(baseDir, rels);

  const m = loadMapping(mappingPath);
  // 같은 페이지가 다른 키에 남아 있으면(문서가 옮겨졌으면) 중복 항목이 된다 → 옛 키를 걷어낸다
  const ids = new Set([...pathById.keys(), ...folderIds.values()]);
  for (const [k, v] of Object.entries(m)) if (ids.has(v.pageId)) delete m[k];

  let n = 0;
  for (const [id, abs] of pathById) {
    const rel = posix(relative(baseDir, abs));
    const doc = rel.startsWith('..') ? undefined : docs[rel];
    if (!doc) continue; // base 밖으로 받았거나 제외 규칙에 걸린 문서는 기록하지 않는다
    m[rel] = { pageId: id, title: doc.title, hash: docHash(doc.title, render(rel, doc.body, doc.title)), ...(versions.has(id) ? { remoteVersion: versions.get(id) } : {}) };
    n++;
  }
  for (const [dir, id] of folderIds) {
    const rel = posix(relative(baseDir, dir));
    if (!rel || rel.startsWith('..')) continue;
    m[`${rel}/`] = { pageId: id, title: basename(dir), type: 'folder' };
    n++;
  }

  saveMapping(mappingPath, m);
  return n;
}

export async function runPull(argv: string[]): Promise<void> {
  const wholeSpace = argv.includes('--space');
  const noMapping = argv.includes('--no-mapping');
  const explicitBase = optVal(argv, '--base');
  const outDir = resolve(optVal(argv, '--out') ?? resolveSyncBase(explicitBase) ?? process.cwd());
  const baseDir = resolve(explicitBase ?? findSyncBase(outDir) ?? outDir);
  if (!within(baseDir, outDir)) throw new Error(`--out 이 base 밖입니다: ${outDir}`);
  const mappingPath = resolve(optVal(argv, '--mapping') ?? defaultMappingPath(baseDir));
  const workspace = loadWorkspace(baseDir);
  const oldMapping = loadMapping(mappingPath);
  const env = readEnv(baseDir);
  requireEnv(env);
  assertWorkspaceConnection(workspace, env);
  const client = createClient({ baseUrl: env.baseUrl!, email: env.email!, token: env.token! }, { force: false, verify: false });
  const args = positionalArgs(argv);
  const target = args[1];
  const restricted = !!workspace.syncPaths && !workspace.syncPaths.includes('.');
  if (wholeSpace && restricted) throw new Error('저장된 관리 범위가 있습니다. pull --space 대신 pull로 해당 범위만 가져오세요.');
  let rootId: string | undefined;
  let ids: string[];
  if (wholeSpace) {
    rootId = (await client.getSpaceInfo(env.spaceKey!)).homepageId;
    if (!rootId) throw new Error(`스페이스 '${env.spaceKey}' 의 홈페이지를 찾을 수 없습니다.`);
    ids = [rootId];
  } else if (target) {
    const id = parseContentId(target);
    if (!id) throw new Error(`콘텐츠 ID를 인식할 수 없습니다: ${target}`);
    ids = [id];
    if (argv.includes('--root')) rootId = id;
  } else if (restricted) {
    ids = workspace.syncPaths!.map(path => {
      const key = oldMapping[`${path}/`] ? `${path}/` : /\.md$/i.test(path) ? path : `${path}/README.md`;
      const id = oldMapping[key]?.pageId;
      if (!id) throw new Error(`관리 범위 루트의 매핑이 없습니다: ${path}`);
      return id;
    });
  } else if (workspace.root) { rootId = workspace.root.id; ids = [rootId]; }
  else throw new Error('가져올 페이지/폴더를 지정하세요: csync pull <pageId|url>, 또는 pull --space');
  if (rootId && env.parentId && env.parentId !== rootId) throw new Error('CONFLUENCE_PARENT_ID가 가져올 작업공간 루트와 다릅니다. 설정을 확인하세요.');
  if (rootId && baseDir !== outDir) throw new Error('--space/--root는 --base와 --out을 같은 작업공간 루트로 지정하세요.');
  if (rootId && workspace.root && rootId !== workspace.root.id) throw new Error('이미 다른 원격 루트에 연결된 작업공간입니다.');
  if (rootId && noMapping) throw new Error('--space/--root는 안전한 왕복을 위해 매핑이 필요합니다.');

  const knownById = new Map(Object.entries(noMapping ? {} : oldMapping).map(([rel, entry]) => [entry.pageId, rel]));
  if (rootId && knownById.has(rootId) && knownById.get(rootId) !== 'README.md') throw new Error('기존 pull 루트가 하위 경로에 매핑되어 있습니다. 기존 트리를 보존하고 새 --out으로 받거나 실제 문서 루트를 --base로 지정하세요.');
  // Stage everything first. Any download/conversion/scope failure leaves local sources untouched.
  const stamp = (file: string) => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : undefined;
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
  const tree = existsSync(baseDir) ? buildTreeRenderer(baseDir, rels) : undefined;
  const localHashes = new Map(rels.map(rel => { const doc = tree!.docs[rel]; return [rel, docHash(doc.title, tree!.render(rel, doc.body, doc.title))]; }));
  const stage = mkdtempSync(join(tmpdir(), 'csync-pull-'));
  const stageOut = join(stage, relative(baseDir, outDir));
  const ctx: Ctx = {
    client, withChildren: wholeSpace || !!rootId || restricted || argv.includes('--children'),
    obsidian: argv.includes('--obsidian'), spaceKey: env.spaceKey!, written: [], pathById: new Map(), folderIds: new Map(),
    versions: new Map(), assetOwners: new Map(), knownPaths: new Map([...knownById].map(([id, rel]) => [id, resolve(stage, rel)])),
    stageBase: stage, baseDir, workspace, rootId, claimed: new Map(),
  };
  try {
    // Reuse page IDs and local paths even when a remote title has changed.
    if (rootId) ctx.knownPaths.delete(rootId);
    let rootType: 'page' | 'folder' = 'page';
    const counts: Counts = { pages: 0, folders: 0 };
    for (const id of [...new Set(ids)]) {
      const rel = knownById.get(id);
      if (restricted && (!rel || !inScope(rel, workspace))) throw new Error('선택한 원격 대상이 저장된 관리 범위 밖입니다.');
      if (rootId === id && oldMapping['README.md'] && oldMapping['README.md'].pageId !== id) throw new Error('루트 README.md가 다른 페이지에 연결되어 있습니다.');
      add(counts, await pullNode(ctx, id, stageOut));
      if (ctx.folderIds.get(stageOut) === id) rootType = 'folder';
    }
    const { count: anchors, info } = anchorPass(ctx.written, ctx.pathById);
    const relinked = relinkPass(ctx.written, ctx.pathById, ctx.obsidian, info);
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
        if (!entry?.hash || entry.hash !== localHashes.get(rel) || entry.pendingMove) throw new Error(`로컬 변경 충돌: ${rel}. 변경을 보관하거나 비교한 뒤 다시 pull하세요.`);
      } else if (stamp(file) !== stamp(dest)) {
        const owner = ctx.assetOwners.get(file);
        const ownerRel = owner ? knownById.get(owner) : undefined;
        if (!ownerRel || !oldMapping[ownerRel]?.hash || oldMapping[ownerRel].hash !== localHashes.get(ownerRel)) throw new Error(`첨부 파일 충돌: ${rel}. 별도 --out으로 받아 비교하세요.`);
      }
    }
    for (const path of [mappingPath, join(baseDir, '.env'), ...metadataFiles(baseDir)]) if (stamp(path) !== originals.get(path)) throw new Error('pull 도중 설정·매핑이 변경되었습니다.');
    mkdirSync(baseDir, { recursive: true });
    for (const dir of stagedDirs) mkdirSync(join(baseDir, relative(stage, dir)), { recursive: true });
    for (const file of stagedFiles) {
      const dest = join(baseDir, relative(stage, file));
      mkdirSync(dirname(dest), { recursive: true }); copyFileSync(file, dest);
    }
    const paths = new Map([...ctx.pathById].map(([id, path]) => [id, join(baseDir, relative(stage, path))]));
    const folders = new Map([...ctx.folderIds].map(([path, id]) => [join(baseDir, relative(stage, path)), id]));
    const mapped = noMapping ? 0 : mappingPass(baseDir, mappingPath, paths, folders, ctx.versions);
    if (rootId) {
      workspace.root = { id: rootId, type: rootType, baseUrl: env.baseUrl!, spaceKey: env.spaceKey! };
    }
    if (!noMapping) {
      workspace.connection = { baseUrl: env.baseUrl!, spaceKey: env.spaceKey! };
      saveWorkspace(baseDir, workspace);
    }
    console.log(`\n${green('완료')}  페이지 ${counts.pages}개, 폴더 ${counts.folders}개  매핑 ${mapped}건  내부링크 ${relinked}개, 앵커 ${anchors}개`);
    console.log(dim(`  base: ${baseDir}`));
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
