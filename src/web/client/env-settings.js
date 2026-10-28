/** Two explicit sources: workspace .env or an imported session configuration. */
export function createEnvSettings({ api, context, setBusy, changed, renderConfig, status }) {
  const $ = id => document.getElementById(id);
  let base = context().base, envId = '', filename = '', busy = false, approval = null;
  $('sync-env-toggle').onclick = () => {
    const expanded = $('sync-env-toggle').getAttribute('aria-expanded') !== 'true';
    $('sync-env-toggle').setAttribute('aria-expanded', String(expanded));
    $('sync-env-body').hidden = !expanded;
    $('sync-env-chevron').textContent = expanded ? '▾' : '▸';
    $('sync-env-toggle-label').textContent = expanded ? '접기' : '펼치기';
  };
  const imported = () => $('sync-env-import-mode').checked;
  const identity = () => `${imported() ? 'import' : 'base'}:${envId}`;
  const request = () => ({ base: context().base, envId: imported() ? envId || 'not-imported' : '' });
  function resetApproval() { approval = null; if ($('sync-env-confirm').open) $('sync-env-confirm').close(); }
  function update(value) {
    busy = value;
    if (base !== context().base) {
      base = context().base; envId = ''; filename = ''; $('sync-env-file').value = '';
      $('sync-env-base-mode').checked = true; $('sync-env-import-mode').checked = false; resetApproval();
    }
    for (const id of ['sync-env-base-mode', 'sync-env-import-mode']) $(id).disabled = busy;
    $('sync-env-import-controls').hidden = !imported();
    $('sync-env-file-name').textContent = filename || '선택한 파일 없음';
    $('sync-env-choose').disabled = busy || !base;
    $('sync-env-save').disabled = busy || !envId || !imported();
    $('sync-env-source-note').textContent = imported() ? '가져온 설정은 현재 웹 작업에만 적용됩니다. 새로고침하면 다시 가져와야 합니다.' : '01에서 선택한 기준 폴더의 .env만 읽습니다. 파일이 없으면 .env를 가져오세요.';
  }
  for (const id of ['sync-env-base-mode', 'sync-env-import-mode']) $(id).onchange = () => { resetApproval(); changed(); update(busy); };
  $('sync-env-choose').onclick = () => { if (!busy) $('sync-env-file').click(); };
  $('sync-env-file').onchange = async () => {
    const file = $('sync-env-file').files?.[0]; if (!file || busy) return;
    if (file.size > 12_000) { status('.env 파일은 12KB 이하 텍스트여야 합니다.', true); $('sync-env-file').value = ''; return; }
    const origin = context().base; setBusy(true); resetApproval();
    try {
      const text = await file.text();
      const result = await api('/api/sync/env/import', { base: origin, text, name: file.name });
      if (origin !== context().base) return;
      envId = result.envId; filename = file.name; changed(); renderConfig(result.config);
      status('.env를 가져왔습니다. 기준 폴더의 파일은 변경하지 않았습니다.', false, 'success');
    } catch (error) { status(error.message, true); }
    finally { $('sync-env-file').value = ''; setBusy(false); }
  };
  async function save(body) {
    setBusy(true);
    try {
      const result = await api('/api/sync/env/save', body);
      $('sync-env-base-mode').checked = true; $('sync-env-import-mode').checked = false;
      changed(); renderConfig(result.config); status('기준 폴더에 .env를 저장했습니다. CLI에서도 같은 설정을 사용할 수 있습니다.', false, 'success');
    } catch (error) { status(error.message, true); }
    finally { resetApproval(); setBusy(false); }
  }
  $('sync-env-save').onclick = async () => {
    if (busy || !envId || !imported()) return;
    const body = request(); setBusy(true);
    try {
      const result = await api('/api/sync/env/save', body);
      const approved = { ...body, expectedHash: result.expectedHash };
      if (result.needsConfirmation) {
        approval = approved; $('sync-env-confirm-path').textContent = result.path; $('sync-env-confirm').showModal();
      } else { await save(approved); }
    } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  };
  $('sync-env-confirm-save').onclick = () => { if (approval && !busy) return save(approval); };
  $('sync-env-confirm-cancel').onclick = resetApproval;
  $('sync-env-confirm').addEventListener('cancel', resetApproval);
  return { update, identity, request };
}
