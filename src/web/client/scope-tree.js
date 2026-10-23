/** Lazy remote hierarchy. Browsing never selects or saves a scope. */
export function createScopeTree({ api, context, configKey, request, setBusy, status, onSave }) {
  const $ = id => document.getElementById(id);
  let identity = configKey(), nodes = new Map(), root = null, candidate = null, savedScope = undefined, busy = false, controls = [], approval = null;
  function render() {
    const focused = controls.find(control => control.button === document.activeElement);
    controls = [];
    const walk = node => {
      const li = document.createElement('li'), row = document.createElement('div'); row.className = 'scope-tree-row';
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'scope-tree-toggle';
      const leaf = node.children?.length === 0;
      toggle.textContent = leaf ? '·' : node.expanded ? '▾' : '▸';
      toggle.setAttribute('aria-label', `${node.item.title || '/'} ${leaf ? '하위 항목 없음' : node.expanded ? '접기' : '펼치기'}`);
      if (!leaf) toggle.setAttribute('aria-expanded', String(!!node.expanded)); toggle.disabled = busy || leaf;
      toggle.onclick = () => expand(node); controls.push({ button: toggle, leaf, key: `${node.item.id}:toggle` });
      const select = document.createElement('button'); select.type = 'button'; select.className = 'scope-tree-select';
      select.setAttribute('aria-pressed', String(candidate?.id === node.item.id)); select.disabled = busy;
      const name = document.createElement('span'); name.className = 'scope-tree-name'; name.textContent = node.item.path === '/' ? '스페이스 전체 /' : node.item.title;
      const type = document.createElement('span'); type.className = 'scope-tree-type'; type.textContent = node.item.type === 'folder' ? '폴더' : '페이지';
      select.append(name, type);
      if (savedScope?.id === node.item.id) { const tag = document.createElement('span'); tag.className = 'scope-saved-tag'; tag.textContent = '저장됨'; select.append(tag); }
      select.onclick = () => { candidate = node.item; render(); update(busy); };
      controls.push({ button: select, leaf: false, key: `${node.item.id}:select` }); row.append(toggle, select); li.append(row);
      if (node.expanded && node.children?.length) { const group = document.createElement('ul'); for (const child of node.children) group.append(walk(child)); li.append(group); }
      return li;
    };
    if (root) { const list = document.createElement('ul'); list.append(walk(root)); $('sync-scope-tree').replaceChildren(list); }
    else { const empty = document.createElement('p'); empty.className = 'scope-tree-empty'; empty.textContent = '트리를 불러오면 페이지와 폴더를 탐색할 수 있습니다.'; $('sync-scope-tree').replaceChildren(empty); }
    $('sync-scope-candidate').textContent = candidate ? `${candidate.path} (#${candidate.id})` : '아직 선택하지 않았습니다.';
    $('sync-scope-saved').textContent = savedScope ? `${savedScope.path} (#${savedScope.id})` : savedScope === undefined ? '설정 확인으로 불러오세요.' : '미설정';
    if (focused) controls.find(control => control.key === focused.key)?.button.focus?.();
  }
  function cancelReview() { approval = null; if ($('scope-review-dialog').open) $('scope-review-dialog').close(); }
  function update(value) {
    busy = value;
    if (identity !== configKey()) { identity = configKey(); cancelReview(); nodes = new Map(); root = null; candidate = null; savedScope = undefined; render(); }
    $('sync-scope-browse').disabled = busy || !context().base;
    $('sync-scope-save').disabled = busy || !candidate;
    $('sync-scope-tree').setAttribute('aria-busy', String(busy));
    for (const { button, leaf } of controls) button.disabled = busy || leaf;
  }
  function nodeFor(item) {
    let node = nodes.get(item.id);
    if (!node) { node = { item, children: null, expanded: false }; nodes.set(item.id, node); }
    return node;
  }
  async function expand(node) {
    if (busy) return;
    if (node.children !== null) { node.expanded = !node.expanded; render(); return; }
    await load(node);
  }
  async function load(node = null) {
    if (busy) return;
    const key = configKey(); setBusy(true);
    try {
      const result = await api('/api/sync/scopes', { ...request(), ...(node ? { parentId: node.item.id } : {}) });
      if (key !== configKey()) return;
      if (!node) { nodes = new Map(); candidate = null; root = nodeFor(result.parent); node = root; }
      node.children = result.children.map(nodeFor); node.expanded = true; render();
      status('행을 눌러 관리할 위치를 선택하세요. 저장 전까지 스코프는 변경되지 않습니다.');
    } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  }
  $('sync-scope-browse').onclick = () => load();
  function showReview(result, key, body) {
    const review = result.review, s = review.summary;
    approval = { key, body: { ...body, confirmation: review.token } };
    $('scope-review-transition').textContent = `${review.previous?.path ?? '미설정'} → ${review.next.path} (#${review.next.id})`;
    $('scope-review-counts').textContent = `기존 매핑 ${s.total}개 · 일치 ${s.aligned} · 범위 밖 ${s.outside} · 루트 충돌 ${s.rootConflict} · 페이지 위치 변경 ${s.pageMove} · 폴더 충돌 ${s.folderConflict}`;
    const labels = { outside: '스코프 밖 — Push 차단', rootConflict: '루트 매핑 충돌 — Push 차단', pageMove: 'Push 시 위치 변경 검토', folderConflict: '폴더 구조 불일치 — Push 차단', aligned: '일치' };
    const items = review.entries.filter(entry => entry.status !== 'aligned').map(entry => {
      const li = document.createElement('li'); li.textContent = `${entry.path} (#${entry.pageId}): ${labels[entry.status]} · 현재 ${entry.remotePath}`; return li;
    });
    if (!items.length) { const li = document.createElement('li'); li.textContent = '기존 매핑의 위치 충돌은 없습니다. 새 문서는 새 스코프 아래에 업로드됩니다.'; items.push(li); }
    $('scope-review-items').replaceChildren(...items); $('scope-review-dialog').showModal();
  }
  async function saveScope(body, key) {
    setBusy(true);
    try {
      const result = await api('/api/sync/scope', body);
      if (key !== configKey()) return;
      if (result.confirmationRequired) showReview(result, key, body);
      else { cancelReview(); onSave(result); status('스코프 연결을 저장했습니다. 원격 문서는 변경하지 않았습니다. 작업 방향과 대상을 확인하세요.'); }
    } catch (error) { cancelReview(); status(error.message, true); }
    finally { setBusy(false); }
  }
  $('sync-scope-save').onclick = () => {
    if (busy || !candidate) return;
    return saveScope({ ...request(), scopeId: candidate.id }, configKey());
  };
  $('scope-review-confirm').onclick = () => {
    if (busy || !approval) return;
    if (approval.key !== configKey() || approval.body.scopeId !== candidate?.id) { cancelReview(); status('설정이나 선택 위치가 바뀌었습니다. 변경 영향을 다시 확인하세요.', true); return; }
    const { body, key } = approval; cancelReview(); return saveScope(body, key);
  };
  $('scope-review-cancel').onclick = cancelReview;
  $('scope-review-dialog').addEventListener('cancel', cancelReview);
  render();
  return { update, saved(scope) { savedScope = scope || null; render(); } };
}
