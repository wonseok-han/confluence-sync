/** Visible request/job activity, independent of application busy state and API polling. */
export function describeRequest(path, body, options = {}) {
  if (options.quiet || path === '/api/sync/job') return null;
  if (path === '/api/sync/staging') return {label: body?.action === 'add' ? '업로드 문서에 포함하는 중' : body?.action === 'remove' ? '업로드 선택을 해제하는 중' : '로컬 변경을 확인하는 중', background: !!options.background, button: body?.action ? body.paths?.length === 1 ? null : body.action === 'add' ? 'sync-stage-add' : 'sync-stage-remove' : 'sync-stage-scan', region: 'sync-stage-list'};
  const specs = {
    '/api/sync/config': ['연결 설정을 확인하는 중', 'sync-load', 'sync-env-body'],
    '/api/sync/connect': ['스페이스에 연결하는 중', 'sync-connect', 'sync-env-body'],
    '/api/sync/env/import': ['.env를 읽는 중', 'sync-env-choose', 'sync-env-body'],
    '/api/sync/env/save': ['.env 저장을 확인하는 중', 'sync-env-save', 'sync-env-body'],
    '/api/sync/fetch': ['원격 변경을 확인하는 중', 'sync-fetch', 'sync-view'],
    '/api/sync/restore': ['원격 복구 대상을 확인하는 중', undefined, 'sync-view'],
    '/api/sync/pull': ['Confluence에서 가져오는 중', 'sync-pull-remote', 'sync-view'],
    '/api/sync/preview': ['업로드 미리보기를 계산하는 중', 'sync-preview', 'sync-view'],
    '/api/sync/push': ['Confluence에 업로드하는 중', 'sync-push', 'sync-view'],
    '/api/sync/diff': [body?.remote ? '원격 본문을 비교하는 중' : '저장된 기준본을 비교하는 중', 'sync-diff-remote', 'sync-diff-dialog'],
    '/api/document-preview': ['문서 미리보기를 만드는 중', 'document-preview-refresh', 'document-preview-panel'],
    '/api/document-format/preview': ['문서 서식을 비교하는 중', body?.basic ? 'document-format-basic' : 'document-format-review', 'document-preview-panel'],
    '/api/table-format/preview': ['표 서식을 비교하는 중', 'document-format-review', 'document-preview-panel'],
    '/api/table-format/save': ['문서 서식을 저장하는 중', 'table-save', 'table-review-dialog'],
    '/api/convert': [body?.preview ? '변환 미리보기를 만드는 중' : '문서와 첨부를 변환하는 중', body?.preview ? 'preview' : 'save', 'convert-view'],
    '/api/pick-folder': ['시스템 창에서 폴더를 선택해 주세요', body?.kind === 'reference' ? 'sync-add-reference' : body?.kind === 'out' ? 'choose-out' : 'choose-base', null],
    '/api/open': ['결과 폴더를 여는 중', 'open', null],
  };
  if (path.startsWith('/api/search')) return {label: '문서를 검색하는 중', region: 'files'};
  const [label, button, region] = specs[path] ?? ['문서 폴더를 불러오는 중', null, 'files'];
  return {label, button, region};
}
export function createActivity({get = id => document.getElementById(id), now = () => Date.now()} = {}) {
  const entries = new Map(), targets = new Map();
  let sequence = 0, ticker;
  const panel = get('activity-panel');
  function mark(id, change) {
    const node = id && get(id); if (!node) return;
    let target = targets.get(node);
    if (change > 0) {
      if (!target) { target = {count: 0, busy: node.getAttribute('aria-busy')}; targets.set(node, target); }
      target.count++;
      node.setAttribute('aria-busy','true'); node.classList.add('is-loading');
    } else if (target && --target.count === 0) {
      if (target.busy === null) node.removeAttribute('aria-busy'); else node.setAttribute('aria-busy',target.busy);
      node.classList.remove('is-loading'); targets.delete(node);
    }
  }
  function elapsed(entry) {
    const seconds = Math.max(0, Math.floor((now() - entry.startedAt) / 1000));
    return seconds < 60 ? `${seconds}초 경과` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초 경과`;
  }
  function renderClock() {
    const current = [...entries.values()].filter(entry => !entry.background).at(-1);
    if (current && panel) get('activity-elapsed').textContent = elapsed(current);
  }
  function render() {
    const current = [...entries.values()].filter(entry => !entry.background).at(-1);
    if (panel) {
      panel.hidden = !current;
      if (current) {
        get('activity-title').textContent = current.label;
        get('activity-detail').textContent = current.detail || '처리가 끝나면 결과를 표시합니다.';
        panel.classList.toggle('is-uncertain', current.uncertain === true);
        get('activity-link').hidden = !current.link;
        if (current.link) get('activity-link').setAttribute('href',current.link);
      }
    }
    const background = get('sync-stage-checking');
    if (background) {
      const visible = [...entries.values()].some(entry => entry.background && entry.visible);
      background.classList.toggle('is-checking', visible); background.setAttribute('aria-hidden', String(!visible));
    }
    if (current && !ticker) ticker = setInterval(renderClock, 1000);
    if (!current && ticker) { clearInterval(ticker); ticker = undefined; }
    renderClock();
  }
  function begin(options) {
    const id = ++sequence, parsed = Date.parse(options.startedAt);
    const entry = {...options, startedAt: Number.isFinite(parsed) ? parsed : now(), visible: false};
    entries.set(id,entry);
    // Background scans never change the global busy state, region attributes or buttons.
    if (entry.background) entry.delay = setTimeout(() => { if (entries.has(id)) {entry.visible = true; render();} }, 350);
    else {mark(entry.button,1); mark(entry.region,1);}
    render();
    return {
      update(values) {
        if (!entries.has(id)) return;
        const parsed = Date.parse(values.startedAt);
        Object.assign(entry,values,{startedAt:Number.isFinite(parsed)?parsed:entry.startedAt}); render();
      },
      end() {
        if (!entries.delete(id)) return;
        clearTimeout(entry.delay);
        if (!entry.background) {mark(entry.button,-1); mark(entry.region,-1);}
        render();
      },
    };
  }
  return {begin};
}
