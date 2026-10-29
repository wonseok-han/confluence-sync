import { downloadText, formatJobLog, jobLogFilename } from './download.js';
import { createRestore } from './restore.js';
import { createSyncDiff } from './sync-diff.js';
import { createStaging } from './staging.js';
import { createEnvSettings } from './env-settings.js';
import { renderSyncLog } from './sync-log.js';

export function initSync({ api, monaco, context, setBusy, showSync, refresh = async () => {}, notify = () => {}, activity }) {
  const $ = id => document.getElementById(id);
  let busy = false, planId = null, previewJobId = null, preparedKey = '', loadedKey = '', timer, configured = false, credentialsReady = false, remotePath = '', workspaceLabel = '스페이스 전체';
  let jobActivity,currentJob;
  const jobLabels = {restore:'선택한 문서를 원격 최신으로 복구하는 중',preview:'업로드 미리보기를 계산하는 중',fetch:'원격 변경을 확인하는 중',pull:'Confluence에서 가져오는 중',push:'Confluence에 업로드하는 중'};
  const jobButtons = {restore:'sync-restore-confirm',preview:'sync-preview',fetch:'sync-fetch',pull:'sync-pull-remote',push:'sync-push'};
  function beginJobActivity(kind, button) {
    jobActivity?.end();
    jobActivity = activity?.begin({label:jobLabels[kind],detail:'작업을 준비하고 있습니다.',button:button || jobButtons[kind],region:'sync-results',link:'#sync-results'});
  }
  function finishJobActivity() {jobActivity?.end();jobActivity=undefined;}
  const announcedJobs = new Set();
  const status = (text, error = false, kind = error ? 'error' : 'info') => { $('sync-status').textContent = text; $('sync-status').classList.toggle('error', error); if (kind) notify(text, kind); };
  function selection() {
    const ctx = context();
    return { base: ctx.base || '', target: '', envId: envSettings.request().envId, verify: $('sync-verify').checked, referenceRoots: $('sync-references').value.split(/\r?\n/).map(path => path.trim()).filter(Boolean) };
  }
  const pullFormat=()=>$('sync-pull-format').value==='obsidian'?'obsidian':'markdown';
  const key = () => JSON.stringify(selection());
  const configKey = () => JSON.stringify([context().base, envSettings.identity()]);
  const hasTarget = () => !!context().base;
  function invalidatePreview() { planId = null; previewJobId = null; preparedKey = ''; }
  function update(isBusy, transient = false) {
    busy = isBusy;
    if (!transient && preparedKey && preparedKey !== key()) { invalidatePreview(); status('대상이나 옵션이 바뀌었습니다. 다시 미리보기해 주세요.'); }
    if (!transient && loadedKey && loadedKey !== configKey()) {
      loadedKey = ''; configured = false; credentialsReady = false; remotePath = ''; $('sync-config').replaceChildren(); $('sync-config-status').textContent = '설정 확인 또는 .env 가져오기로 연결 정보를 불러오세요.';
    }
    $('sync-log-download').disabled=!currentJob?.log?.trim();
    $('sync-job-state').hidden=!currentJob;
    envSettings.update(busy);
    $('sync-connect').disabled = busy || !context().base || !credentialsReady || configured;
    $('sync-connect').textContent = configured ? '스페이스 연결됨' : '스페이스 연결';
    staging.update(busy);
    for (const id of ['sync-pull-format', 'sync-load', 'sync-verify', 'sync-references', 'sync-add-reference']) $(id).disabled = busy;
    $('sync-pull-format-help').textContent=pullFormat()==='obsidian'?'위키링크([[문서|이름]])·콜아웃·각주 문법으로 복원합니다. 파일명이 겹치거나 HTML 표 안의 링크는 호환되는 상대 경로 링크를 유지합니다. 새로 받는 문서와 복구·원복에 적용합니다.':'Markdown 링크([이름](문서.md))·제목이 있는 인용문·위첨자 각주 목록으로 받습니다. 새로 받는 문서와 복구·원복에 적용하며 기존 파일을 일괄 변환하지 않습니다.';
    const receive=$('sync-pull-remote');
    if(receive){const count=staging.remoteOnlyCount();receive.disabled=busy||!configured||!credentialsReady||!count;receive.textContent=`↓ 원격 문서 ${count}개 가져오기 (Pull)`;}
    $('sync-fetch').disabled = busy || !context().base || !configured || !credentialsReady;
    $('sync-log-empty').textContent = '미리보기 또는 Fetch·Pull·복구를 실행하면 문서별 처리 내역을 확인할 수 있습니다.';
    $('sync-load').disabled = busy || !context().base;
    $('sync-preview').disabled = busy || !hasTarget() || !configured || !staging.ready();
    $('sync-push').disabled = busy || !configured || !credentialsReady || !planId || !previewJobId || preparedKey !== key();
    $('sync-push').title = planId ? '미리보기한 범위를 업로드합니다.' : '현재 선택과 설정으로 업로드 미리보기를 먼저 완료하세요.';
    const request = selection();
    $('sync-target').textContent = hasTarget() ? `기준 폴더 ${request.base} ↔ ${workspaceLabel} · Push는 체크한 문서만` : '로컬 문서에서 기준 폴더를 선택하세요.';
  }
  function renderConfig(config) {
    loadedKey = configKey(); configured = !!config.connected; credentialsReady = !config.missing.length; workspaceLabel = config.rootPath && config.rootPath !== '/' ? `기존 원격 루트 ${config.rootPath}` : '스페이스 전체'; remotePath = configured ? `${config.baseUrl}/${config.spaceKey}/${config.rootPath || '/'}` : ''; $('sync-config').replaceChildren();
    for (const [name, value] of [['설정 출처', config.source], ['서버', config.baseUrl || '미설정'], ['계정', config.email || '미설정'], ['스페이스', config.spaceKey || '미설정'], ['작업공간', configured ? `기준 폴더 ↔ ${workspaceLabel}` : '미연결'], ['API 토큰', config.hasToken ? '설정됨' : '미설정']]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; $('sync-config').append(dt, dd);
    }
    $('sync-config-status').textContent = config.missing.length ? `설정 필요: ${config.missing.join(', ')}. 미리보기는 인증 없이 사용할 수 있습니다.` : configured ? '접속 설정과 스페이스 연결을 불러왔습니다.' : '스페이스 연결을 눌러 기준 폴더와 연결하세요.';
  }
  function renderJob(job) {
    currentJob=job;$('sync-log-download').disabled=!job.log?.trim();
    if(job.state==='running'&&!jobActivity)beginJobActivity(job.kind);
    if(jobActivity) {
      const latest=(job.log||'').split(/\r?\n/).filter(line=>line.trim()&&!/^\s*(?:✓|완료|진행 ·)/.test(line)).at(-1);
      jobActivity.update({label:job.state==='running'?(job.phase==='fetch'?'완료 후 원격 상태를 다시 확인하는 중':jobLabels[job.kind]):'실행 결과를 반영하는 중',detail:job.state==='running'?(latest||'처리 중입니다. 실행 내역에서 세부 내용을 확인할 수 있습니다.'):'변경 목록과 로컬 폴더를 갱신하고 있습니다.',startedAt:job.startedAt,uncertain:false});
    }
    $('sync-job-summary').hidden = false;
    $('sync-job-summary').textContent = `${job.kind === 'restore' ? '문서 복구' : job.kind === 'preview' ? '업로드 미리보기' : job.kind === 'fetch' ? '원격 변경 확인' : job.kind === 'pull' ? '가져오기' : '업로드'} · ${['pull','fetch','restore'].includes(job.kind) ? `${job.config.spaceKey || '스페이스 미설정'} → ${job.selection.base}` : `${job.selection.target || job.selection.base} → ${job.config.spaceKey || '스페이스 미설정'}`} (${job.config.baseUrl || '서버 미설정'})`;
    if(['pull','restore'].includes(job.kind))$('sync-job-summary').textContent+=` · 가져오기 형식: ${job.selection.format==='obsidian'?'Obsidian':'Markdown'}`;
    $('sync-log-empty').hidden = true; $('sync-log').hidden = false;
    const log = $('sync-log'), following = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    renderSyncLog(log, job.log || '작업을 준비하는 중입니다…');
    if (following) log.scrollTop = log.scrollHeight;
    $('sync-job-state').hidden=false;
    $('sync-job-state').setAttribute('data-state',job.state==='succeeded'&&(job.warningCount||job.refreshFailed)?'warning':job.state);
    $('sync-job-state').textContent = job.state === 'succeeded' && (job.warningCount||job.refreshFailed) ? '완료 (경고)' : { running: '진행 중', succeeded: '완료', failed: '실패' }[job.state];
    const announce = !announcedJobs.has(job.id);
    if (job.state !== 'running') announcedJobs.add(job.id);
    if (job.state === 'running' && job.phase === 'fetch') status('Push·Pull을 완료했습니다. 최신 원격 상태를 다시 확인하고 있습니다…', false, null);
    else if (job.state === 'running') status(job.kind === 'restore' ? '선택한 문서를 원격 최신으로 복구하고 있습니다…' : job.kind === 'preview' ? '로컬 문서와 매핑을 비교하고 있습니다…' : job.kind === 'fetch' ? '원격 페이지 메타데이터를 확인하고 있습니다…' : job.kind === 'pull' ? 'Confluence에서 문서를 가져오고 있습니다…' : 'Confluence에 업로드하고 있습니다. 진행 내역을 확인하세요.', false, null);
    else if (job.state === 'failed') status(job.kind === 'restore' ? '문서 복구에 실패했습니다. 실행 내역을 확인하세요.' : job.kind === 'fetch' ? '원격 변경 확인에 실패했습니다. 실행 내역을 확인하세요. 이전 캐시는 유지됩니다.' : job.kind === 'pull' ? '가져오기에 실패했습니다. 로컬 변경이나 오류 내역을 확인한 뒤 다시 시도하세요.' : '업로드가 실패했거나 일부 문서가 처리되지 않았습니다. 내역을 확인한 뒤 다시 미리보기해 주세요.', true, announce ? 'error' : null);
    else if (job.kind === 'preview') {
      if (job.id === previewJobId && preparedKey === key() && !job.config.missing.length && job.config.connected) planId = job.planId;
      status(job.config.missing.length ? '미리보기 완료. 접속 설정을 채운 뒤 다시 미리보기해 주세요.' : planId ? '미리보기 완료. 대상과 업로드 위치를 확인하고 Confluence에 업로드를 누르세요.' : '미리보기 내역을 불러왔습니다. 현재 선택으로 다시 미리보기해 주세요.', false, announce ? (job.config.missing.length ? 'warning' : 'success') : null);
    } else if (job.kind === 'fetch') status('Fetch를 완료했습니다. 변경 문서 목록에 원격 상태를 반영합니다. 상세 조회 내역은 대상 및 실행 내역에서 확인할 수 있으며 문서와 동기화 기준은 유지됩니다.', false, announce ? 'success' : null);
    else if (job.refreshFailed) status(`${job.kind === 'push' ? '업로드' : '가져오기'}는 완료했지만 후속 Fetch에 실패했습니다. ${job.warningCount ? `첨부 ${job.warningCount}개는 원격 참조를 유지했습니다. ` : ''}변경 목록이 최신이 아닐 수 있으니 Fetch를 다시 실행하세요.`, false, announce ? 'warning' : null);
    else if (job.warningCount) status(`가져오기를 완료했습니다. 첨부 ${job.warningCount}개를 저장하지 못해 원격 참조를 유지했습니다. 실행 내역을 확인하세요.`, false, announce ? 'warning' : null);
    else status(job.kind === 'restore' ? '원격 최신으로 복구했습니다. 복구 문서는 업로드 선택에서 제외했습니다.' : job.kind === 'pull' ? '가져오기가 완료되었습니다. 기준 폴더에서 문서를 확인하세요.' : '업로드가 완료되었습니다. 다른 대상을 선택해 계속 작업할 수 있습니다.', false, announce ? 'success' : null);
  }
  async function poll() {
    clearTimeout(timer);
    try {
      const { job } = await api('/api/sync/job');
      if (!job) { finishJobActivity(); setBusy(false); return; }
      renderJob(job); $('sync-reconnect').hidden = true;
      if (job.state === 'running') timer = setTimeout(poll, 800);
      else { if (['push','pull','fetch','restore'].includes(job.kind) && job.state === 'succeeded') await staging.reload(true); if (['pull','restore'].includes(job.kind) && job.state === 'succeeded') await refresh(); finishJobActivity(); setBusy(false); }
    } catch (error) {
      // A failed status request does not mean the server-side upload stopped.
      status(`진행 상태를 확인하지 못했습니다. 작업은 서버에서 계속될 수 있습니다. ${error.message}`, true);
      jobActivity?.update({label:'진행 상태 확인이 필요합니다',detail:'서버 작업이 계속될 수 있습니다. 진행 상태 다시 확인으로 연결하세요.',uncertain:true});
      $('sync-reconnect').hidden = false;
    }
  }
  async function start(kind, restoreRequest) {
    const remoteOnly = kind === 'pull-remote';
    if(remoteOnly)kind='pull';
    if (busy || !configured) return;
    const request = selection(), id = planId;
    if (kind === 'push' && (!id || !previewJobId || preparedKey !== key() || !credentialsReady)) return;
    invalidatePreview();
    if (kind === 'preview') preparedKey = key();
    beginJobActivity(kind,remoteOnly?'sync-pull-remote':undefined);
    setBusy(true);
    status(kind === 'restore' ? '선택한 문서를 복구합니다…' : kind === 'preview' ? '동기화 대상을 확인하고 있습니다…' : kind === 'fetch' ? '원격 변경 확인을 시작합니다…' : kind === 'pull' ? 'Confluence에서 가져오기를 시작합니다…' : '업로드를 시작합니다…', false, null);
    try {
      const { job } = await api('/api/sync/' + kind, kind === 'restore' ? restoreRequest : kind === 'preview' ? request : kind === 'pull' ? {...envSettings.request(),remoteOnly:true,format:pullFormat()} : kind === 'fetch' ? envSettings.request() : { planId: id });
      if (kind === 'preview') previewJobId = job.id;
      renderConfig(job.config); renderJob(job);
      if (kind === 'fetch') $('sync-stage-heading').scrollIntoView({ block: 'start' });
      await poll();
    } catch (error) {
      status(error.message, true);
      // Recover the actual job state before allowing another mutation after a lost response.
      try {
        const { job } = await api('/api/sync/job');
        if (job?.state === 'running') { await poll(); return; }
        finishJobActivity();setBusy(false);
      } catch { jobActivity?.update({label:'진행 상태 확인이 필요합니다',detail:'요청 결과를 확인하지 못했습니다. 작업이 계속될 수 있으니 진행 상태를 다시 확인하세요.',uncertain:true});$('sync-reconnect').hidden = false; }
    }
  }
  $('sync-add-reference').onclick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api('/api/pick-folder', { kind: 'reference', start: context().base });
      if (result.path) {
        const paths = selection().referenceRoots;
        $('sync-references').value = [...new Set([...paths, result.path])].join('\n');
        $('sync-references').dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  };
  const comparison = createSyncDiff({api,selection,monaco,notify});
  const restoration = createRestore({api,selection:()=>({...selection(),format:pullFormat()}),setBusy,isBusy:()=>busy,status,start});
  const staging = createStaging({restore:restoration.open,canRestore:()=>configured&&credentialsReady,scopeKey:() => remotePath, compare:comparison.open,api, selection, changed:invalidatePreview, busy:setBusy, status, update:() => update(busy)});
  const envSettings = createEnvSettings({ api, context, setBusy, changed: () => { invalidatePreview(); update(busy); }, renderConfig: config => { invalidatePreview(); renderConfig(config); }, status });
  $('sync-connect').onclick = async () => {
    if (busy || configured || !credentialsReady) return;
    const identity = configKey(); invalidatePreview(); setBusy(true);
    try {
      const config = await api('/api/sync/connect', envSettings.request());
      if (identity !== configKey()) return;
      renderConfig(config); status('기준 폴더를 스페이스에 연결했습니다. Fetch로 받을 문서를 확인한 뒤 가져오세요.', false, 'success');
    } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  };
  $('sync-pull-format').onchange=()=>update(busy);
  $('sync-fetch').onclick = () => start('fetch');
  if($('sync-pull-remote'))$('sync-pull-remote').onclick=()=>start('pull-remote');
  $('sync-preview').onclick = () => start('preview');
  $('sync-push').onclick = () => start('push');
  $('sync-reconnect').onclick = poll;
  $('sync-log-download').onclick=()=>{
    if(!currentJob?.log?.trim())return;
    try{downloadText(jobLogFilename(currentJob),formatJobLog(currentJob));notify('로그 다운로드를 시작했습니다.','success');}
    catch(error){status('로그 다운로드를 시작하지 못했습니다. '+error.message,true);}
  };
  $('sync-load').onclick = async () => {
    if (busy) return;
    invalidatePreview(); setBusy(true);
    const identity = configKey();
    try { const config = await api('/api/sync/config', envSettings.request()); if (identity === configKey()) { renderConfig(config); status($('sync-config-status').textContent, false, config.missing.length || !config.connected ? 'warning' : 'success'); } }
    catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  };
  for (const id of ['sync-verify', 'sync-references']) $(id).addEventListener('input', () => update(busy));
  return {
    waitForLocalCheck:()=>staging.idle(),
    watch: () => staging.startWatching(async () => {
      if(busy || document.hidden || $('sync-view').hidden || !context().base)return false;
      if(!configured || loadedKey !== configKey()) {
        try {const identity=configKey();const config=await api('/api/sync/config',envSettings.request(),undefined,{quiet:true});if(identity!==configKey()||busy)return false;renderConfig(config);update(busy);}catch{return false;}
      }
      return configured;
    }),
    update,
    resume: async () => {
      try {
        const { job } = await api('/api/sync/job');
        if (!job) return;
        renderJob(job);
        if (job.state === 'running') { await showSync(); setBusy(true); await poll(); }
      } catch (error) { status('작업 상태를 불러오지 못했습니다. ' + error.message, true); }
    },
  };
}
