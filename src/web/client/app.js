import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import './styles.css';
import { initSync } from './sync.js';

self.MonacoEnvironment = { getWorker: () => new Worker('/assets/editor.worker.js', { type: 'module' }) };
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="csync-token"]').content;
let folder, parent, entries = [], base = null, file = null, output = null, busy = false, navigation = 0;
let searchResults = null, searchRoot = null, searching = false, searchMessage = '';
let searchTimer, searchController, searchVersion = 0;
let editor, syncUI;
let previews = [];
let convertKind = 'file';
let expanded = new Set(), treeCache = new Map(), treeLoading = new Set();
let mode = 'convert';
let restoring = true;
let workspaces = { convert: {}, sync: {} };
const explorerState = () => ({ base, folder, file, baseInput: $('base-input').value, expanded: [...expanded] });
const preferencesKey = 'csync.workspace.v1';
function savePreferences() {
  if (restoring) return;
  workspaces[mode] = explorerState();
  try {
    localStorage.setItem(preferencesKey, JSON.stringify({
      workspaces, mode,
      referenceRoots: $('sync-references').value, out: $('out-input').value, envFile: $('sync-env').value,
      convertScope: convertKind, direction: $('direction').value, fix: $('fix').checked,
      scope: $('sync-scope').value, verify: $('sync-verify').checked,
      sideBySide: $('side-by-side').checked,
    }));
  } catch { /* Storage may be disabled; the workspace remains usable. */ }
}
function loadPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(preferencesKey));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function displayMode(next) {
  mode = next;
  for (const name of ['convert', 'sync']) {
    $('tab-' + name).setAttribute('aria-selected', String(name === mode));
    $('tab-' + name).tabIndex = name === mode ? 0 : -1;
    $(name + '-view').hidden = name !== mode;
  }
  $('choose-base').lastChild.textContent = mode === 'sync' ? '동기화 폴더 선택…' : '변환 폴더 선택…';
  $('base-input').setAttribute('aria-label', mode === 'sync' ? '동기화 기준 폴더 경로' : '변환 기준 폴더 경로');
  $('workspace-note').textContent = mode === 'sync' ? '동기화를 실행하면 선택한 문서를 Confluence에 업로드합니다.' : '변환은 이 컴퓨터에서 처리됩니다.';
  if (mode === 'convert') editor?.layout();
}
async function showMode(next) {
  if (next === mode || busy) return;
  savePreferences();
  restoring = true; busy = true;
  displayMode(next);
  let warning;
  try { warning = await restoreExplorer(workspaces[next]); }
  finally { restoring = false; busy = false; controls(); render(); }
  if (warning) status(warning, true);
}
for (const name of ['convert', 'sync']) {
  $('tab-' + name).onclick = () => showMode(name);
  $('tab-' + name).onkeydown = event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 'convert' : event.key === 'End' ? 'sync' : name === 'convert' ? 'sync' : 'convert';
      if (!$('tab-' + next).disabled) { showMode(next); $('tab-' + next).focus(); }
    }
  };
}
const original = monaco.editor.createModel('', 'markdown');
const modified = monaco.editor.createModel('', 'markdown');
try {
  editor = monaco.editor.createDiffEditor($('diff'), {
    automaticLayout: true, readOnly: true, originalEditable: false,
    renderSideBySide: true, useInlineViewWhenSpaceIsLimited: true,
    renderSideBySideInlineBreakpoint: 700, ignoreTrimWhitespace: false,
    minimap: { enabled: false }, scrollBeyondLastLine: false,
    wordWrap: 'on', renderOverviewRuler: true, accessibilityVerbose: true,
    padding: { top: 12, bottom: 12 }, lineHeight: 22, fontSize: 12,
  });
  editor.setModel({ original, modified });
  editor.getOriginalEditor().updateOptions({ ariaLabel: '원본 Markdown' });
  editor.getModifiedEditor().updateOptions({ ariaLabel: '변환 결과 Markdown' });
  editor.onDidUpdateDiff(() => {
    const changes = editor.getLineChanges();
    const hasChanges = !!changes?.length;
    $('previous-change').disabled = $('next-change').disabled = !hasChanges;
  });
} catch (error) {
  $('editor-error').hidden = false;
  $('editor-error').textContent = '본문 비교 화면을 불러오지 못했습니다. 새로고침해 주세요. ' + error.message;
}
$('previous-change').onclick = () => editor?.goToDiff('previous');
$('next-change').onclick = () => editor?.goToDiff('next');
$('side-by-side').onchange = () => editor?.updateOptions({ renderSideBySide: $('side-by-side').checked });

