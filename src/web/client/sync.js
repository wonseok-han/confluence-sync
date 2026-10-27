import { createEnvSettings } from './env-settings.js';
import { createScopeSelection } from './scope-selection.js';
import { renderSyncLog } from './sync-log.js';

export function initSync({ api, context, setBusy, showSync, refresh = async () => {}, notify = () => {} }) {
  const $ = id => document.getElementById(id);
  let busy = false, planId = null, previewJobId = null, preparedKey = '', loadedKey = '', timer, configured = false, credentialsReady = false, direction = 'push', remotePath = '';
  const announcedJobs = new Set();
  const status = (text, error = false, kind = error ? 'error' : 'info') => { $('sync-status').textContent = text; $('sync-status').classList.toggle('error', error); if (kind) notify(text, kind); };
  function selection() {
    const ctx = context();
    return { base: ctx.base || '', target: '', envId: envSettings.request().envId, verify: $('sync-verify').checked, referenceRoots: $('sync-references').value.split(/\r?\n/).map(path => path.trim()).filter(Boolean) };
  }
  const key = () => JSON.stringify([direction, selection()]);
  const configKey = () => JSON.stringify([context().base, envSettings.identity()]);
  const hasTarget = () => !!context().base;
  function invalidatePreview() { planId = null; previewJobId = null; preparedKey = ''; }
  function update(isBusy, transient = false) {
    busy = isBusy;
    if (!transient && preparedKey && preparedKey !== key()) { invalidatePreview(); status('대상이나 옵션이 바뀌었습니다. 다시 미리보기해 주세요.'); }
    if (!transient && loadedKey && loadedKey !== configKey()) {
      loadedKey = ''; configured = false; credentialsReady = false; remotePath = ''; $('sync-config').replaceChildren(); $('sync-config-status').textContent = '설정 확인 또는 .env 가져오기로 연결 정보를 불러오세요.';
    }
    envSettings.update(busy);
    scopeSelection.update(busy);
    for (const id of ['sync-direction-push', 'sync-direction-pull', 'sync-load', 'sync-verify', 'sync-references', 'sync-add-reference']) $(id).disabled = busy;
    for (const value of ['push', 'pull']) $('sync-direction-' + value).setAttribute('aria-pressed', String(direction === value));
    $('sync-push-options').hidden = direction === 'pull';
    $('sync-preview').hidden = direction === 'pull'; $('sync-push').hidden = direction === 'pull';
    $('sync-pull').hidden = direction !== 'pull'; $('sync-pull-note').hidden = direction !== 'pull';
    $('sync-fetch').disabled = busy || !context().base || !configured || !credentialsReady;
    $('sync-pull').disabled = busy || !context().base || !configured || !credentialsReady;
    $('sync-log-empty').textContent = direction === 'pull' ? '가져오기를 실행하면 다운로드 내역을 표시합니다.' : '업로드 미리보기를 실행하면 문서별 신규·변경·이동 계획을 확인할 수 있습니다.';
    $('sync-direction-label').textContent = direction === 'pull' ? 'Confluence → 로컬' : '로컬 → Confluence';
    $('sync-direction-note').textContent = direction === 'pull' ? 'Confluence → 로컬. 저장된 작업 스코프에 해당하는 문서를 기준 폴더의 원래 위치로 가져옵니다.' : '스페이스 루트 연결은 유지하고, 저장된 작업 스코프 안의 문서만 업로드합니다.';
    $('sync-pull-note').textContent = `작업 스코프 ${remotePath || '미설정'} → ${context().base || '01의 기준 폴더'}. 로컬 변경·이동 대기가 있으면 중단합니다. 자동 병합하지 않습니다.`;
    $('sync-load').disabled = busy || !context().base;
    $('sync-preview').disabled = busy || !hasTarget() || !configured;
    $('sync-push').disabled = busy || direction !== 'push' || !configured || !credentialsReady || !planId || !previewJobId || preparedKey !== key();
    $('sync-push').title = planId ? '미리보기한 범위를 업로드합니다.' : '현재 스코프와 설정으로 업로드 미리보기를 먼저 완료하세요.';
    const request = selection();
    $('sync-target').textContent = hasTarget() ? `업로드 작업 스코프 ${remotePath || '미설정'} · ${request.base} → Confluence` : '01에서 기준 폴더를 선택하세요.';
  }
  function renderConfig(config) {
    scopeSelection.saved(config.scope);
    loadedKey = configKey(); configured = !!config.scope; credentialsReady = !config.missing.length; remotePath = config.scope?.path || ''; $('sync-config').replaceChildren();
    for (const [name, value] of [['설정 출처', config.source], ['서버', config.baseUrl || '미설정'], ['계정', config.email || '미설정'], ['스페이스', config.spaceKey || '미설정'], ['작업 스코프', config.scope ? `${config.scope.path} (${config.scope.type === 'file' ? '파일 하나' : '폴더와 하위 문서'})` : '미설정 — 직접 선택 필요'], ['API 토큰', config.hasToken ? '설정됨' : '미설정']]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; $('sync-config').append(dt, dd);
    }
    $('sync-config-status').textContent = config.missing.length ? `설정 필요: ${config.missing.join(', ')}. 미리보기는 인증 없이 사용할 수 있습니다.` : configured ? '접속 설정과 저장된 스코프를 불러왔습니다.' : '로컬 파일·폴더 범위를 직접 선택하고 저장하세요.';
  }
  function renderJob(job) {
    $('sync-job-summary').hidden = false;
    $('sync-job-summary').textContent = `${job.kind === 'preview' ? '업로드 미리보기' : job.kind === 'fetch' ? '원격 변경 확인' : job.kind === 'pull' ? '가져오기' : '업로드'} · ${job.kind === 'pull' || job.kind === 'fetch' ? `${job.config.spaceKey || '스페이스 미설정'} → ${job.selection.base}` : `${job.selection.target || job.selection.base} → ${job.config.spaceKey || '스페이스 미설정'}`} (${job.config.baseUrl || '서버 미설정'})`;
    $('sync-log-empty').hidden = true; $('sync-log').hidden = false;
    const log = $('sync-log'), following = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    renderSyncLog(log, job.log || '작업을 준비하는 중입니다…');
    if (following) log.scrollTop = log.scrollHeight;
    $('sync-job-state').textContent = job.state === 'succeeded' && job.warningCount ? '완료 (경고)' : { running: '진행 중', succeeded: '완료', failed: '실패' }[job.state];
    const announce = !announcedJobs.has(job.id);
    if (job.state !== 'running') announcedJobs.add(job.id);
    if (job.state === 'running') status(job.kind === 'preview' ? '로컬 문서와 매핑을 비교하고 있습니다…' : job.kind === 'fetch' ? '원격 페이지 메타데이터를 확인하고 있습니다…' : job.kind === 'pull' ? 'Confluence에서 문서를 가져오고 있습니다…' : 'Confluence에 업로드하고 있습니다. 진행 내역을 확인하세요.', false, null);
    else if (job.state === 'failed') status(job.kind === 'fetch' ? '원격 변경 확인에 실패했습니다. 실행 내역을 확인하세요. 이전 캐시는 유지됩니다.' : job.kind === 'pull' ? '가져오기에 실패했습니다. 로컬 변경이나 오류 내역을 확인한 뒤 다시 시도하세요.' : '업로드가 실패했거나 일부 문서가 처리되지 않았습니다. 내역을 확인한 뒤 다시 미리보기해 주세요.', true, announce ? 'error' : null);
    else if (job.kind === 'preview') {
      if (job.id === previewJobId && preparedKey === key() && !job.config.missing.length && job.config.scope) planId = job.planId;
      status(job.config.missing.length ? '미리보기 완료. 접속 설정을 채운 뒤 다시 미리보기해 주세요.' : planId ? '미리보기 완료. 대상과 업로드 위치를 확인하고 Confluence에 업로드를 누르세요.' : '미리보기 내역을 불러왔습니다. 현재 선택으로 다시 미리보기해 주세요.', false, announce ? (job.config.missing.length ? 'warning' : 'success') : null);
    } else if (job.kind === 'fetch') status('원격 변경 확인을 완료했습니다. 조회 시각·변경 내역은 03 실행 내역에서 확인하세요. 문서와 동기화 기준은 유지됩니다.', false, announce ? 'success' : null);
    else if (job.warningCount) status(`가져오기를 완료했습니다. 첨부 ${job.warningCount}개를 저장하지 못해 원격 참조를 유지했습니다. 실행 내역을 확인하세요.`, false, announce ? 'warning' : null);
    else status(job.kind === 'pull' ? '가져오기가 완료되었습니다. 기준 폴더에서 문서를 확인하세요.' : '업로드가 완료되었습니다. 다른 대상을 선택해 계속 작업할 수 있습니다.', false, announce ? 'success' : null);
  }
  async function poll() {
    clearTimeout(timer);
    try {
      const { job } = await api('/api/sync/job');
      if (!job) { setBusy(false); return; }
      renderJob(job); $('sync-reconnect').hidden = true;
      if (job.state === 'running') timer = setTimeout(poll, 800);
      else { if (job.kind === 'pull' && job.state === 'succeeded') await refresh(); setBusy(false); }
    } catch (error) {
      // A failed status request does not mean the server-side upload stopped.
      status(`진행 상태를 확인하지 못했습니다. 작업은 서버에서 계속될 수 있습니다. ${error.message}`, true);
      $('sync-reconnect').hidden = false;
    }
  }
  async function start(kind) {
    if (busy || !configured) return;
    const request = selection(), id = planId;
    if (kind === 'push' && (!id || !previewJobId || preparedKey !== key() || !credentialsReady)) return;
    invalidatePreview();
    if (kind === 'preview') preparedKey = key();
    setBusy(true);
    status(kind === 'preview' ? '동기화 대상을 확인하고 있습니다…' : kind === 'fetch' ? '원격 변경 확인을 시작합니다…' : kind === 'pull' ? 'Confluence에서 가져오기를 시작합니다…' : '업로드를 시작합니다…', false, null);
    try {
      const { job } = await api('/api/sync/' + kind, kind === 'preview' ? request : (kind === 'pull' || kind === 'fetch') ? envSettings.request() : { planId: id });
      if (kind === 'preview') previewJobId = job.id;
      renderConfig(job.config); renderJob(job);
      if (kind === 'fetch') $('sync-results').scrollIntoView({ block: 'start' });
      await poll();
    } catch (error) {
      status(error.message, true);
      // Recover the actual job state before allowing another mutation after a lost response.
      try {
        const { job } = await api('/api/sync/job');
        if (job?.state === 'running') { await poll(); return; }
        setBusy(false);
      } catch { $('sync-reconnect').hidden = false; }
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
  const envSettings = createEnvSettings({ api, context, setBusy, changed: () => { invalidatePreview(); update(busy); }, renderConfig: config => { invalidatePreview(); renderConfig(config); }, status });
  const scopeSelection = createScopeSelection({ api, context, configKey, setBusy, status,
    request: () => envSettings.request(),
    onSave: config => { invalidatePreview(); renderConfig(config); },
  });
  for (const value of ['push', 'pull']) $('sync-direction-' + value).onclick = () => { if (!busy) { direction = value; update(false); } };
  $('sync-fetch').onclick = () => start('fetch');
  $('sync-pull').onclick = () => start('pull');
  $('sync-preview').onclick = () => start('preview');
  $('sync-push').onclick = () => start('push');
  $('sync-reconnect').onclick = poll;
  $('sync-load').onclick = async () => {
    if (busy) return;
    invalidatePreview(); setBusy(true);
    const identity = configKey();
    try { const config = await api('/api/sync/config', envSettings.request()); if (identity === configKey()) { renderConfig(config); status($('sync-config-status').textContent, false, config.missing.length || !config.scope ? 'warning' : 'success'); } }
    catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  };
  for (const id of ['sync-verify', 'sync-references']) $(id).addEventListener('input', () => update(busy));
  return {
    update,
    resume: async () => {
      try {
        const { job } = await api('/api/sync/job');
        if (!job) return;
        renderJob(job);
        if (job.state === 'running') { direction = job.kind === 'pull' ? 'pull' : 'push'; await showSync(); setBusy(true); await poll(); }
      } catch (error) { status('작업 상태를 불러오지 못했습니다. ' + error.message, true); }
    },
  };
}
