export function fitColumnWidths(total, weights) {
  const extra = total - weights.length * 40;
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map(w => w / sum * extra);
  const values = shares.map(w => 40 + Math.floor(w));
  const order = shares.map((w, i) => ({ i, remainder: w - Math.floor(w) })).sort((a, b) => b.remainder - a.remainder);
  const rest = total - values.reduce((a, b) => a + b, 0);
  for (let i = 0; i < rest; i++) values[order[i].i]++;
  return values;
}

export function initTableFormatting({ api, monaco, refresh, setBusy, notify = () => {} }) {
  const $ = id => document.getElementById(id);
  const frame = $('document-preview-frame'), toggle = $('table-edit-toggle'), controls = $('table-format-controls');
  const dialog = $('table-review-dialog'), note = $('table-format-status');
  let documentData, selection, enabled = false, index = -1, widths = [], plans = new Map(), planId, editor, beforeModel, afterModel, generation = 0;
  const post = data => frame.contentWindow?.postMessage({ ...data, channel: documentData?.channel }, '*');
  const message = text => { note.textContent = text; };
  const invalidate = () => { planId = null; $('table-save').disabled = true; };
  function clear() {
    frame.onload = null;
    generation++; documentData = null; selection = null; enabled = false; index = -1; widths = []; plans.clear(); invalidate();
    toggle.disabled = true; toggle.textContent = '표 서식 편집'; toggle.setAttribute('aria-pressed', 'false');
    controls.hidden = true; if (dialog.open) dialog.close(); updateControls();
  }
  function updateControls() {
    const active = index >= 0;
    for (const id of ['table-total-width', 'table-equal', 'table-review', 'table-revert']) $(id).disabled = !active;
    $('table-fit').disabled = !active || !documentData?.tables.find(t => t.index === index)?.contentWeights;
    if (active) {
      const total = widths.reduce((a, b) => a + b, 0);
      $('table-total-width').min = String(Math.max(320, widths.length * 40));
      $('table-total-width').max = String(Math.max(1200, total));
      $('table-total-width').value = total; $('table-total-label').textContent = total + 'px';
    } else $('table-total-label').textContent = '';
  }
  function apply(values) {
    widths = values.slice(); plans.set(index, widths.slice()); invalidate();
    post({ type: 'csync-table-widths', index, widths }); updateControls();
    message('표 ' + (index + 1) + ' · 아직 파일에 저장하지 않았습니다.');
  }
  toggle.onclick = () => {
    enabled = !enabled; controls.hidden = !enabled;
    toggle.textContent = enabled ? '표 편집 끝내기' : '표 서식 편집'; toggle.setAttribute('aria-pressed', String(enabled));
    post({ type: 'csync-table-edit', enabled });
    if (enabled && index >= 0) post({ type: 'csync-table-widths', index, widths });
    else if (enabled) message('미리보기에서 편집할 표를 클릭하세요.');
  };
  window.addEventListener('message', event => {
    const data = event.data;
    if (!documentData || !enabled || event.source !== frame.contentWindow || data?.channel !== documentData.channel) return;
    const table = documentData.tables.find(t => t.index === data.index && t.editable);
    if (!table) return;
    if (data.type === 'csync-table-select') {
      index = table.index; widths = (plans.get(index) ?? table.widths).slice();
      invalidate(); post({ type: 'csync-table-widths', index, widths }); updateControls();
      message('표 ' + (index + 1) + ' 선택 · 내용에 맞춤으로 자동 배분하거나 열 경계를 드래그하세요.');
    }
    if (data.type === 'csync-table-change' && data.index === index && Array.isArray(data.widths)
      && data.widths.length === table.widths.length && data.widths.every(w => Number.isInteger(w) && w >= 40)
      && data.widths.reduce((a, b) => a + b, 0) <= 3000) {
      widths = data.widths.slice(); plans.set(index, widths.slice()); invalidate(); updateControls();
      message('표 ' + (index + 1) + ' · 아직 파일에 저장하지 않았습니다.');
    }
  });
  const distribute = (total, count) => Array.from({ length: count }, (_, i) => Math.floor(total / count) + (i < total % count ? 1 : 0));
  $('table-equal').onclick = () => apply(distribute(widths.reduce((a, b) => a + b, 0), widths.length));
  $('table-fit').onclick = () => {
    const table = documentData.tables.find(t => t.index === index);
    apply(fitColumnWidths(widths.reduce((a, b) => a + b, 0), table.contentWeights));
    message('표 ' + (index + 1) + ' · 글자 길이에 맞춰 배분했습니다. 아직 저장하지 않았습니다.');
  };
  $('table-total-width').oninput = event => {
    const total = Number(event.target.value), extra = total - widths.length * 40;
    const weights = widths.map(w => w - 40), sum = weights.reduce((a, b) => a + b, 0);
    const values = sum ? weights.map(w => 40 + Math.floor(w / sum * extra)) : distribute(total, widths.length);
    let rest = total - values.reduce((a, b) => a + b, 0);
    for (let i = 0; rest > 0; i++, rest--) values[i % values.length]++;
    apply(values);
  };
  $('table-revert').onclick = () => {
    plans.delete(index); widths = documentData.tables.find(t => t.index === index).widths.slice();
    post({ type: 'csync-table-widths', index, widths }); invalidate(); updateControls(); message('선택한 표의 변경을 취소했습니다.');
  };
  $('table-review').onclick = async () => {
    const current = generation;
    const chosen = index, values = widths.slice();
    const changes = Array.from(new Map([...plans, [chosen, values]]), ([index, widths]) => ({ index, widths: widths.slice() }));
    $('table-review').disabled = true; message('변경 내용을 비교하는 중…');
    try {
      const data = await api('/api/table-format/preview', { ...selection, hash: documentData.hash, index: chosen, widths: values, changes });
      if (current !== generation || chosen !== index || JSON.stringify(widths) !== JSON.stringify(values)) return;
      planId = data.planId; $('table-save-status').textContent = '';
      dialog.showModal();
      if (!editor) {
        beforeModel = monaco.editor.createModel('', 'markdown'); afterModel = monaco.editor.createModel('', 'markdown');
        editor = monaco.editor.createDiffEditor($('table-review-diff'), { automaticLayout: true, readOnly: true, originalEditable: false, minimap: { enabled: false }, wordWrap: 'on', scrollBeyondLastLine: false });
        editor.setModel({ original: beforeModel, modified: afterModel });
      }
      beforeModel.setValue(data.before); afterModel.setValue(data.after); editor.layout();
      $('table-save').disabled = false;
      message('변경 내용을 확인한 뒤 원본 파일에 저장할 수 있습니다.');
    } catch (error) { message(error.message); notify(error.message, 'error'); }
    finally { if (current === generation) updateControls(); }
  };
  $('table-save').onclick = async () => {
    if (!planId) return;
    const approved = planId;
    $('table-save').disabled = true; $('table-review-close').disabled = true; setBusy(true);
    try {
      await api('/api/table-format/save', { planId: approved });
      dialog.close(); notify('표 서식을 원본 파일에 저장했습니다.', 'success'); await refresh();
    } catch (error) { $('table-save-status').textContent = error.message; notify(error.message, 'error'); }
    finally { $('table-review-close').disabled = false; setBusy(false); }
  };
  $('table-review-close').onclick = () => dialog.close();
  return { clear, load(data, target) {
    clear(); documentData = data; selection = target;
    frame.onload = () => {
      if (documentData !== data) return;
      toggle.disabled = !data.tables?.some(t => t.editable);
      post({ type: 'csync-table-edit', enabled });
    };
  } };
}
