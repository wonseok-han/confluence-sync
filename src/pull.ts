/**
 * `confluence-sync pull <pageId|url> [--out <dir>] [--children]`
 * Confluence 페이지를 읽어 Markdown(.md) 으로 생성한다(역방향).
 * 자식이 있는 페이지는 push 관례를 역으로 적용해 <slug>/README.md 폴더로 펼친다.
 * 첨부는 attachments/<문서명>/ 하위에 내려받고 이미지 링크를 그 경로로 재작성한다.
 *
 * 함께 받은 페이지끼리의 내부 링크는 마지막에 상대 .md 경로로 이어 붙인다(Obsidian 그래프·백링크가 살아난다).
 * 각 문서 머리에 pageId 를 담은 frontmatter 를 남겨, 매핑 파일 없이도 push 가 원본 페이지를 다시 찾아간다.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, dirname, basename, relative } from 'node:path';
import { readEnv, requireEnv } from './config.js';
import { createClient, type ContentNode } from './confluence.js';
import { htmlToMarkdown, codeLanguagesFromStorage } from './html2md.js';
import { buildFrontmatter } from './obsidian.js';
import { cyan, dim, green, red, yellow } from './colors.js';

type Client = ReturnType<typeof createClient>;

// 첨부 이미지는 항상 <md위치>/attachments/<문서명>/ 하위에 저장한다.
const ASSETS_DIR = 'attachments';

/** 마크다운 링크 중 Confluence 페이지를 가리키는 것: [text](https://.../pages/<id>/...) */
const PAGE_LINK = /\[([^\]]*)\]\(<?(https?:\/\/[^\s)<>]*?\/pages\/(\d+)[^\s)<>]*?)>?\)/g;

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

/**
 * 함께 받은 페이지를 가리키는 절대 Confluence URL 을 상대 .md 링크(또는 [[wikilink]])로 바꾼다.
 * 이번에 받지 않은 페이지의 링크는 절대 URL 그대로 둔다(깨진 링크를 만들지 않는다).
 * 반환값은 재작성한 링크 수.
 */
export function relinkPass(written: string[], pathById: Map<string, string>, wikilinks: boolean): number {
  const noExt = (p: string) => basename(p).replace(/\.md$/i, '');
  // wikilink 는 vault 어디서든 "이름"으로 찾으므로, 파일명이 유일할 때만 안전하게 쓸 수 있다.
  const nameCount = new Map<string, number>();
  for (const p of pathById.values()) nameCount.set(noExt(p), (nameCount.get(noExt(p)) ?? 0) + 1);

  let count = 0;
  for (const file of written) {
    const before = readFileSync(file, 'utf8');
    const after = before.replace(PAGE_LINK, (whole, text: string, url: string, id: string) => {
      const target = pathById.get(id);
      if (!target || target === file) return whole; // 못 받은 페이지·자기 자신 → 원본 URL 유지
      count++;
      const name = noExt(target);
      const label = (text || name).trim();

      if (wikilinks && nameCount.get(name) === 1) {
        return label === name ? `[[${name}]]` : `[[${name}|${label}]]`;
      }
      const anchor = url.includes('#') ? '#' + url.split('#').slice(1).join('#') : '';
      const rel = relative(dirname(file), target).split('\\').join('/');
      return `[${label}](${dest(rel + anchor)})`;
    });
    if (after !== before) writeFileSync(file, after);
  }
  return count;
}

export async function runPull(argv: string[]): Promise<void> {
  const withChildren = argv.includes('--children');
  const wholeSpace = argv.includes('--space');
  const outDir = resolve(optVal(argv, '--out') ?? process.cwd());

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
  };

  const done = (c: Counts) => {
    const relinked = relinkPass(ctx.written, ctx.pathById, ctx.obsidian);
    console.log(
      `\n${green('완료')}  페이지 ${c.pages}개${c.folders ? `, 폴더 ${c.folders}개` : ''} 생성` +
      (relinked ? `  ${cyan(`내부링크 ${relinked}개 연결`)}` : ''),
    );
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
    if (argv[i] === '--out') { i++; continue; }
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
