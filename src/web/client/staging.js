/** Persistent upload selection; saved display rows never grant upload approval. */
export function createStaging({api, selection, changed, busy, status, update, compare, restore = () => {}, canRestore = () => false, scopeKey = () => ''}) {
  const $ = id => document.getElementById(id);
  const storageKey = 'csync.staging.views.v1';
  const states = new Set(['same','new','changed','moved','unavailable']);
  let rows = [], loaded = '', activeView = '', scannedAt = null, hasSnapshot = false, lastRevision = '', watchTimer, stopped = true, pendingRequest = null;
  const identity = () => { const {verify, ...value} = selection(); return JSON.stringify([value, scopeKey()]); };
  // Session credential handles and tokens are never persisted. Views are advisory only.
  const viewKey = () => JSON.stringify([selection().base, selection().referenceRoots]);
  const includable = () => rows.filter(row => !row.unmapped && row.remoteState!=='new' && row.status !== 'unavailable' && (row.staged ? row.stale : row.status !== 'same')).map(row => row.path);
  const included = () => rows.filter(row => row.staged).map(row => row.path);
  const fresh = () => !!loaded && loaded === identity();
  function cache() {
    try { const saved = JSON.parse(localStorage.getItem(storageKey)); return Array.isArray(saved) ? saved : []; } catch { return []; }
  }
  function persist() {
    try {
      const views = cache().filter(view => view?.key !== activeView);
      views.push({key:activeView, scannedAt, rows:rows.map(({path,status,staged,stale,pageId,unmapped,recoverable,remoteState,remoteVersion,baselineVersion}) => ({path,status,staged,stale,pageId,unmapped,recoverable,remoteState,remoteVersion,baselineVersion}))});
      localStorage.setItem(storageKey,JSON.stringify(views.slice(-5)));
    } catch { /* Storage restrictions must not interrupt selection or upload. */ }
  }
  function note() {
    const stale = hasSnapshot && !fresh();
    $('sync-stage-note').classList.toggle('stale',stale);
    if (stale) {
      const time = new Date(scannedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
      $('sync-stage-note').textContent = `이전 조회 결과입니다 (${time}). 파일이나 업로드 선택이 바뀌었을 수 있습니다. 로컬 변경을 자동으로 다시 확인한 뒤 업로드할 문서를 체크하고 미리보기를 진행하세요.`;
    } else $('sync-stage-note').textContent = !hasSnapshot ? '로컬 변경을 자동으로 확인합니다. 원격 상태는 Fetch를 눌러 확인하세요.'
      : !rows.some(row => row.status !== 'same' || row.staged || row.remoteState && row.remoteState !== 'unchanged') ? '로컬에 변경된 문서가 없습니다. 원격 신규·변경은 Fetch로 확인하세요.'
      : rows.some(row=>row.unmapped) ? '받기 미완료 문서가 있습니다. Fetch 후 다시 가져오면 원격과 일치하는 문서만 연결하며 로컬 수정은 보존합니다.'
      : rows.some(row => row.staged && row.stale) ? '수정되거나 범위를 벗어난 대상이 있습니다. 최신 내용 반영을 누르거나 체크를 해제해 업로드에서 제외하세요.'
      : rows.some(row=>row.remoteState==='new'||row.status==='same'&&row.remoteState==='changed') ? '원격 신규·변경 문서는 위의 가져오기로 받으세요. 업로드 체크는 로컬 문서를 보낼 때만 사용합니다.'
      : '체크하면 업로드에 바로 포함됩니다. 체크를 해제하면 제외되며 원본 파일은 유지됩니다. 선택 후 업로드 미리보기를 진행하세요.';
  }
  function draw() {
    $('sync-stage-list').replaceChildren();
    const group = row => row.unmapped&&row.remoteState!=='new'?'attention':row.remoteState==='new'?(row.recoverable||row.status==='unavailable'?'receive':'conflict'):row.status==='same'&&row.remoteState==='changed'?'receive':row.remoteState==='changed'&&['changed','moved','new'].includes(row.status)?'conflict':'send';
    const order={receive:0,conflict:1,attention:2,send:3};
    let previousGroup;
    for (const row of rows.filter(row => row.status !== 'same' || row.staged || row.remoteState && row.remoteState !== 'unchanged').sort((a,b)=>order[group(a)]-order[group(b)])) {
      const currentGroup=group(row);
      if(previousGroup!==currentGroup){const heading=document.createElement('h3');heading.className='stage-group-heading';heading.textContent={receive:'↓ 받을 문서 · 원격 신규·변경',conflict:'! 양쪽 변경 · 비교 필요',attention:'! 연결 확인 필요',send:'↑ 보낼 변경 · 로컬 작업'}[currentGroup];$('sync-stage-list').append(heading);previousGroup=currentGroup;}
      const rowElement = document.createElement('div'), label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span'), tag = document.createElement('small');
      input.type = 'checkbox'; input.value = row.path; input.checked = row.staged;
      input.setAttribute('aria-label', row.path + ' 업로드에 포함');
      text.textContent = row.path;
      const changeLabel = {new:'로컬 신규',changed:'로컬 수정',moved:'로컬 이동',same:'변경 없음',unavailable:'파일 확인'}[row.status];
      const icon = document.createElement('span'), statusText = document.createElement('span');
      const both = row.remoteState==='new'&&!row.unmapped&&row.status!=='unavailable'||row.remoteState === 'changed' && ['changed','moved','new'].includes(row.status);
      const attention = row.unmapped || row.stale || both || ['unknown','unavailable'].includes(row.remoteState);
      const kind = row.remoteState==='new'&&!both ? 'incoming' : attention ? 'attention' : row.staged ? 'included' : row.remoteState === 'changed' ? 'moved' : row.status;
      const paths = {
        incoming:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
        included:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
        new:'<path d="M12 5v14M5 12h14"/>',
        changed:'<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
        moved:'<path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4"/>',
        same:'<path d="m5 12 4 4L19 6"/>',
        attention:'<path d="m12 3 10 18H2L12 3ZM12 9v5m0 3v.1"/>',
      };
      icon.className = 'stage-state-icon'; icon.setAttribute('aria-hidden','true');
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (paths[kind] || paths.attention) + '</svg>';
      statusText.textContent = row.unmapped?'받기 미완료 · 원격 대조 필요':row.remoteState==='new' ? (both?'원격 신규 · 로컬 경로 확인':'원격 신규') : both ? (row.stale ? '양쪽 수정 · 최신 내용 확인 필요' : '양쪽 수정 · 충돌 주의') : row.stale ? '최신 내용 확인 필요' : row.remoteState === 'changed' ? (row.remoteReasons?.some(reason => reason.includes('부모 위치 변경')) ? '원격 위치 변경' : '원격 수정') : row.remoteState === 'unavailable' ? '원격 조회 불가' : row.remoteState === 'unknown' ? '원격 확인 필요' : changeLabel + (row.staged ? ' · 업로드 포함' : '');
      input.remoteOnly = row.unmapped&&!row.staged || row.remoteState==='new'&&!row.staged || (row.status === 'same' && row.remoteState === 'changed' && !row.staged);
      if(input.remoteOnly)input.title=row.remoteState==='new'?'아직 받지 않은 원격 문서입니다. Pull로 가져오세요.':'원격에서만 변경되었습니다. diff를 확인하고 Pull로 가져오세요.';
      tag.append(icon,statusText);
      rowElement.className = 'sync-stage-row' + (attention ? ' needs-attention' : row.staged ? ' is-included' : group(row)==='receive'?' is-incoming':''); label.className = 'sync-stage-choice'; tag.className = 'stage-status stage-status-' + kind;
      input.onchange = () => request(input.checked ? 'add' : 'remove', [row.path]); label.append(input, text); rowElement.append(label, tag);
      if (!row.unmapped && row.staged && row.stale && row.status !== 'unavailable') { const renew = document.createElement('button'); renew.type = 'button'; renew.textContent = '↻ 최신 내용 반영'; renew.setAttribute('aria-label', row.path + ' 최신 내용 반영'); renew.onclick = () => request('add', [row.path]); rowElement.append(renew); }
      if (!row.unmapped && row.status !== 'unavailable' && row.remoteState!=='new') { const diff = document.createElement('button'); diff.type = 'button'; diff.textContent = '↔ diff 보기'; diff.setAttribute('aria-label', row.path + ' 변경 비교'); diff.onclick = () => compare(row.path); rowElement.append(diff); }
      if (row.remoteState!=='new' && row.pageId && row.status !== 'new' && row.status !== 'moved') { const button=document.createElement('button'); button.type='button'; button.className='stage-restore'; button.isRestore=true; const glyph=document.createElement('span'),caption=document.createElement('span'); glyph.className='stage-action-icon'; glyph.setAttribute('aria-hidden','true'); glyph.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="'+(row.status==='unavailable'?'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4':'M3 11a9 9 0 1 1 2.64 6.36M3 3v8h8')+'"/></svg>'; caption.textContent=row.status==='unavailable'?'원격에서 복구':'원격으로 원복'; button.append(glyph,caption); button.setAttribute('aria-label',row.path+' 원격 최신으로 복구'); button.onclick=()=>{if(fresh()&&canRestore())restore(row.path,row.status!=='unavailable');}; rowElement.append(button); }
      $('sync-stage-list').append(rowElement);
    }
    note();
  }
  function restoreView() {
    const next = viewKey();
    if (activeView === next) return;
    activeView = next; loaded = ''; rows = []; scannedAt = null; hasSnapshot = false; lastRevision = '';
    const saved = cache().find(view => view?.key === next);
    if (saved && Number.isFinite(Date.parse(saved.scannedAt)) && Array.isArray(saved.rows)
      && saved.rows.every(row => row && typeof row.path === 'string' && states.has(row.status) && typeof row.staged === 'boolean' && typeof row.stale === 'boolean')) {
      rows = saved.rows; scannedAt = saved.scannedAt; hasSnapshot = true;
    }
    draw();
  }
  function controls(disabled) {
    restoreView();
    if (loaded && loaded !== identity()) { loaded = ''; note(); }
    $('sync-stage-scan').disabled = disabled || !selection().base;
    $('sync-stage-add').disabled = disabled || !fresh() || !includable().length;
    $('sync-stage-remove').disabled = disabled || !fresh() || !included().length;
    $('sync-stage-count').textContent = `${hasSnapshot && !fresh() ? '이전 조회 · ' : ''}${rows.filter(row => row.staged).length}개 업로드 예정`;
    for (const input of $('sync-stage-list').querySelectorAll('input')) input.disabled = disabled || !fresh() || input.remoteOnly;
    for (const button of $('sync-stage-list').querySelectorAll('button')) button.disabled = disabled || (button.isRestore && (!fresh() || !canRestore()));
  }
  async function performRequest(action, paths, quiet = false) {
    if (action && (!fresh() || !paths?.length)) return;
    const requestIdentity = identity(), requestSelection = selection();
    let displayChanged = false;
    if(!quiet) busy(true);
    if (!quiet) $('sync-stage-note').textContent = action === 'remove' ? '업로드 대상에서 제외하고 있습니다…' : action === 'add' ? '선택한 문서를 확인해 업로드에 포함하고 있습니다…' : '로컬 문서의 변경을 검사하고 있습니다…';
    try {
      const result = await api('/api/sync/staging', {...requestSelection, ...(action ? {action, paths} : {})}, undefined, {background:quiet});
      if (requestIdentity !== identity()) return;
      if (!Array.isArray(result.rows)) throw new Error('변경 목록 응답을 확인할 수 없습니다. 다시 불러오세요.');
      const remoteNote = $('sync-stage-remote-note');
      if(remoteNote)remoteNote.textContent = result.remoteCheckedAt ? `원격 확인: ${new Date(result.remoteCheckedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}${result.remoteExpired?' · 이전 조회 결과입니다. Fetch로 갱신하세요.':''}` : '원격 상태 미확인 · Fetch를 누르면 버전과 위치를 묶어서 조회합니다.';
      if (quiet && fresh() && result.revision && result.revision === lastRevision) return;
      lastRevision = result.revision || '';
      displayChanged = true;
      changed(); rows = result.rows; loaded = requestIdentity; hasSnapshot = true;
      if (!action || !scannedAt) scannedAt = new Date().toISOString();
      persist(); draw();
      $('sync-stage-scan').hidden = true;
      if (action) status(action === 'add' ? '업로드에 포함했습니다. 미리보기 후 업로드할 수 있습니다.' : '업로드에서 제외했습니다. 원본 파일은 유지됩니다.', false, 'success');
    } catch (error) {
      if (requestIdentity !== identity()) return;
      displayChanged = true;
      changed(); loaded = ''; draw(); if(!quiet) status(error.message, true); else { $('sync-stage-note').textContent = '로컬 자동 확인 실패: ' + error.message + ' 이전 목록은 유지됩니다.'; $('sync-stage-scan').hidden = false; }
    } finally { if(!quiet) {busy(false);update();} else if(displayChanged) update(); }
  }
  async function request(action, paths, quiet = false) {
    if(quiet && pendingRequest)return;
    const scheduledIdentity=identity();
    const next=(pendingRequest??Promise.resolve()).catch(()=>{}).then(()=>scheduledIdentity===identity()?performRequest(action,paths,quiet):undefined);
    pendingRequest=next;
    try {await next;}finally{if(pendingRequest===next)pendingRequest=null;}
  }
  $('sync-stage-scan').onclick = () => request();
  $('sync-stage-add').onclick = () => request('add', includable());
  $('sync-stage-remove').onclick = () => request('remove', included());
  function startWatching(canCheck) {
    stopped = false;
    const tick = async () => {
      try { if(!stopped && await canCheck()) await request(undefined,undefined,true); }
      finally { if(!stopped) watchTimer=setTimeout(tick,5000); }
    };
    clearTimeout(watchTimer); watchTimer=setTimeout(tick,100);
    return () => {stopped=true;clearTimeout(watchTimer);};
  }
  return {idle:()=>pendingRequest??Promise.resolve(),remoteOnlyCount:()=>fresh()?rows.filter(row=>row.status==='same'&&row.remoteState==='changed'||(row.recoverable||row.status==='unavailable')&&row.remoteState==='new').length:0,startWatching,update:controls, ready:() => fresh() && rows.some(row => row.staged) && !rows.some(row => row.staged && (row.stale||row.unmapped)), reload:(quiet=false) => request(undefined,undefined,quiet)};
}
