#!/usr/bin/env node
/**
 * confluence-sync — Markdown 디렉토리 → Confluence Cloud 단방향 동기화 (진입점)
 *
 *   confluence-sync [경로...]          base 전체(또는 지정 파일/폴더)에서 변경된 문서만 갱신(+신규)
 *   confluence-sync --base <dir>       동기화 루트 지정(필수, 또는 env CONFLUENCE_SYNC_BASE)
 *   confluence-sync --dry-run          호출 없이 대상·상태 출력
 *   confluence-sync --list             인식된 문서·제목·계층만 출력(인증 불필요)
 *   confluence-sync --rebuild          매핑된 페이지 전부 삭제 후 재생성
 *   confluence-sync init               대화형으로 .env 설정 파일 생성
 *   confluence-sync --help | --version
 *
 * git 이 원천(SoT)이며 Confluence 는 미러다. 양방향 동기화는 하지 않는다.
 * 세부 로직은 ./markdown ./docs ./mapping ./confluence ./config ./init ./help 모듈에 있다.
 */
import 'dotenv/config';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { readEnv, requireEnv } from './config.js';
import { toStorage, splitTitleAndBody, docHash, type Rendered } from './markdown.js';
import {
  collectMarkdown, buildTitleIndex, buildFolderIndex,
  parentKeyOf, sortForSync, resolveSelection, withParents,
} from './docs.js';
import { loadMapping, saveMapping, type Mapping } from './mapping.js';
import { createClient } from './confluence.js';
import { runInit } from './init.js';
import { runPull } from './pull.js';
import { printHelp, readPkgVersion } from './help.js';
import { bold, dim, red, green, yellow, magenta, cyan, gray } from './colors.js';

// ---- CLI 인자 ----
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const LIST = argv.includes('--list');
const REBUILD = argv.includes('--rebuild');
const FORCE = argv.includes('--force');
const VERIFY = argv.includes('--verify');
const HELP = argv.includes('--help') || argv.includes('-h');
const VERSION = argv.includes('--version') || argv.includes('-v');
function optVal(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
// 위치 인자(선택 경로/서브커맨드): 플래그·옵션값 제외
const positionals: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--base' || argv[i] === '--mapping') { i++; continue; }
  if (argv[i].startsWith('-')) continue;
  positionals.push(argv[i]);
}

// 인증·동기화 루트가 필요 없는 즉시 종료 모드 (base 검사보다 먼저)
if (HELP) { printHelp(); process.exit(0); }
if (VERSION) { console.log(readPkgVersion()); process.exit(0); }
if (positionals[0] === 'init') { await runInit(argv); process.exit(0); }
if (positionals[0] === 'pull') { await runPull(argv); process.exit(0); }

const baseInput = optVal('--base') ?? process.env.CONFLUENCE_SYNC_BASE;
if (!baseInput) {
  console.error(
    red('✗ 동기화 루트가 지정되지 않았습니다.') + '\n' +
    '  --base <dir> 인자 또는 env CONFLUENCE_SYNC_BASE 로 동기화할 디렉토리를 지정하세요.\n' +
    `  예) ${cyan('confluence-sync --base ./docs')}\n` +
    `  설정(.env)을 만들려면:  ${cyan('confluence-sync init')}\n` +
    `  전체 도움말:           ${cyan('confluence-sync --help')}`,
  );
  process.exit(1);
}
const BASE_DIR = resolve(baseInput);
// mapping 은 base 루트에 둔다(문서셋에 종속). --mapping 으로 위치 override 가능.
const mappingOpt = optVal('--mapping');
const MAPPING_PATH = mappingOpt ? resolve(mappingOpt) : resolve(BASE_DIR, '.confluence-sync.json');

const env = readEnv();

