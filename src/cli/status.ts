/** Git-like status from local files and the last saved Fetch observation. */
import { bold, cyan, blue, green, yellow, red, gray, dim } from '../shared/colors.js';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { readEnv } from '../confluence/config.js';
import { inspectStaging } from '../sync/staging.js';
import { observeChanges, changeGroup, type ChangeGroup, type ChangeRow } from '../sync/changes.js';
import { loadWorkspace, requireScope, resolveSyncBase } from '../sync/workspace.js';

export async function runStatus(argv: string[]) {
  let explicitBase: string | undefined;
  const referenceRoots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base' || arg === '--reference-root') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error(`${arg} 뒤에 폴더를 지정하세요.`);
      if (arg === '--base') explicitBase = value; else referenceRoots.push(value);
    } else if (!['status', '--no-color'].includes(arg)) throw new Error(`지원하지 않는 status 인자: ${arg}. csync status --help를 확인하세요.`);
  }
  const base = resolveSyncBase(explicitBase);
  if (!base) throw new Error('작업공간이 없습니다. .env를 준비하고 csync pull 또는 csync init --connect를 실행하세요.');
  const workspace = loadWorkspace(base); requireScope(workspace);
  const env = readEnv(base);
  const view = observeChanges(base, await inspectStaging(base, {referenceRoots, baseUrl: env.baseUrl}), env);
  console.log(`${bold('작업공간:')} ${cyan(resolve(base))}\n${bold('스페이스:')} ${cyan(workspace.connection!.spaceKey)}`);
  console.log(view.remoteCheckedAt
    ? `${dim('원격 확인: ' + view.remoteCheckedAt)}${view.remoteExpired ? yellow(' · 이전 조회 결과(2분 경과), csync fetch로 갱신하세요.') : dim(' · 저장된 Fetch 결과')}\n${dim('현재 상태는 마지막 조회 시점 기준입니다. 이번 API 요청: 0회')}`
    : yellow('원격 미확인 · csync fetch로 원격 변경을 확인하세요. 이번 API 요청: 0회'));
  if (view.remoteError) console.log(yellow(view.remoteError));
  const titles: Record<ChangeGroup, string> = {receive: '↓ 받을 변경', conflict: '! 양쪽 변경 · 비교 필요', attention: '! 확인 필요', send: '↑ 보낼 변경 · 로컬 작업', same: '변경 없음'};
  const tones = {receive: cyan, conflict: red, attention: yellow, send: blue, same: gray};
  const labels: Record<string, string> = {new: '로컬 신규', changed: '로컬 수정', moved: '로컬 이동', same: '로컬 변경 없음', unavailable: '로컬 파일 없음·제외 여부 확인'};
  const detail = (row: ChangeRow) => {
    const selection = row.staged ? row.stale ? yellow('[재추가 필요]') : green('[추가됨]') : gray('[미선택]');
    const group = changeGroup(row);
    const pathTone = group === 'conflict' || group === 'attention' ? tones[group] : row.staged ? green : group === 'receive' ? cyan : (text: string) => text;
    const remote = row.remoteState === 'unavailable' ? ' · 원격 조회 불가(삭제로 확정하지 않음)' : row.remoteState === 'unknown' ? ' · 원격 기준 확인 필요' : '';
    const versions = row.remoteVersion !== undefined ? ` · 기준 v${row.baselineVersion ?? '?'} / 원격 v${row.remoteVersion}` : '';
    return `  ${selection} ${pathTone(row.path)} · ${row.unmapped?'받기 미완료 · 원격 대조 필요':row.remoteState==='new'?'원격 신규':row.renamed?'로컬 경로 변경':labels[row.status] ?? row.status}${gray(versions)}${yellow(remote)}`;
  };
  for (const group of ['receive', 'conflict', 'attention', 'send'] as const) {
    const rows = view.rows.filter(row => changeGroup(row) === group).sort((a, b) => a.path.localeCompare(b.path));
    if (!rows.length) continue;
    console.log(`\n${bold(tones[group](titles[group] + ` (${rows.length}개)`))}`);
    for (const row of rows) {
      console.log(detail(row));
      if (row.status === 'unavailable' && row.remoteState!=='new' && row.pageId && !view.rows.some(other => other !== row && other.pageId === row.pageId && other.status !== 'unavailable')) {
        try {lstatSync(resolve(base, row.path));}
        catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') console.log(`    원격에서 복구: ${cyan(`csync restore ${JSON.stringify(row.path)}`)}`);}
      }
      if (group === 'conflict' || group === 'attention') for (const reason of row.remoteReasons ?? []) console.log(dim(`    ${reason}`));
    }
  }
  if (view.rows.every(row => changeGroup(row) === 'same')) console.log(view.remoteCheckedAt ? green('\n마지막 조회 기준 표시할 변경이 없습니다.') : dim('\n로컬 변경이 없습니다. 원격 상태는 아직 확인하지 않았습니다.'));
  const staged = view.rows.filter(row => row.staged);
  const attention = staged.filter(row => row.stale || row.status === 'unavailable').length;
  console.log(`\n${bold('업로드 선택:')} ${green(`${staged.length}개`)} · 재추가·파일 확인 필요: ${(attention ? yellow : gray)(`${attention}개`)}`);
  if (view.rows.some(row => changeGroup(row) === 'receive')) console.log(`받기: ${cyan('csync pull')} · 원격 신규·변경 문서 받기, 로컬 수정·삭제 보존`);
  if (view.rows.some(row => changeGroup(row) === 'conflict')) console.log(`${red('양쪽 변경:')} ${cyan('csync diff "문서.md" --remote')}로 비교하세요. 자동 병합·덮어쓰기는 하지 않습니다.`);
  if (view.rows.some(row => row.status === 'unavailable' && row.remoteState!=='new')) console.log(yellow('로컬 파일 누락·제외는 원격 삭제로 반영하지 않습니다. 이동·제외 규칙과 파일 위치를 확인하세요.'));
  console.log(`보내기: ${cyan('csync add <파일·폴더>')} → ${cyan('csync push --dry-run')} → ${cyan('csync push')}\n선택 해제: ${cyan('csync unstage <파일·폴더>')} · 원본 유지\n새 원격 문서 확인: ${cyan('csync fetch')}`);
}
