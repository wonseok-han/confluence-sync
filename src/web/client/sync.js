import { createEnvSettings } from './env-settings.js';
import { createScopeTree } from './scope-tree.js';
import { renderSyncLog } from './sync-log.js';

export function initSync({ api, context, setBusy, showSync, refresh = async () => {} }) {
  const $ = id => document.getElementById(id);
  let busy = false, planId = null, preparedKey = '', loadedKey = '', timer, configured = false, credentialsReady = false, direction = 'push', remotePath = '';
  const status = (text, error = false) => { $('sync-status').textContent = text; $('sync-status').classList.toggle('error', error); };
  function selection() {
    const ctx = context();
    return { base: ctx.base || '', target: '', envId: envSettings.request().envId, verify: $('sync-verify').checked, referenceRoots: $('sync-references').value.split(/\r?\n/).map(path => path.trim()).filter(Boolean) };
  }
  const key = () => JSON.stringify([direction, selection()]);
  const configKey = () => JSON.stringify([context().base, envSettings.identity()]);
  const hasTarget = () => !!context().base;
  function update(isBusy, transient = false) {
    busy = isBusy;
    if (!transient && preparedKey && preparedKey !== key()) { planId = null; preparedKey = ''; status('대상이나 옵션이 바뀌었습니다. 다시 미리보기해 주세요.'); }
    if (!transient && loadedKey && loadedKey !== configKey()) {
      loadedKey = ''; configured = false; credentialsReady = false; remotePath = ''; $('sync-config').replaceChildren(); $('sync-config-status').textContent = '설정 확인 또는 .env 가져오기로 연결 정보를 불러오세요.';
    }
    envSettings.update(busy);
    scopeTree.update(busy);
    for (const id of ['sync-direction-push', 'sync-direction-pull', 'sync-load', 'sync-verify', 'sync-references', 'sync-add-reference']) $(id).disabled = busy;
    for (const value of ['push', 'pull']) $('sync-direction-' + value).setAttribute('aria-pressed', String(direction === value));
    $('sync-push-options').hidden = direction === 'pull';
    $('sync-preview').hidden = direction === 'pull'; $('sync-push').hidden = direction === 'pull';
    $('sync-pull').hidden = direction !== 'pull'; $('sync-pull-note').hidden = direction !== 'pull';
    $('sync-pull').disabled = busy || !context().base || !configured || !credentialsReady;
    $('sync-log-empty').textContent = direction === 'pull' ? '가져오기를 실행하면 다운로드 내역을 표시합니다.' : '업로드 미리보기를 실행하면 문서별 신규·변경·이동 계획을 확인할 수 있습니다.';
    $('sync-direction-label').textContent = direction === 'pull' ? 'Confluence → 로컬' : '로컬 → Confluence';
    $('sync-direction-note').textContent = direction === 'pull' ? 'Confluence → 로컬. 저장된 원격 스코프와 그 하위 문서를 기준 폴더로 가져옵니다.' : '01의 기준 폴더 전체 → 저장된 원격 스코프. 문서 선택은 미리보기·편집에만 사용합니다.';
    $('sync-pull-note').textContent = `${remotePath || '저장된 원격 스코프'} → ${context().base || '01의 기준 폴더'}. 로컬 변경·이동 대기가 있으면 중단합니다. 자동 병합하지 않습니다.`;
    $('sync-load').disabled = busy || !context().base;
    $('sync-preview').disabled = busy || !hasTarget() || !configured;
    $('sync-push').disabled = busy || !planId;
    const request = selection();
    $('sync-target').textContent = hasTarget() ? `업로드 기준 폴더 전체 · ${request.base} → ${remotePath || '원격 스코프 미설정'}` : '01에서 기준 폴더를 선택하세요.';
  }
  function renderConfig(config) {
    scopeTree.saved(config.scope);
    loadedKey = configKey(); configured = !!config.scope; credentialsReady = !config.missing.length; remotePath = config.scope?.path || ''; $('sync-config').replaceChildren();
    for (const [name, value] of [['설정 출처', config.source], ['서버', config.baseUrl || '미설정'], ['계정', config.email || '미설정'], ['스페이스', config.spaceKey || '미설정'], ['원격 스코프', config.scope ? `${config.scope.path} (#${config.scope.id})` : '미설정 — 직접 선택 필요'], ['API 토큰', config.hasToken ? '설정됨' : '미설정']]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; $('sync-config').append(dt, dd);
    }
    $('sync-config-status').textContent = config.missing.length ? `설정 필요: ${config.missing.join(', ')}. 미리보기는 인증 없이 사용할 수 있습니다.` : configured ? '접속 설정과 저장된 스코프를 불러왔습니다.' : '원격 스코프를 직접 선택하고 저장하세요.';
  }
  function renderJob(job) {
    $('sync-job-summary').hidden = false;
    $('sync-job-summary').textContent = `${job.kind === 'preview' ? '업로드 미리보기' : job.kind === 'pull' ? '가져오기' : '업로드'} · ${job.kind === 'pull' ? `${job.config.spaceKey || '스페이스 미설정'} → ${job.selection.base}` : `${job.selection.target || job.selection.base} → ${job.config.spaceKey || '스페이스 미설정'}`} (${job.config.baseUrl || '서버 미설정'})`;
    $('sync-log-empty').hidden = true; $('sync-log').hidden = false;
    const log = $('sync-log'), following = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    renderSyncLog(log, job.log || '작업을 준비하는 중입니다…');
    if (following) log.scrollTop = log.scrollHeight;
    $('sync-job-state').textContent = { running: '진행 중', succeeded: '완료', failed: '실패' }[job.state];
    if (job.state === 'running') status(job.kind === 'preview' ? '로컬 문서와 매핑을 비교하고 있습니다…' : job.kind === 'pull' ? 'Confluence에서 문서를 가져오고 있습니다…' : 'Confluence에 업로드하고 있습니다. 진행 내역을 확인하세요.');
    else if (job.state === 'failed') status(job.kind === 'pull' ? '가져오기에 실패했습니다. 로컬 변경이나 오류 내역을 확인한 뒤 다시 시도하세요.' : '업로드가 실패했거나 일부 문서가 처리되지 않았습니다. 내역을 확인한 뒤 다시 미리보기해 주세요.', true);
    else if (job.kind === 'preview') {
      if (preparedKey === key() && !job.config.missing.length) planId = job.planId;
      status(job.config.missing.length ? '미리보기 완료. 접속 설정을 채운 뒤 다시 미리보기해 주세요.' : planId ? '미리보기 완료. 대상과 업로드 위치를 확인하고 Confluence에 업로드를 누르세요.' : '미리보기 내역을 불러왔습니다. 현재 선택으로 다시 미리보기해 주세요.');
    } else status(job.kind === 'pull' ? '가져오기가 완료되었습니다. 기준 폴더에서 문서를 확인하세요.' : '업로드가 완료되었습니다. 다른 대상을 선택해 계속 작업할 수 있습니다.');
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
    if (kind === 'push' && !id) return;
    preparedKey = key(); planId = null; setBusy(true);
    status(kind === 'preview' ? '동기화 대상을 확인하고 있습니다…' : kind === 'pull' ? 'Confluence에서 가져오기를 시작합니다…' : '업로드를 시작합니다…');
    try {
      const { job } = await api('/api/sync/' + kind, kind === 'preview' ? request : kind === 'pull' ? envSettings.request() : { planId: id });
      renderConfig(job.config); renderJob(job);
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
  const envSettings = createEnvSettings({ api, context, setBusy, changed: () => update(busy), renderConfig, status });
  const scopeTree = createScopeTree({ api, context, configKey, setBusy, status,
    request: () => envSettings.request(),
    onSave: config => { planId = null; preparedKey = ''; if (config.scopeCheckRequired) $('sync-verify').checked = true; renderConfig(config); },
  });
  for (const value of ['push', 'pull']) $('sync-direction-' + value).onclick = () => { if (!busy) { direction = value; update(false); } };
  $('sync-pull').onclick = () => start('pull');
  $('sync-preview').onclick = () => start('preview');
  $('sync-push').onclick = () => start('push');
  $('sync-reconnect').onclick = poll;
  $('sync-load').onclick = async () => {
    if (busy) return;
    setBusy(true);
    const identity = configKey();
    try { const config = await api('/api/sync/config', envSettings.request()); if (identity === configKey()) renderConfig(config); }
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