async function api(path, body, signal) {
  const response = await fetch(path, {
    signal, method: body ? 'POST' : 'GET', headers: { 'X-Csync-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '요청을 처리하지 못했습니다.'), { code: data.code, conflicts: data.conflicts });
  return data;
}
function status(text, error = false) {
  const el = $(mode === 'sync' ? 'sync-status' : 'status');
  el.textContent = text; el.classList.toggle('error', error);
}
function reset() {
  if (mode === 'sync') { status(''); return; }
  previews = []; $('preview-documents').hidden = true;
  output = null; $('result').hidden = true; $('details').hidden = true;
  original.setValue(''); modified.setValue('');
  $('comparison-empty').hidden = false;
  $('previous-change').disabled = $('next-change').disabled = true;
  $('preview-label').textContent = '미리보기 대기'; status('');
}
const inside = (root, path) => path === root || path.startsWith(root.endsWith('/') ? root : root + '/') || path.startsWith(root.endsWith('\\') ? root : root + '\\');
function controls() {
  for (const id of ['preview', 'save', 'next-document']) $(id).disabled = busy || !file;
  for (const id of [ 'preview-document', 'tab-convert', 'tab-sync', 'choose-base', 'apply-base', 'base-input', 'up', 'choose-out', 'out-input', 'direction', 'fix', 'search']) $(id).disabled = busy;
  if (!busy) $('up').disabled = folder === parent || (base && !inside(base, parent));
  $('fix').disabled = busy || $('direction').value === 'repair';
  $('selected').textContent = file ? file.split(/[\\/]/).pop() : '변환할 문서를 선택하세요';
  const folderMode = convertKind === 'folder';
  $('selected').textContent = file ? (folderMode && mode === 'convert' ? '폴더 · ' : '') + file.split(/[\\/]/).pop() : folderMode ? '변환할 폴더를 선택하세요' : '변환할 문서를 선택하세요';
  $('base').textContent = file || '왼쪽에서 대상을 선택하세요.';
  $('convert-output-hint').textContent = folderMode ? '선택 폴더 안의 모든 Markdown을 변환합니다. 출력 폴더 아래에 선택 폴더 내부 구조만 유지합니다.' : '선택한 Markdown을 출력 폴더 바로 아래에 저장합니다. 링크는 해당 파일이 있는 폴더를 기준으로 해석합니다.';
  $('base').title = base || ''; $('selected').title = file || '';
  syncUI?.update(busy, restoring);
  savePreferences();
}
function render() {
  const scroll = $('files').scrollTop;
  $('files').replaceChildren();
  const filtered = searchResults ?? entries;
  $('count').textContent = searching ? '검색 중…' : filtered.length + (searchResults ? '개 결과' : '개 항목');
  if (searchMessage || (searchResults && !filtered.length)) {
    const el = document.createElement('div'); el.className = 'empty';
    el.textContent = searchMessage || (searchResults ? '일치하는 .md 문서가 없습니다.' : '표시할 폴더나 .md 문서가 없습니다.');
    $('files').append(el);
  }
  const appendEntry = (entry, level = 0) => {
    const row = document.createElement('div'); row.className = 'tree-row'; row.style.paddingLeft = (level * 16) + 'px';
    const toggle = document.createElement(entry.directory ? 'button' : 'span'); toggle.className = 'tree-toggle';
    if (entry.directory) {
      toggle.textContent = expanded.has(entry.path) ? '▾' : '▸'; toggle.disabled = busy;
      toggle.dataset.path = entry.path; toggle.setAttribute('aria-expanded', String(expanded.has(entry.path)));
      toggle.setAttribute('aria-label', entry.name + (expanded.has(entry.path) ? ' 접기' : ' 펼치기'));
      toggle.onclick = () => toggleFolder(entry.path);
    }
    row.append(toggle);
    const button = document.createElement('button'); button.className = 'file' + (entry.path === file ? ' selected' : ''); button.disabled = busy;
    const icon = document.createElement('span'); icon.className = entry.directory ? 'icon folder-icon' : 'icon';
    if (entry.directory) {
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" fill="#f7d783" stroke="#bf9132" stroke-width="1.5"/><path d="M3 9h18" stroke="#bf9132" stroke-width="1.5"/></svg>';
    } else icon.textContent = 'MD'; icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.textContent = entry.name;
    const label = document.createElement('span'); label.className = 'file-label'; label.append(name);
    if (entry.relativePath) {
      const path = document.createElement('small'); path.className = 'file-location'; path.textContent = entry.relativePath;
      label.append(path); button.title = entry.path;
    }
    button.append(icon, label); button.title = entry.path; button.setAttribute('aria-pressed', String(entry.path === file));
    button.onclick = () => {
      if (mode === 'sync' && entry.directory) { browse(entry.path); return; }
      if (mode === 'convert') convertKind = entry.directory ? 'folder' : 'file';
      file = entry.path;
      if (!base || !inside(base, file)) base = searchRoot || folder;
      reset(); controls(); render();
    };
    row.append(button); $('files').append(row);
    if (entry.directory && expanded.has(entry.path)) {
      const children = treeCache.get(entry.path);
      if (children?.length) children.forEach(child => appendEntry(child, level + 1));
      else {
        const note = document.createElement('div'); note.className = 'tree-note'; note.style.paddingLeft = ((level + 1) * 16 + 24) + 'px';
        note.textContent = treeLoading.has(entry.path) ? '불러오는 중…' : children ? '표시할 문서가 없습니다.' : '펼치기를 다시 눌러 주세요.';
        $('files').append(note);
      }
    }
  };
  if (searchResults) filtered.forEach(entry => appendEntry(entry));
  else if (folder) appendEntry({ name: folder.split(/[\\/]/).pop() || folder, path: folder, directory: true });
  $('files').scrollTop = scroll;
}
async function toggleFolder(path) {
  if (busy) return;
  const version = navigation;
  if (expanded.has(path)) expanded.delete(path);
  else {
    expanded.add(path);
    if (!treeCache.has(path) && !treeLoading.has(path)) {
      treeLoading.add(path); render();
      try {
        const data = await api('/api/browse?path=' + encodeURIComponent(path));
        if (version !== navigation) return;
        treeCache.set(path, data.entries);
      } catch (error) { if (version === navigation) { expanded.delete(path); status('폴더를 펼칠 수 없습니다: ' + error.message, true); } }
      finally { if (version === navigation) treeLoading.delete(path); }
    }
  }
  if (version !== navigation) return;
  render(); savePreferences();
  [...$('files').querySelectorAll('.tree-toggle')].find(el => el.dataset.path === path)?.focus();
}
async function browse(path, chooseBase = false) {
  clearSearch(); $('search').value = '';
  const version = ++navigation;
  try {
    const data = await api('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : ''));
    if (version !== navigation) return;
    folder = data.path; parent = data.parent; entries = data.entries;
    treeCache = new Map([[folder, entries]]); expanded = new Set([folder]); treeLoading = new Set();
    if (chooseBase) { base = folder; file = null; if (!restoring) reset(); }
    $('base-input').value = base || folder;
    $('path').textContent = folder; $('path').title = folder; $('base-input').title = base || folder; $('search').value = ''; render(); controls();
    return true;
  } catch (error) { if (version === navigation) status('폴더를 열 수 없습니다: ' + error.message, true); }
}
async function pickFolder(kind) {
  busy = true; controls(); render(); status('시스템 폴더 다이얼로그에서 폴더를 선택해 주세요.');
  try {
    const data = await api('/api/pick-folder', { kind, start: kind === 'base' ? folder : $('out-input').value || parent });
    if (data.path) {
      if (kind === 'base') await browse(data.path, true);
      else { $('out-input').value = data.path; reset(); }
    } else status('폴더 선택을 취소했습니다.');
  } catch (error) { status(error.message, true); }
  finally { busy = false; controls(); render(); }
}
$('choose-base').onclick = () => pickFolder('base');
$('choose-out').onclick = () => pickFolder('out');
$('apply-base').onclick = () => browse($('base-input').value, true);
$('base-input').onkeydown = event => { if (event.key === 'Enter') browse($('base-input').value, true); };
$('up').onclick = () => browse(parent);
function clearSearch() {
  clearTimeout(searchTimer); searchController?.abort(); searchVersion++;
  searchResults = null; searchRoot = null; searching = false; searchMessage = '';
}
$('search').oninput = () => {
  clearSearch();
  const query = $('search').value.trim();
  if (!query || !folder) { render(); return; }
  const version = searchVersion;
  searchRoot = base || folder;
  searchResults = []; searching = true; searchMessage = '기준 폴더의 모든 하위 폴더를 검색합니다…'; render();
  searchTimer = setTimeout(async () => {
    searchController = new AbortController();
    try {
      const data = await api('/api/search?' + new URLSearchParams({ path: searchRoot, q: query }), undefined, searchController.signal);
      if (version !== searchVersion) return;
      searchRoot = data.root; searchResults = data.entries;
      searchMessage = data.skipped ? '읽을 수 없는 하위 폴더 ' + data.skipped + '개를 건너뛰었습니다.' : '';
    } catch (error) {
      if (version !== searchVersion) return;
      searchMessage = '검색하지 못했습니다: ' + error.message;
    } finally {
      if (version === searchVersion) { searching = false; render(); }
    }
  }, 250);
};
$('direction').onchange = () => {
  reset(); controls();
  $('direction-hint').textContent = {
    markdown: '위키링크를 상대 링크로, PDF 페이지 참조를 이미지로 변환합니다.',
    obsidian: '상대 문서 링크를 위키링크로 바꾸고 각주·PDF 참조를 복원합니다.',
    repair: '링크 형식은 유지하고 코드블록 언어·CSS 잔해·이스케이프 등을 보정합니다.',
  }[$('direction').value];
};
const helpButton = $('repair-help-button');
const helpTooltip = $('repair-tooltip');
const showHelp = () => { helpTooltip.hidden = false; };
helpButton.onfocus = helpButton.onclick = showHelp;
helpButton.parentElement.onmouseenter = showHelp;
helpButton.parentElement.onmouseleave = () => {
  if (document.activeElement !== helpButton) helpTooltip.hidden = true;
};
helpButton.onblur = () => { helpTooltip.hidden = true; };
helpButton.onkeydown = event => {
  if (event.key === 'Escape') { helpTooltip.hidden = true; event.stopPropagation(); }
};
function showPreview(index) {
  const doc = previews[index]; if (!doc) return;
  original.setValue(doc.before); modified.setValue(doc.after);
  $('comparison-empty').hidden = true;
  $('preview-label').textContent = doc.before === doc.after ? '본문 변경 없음' : '변경된 부분 표시';
}
$('preview-document').onchange = () => showPreview(Number($('preview-document').value));
$('fix').onchange = reset; $('out-input').oninput = reset;
async function convert(preview) {
  if (busy || !file) return;
  busy = true;
  try {
    reset(); controls(); render(); status(preview ? '미리보기를 만드는 중입니다…' : '문서와 첨부파일을 변환하는 중입니다…');
    const request = { base, file, scope: convertKind, out: $('out-input').value, to: $('direction').value, fix: $('fix').checked, preview };
    let data;
    const approvedOverwrites = {};
    while (!data) {
      try { data = await api('/api/convert', { ...request, approvedOverwrites }); }
      catch (error) {
        if (preview || error.code !== 'OVERWRITE_REQUIRED') throw error;
        const files = error.conflicts.map(item => item.path);
        const list = files.slice(0, 20).join('\n') + (files.length > 20 ? `\n외 ${files.length - 20}개` : '');
        if (!window.confirm(`출력 폴더의 기존 파일 ${files.length}개를 덮어쓸까요?\n${request.out}\n\n${list}\n\n기존 내용이 변환 결과로 교체됩니다. 취소하면 저장하지 않습니다.`)) {
          status('덮어쓰기를 취소했습니다. 저장하지 않았습니다.'); return;
        }
        for (const item of error.conflicts) approvedOverwrites[item.path] = item.hash;
        status('기존 파일을 덮어쓰는 중입니다…');
      }
    }
    previews = data.previews;
    $('preview-document').replaceChildren(...previews.map((doc, index) => {
      const option = document.createElement('option'); option.value = index; option.textContent = doc.path; return option;
    }));
    $('preview-documents').hidden = data.documentCount <= 1;
    $('preview-count').textContent = `전체 ${data.documentCount}개 변환 · ${previews.length}개 본문 비교`;
    showPreview(0);
    $('log').textContent = data.log; $('details').hidden = false; output = data.output;
    if (output) { $('output').textContent = output; $('result').hidden = false; }
    if (preview) status('미리보기 완료. 출력 위치를 확인하고 저장하세요.');
    else if (data.saved && data.saved.created === 0 && data.saved.overwritten === 0) {
      status(`기존 출력과 내용이 같아 저장하지 않았습니다. 파일 ${data.saved.reused}개를 그대로 재사용했습니다.`);
    } else {
      const saved = data.saved;
      status(saved ? `저장 완료 · 새 파일 ${saved.created}개 · 덮어쓴 파일 ${saved.overwritten}개 · 동일 내용 재사용 ${saved.reused}개 (문서·첨부 포함)` : `문서 ${data.documentCount}개 저장 완료.`);
    }
  } catch (error) { status(error.message, true); }
  finally { busy = false; controls(); render(); }
}
$('next-document').onclick = () => {
  if (busy) return;
  file = null; reset(); clearSearch(); $('search').value = ''; controls(); render();
  $('search').focus(); $('search').scrollIntoView({ block: 'center', behavior: 'auto' });
  status('다음 문서를 선택하세요. 기준 폴더와 변환 설정은 유지됩니다.');
};
$('preview').onclick = () => convert(true); $('save').onclick = () => convert(false);
$('open').onclick = async () => {
  try { await api('/api/open', { path: output }); }
  catch (error) { status('폴더를 열 수 없습니다. 위 저장 경로를 이용해 주세요. ' + error.message, true); }
};
syncUI = initSync({
  api, context: () => {
    const state = mode === 'sync' ? explorerState() : workspaces.sync;
    return { base: state.base || state.folder, folder: state.folder, file: state.file };
  },
  setBusy: value => { busy = value; controls(); render(); },
  showSync: () => showMode('sync'),
});
// Persist only local UI preferences, never credentials, logs or upload approval.
document.querySelector('.app-main').addEventListener('input', savePreferences);
document.querySelector('.app-main').addEventListener('change', savePreferences);
async function restoreExplorer(saved) {
  const text = name => typeof saved[name] === 'string' ? saved[name] : '';
  navigation++; clearSearch();
  base = null; file = null; folder = undefined; parent = undefined; entries = [];
  $('base-input').value = ''; controls(); render();
  let warning = '';
  const root = text('base'), location = text('folder');
  if (root) {
    if (!await browse(root, true)) {
      warning = '저장된 기준 폴더를 열 수 없어 시작 폴더를 열었습니다. 경로를 다시 선택해 주세요.';
      await browse();
    } else if (location && inside(base, location) && location !== base) {
      if (!await browse(location)) warning = '이전 탐색 폴더를 열 수 없어 기준 폴더를 열었습니다.';
    }
  } else if (!await browse(location || undefined)) {
    warning = '이전 폴더를 열 수 없어 시작 폴더를 열었습니다.'; await browse();
  }
  const selected = text('file');
  if (selected && base && inside(base, selected)) {
    try {
      if (mode === 'convert' && convertKind === 'folder') {
        const listing = await api('/api/browse?path=' + encodeURIComponent(selected));
        file = listing.path;
      } else {
      // A search result can be selected outside the currently displayed folder.
      const directory = selected.slice(0, Math.max(selected.lastIndexOf('/'), selected.lastIndexOf('\\')));
      const listing = await api('/api/browse?path=' + encodeURIComponent(directory));
      if (listing.entries.some(entry => !entry.directory && entry.path === selected)) file = selected;
      else warning = '이전에 선택한 문서가 없어 선택을 해제했습니다.';
      }
    } catch { warning = '이전에 선택한 문서를 열 수 없어 선택을 해제했습니다.'; }
  }
  const reopen = new Set(Array.isArray(saved.expanded) ? saved.expanded.filter(path => typeof path === 'string' && folder && inside(folder, path)) : []);
  if (!Array.isArray(saved.expanded) && file && folder && inside(folder, file)) {
    let path = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
    while (path && inside(folder, path)) { reopen.add(path); if (path === folder) break; path = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))); }
  }
  for (const path of reopen) {
    try {
      if (!treeCache.has(path)) treeCache.set(path, (await api('/api/browse?path=' + encodeURIComponent(path))).entries);
      expanded.add(path);
    } catch { /* Missing expanded folders do not prevent restoring the selection. */ }
  }
  if (!warning && text('baseInput')) $('base-input').value = text('baseInput');
  if (warning && mode === 'convert') reset();
  return warning;
}
async function restoreWorkspace() {
  const saved = loadPreferences();
  const text = name => typeof saved[name] === 'string' ? saved[name] : '';
  busy = true; controls();
  $('sync-references').value = text('referenceRoots'); $('out-input').value = text('out'); $('sync-env').value = text('envFile');
  if (['file', 'folder'].includes(saved.convertScope)) convertKind = saved.convertScope;
  if (['markdown', 'obsidian', 'repair'].includes(saved.direction)) $('direction').value = saved.direction;
  if (['file', 'folder', 'all'].includes(saved.scope)) $('sync-scope').value = saved.scope;
  if (typeof saved.fix === 'boolean') $('fix').checked = saved.fix;
  if (typeof saved.verify === 'boolean') $('sync-verify').checked = saved.verify;
  if (typeof saved.sideBySide === 'boolean') {
    $('side-by-side').checked = saved.sideBySide;
    editor?.updateOptions({ renderSideBySide: saved.sideBySide });
  }
  const valid = value => value && typeof value === 'object' && !Array.isArray(value);
  // Migrate the previous shared explorer without losing either workflow's paths.
  workspaces = valid(saved.workspaces)
    ? { convert: valid(saved.workspaces.convert) ? saved.workspaces.convert : {}, sync: valid(saved.workspaces.sync) ? saved.workspaces.sync : {} }
    : { convert: { base: saved.base, folder: saved.folder, file: saved.file, baseInput: saved.baseInput },
        sync: { base: saved.base, folder: saved.folder, file: saved.file, baseInput: saved.baseInput } };
  $('direction').onchange(); displayMode(saved.mode === 'sync' ? 'sync' : 'convert');
  let warning;
  try { warning = await restoreExplorer(workspaces[mode]); }
  finally { restoring = false; busy = false; controls(); render(); }
  await syncUI.resume();
  if (warning) status(warning, true);
}

restoreWorkspace();
