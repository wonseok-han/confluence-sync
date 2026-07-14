/**
 * `confluence-sync convert [--to obsidian|markdown] [--fix] [파일|폴더...] [--base <dir>] [--dry-run]`
 * 이미 내려받은 .md 를 제자리에서 손본다. Confluence 호출도 인증도 없다.
 *
 *   --to obsidian  — 상대 .md 링크 → [[wikilink]]
 *   --to markdown  — [[wikilink]] · ![[embed]] → 상대 .md 링크 (되돌리기)
 *   --fix          — 옛 변환기가 남긴 흔적 보정(코드블록 언어·CSS 잔해·이스케이프·빈 줄)
 *
 * 스페이스를 통째로 다시 받지 않고도 최신 변환 품질을 얻기 위한 것이다.
 * 링크는 대상이 트리 안에 실제로 있을 때만 바꾼다(외부 URL·이미지·깨진 링크는 손대지 않는다).
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, relative, dirname, basename, join } from 'node:path';
import { collectMarkdown, collectAssets, buildVault, vaultResolver } from './docs.js';
import { linksToWikilinks, resolveWikilinks } from './obsidian.js';
import { repairMarkdown, totalFixes, type RepairStats } from './repair.js';
import { bold, cyan, dim, gray, green, red, yellow } from './colors.js';

type Direction = 'obsidian' | 'markdown';

function optVal(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const posix = (s: string) => s.split('\\').join('/');

// ![alt](경로) — 본문이 참조하는 로컬 이미지(--out 으로 복사할 때 같이 옮긴다)
const IMAGE = /!\[[^\]]*\]\((<[^>]+>|[^()\s]+)\)/g;

/** md 본문이 참조하는 로컬 첨부의 절대경로들(외부 URL 제외, 실제 존재하는 것만). */
function referencedAssets(text: string, fileAbs: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMAGE)) {
    const dest = decode(m[1].replace(/^<(.*)>$/, '$1')).split('#')[0];
    if (/^(https?:|data:)/i.test(dest)) continue;
    const abs = resolve(dirname(fileAbs), dest);
    if (existsSync(abs)) out.push(abs);
  }
  return out;
}

/** 준 경로들을 모두 담는 가장 가까운 폴더(파일은 그 파일이 있는 폴더로 친다). 인자가 없으면 null. */
function commonAncestor(paths: string[]): string | null {
  if (!paths.length) return null;
  const dirs = paths.map((p) => {
    const abs = resolve(p);
    return statSync(abs).isDirectory() ? abs : dirname(abs);
  });
  const split = dirs.map((d) => d.split('/'));
  const head = split[0];
  let i = 0;
  while (i < head.length && split.every((s) => s[i] === head[i])) i++;
  return split.length === 1 ? dirs[0] : head.slice(0, i).join('/') || '/';
}

/**
 * 상대 .md 링크 → [[wikilink]].
 * wikilink 는 vault 어디서든 "이름"으로 찾으므로, 파일명이 트리 안에서 유일할 때만 바꾼다
 * (겹치면 엉뚱한 노트로 이어질 수 있어 상대 링크를 그대로 둔다).
 */
