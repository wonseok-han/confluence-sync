/** Selection-driven preview; stale reads must never replace the current document. */
export function initDocumentPreview({ api, selection, formatting, notify = () => {} }) {
  const frame = document.getElementById('document-preview-frame');
  const note = document.getElementById('document-preview-status');
  const refresh = document.getElementById('document-preview-refresh');
  const toggle = document.getElementById('document-preview-toggle');
  let key, controller, version = 0, expanded = false, pending = false;
  function clear() {
    version++; controller?.abort(); formatting?.clear();
    frame.hidden = true; frame.removeAttribute('srcdoc'); key = undefined; pending = false;
  }
  async function update(force = false) {
    const { base, file, folder } = selection();
    const next = base && file && !folder ? JSON.stringify([base, file]) : '';
    if (!expanded) {
      if (key !== undefined && (next !== key || pending)) clear();
      refresh.disabled = true;
      return;
    }
    refresh.disabled = !next;
    if (!force && next === key) return;
    clear();
    key = next;
    const current = version;
    refresh.disabled = !next;
    note.textContent = next ? '문서를 불러오는 중…' : 'Markdown 파일을 선택하면 본문이 표시됩니다.';
    if (!next) return;
    controller = new AbortController();
    pending = true;
    try {
      const data = await api('/api/document-preview', { base, file }, controller.signal);
      if (current !== version) return;
      frame.srcdoc = data.html; frame.hidden = false;
      formatting?.load(data, { base, file });
      note.textContent = file.split(/[\\/]/).pop() + ' · 내용을 선택해 복사할 수 있습니다.';
    } catch (error) {
      if (current !== version || error.name === 'AbortError') return;
      note.textContent = '문서를 표시하지 못했습니다: ' + error.message;
      notify(note.textContent, 'error');
    } finally {
      if (current === version) pending = false;
    }
  }
  toggle.onclick = () => {
    expanded = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    document.getElementById('document-preview-body').hidden = !expanded;
    document.getElementById('document-preview-actions').hidden = !expanded;
    document.getElementById('document-preview-chevron').textContent = expanded ? '▾' : '▸';
    document.getElementById('document-preview-toggle-label').textContent = expanded ? '접기' : '펼치기';
    return update();
  };
  refresh.onclick = () => update(true);
  return { update };
}
