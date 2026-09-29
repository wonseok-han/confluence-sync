export function initSync({ api, context, setBusy, showSync }) {
  const $ = id => document.getElementById(id);
  let busy = false, planId = null, preparedKey = '', loadedKey = '', timer;
  const status = (text, error = false) => { $('sync-status').textContent = text; $('sync-status').classList.toggle('error', error); };
  function selection() {
    const ctx = context(), scope = $('sync-scope').value;
    return { base: ctx.base || '', target: scope === 'all' ? '' : scope === 'folder' ? ctx.folder || '' : ctx.file || '', envFile: $('sync-env').value.trim(), verify: $('sync-verify').checked };
  }
  const key = () => JSON.stringify(selection());
  const configKey = () => JSON.stringify([context().base, $('sync-env').value.trim()]);
  const hasTarget = () => !!context().base && ($('sync-scope').value !== 'file' || !!context().file);
  function update(isBusy, transient = false) {
    busy = isBusy;
    if (!transient && preparedKey && preparedKey !== key()) { planId = null; preparedKey = ''; status('대상이나 옵션이 바뀌었습니다. 다시 미리보기해 주세요.'); }
    if (!transient && loadedKey && loadedKey !== configKey()) {
      loadedKey = ''; $('sync-config').replaceChildren(); $('sync-config-status').textContent = '설정 확인 또는 미리보기를 실행하면 업로드 위치를 불러옵니다.';
    }
    for (const id of ['sync-scope', 'sync-env', 'sync-load', 'sync-verify']) $(id).disabled = busy;
    $('sync-load').disabled = busy || !context().base;
    $('sync-preview').disabled = busy || !hasTarget();
    $('sync-push').disabled = busy || !planId;
    const request = selection();
    $('sync-target').textContent = hasTarget() ? `대상 · ${request.target || request.base}` : '왼쪽에서 문서를 선택하세요.';
  }
  function renderConfig(config) {
    loadedKey = configKey(); $('sync-config').replaceChildren();
    for (const [name, value] of [['설정 출처', config.source], ['서버', config.baseUrl || '미설정'], ['계정', config.email || '미설정'], ['스페이스', config.spaceKey || '미설정'], ['상위 페이지 / 폴더', config.parentId || '스페이스 최상위'], ['API 토큰', config.hasToken ? '설정됨' : '미설정']]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; $('sync-config').append(dt, dd);
    }
    $('sync-config-status').textContent = config.missing.length ? `설정 필요: ${config.missing.join(', ')}. 미리보기는 인증 없이 사용할 수 있습니다.` : '접속 설정을 불러왔습니다. 실제 연결·권한 확인은 동기화 시 수행합니다.';
  }
  function renderJob(job) {
    $('sync-job-summary').hidden = false;
    $('sync-job-summary').textContent = `${job.kind === 'preview' ? '미리보기' : '동기화'} · ${job.selection.target || job.selection.base} → ${job.config.spaceKey || '스페이스 미설정'} (${job.config.baseUrl || '서버 미설정'})`;
    $('sync-log-empty').hidden = true; $('sync-log').hidden = false;
    const log = $('sync-log'), following = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = job.log || '작업을 준비하는 중입니다…';
    if (following) log.scrollTop = log.scrollHeight;
    $('sync-job-state').textContent = { running: '진행 중', succeeded: '완료', failed: '실패' }[job.state];
    if (job.state === 'running') status(job.kind === 'preview' ? '로컬 문서와 매핑을 비교하고 있습니다…' : 'Confluence에 동기화하고 있습니다. 진행 내역을 확인하세요.');
    else if (job.state === 'failed') status('작업이 실패했거나 일부 문서가 처리되지 않았습니다. 내역을 확인한 뒤 다시 미리보기해 주세요.', true);
    else if (job.kind === 'preview') {
      if (preparedKey === key() && !job.config.missing.length) planId = job.planId;
      status(job.config.missing.length ? '미리보기 완료. 접속 설정을 채운 뒤 다시 미리보기해 주세요.' : planId ? '미리보기 완료. 대상과 업로드 위치를 확인하고 Confluence에 동기화를 누르세요.' : '미리보기 내역을 불러왔습니다. 현재 선택으로 다시 미리보기해 주세요.');
    } else status('동기화가 완료되었습니다. 다른 대상을 선택해 계속 작업할 수 있습니다.');
  }
  async function poll() {
    clearTimeout(timer);
    try {
      const { job } = await api('/api/sync/job');
      if (!job) { setBusy(false); return; }
      renderJob(job); $('sync-reconnect').hidden = true;
      if (job.state === 'running') timer = setTimeout(poll, 800);
      else { setBusy(false); }
    } catch (error) {
      // A failed status request does not mean the server-side upload stopped.
      status(`진행 상태를 확인하지 못했습니다. 동기화는 서버에서 계속될 수 있습니다. ${error.message}`, true);
      $('sync-reconnect').hidden = false;
    }
  }
  async function start(kind) {
    if (busy) return;
    const request = selection(), id = planId;
    if (kind === 'push' && !id) return;
    preparedKey = key(); planId = null; setBusy(true);
    status(kind === 'preview' ? '동기화 대상을 확인하고 있습니다…' : '동기화를 시작합니다…');
    try {
      const { job } = await api('/api/sync/' + kind, kind === 'preview' ? request : { planId: id });
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
  $('sync-preview').onclick = () => start('preview');
  $('sync-push').onclick = () => start('push');
  $('sync-reconnect').onclick = poll;
  $('sync-load').onclick = async () => {
    if (busy) return;
    setBusy(true);
    try { renderConfig(await api('/api/sync/config', { base: context().base, envFile: $('sync-env').value.trim() })); }
    catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  };
  for (const id of ['sync-env', 'sync-scope', 'sync-verify']) $(id).addEventListener('input', () => update(busy));
  return {
    update,
    resume: async () => {
      try {
        const { job } = await api('/api/sync/job');
        if (!job) return;
        renderJob(job);
        if (job.state === 'running') { await showSync(); setBusy(true); await poll(); }
      } catch (error) { status('동기화 상태를 불러오지 못했습니다. ' + error.message, true); }
    },
  };
}
