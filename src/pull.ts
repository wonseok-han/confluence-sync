/**
 * `confluence-sync pull <pageId|url> [--out <dir>] [--children]`
 * Confluence 페이지를 읽어 Markdown(.md) 으로 생성한다(역방향).
 * 자식이 있는 페이지는 push 관례를 역으로 적용해 <slug>/README.md 폴더로 펼친다.
 * 첨부는 .md 옆에 내려받고 이미지 링크를 로컬 파일명으로 재작성한다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { readEnv, requireEnv } from './config.js';
import { createClient } from './confluence.js';
import { htmlToMarkdown } from './html2md.js';
import { cyan, dim, green, red, yellow } from './colors.js';

type Client = ReturnType<typeof createClient>;

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

/** 페이지 1건을 .md 로 생성(자식 페이지가 있으면 <slug>/README.md 폴더로). */
async function pullPage(client: Client, id: string, title: string, html: string, destDir: string, withChildren: boolean): Promise<Counts> {
  const children = withChildren ? await client.getChildPages(id) : [];
  const hasChildren = children.length > 0;

  const folder = hasChildren ? join(destDir, slug(title)) : destDir;
  const filePath = hasChildren ? join(folder, 'README.md') : join(destDir, `${slug(title)}.md`);
  mkdirSync(dirname(filePath), { recursive: true });

  const referenced = new Set<string>();
  const body = htmlToMarkdown(html, { onImage: (f) => referenced.add(f) });

  if (referenced.size) {
    const attachments = await client.listAttachments(id);
    const byName = new Map(attachments.map((a) => [a.filename, a.downloadPath]));
    for (const name of referenced) {
      const dp = byName.get(name);
      if (!dp) { console.error(yellow(`    ⚠ 첨부 없음: ${name}`)); continue; }
      try {
        writeFileSync(join(dirname(filePath), name), await client.downloadAttachment(dp));
      } catch (e) {
        console.error(red(`    ✗ 첨부 다운로드 실패 ${name}`) + `\n${(e as Error).message}`);
      }
    }
  }

  writeFileSync(filePath, `# ${title}\n\n${body}`);
  const imgNote = referenced.size ? `, 이미지 ${referenced.size}` : '';
  console.log(`  ${green('＋ 생성')}  ${filePath}  ${dim(`(#${id}${imgNote})`)}`);

  const counts: Counts = { pages: 1, folders: 0 };
  for (const c of children) add(counts, await pullNode(client, c.id, folder, withChildren));
  return counts;
}

function add(acc: Counts, c: Counts) { acc.pages += c.pages; acc.folders += c.folders; }

/** 노드(페이지/폴더)를 재귀적으로 가져온다. 폴더는 디렉토리(본문 없음)로 만든다. */
async function pullNode(client: Client, id: string, destDir: string, withChildren: boolean): Promise<Counts> {
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

  // page: 본문을 위해 그대로 getNode 결과(html) 사용
  return pullPage(client, id, node.title, node.html, destDir, withChildren);
}

export async function runPull(argv: string[]): Promise<void> {
  const withChildren = argv.includes('--children');
  const outDir = resolve(optVal(argv, '--out') ?? process.cwd());

  // 위치 인자: ['pull', <pageId|url>, ...]
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    positionals.push(argv[i]);
  }
  const target = positionals[1];
  if (!target) {
    console.error(red('✗ 가져올 페이지/폴더를 지정하세요.') + `\n  예) ${cyan('confluence-sync pull <pageId|url> [--out <dir>] [--children]')}`);
    process.exit(1);
  }
  const contentId = parseContentId(target);
  if (!contentId) {
    console.error(red(`✗ 콘텐츠 ID 를 인식할 수 없습니다: ${target}`) + '\n  숫자 ID 또는 .../pages/<ID>/... · .../folder/<ID> URL 을 주세요.');
    process.exit(1);
  }

  const env = readEnv();
  requireEnv(env);
  const client = createClient(
    { baseUrl: env.baseUrl!, email: env.email!, token: env.token! },
    { force: false, verify: false },
  );

  console.log(`${dim('pull:')} #${contentId} ${dim('→')} ${cyan(outDir)}${withChildren ? dim(' (+children)') : ''}`);
  const { pages, folders } = await pullNode(client, contentId, outDir, withChildren);
  console.log(`\n${green('완료')}  페이지 ${pages}개${folders ? `, 폴더 ${folders}개` : ''} 생성`);
}
