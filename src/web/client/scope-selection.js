/** Explicitly save the explorer selection as the local work scope. */
export function createScopeSelection({ api, context, configKey, request, setBusy, status, onSave }) {
  const $ = id => document.getElementById(id);
  let identity = configKey(), saved, busy = false;
  function candidate() {
    const {base, file} = context();
    if (!base || !file) return '';
    const root = base.replace(/\\/g, '/').replace(/\/+$/, '');
    const selected = file.replace(/\\/g, '/').replace(/\/+$/, '');
    if (selected === root) return '/';
    return selected.startsWith(root + '/') ? selected.slice(root.length + 1) : '';
  }
  function render() {
    const path = candidate();
    $('sync-scope-save').disabled = busy || !path;
    $('sync-scope-candidate').textContent = path ? `${path} (${context().directory ? '폴더와 하위 문서' : '파일 하나'})` : '아래 문서 탐색에서 파일·폴더를 선택하세요.';
    $('sync-scope-saved').textContent = saved ? `${saved.path === '.' ? '/' : saved.path} (${saved.type === 'file' ? '파일 하나' : '폴더와 하위 문서'})` : saved === undefined ? '.env 연결 설정에서 설정 확인을 눌러 불러오세요.' : '미설정 — 직접 선택하세요.';
  }
  $('sync-scope-save').onclick = async () => {
    const path = candidate();
    if (busy || !path) return;
    const key = configKey(); setBusy(true);
    status('로컬 작업 범위를 저장하고 있습니다…', false, null);
    try {
      const config = await api('/api/sync/scope', {...request(),scopePath:path});
      if (key !== configKey()) return;
      onSave(config); status('스코프를 저장했습니다. 선택한 파일·폴더만 Push·Pull하며 기존 매핑과 원격 위치는 유지합니다.',false,'success');
    } catch (error) { if (key === configKey()) status(error.message,true); }
    finally { setBusy(false); }
  };
  render();
  return { update(value) {
    busy = value;
    if (identity !== configKey()) { identity = configKey(); saved = undefined; }
    render();
  }, saved(scope) { saved = scope || null; render(); } };
}
