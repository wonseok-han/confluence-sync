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
import { existsSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { readEnv, requireEnv } from './config.js';
import { toStorage, docHash, type Rendered } from './markdown.js';
import {
  collectMarkdown, collectAssets, buildTitleIndex, buildFolderIndex, buildVault, vaultResolver, readDoc,
  parentKeyOf, containerKeyOf, sortForSync, resolveSelection, withParents,
} from './docs.js';
import { loadMapping, saveMapping, type Mapping } from './mapping.js';
import { createClient } from './confluence.js';
import { runInit } from './init.js';
import { runPull } from './pull.js';
import { runConvert } from './convert.js';
import { buildIgnorer } from './ignore.js';
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
/** 반복 가능한 옵션의 모든 값 수집(예: --exclude a --exclude b) */
function optVals(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && i + 1 < argv.length) out.push(argv[++i]);
  return out;
}
const EXCLUDES = optVals('--exclude');
// 위치 인자(선택 경로/서브커맨드): 플래그·옵션값 제외
const positionals: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--base' || argv[i] === '--mapping' || argv[i] === '--exclude'
    || argv[i] === '--to' || argv[i] === '--out') { i++; continue; }
  if (argv[i].startsWith('-')) continue;
  positionals.push(argv[i]);
}

// 인증·동기화 루트가 필요 없는 즉시 종료 모드 (base 검사보다 먼저)
if (HELP) { printHelp(); process.exit(0); }
if (VERSION) { console.log(readPkgVersion()); process.exit(0); }
if (positionals[0] === 'init') { await runInit(argv); process.exit(0); }
if (positionals[0] === 'pull') { await runPull(argv); process.exit(0); }
if (positionals[0] === 'convert') { await runConvert(argv); process.exit(0); }

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

  const ignorer = buildIgnorer(BASE_DIR, EXCLUDES);
  const collected = collectMarkdown(BASE_DIR).map((f) => relative(BASE_DIR, f));
  const allRel = collected.filter((r) => !ignorer.ignores(r)); // 제외된 문서는 모든 단계에서 빠짐
  const ignoredCount = collected.length - allRel.length;
  const folderIndex = buildFolderIndex(allRel);
  const titleIndex = buildTitleIndex(allRel, BASE_DIR); // 링크 변환은 항상 전체 기준
  // Obsidian [[wikilink]] 해석용 이름 인덱스. 제외된 문서는 링크 대상에서도 빠진다.
  const vault = buildVault(allRel, collectAssets(BASE_DIR).map((f) => relative(BASE_DIR, f)));
  const render = (rel: string, body: string) => toStorage(body, rel, titleIndex, BASE_DIR, vaultResolver(rel, vault));

  const selected = positionals.length
    ? withParents(resolveSelection(allRel, positionals, BASE_DIR), folderIndex)
    : allRel;
  const files = sortForSync(selected);
  const scope = positionals.length ? `선택 ${files.length}/${allRel.length}건` : `${files.length}건`;
  const ignoredNote = ignoredCount ? dim(`  (제외 ${ignoredCount})`) : '';
  console.log(`${dim('base:')} ${cyan(BASE_DIR)}\n${dim('대상:')} ${scope}${ignoredNote}`);

  // ---- 경로 헬퍼 ----
  const isReadmeFile = (p: string) => /README\.md$/.test(p);
  const segOf = (s: string) => (s === '' ? 0 : s.split('/').length);
  const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
  const parentDirOf = (d: string) => (d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '');
  const fileDepth = (rel: string) => (isReadmeFile(rel) ? Math.max(0, segOf(dirOf(rel)) - 1) : segOf(dirOf(rel)));
  const folderDepth = (d: string) => Math.max(0, segOf(d) - 1);
  // 파일의 README 없는(=폴더로 만들) 조상 dir들, shallow→deep
  const ancestorFolderDirs = (rel: string) => {
    const out: string[] = [];
    for (let d = dirOf(rel); d !== ''; d = parentDirOf(d)) if (!folderIndex[d]) out.unshift(d);
    return out;
  };

  // --list: base에서 인식된 문서·제목·계층만 출력(Confluence 호출 없음)
  if (LIST) {
    const seen = new Set<string>();
    for (const rel of files) {
      for (const d of ancestorFolderDirs(rel)) if (!seen.has(d)) {
        seen.add(d);
        console.log(`  ${'  '.repeat(folderDepth(d))}${cyan(`📁 ${d}/`)}`);
      }
      console.log(`  ${'  '.repeat(fileDepth(rel))}${rel}  ${dim('—')}  ${cyan(`"${titleIndex[rel]}"`)}`);
    }
    return;
  }

  const mapping = loadMapping(MAPPING_PATH);

  if (DRY_RUN) {
    const seen = new Set<string>();
    for (const rel of files) {
      for (const d of ancestorFolderDirs(rel)) if (!seen.has(d)) {
        seen.add(d);
        const fex = mapping[`${d}/`];
        console.log(`  [${fex?.pageId ? gray('폴더') : green('폴더+')}] 📁 ${d}/`);
      }
      const { title, body, fm } = readDoc(BASE_DIR, rel);
      const r = render(rel, body);
      const hash = docHash(title, r);
      const ex = mapping[rel];
      // 매핑엔 없지만 frontmatter 에 pageId 가 있으면 신규 생성이 아니라 기존 페이지에 연결된다
      const status = !ex?.pageId
        ? (fm.pageId ? cyan('연결') : green('신규'))
        : ex.hash === hash ? gray('동일') : yellow('변경');
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

  let created = 0, updated = 0, skipped = 0, recreated = 0, relinked = 0, foldersMade = 0, linked = 0;
  const rendered = new Map<string, Rendered & { title: string; hash: string; parentId: string | undefined }>();
  const recreatedTitles = new Set<string>(); // 이번에 재생성된 문서의 제목
  const touched = new Set<string>();          // 이번에 발행(생성/갱신/재생성)된 문서
  const handledFolders = new Set<string>();   // 이번 실행에서 처리한 폴더 dir

  // README 없는 폴더를 Confluence 폴더로 생성(없으면)하고 work 에 등록. 성공 여부 반환.
  const ensureFolder = async (dir: string): Promise<boolean> => {
    const key = `${dir}/`;
    const pcKey = containerKeyOf(parentDirOf(dir), folderIndex);
    const parentId = pcKey ? work[pcKey]?.pageId : env.parentId;
    if (pcKey && !parentId) {
      console.error(yellow(`  ✗ 폴더 건너뜀  ${dir}/  (부모 '${pcKey}' 가 아직 없음)`));
      return false;
    }
    const ex = work[key];
    if (ex?.pageId && ex.type === 'folder' && (await client.getContentOrNull(ex.pageId))) {
      return true; // 이미 존재
    }
    try {
      const title = dir.split('/').pop()!;
      const fid = await client.createFolder(spaceId, title, parentId);
      work[key] = { pageId: fid, title, type: 'folder' };
      saveMapping(MAPPING_PATH, work);
      console.log(`  ${cyan('📁 폴더')}  ${dir}/  ${dim(`(부모: ${pcKey ?? 'ROOT'})`)}`);
      foldersMade++;
      return true;
    } catch (e) {
      console.error(red(`  ✗ 폴더 생성 실패  ${dir}/`) + `\n${(e as Error).message}`);
      return false;
    }
  };

  for (const rel of files) {
    // 상위 README-less 폴더들 보장(shallow→deep)
    let folderOk = true;
    for (const d of ancestorFolderDirs(rel)) {
      if (!handledFolders.has(d)) { handledFolders.add(d); if (!(await ensureFolder(d))) folderOk = false; }
      else if (!work[`${d}/`]?.pageId) folderOk = false;
      if (!folderOk) break;
    }
    if (!folderOk) { console.error(yellow(`  ✗ 건너뜀  ${rel}  (상위 폴더 미생성)`)); continue; }

    const { title, body, fm } = readDoc(BASE_DIR, rel);
    const r = render(rel, body);
    const hash = docHash(title, r);
    const pk = parentKeyOf(rel, folderIndex);
    const parentId = pk ? work[pk]?.pageId : env.parentId;
    rendered.set(rel, { ...r, title, hash, parentId });
    if (pk && !parentId) {
      console.error(yellow(`  ✗ 건너뜀  ${rel}  (부모 '${pk}' 가 아직 없음)`));
      continue;
    }

    // pull 로 받은 문서(frontmatter 에 pageId)는 매핑이 없어도 원본 페이지에 다시 연결한다.
    // 매핑 파일을 잃었거나 vault 를 다른 곳에 복제한 경우 중복 생성을 막아준다.
    if (!work[rel]?.pageId && fm.pageId) {
      try {
        if (await client.getContentOrNull(fm.pageId)) {
          work[rel] = { pageId: fm.pageId, title };
          saveMapping(MAPPING_PATH, work);
          console.log(`  ${cyan('🔗 연결')}  ${rel}  ${dim(`→ 기존 페이지 #${fm.pageId}`)}`);
          linked++;
        } else {
          console.error(yellow(`  ⚠ frontmatter 의 pageId #${fm.pageId} 를 찾을 수 없습니다 → 새로 생성  (${rel})`));
        }
      } catch (e) {
        console.error(yellow(`  ⚠ pageId 확인 실패 #${fm.pageId}: ${(e as Error).message}`));
      }
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
    (linked ? `  ${cyan(`연결 ${linked}`)}` : '') +
    (foldersMade ? `  ${cyan(`폴더 ${foldersMade}`)}` : '') +
    `  ${dim(`대상 ${files.length}`)}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
