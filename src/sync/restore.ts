/** Recover selected local documents from Confluence; never deletes or writes remote content. */
import { positionalArgs } from '../cli/args.js';
import { resolveSyncBase } from './workspace.js';
import { runPull, validateRestorePaths } from './pull.js';
import { loadIndex, completeStaged } from './staging.js';

export async function runRestore(argv: string[]): Promise<void> {
  let explicitBase: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--base 뒤에 작업공간 폴더를 지정하세요.');
      explicitBase = value;
    } else if (argv[i].startsWith('-') && !['--no-color','--obsidian','--overwrite'].includes(argv[i])) throw new Error(`지원하지 않는 restore 옵션: ${argv[i]}. csync restore --help를 확인하세요.`);
  }
  const base = resolveSyncBase(explicitBase);
  if (!base) throw new Error('작업공간을 지정하세요: csync restore README.md --base <폴더>');
  const overwrite = argv.includes('--overwrite');
  const paths = validateRestorePaths(base, positionalArgs(argv).slice(1), overwrite);
  const staged = loadIndex(base).entries;
  await runPull(['pull','--base',base,...(argv.includes('--obsidian')?['--obsidian']:[])], {restorePaths: paths, restoreOverwrite: overwrite});
  for (const path of paths) completeStaged(base, path, staged[path]);
  console.log('복구한 문서는 업로드 대상으로 추가하지 않습니다. 업로드하려면 직접 csync add로 선택하세요.');
}