async function main() {
  if (!existsSync(BASE_DIR) || !statSync(BASE_DIR).isDirectory()) {
    console.error(red(`동기화 루트가 디렉토리가 아닙니다: ${BASE_DIR}`));
    process.exit(1);
  }
  if (!DRY_RUN && !LIST) requireEnv(env); // list/dry 는 Confluence 호출이 없어 인증 불필요

  const allRel = collectMarkdown(BASE_DIR).map((f) => relative(BASE_DIR, f));
  const folderIndex = buildFolderIndex(allRel);
  const titleIndex = buildTitleIndex(allRel, BASE_DIR); // 링크 변환은 항상 전체 기준

  const selected = positionals.length
    ? withParents(resolveSelection(allRel, positionals, BASE_DIR), folderIndex)
    : allRel;
  const files = sortForSync(selected);
  const scope = positionals.length ? `선택 ${files.length}/${allRel.length}건` : `${files.length}건`;
  console.log(`${dim('base:')} ${cyan(BASE_DIR)}\n${dim('대상:')} ${scope}`);

  // --list: base에서 인식된 문서·제목·계층만 출력(Confluence 호출 없음)
  if (LIST) {
    for (const rel of files) {
      let depth = 0;
      for (let pk = parentKeyOf(rel, folderIndex); pk; pk = parentKeyOf(pk, folderIndex)) depth++;
      console.log(`  ${'  '.repeat(depth)}${rel}  ${dim('—')}  ${cyan(`"${titleIndex[rel]}"`)}`);
    }
    return;
  }

  const mapping = loadMapping(MAPPING_PATH);

  if (DRY_RUN) {
    for (const rel of files) {
      const { title, body } = splitTitleAndBody(readFileSync(resolve(BASE_DIR, rel), 'utf8'), rel);
      const r = toStorage(body, rel, titleIndex, BASE_DIR);
      const hash = docHash(title, r);
      const ex = mapping[rel];
      const status = !ex?.pageId ? green('신규') : ex.hash === hash ? gray('동일') : yellow('변경');
      const pk = parentKeyOf(rel, folderIndex);
      console.log(`  [${status}] ${rel}  ${dim('→')}  ${cyan(`"${title}"`)}  ${dim(`(부모: ${pk ?? 'ROOT'}, 내부링크: ${r.internalLinks}, 이미지: ${r.images.length})`)}`);
    }
    console.log('\n' + dim('--dry-run: 실제 호출 없음.'));
    return;
  }

  const client = createClient(
    { baseUrl: env.baseUrl!, email: env.email!, token: env.token! },
    { force: FORCE, verify: VERIFY },
  );
  const spaceId = await client.getSpaceId(env.spaceKey!);
  if (REBUILD) { await client.deleteAll(mapping); saveMapping(MAPPING_PATH, {}); }
  const work: Mapping = REBUILD ? {} : mapping;

  let created = 0, updated = 0, skipped = 0, recreated = 0, relinked = 0;
  const rendered = new Map<string, Rendered & { title: string; hash: string; parentId: string | undefined }>();
  const recreatedTitles = new Set<string>(); // 이번에 재생성된 문서의 제목
  const touched = new Set<string>();          // 이번에 발행(생성/갱신/재생성)된 문서

  for (const rel of files) {
    const { title, body } = splitTitleAndBody(readFileSync(resolve(BASE_DIR, rel), 'utf8'), rel);
    const r = toStorage(body, rel, titleIndex, BASE_DIR);
    const hash = docHash(title, r);
    const pk = parentKeyOf(rel, folderIndex);
    const parentId = pk ? work[pk]?.pageId : env.parentPageId;
    rendered.set(rel, { ...r, title, hash, parentId });
    if (pk && !parentId) {
      console.error(yellow(`  ✗ 건너뜀  ${rel}  (부모 '${pk}' 페이지가 아직 없음)`));
      continue;
    }
    try {
      const result = await client.upsertPage(work, spaceId, rel, title, r.storage, hash, parentId);
      saveMapping(MAPPING_PATH, work);
      if (result === 'skipped') {
        console.log(`  ${gray('=  변경없음')}  ${rel}`);
        skipped++;
        continue;
      }
      const imgOk = await client.uploadImages(work[rel].pageId, r.images, BASE_DIR);
      const imgNote = r.images.length ? `, 이미지 ${imgOk}/${r.images.length}` : '';
      const label = result === 'created' ? green('＋ 생성')
        : result === 'recreated' ? magenta('♻ 재생성(삭제 복구)')
        : yellow('↻ 갱신');
      console.log(`  ${label}  ${rel}  ${dim('→')}  ${cyan(`"${title}"`)}  ${dim(`(부모: ${pk ?? 'ROOT'}${imgNote})`)}`);
      if (result === 'created') created++;
      else if (result === 'recreated') { recreated++; recreatedTitles.add(title); }
      else updated++;
      touched.add(rel);
    } catch (e) {
      console.error(red(`  ✗ 실패  ${rel}`) + `\n${(e as Error).message}`);
    }
  }

  // 링크 정합성: 재생성된 문서를 가리키던, 이번에 발행 안 된(스킵된) 문서를 강제 재발행해 링크를 새 페이지로 재연결
  if (recreatedTitles.size) {
    for (const rel of files) {
      if (touched.has(rel)) continue;
      const r = rendered.get(rel);
      if (!r || !work[rel]?.pageId) continue;
      if (!r.linkedTitles.some((t) => recreatedTitles.has(t))) continue;
      try {
        await client.upsertPage(work, spaceId, rel, r.title, r.storage, r.hash, r.parentId, true);
        saveMapping(MAPPING_PATH, work);
        await client.uploadImages(work[rel].pageId, r.images, BASE_DIR);
        console.log(`  ${cyan('🔗 링크 재연결')}  ${rel}  ${dim('→')}  ${cyan(`"${r.title}"`)}`);
        relinked++;
      } catch (e) {
        console.error(red(`  ✗ 링크 재연결 실패  ${rel}`) + `\n${(e as Error).message}`);
      }
    }
  }

  console.log(
    '\n' + bold('완료') +
    `  ${green(`생성 ${created}`)}` +
    `  ${yellow(`갱신 ${updated}`)}` +
    `  ${magenta(`재생성 ${recreated}`)}` +
    `  ${cyan(`링크재연결 ${relinked}`)}` +
    `  ${gray(`변경없음 ${skipped}`)}` +
    `  ${dim(`대상 ${files.length}`)}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
