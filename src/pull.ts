/**
 * `confluence-sync pull <pageId|url> [--out <dir>] [--children]`
 * Confluence 페이지를 읽어 Markdown(.md) 으로 생성한다(역방향).
 * 자식이 있는 페이지는 push 관례를 역으로 적용해 <slug>/README.md 폴더로 펼친다.
 * 첨부는 attachments/<문서명>/ 하위에 내려받고 이미지 링크를 그 경로로 재작성한다.
 *
 * 함께 받은 페이지끼리의 내부 링크는 마지막에 상대 .md 경로로 이어 붙인다(Obsidian 그래프·백링크가 살아난다).
 * 각 문서 머리에 pageId 를 담은 frontmatter 를 남겨, 매핑 파일 없이도 push 가 원본 페이지를 다시 찾아간다.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname, basename, relative } from 'node:path';
import { readEnv, requireEnv } from './config.js';
import { createClient, type ContentNode } from './confluence.js';
import { htmlToMarkdown, codeLanguagesFromStorage } from './html2md.js';
import { buildFrontmatter, splitFrontmatter } from './obsidian.js';
import { collectHeadings, matchConfluenceAnchor, type Heading } from './anchors.js';
import { collectMarkdown } from './docs.js';
import { buildTreeRenderer } from './render.js';
import { docHash } from './markdown.js';
import { buildIgnorer } from './ignore.js';
import { loadMapping, saveMapping, MAPPING_FILE } from './mapping.js';
import { cyan, dim, green, red, yellow } from './colors.js';

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
};

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
  return title.replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || 'untitled';
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

  const folder = hasChildren ? join(destDir, slug(title)) : destDir;
  const filePath = hasChildren ? join(folder, 'README.md') : join(destDir, `${slug(title)}.md`);
  mkdirSync(dirname(filePath), { recursive: true });

  // 첨부는 항상 <md위치>/attachments/<문서명>/이미지 에 저장
  const mdBase = basename(filePath).replace(/\.md$/, '');
  const assetPrefix = `${ASSETS_DIR}/${mdBase}`;

  const referenced = new Set<string>();
  const body = htmlToMarkdown(html, {
    onImage: (f) => referenced.add(f),
    assetPrefix,
    codeLangs: codeLanguagesFromStorage(storage), // 코드블록 언어는 storage 가 진짜
  });

  if (referenced.size) {
    const attachments = await client.listAttachments(id);
    const byName = new Map(attachments.map((a) => [a.filename, a.downloadPath]));
    const saveDir = join(dirname(filePath), assetPrefix);
    for (const name of referenced) {
      const dp = byName.get(name);
      if (!dp) { console.error(yellow(`    ⚠ 첨부 없음: ${name}`)); continue; }
      try {
        mkdirSync(saveDir, { recursive: true });
        writeFileSync(join(saveDir, name), await client.downloadAttachment(dp));
      } catch (e) {
        console.error(red(`    ✗ 첨부 다운로드 실패 ${name}`) + `\n${(e as Error).message}`);
      }
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

/** 노드(페이지/폴더)를 재귀적으로 가져온다. 폴더는 디렉토리(본문 없음)로 만든다. 노드 하나 실패는 스킵. */
async function pullNode(ctx: Ctx, id: string, destDir: string): Promise<Counts> {
  const { client, withChildren } = ctx;
  try {
    const node = await client.getNode(id);

    if (node.type === 'folder') {
      const dir = join(destDir, slug(node.title));
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
    console.error(red(`  ✗ 실패  #${id}`) + `\n${(e as Error).message}`);
    return { pages: 0, folders: 0 };
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
 * 매핑 파일(.confluence-sync.json)이 있는 가장 가까운 상위 디렉토리 = 동기화 루트.
 * pull 을 base 하위 폴더로 받아도(`--out <base>/어딘가`) 매핑 키가 base 기준으로 남아야
 * 이어지는 push 가 같은 문서를 알아본다.
 */
function findSyncBase(from: string): string | null {
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(join(d, MAPPING_FILE))) return d;
    if (dirname(d) === d) return null;
  }
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
    m[rel] = { pageId: id, title: doc.title, hash: docHash(doc.title, render(rel, doc.body, doc.title)) };
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
  const withChildren = argv.includes('--children');
  const wholeSpace = argv.includes('--space');
  const outDir = resolve(optVal(argv, '--out') ?? process.cwd());

  // 매핑을 어디에 남길지. base 는 매핑 키의 기준이므로 push 때의 --base 와 같아야 한다.
  const noMapping = argv.includes('--no-mapping');
  const baseOpt = optVal(argv, '--base');
  const baseDir = resolve(baseOpt ?? findSyncBase(outDir) ?? outDir);
  const mappingPath = resolve(optVal(argv, '--mapping') ?? join(baseDir, MAPPING_FILE));
  if (!noMapping && relative(baseDir, outDir).startsWith('..')) {
    console.error(red(`✗ --out 이 base 밖입니다: ${outDir}`) + dim(`\n  base: ${baseDir}  (--base 로 맞추거나 --no-mapping 을 쓰세요)`));
    process.exit(1);
  }

  const env = readEnv();
  requireEnv(env);
  const client = createClient(
    { baseUrl: env.baseUrl!, email: env.email!, token: env.token! },
    { force: false, verify: false },
  );

  const ctx: Ctx = {
    client,
    withChildren,
    obsidian: argv.includes('--obsidian'),
    spaceKey: env.spaceKey!,
    written: [],
    pathById: new Map(),
    folderIds: new Map(),
  };

  const done = (c: Counts) => {
    // 앵커를 먼저 슬러그로 바꾼 뒤 링크를 상대경로로 옮긴다(순서가 바뀌면 어느 페이지의 헤딩인지 알 수 없다).
    const { count: anchors, info } = anchorPass(ctx.written, ctx.pathById);
    const relinked = relinkPass(ctx.written, ctx.pathById, ctx.obsidian, info);
    // 본문이 다 정해진 뒤에 기록해야 해시가 맞는다
    const mapped = noMapping ? 0 : mappingPass(baseDir, mappingPath, ctx.pathById, ctx.folderIds);
    console.log(
      `\n${green('완료')}  페이지 ${c.pages}개${c.folders ? `, 폴더 ${c.folders}개` : ''} 생성` +
      (relinked ? `  ${cyan(`내부링크 ${relinked}개 연결`)}` : '') +
      (anchors ? `  ${cyan(`섹션링크 ${anchors}개 복원`)}` : '') +
      (mapped ? `  ${cyan(`매핑 ${mapped}건`)}` : ''),
    );
    if (mapped) console.log(dim(`  매핑: ${mappingPath}  (base: ${baseDir})`));
  };

  // --space: 스페이스 홈페이지(콘텐츠 트리 루트)부터 전체를 재귀적으로 가져옴
  if (wholeSpace) {
    const { homepageId } = await client.getSpaceInfo(env.spaceKey!);
    if (!homepageId) {
      console.error(red(`✗ 스페이스 '${env.spaceKey}' 의 홈페이지를 찾을 수 없습니다.`));
      process.exit(1);
    }
    console.log(`${dim('pull:')} space ${cyan(env.spaceKey!)} ${dim('→')} ${cyan(outDir)} ${dim('(전체)')}`);
    ctx.withChildren = true;
    done(await pullNode(ctx, homepageId, outDir));
    return;
  }

  // 위치 인자: ['pull', <pageId|url>, ...]
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' || argv[i] === '--base' || argv[i] === '--mapping') { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    positionals.push(argv[i]);
  }
  const target = positionals[1];
  if (!target) {
    console.error(red('✗ 가져올 페이지/폴더를 지정하세요.') + `\n  예) ${cyan('confluence-sync pull <pageId|url> [--out <dir>] [--children]')}\n  스페이스 전체: ${cyan('confluence-sync pull --space')}`);
    process.exit(1);
  }
  const contentId = parseContentId(target);
  if (!contentId) {
    console.error(red(`✗ 콘텐츠 ID 를 인식할 수 없습니다: ${target}`) + '\n  숫자 ID 또는 .../pages/<ID>/... · .../folder/<ID> URL 을 주세요.');
    process.exit(1);
  }

  console.log(`${dim('pull:')} #${contentId} ${dim('→')} ${cyan(outDir)}${withChildren ? dim(' (+children)') : ''}`);
  done(await pullNode(ctx, contentId, outDir));
}