function toObsidian(text: string, fileAbs: string, baseDir: string, nameCount: Map<string, number>): string {
  return linksToWikilinks(text, (dest, label) => {
    if (/^(https?:|mailto:|#)/i.test(dest)) return null; // 외부 링크·앵커
    const [pathPart, ...hash] = decode(dest).split('#');
    if (!/\.md$/i.test(pathPart)) return null;

    const targetAbs = resolve(dirname(fileAbs), pathPart);
    if (!existsSync(targetAbs)) return null;                 // 깨진 링크는 손대지 않는다
    if (relative(baseDir, targetAbs).startsWith('..')) return null; // 트리 밖

    const name = basename(targetAbs).replace(/\.md$/i, '');
    if (nameCount.get(name) !== 1) return null;              // 이름이 겹치면 상대 링크 유지

    const anchor = hash.length ? `#${hash.join('#')}` : '';
    const l = label.trim();
    return l && l !== name ? `[[${name}${anchor}|${l}]]` : `[[${name}${anchor}]]`;
  });
}

export async function runConvert(argv: string[]): Promise<void> {
  const toRaw = optVal(argv, '--to');
  const fix = argv.includes('--fix');
  if (toRaw !== undefined && toRaw !== 'obsidian' && toRaw !== 'markdown') {
    console.error(red(`✗ 알 수 없는 변환 방향: ${toRaw}`) + '\n  --to obsidian | --to markdown');
    process.exit(1);
  }
  const to = toRaw as Direction | undefined;
  if (!to && !fix) {
    console.error(
      red('✗ 할 일을 지정하세요: --to <형식> 또는 --fix') +
      `\n  예) ${cyan('confluence-sync convert --to obsidian ./docs')}` +
      `\n      ${cyan('confluence-sync convert --fix ./docs')}          ${dim('(옛 pull 결과 보정)')}` +
      `\n      ${cyan('confluence-sync convert --to obsidian --fix ./docs')}  ${dim('(둘 다)')}`,
    );
    process.exit(1);
  }
  const dryRun = argv.includes('--dry-run');

  // --out: 원본을 두고 변환 결과를 다른 트리에 쓴다(base 기준 상대 경로를 그대로 재현)
  const outOpt = optVal(argv, '--out');
  const outDir = outOpt ? resolve(outOpt) : undefined;

  // 위치 인자: ['convert', <파일|폴더>...]  (옵션 값은 건너뛴다)
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--to' || argv[i] === '--base' || argv[i] === '--out') { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    positionals.push(argv[i]);
  }
  const targets = positionals.slice(1); // [0] 은 'convert'
  for (const t of targets) {
    if (!existsSync(resolve(t))) {
      console.error(red(`✗ 없는 경로: ${t}`));
      process.exit(1);
    }
  }

  /**
   * baseDir 은 **링크를 해석하는 범위**다. 파일 하나만 고칠 때도 주변 문서를 알아야
   * (이름이 유일한지·링크 대상이 실재하는지) 판정할 수 있다.
   * 기본값은 준 경로들의 공통 상위 폴더 — 폴더를 주면 그 폴더, 파일을 주면 그 파일이 있는 폴더다.
   * 링크 변환(--to)에서 트리 전체를 봐야 한다면 --base 로 루트를 지정한다.
   */
  const baseOpt = optVal(argv, '--base');
  const baseDir = resolve(baseOpt ?? commonAncestor(targets) ?? process.cwd());
  if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) {
    console.error(red(`✗ --base 가 디렉토리가 아닙니다: ${baseDir}`));
    process.exit(1);
  }

  const allMd = collectMarkdown(baseDir); // 링크 해석용(전체)
  const mdRels = allMd.map((f) => posix(relative(baseDir, f)));
  const vault = buildVault(mdRels, collectAssets(baseDir).map((f) => posix(relative(baseDir, f))));

  // obsidian 방향의 이름 중복 검사도 트리 전체 기준이어야 한다
  const nameCount = new Map<string, number>();
  for (const f of allMd) {
    const n = basename(f).replace(/\.md$/i, '');
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  }

  // 실제로 고쳐 쓸 파일(선택). 경로를 안 주면 base 전체.
  const selected = targets.length
    ? allMd.filter((f) => targets.some((t) => {
        const abs = resolve(t);
        return f === abs || f.startsWith(abs + '/');
      }))
    : allMd;

  // base 밖의 .md 를 직접 지목한 경우(예: 이웃 폴더 파일) 는 위 필터에 안 걸린다
  const outside = targets
    .map((t) => resolve(t))
    .filter((abs) => statSync(abs).isFile() && !allMd.includes(abs));
  if (outside.length) {
    console.error(yellow(`⚠ --base(${baseDir}) 밖의 파일은 건너뜁니다:`) + '\n  ' + outside.join('\n  '));
  }
  if (!selected.length) {
    console.error(red('✗ 대상 .md 가 없습니다.') + dim('\n  (파일을 직접 지목했다면 --base 로 문서 트리 루트를 알려주세요)'));
    process.exit(1);
  }
  const mdAbs = selected;

  const jobs = [
    to === 'obsidian' ? '상대 .md 링크 → [[wikilink]]' : to === 'markdown' ? '[[wikilink]] → 상대 .md 링크' : '',
    fix ? '변환 흔적 보정' : '',
  ].filter(Boolean).join(' + ');
  const scope = mdAbs.length === allMd.length
    ? `${mdAbs.length}건`
    : `선택 ${mdAbs.length}/${allMd.length}건`;
  if (outDir && (outDir === baseDir || outDir.startsWith(baseDir + '/'))) {
    console.error(red(`✗ --out 이 base 안에 있습니다: ${outDir}`) + dim('\n  원본 트리를 덮어쓰지 않도록 base 밖의 경로를 쓰세요.'));
    process.exit(1);
  }

  console.log(
    `${dim('base:')} ${cyan(baseDir)}\n` +
    `${dim('대상:')} ${scope}  ${dim('—')}  ${jobs}` +
    (outDir ? `\n${dim('출력:')} ${cyan(outDir)} ${dim('(원본 유지)')}` : '') +
    (dryRun ? dim('  (dry-run)') : ''),
  );

  let changed = 0;
  const copiedAssets = new Set<string>();
  const total: RepairStats = { cssJunk: 0, codeLang: 0, trailingWs: 0, escapes: 0, tightList: 0, dupTitle: 0 };

  for (const abs of mdAbs) {
    const rel = posix(relative(baseDir, abs));
    const before = readFileSync(abs, 'utf8');
    let text = before;
    const notes: string[] = [];

    // 보정을 먼저 한다 — 이스케이프가 풀려야(\[…\] → […]) 링크 인식이 정확해진다
    if (fix) {
      const r = repairMarkdown(text);
      text = r.text;
      const n = totalFixes(r.stats);
      if (n) {
        for (const k of Object.keys(total) as (keyof RepairStats)[]) total[k] += r.stats[k];
        notes.push(dim(`보정 ${n}`));
      }
    }
    if (to === 'obsidian') text = toObsidian(text, abs, baseDir, nameCount);
    else if (to === 'markdown') text = resolveWikilinks(text, vaultResolver(rel, vault));

    // 제자리 변환이면 바뀐 것만 쓰지만, --out 이면 대상 전부를 내보낸다(온전한 트리가 나와야 하므로)
    if (!outDir && text === before) continue;

    if (outDir) {
      const target = join(outDir, rel);
      if (!dryRun) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
        // 이미지가 따라가지 않으면 링크가 깨진다 — 참조된 첨부를 같은 상대 위치로 복사
        for (const asset of referencedAssets(text, abs)) {
          const arel = posix(relative(baseDir, asset));
          if (arel.startsWith('..') || copiedAssets.has(arel)) continue; // base 밖 첨부는 두고 온다
          const dstAsset = join(outDir, arel);
          mkdirSync(dirname(dstAsset), { recursive: true });
          copyFileSync(asset, dstAsset);
          copiedAssets.add(arel);
        }
      }
    } else if (!dryRun) {
      writeFileSync(abs, text);
    }

    // --out 이면 안 바뀐 파일도 그대로 내보내지만, 로그는 실제로 손댄 것만 남긴다
    if (text !== before) {
      changed++;
      console.log(`  ${cyan('↻')}  ${rel}${notes.length ? '  ' + notes.join(' ') : ''}`);
    }
  }

  console.log(
    '\n' + bold('완료') + `  ${changed ? green(`${changed}개 파일 변경`) : gray('고칠 것 없음')}` +
    (outDir ? `  ${cyan(`${mdAbs.length}개 파일 출력`)}${copiedAssets.size ? dim(`, 첨부 ${copiedAssets.size}`) : ''}` : '') +
    `  ${dim(`대상 ${mdAbs.length}`)}`,
  );
  if (fix && totalFixes(total)) {
    console.log(
      dim('  보정:') +
      `  중복 제목 ${total.dupTitle}` +
      `  코드블록 언어 ${total.codeLang}` +
      `  CSS 잔해 ${total.cssJunk}` +
      `  이스케이프 ${total.escapes}` +
      `  리스트 빈 줄 ${total.tightList}` +
      `  줄끝 공백 ${total.trailingWs}`,
    );
  }
  if (dryRun) console.log(dim('--dry-run: 파일을 쓰지 않았습니다.'));
}
