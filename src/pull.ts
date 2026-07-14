/**
 * `confluence-sync pull <pageId|url> [--out <dir>] [--children]`
 * Confluence 페이지를 읽어 Markdown(.md) 으로 생성한다(역방향).
 * 자식이 있는 페이지는 push 관례를 역으로 적용해 <slug>/README.md 폴더로 펼친다.
 * 첨부는 .md 옆에 내려받고 이미지 링크를 로컬 파일명으로 재작성한다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { readEnv, requireEnv } from './config.js';
import { createClient } from './confluence.js';
import { htmlToMarkdown, codeLanguagesFromStorage } from './html2md.js';
import { cyan, dim, green, red, yellow } from './colors.js';

type Client = ReturnType<typeof createClient>;

// 첨부 이미지는 항상 <md위치>/attachments/<문서명>/ 하위에 저장한다.
const ASSETS_DIR = 'attachments';

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

type Counts = { pages: number; folders: number };

type Node = { id: string; type: string; title: string; html: string; storage: string };

/** 페이지 1건을 .md 로 생성(자식 페이지/폴더가 있으면 <slug>/README.md 폴더로). */
async function pullPage(client: Client, node: Node, destDir: string, withChildren: boolean): Promise<Counts> {
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

  writeFileSync(filePath, `# ${title}\n\n${body}`);
  const imgNote = referenced.size ? `, 이미지 ${referenced.size}` : '';
  console.log(`  ${green('＋ 생성')}  ${filePath}  ${dim(`(#${id}${imgNote})`)}`);

  const counts: Counts = { pages: 1, folders: 0 };
  for (const f of childFolders) add(counts, await pullNode(client, f.id, folder, withChildren));
  for (const c of childPages) add(counts, await pullNode(client, c.id, folder, withChildren));
  return counts;
}

function add(acc: Counts, c: Counts) { acc.pages += c.pages; acc.folders += c.folders; }

/** 노드(페이지/폴더)를 재귀적으로 가져온다. 폴더는 디렉토리(본문 없음)로 만든다. 노드 하나 실패는 스킵. */
async function pullNode(client: Client, id: string, destDir: string, withChildren: boolean): Promise<Counts> {
  try {
    const node = await client.getNode(id);

    if (node.type === 'folder') {
      const dir = join(destDir, slug(node.title));
      mkdirSync(dir, { recursive: true });
      console.log(`  ${cyan('📁 폴더')}  ${dir}  ${dim(`(#${id})`)}`);
      const counts: Counts = { pages: 0, folders: 1 };
      if (withChildren) {
        for (const f of await client.getChildFolders(id)) add(counts, await pullNode(client, f.id, dir, true));
        for (const p of await client.getChildPages(id)) add(counts, await pullNode(client, p.id, dir, true));
      } else {
        console.log(dim('     (하위 내용은 --children 으로 가져옵니다)'));
      }
      return counts;
    }

    // page: getNode 결과(html + storage) 그대로 사용
    return await pullPage(client, node, destDir, withChildren);
  } catch (e) {
    console.error(red(`  ✗ 실패  #${id}`) + `\n${(e as Error).message}`);
    return { pages: 0, folders: 0 };
  }
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

  // --space: 스페이스 홈페이지(콘텐츠 트리 루트)부터 전체를 재귀적으로 가져옴
  if (wholeSpace) {
    const { homepageId } = await client.getSpaceInfo(env.spaceKey!);
    if (!homepageId) {
      console.error(red(`✗ 스페이스 '${env.spaceKey}' 의 홈페이지를 찾을 수 없습니다.`));
      process.exit(1);
    }
    console.log(`${dim('pull:')} space ${cyan(env.spaceKey!)} ${dim('→')} ${cyan(outDir)} ${dim('(전체)')}`);
    const { pages, folders } = await pullNode(client, homepageId, outDir, true);
    console.log(`\n${green('완료')}  페이지 ${pages}개${folders ? `, 폴더 ${folders}개` : ''} 생성`);
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
  const { pages, folders } = await pullNode(client, contentId, outDir, withChildren);
  console.log(`\n${green('완료')}  페이지 ${pages}개${folders ? `, 폴더 ${folders}개` : ''} 생성`);
}
