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
  let documentData, selection, enabled = false, index = -1, widths = [], plans = new Map(), planId, editor, beforeModel, afterModel, generation = 0, revision = 0;
  const post = data => frame.contentWindow?.postMessage({ ...data, channel: documentData?.channel }, '*');
  const message = text => { note.textContent = text; };
  const invalidate = () => { revision++; planId = null; $('table-save').disabled = true; };
  function clear() {
    frame.onload = null;
    generation++; documentData = null; selection = null; enabled = false; index = -1; widths = []; plans.clear(); invalidate();
    $('document-format-toggle').disabled = true; $('document-format-controls').hidden = true; $('document-format-toggle').setAttribute('aria-expanded', 'false');
    $('document-format-tables').value = 'keep';
    toggle.disabled = true; toggle.lastChild.textContent = '표 직접 편집'; toggle.setAttribute('aria-pressed', 'false');
    controls.hidden = true; if (dialog.open) dialog.close(); updateControls();
  }
  function updateControls() {
    const active = index >= 0;
    for (const id of ['table-total-width', 'table-equal', 'table-revert']) $(id).disabled = !active;
    $('document-format-basic').disabled = !documentData;
    $('document-format-review').disabled = !documentData || !plans.size;
    $('format-summary').textContent = plans.size ? `표 ${plans.size}개 조절됨 · 변경 비교 후 저장합니다.` : '변경 비교 후 원본 파일에 저장합니다.';
    $('table-revert-all').disabled = !plans.size;
    $('document-format-tables').disabled = !documentData?.tables.some(t => t.editable);
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
    toggle.lastChild.textContent = enabled ? '표 직접 편집 중' : '표 직접 편집'; toggle.setAttribute('aria-pressed', String(enabled));
    post({ type: 'csync-table-edit', enabled });
    if (enabled) {
      for (const [index, widths] of plans) post({ type: 'csync-table-widths', index, widths });
      if (index >= 0) post({ type: 'csync-table-widths', index, widths });
    }
    if (enabled && index < 0) message('미리보기에서 편집할 표를 클릭하세요.');
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
  function bulk(mode) {
    const tables = documentData.tables.filter(t => t.editable);
    if (!tables.length) return;
    post({ type: 'csync-table-edit', enabled: true });
    for (const table of tables) {
      const current = plans.get(table.index) ?? table.widths, total = current.reduce((a, b) => a + b, 0);
      const values = mode === 'fit' ? fitColumnWidths(total, table.contentWeights) : distribute(total, current.length);
      plans.set(table.index, values); post({ type: 'csync-table-widths', index: table.index, widths: values });
    }
    if (index < 0) index = tables[0].index;
    widths = plans.get(index).slice(); post({ type: 'csync-table-widths', index, widths }); invalidate(); updateControls();
    post({ type: 'csync-table-edit', enabled });
    message(`표 ${tables.length}개에 ${mode === 'fit' ? '내용에 맞춤' : '균등 배분'}을 적용했습니다. 변경 비교 후 저장하세요.`);
  }
  $('document-format-tables').onchange = () => {
    if ($('document-format-tables').value === 'keep') $('table-revert-all').onclick();
    else bulk($('document-format-tables').value);
  };
  $('table-revert-all').onclick = () => {
    post({ type: 'csync-table-edit', enabled: true });
    for (const table of documentData.tables.filter(t => t.editable)) post({ type: 'csync-table-widths', index: table.index, widths: table.widths });
    plans.clear(); $('document-format-tables').value = 'keep';
    if (index >= 0) { widths = documentData.tables.find(t => t.index === index).widths.slice(); post({ type: 'csync-table-widths', index, widths }); }
    post({ type: 'csync-table-edit', enabled });
    invalidate(); updateControls(); message('모든 표의 너비 변경을 취소했습니다.');
  };
  $('document-format-toggle').onclick = () => {
    const hidden = !$('document-format-controls').hidden; $('document-format-controls').hidden = hidden;
    $('document-format-toggle').setAttribute('aria-expanded', String(!hidden));
    if (hidden && enabled) toggle.onclick();
  };
  function review(data, basic) {
    planId = data.planId; $('table-save-status').textContent = '';
    $('table-review-title').textContent = '문서 서식 변경 확인';
    $('format-review-note').textContent = basic ? '기본 서식 정리와 표 조절 결과를 확인하세요. 저장을 눌러야 파일에 반영됩니다.' : '표 조절 결과를 확인하세요. 본문 기본 서식은 변경하지 않습니다. 저장을 눌러야 파일에 반영됩니다.';
    if (!dialog.open) dialog.showModal();
    if (!editor) {
      beforeModel = monaco.editor.createModel('', 'markdown'); afterModel = monaco.editor.createModel('', 'markdown');
      editor = monaco.editor.createDiffEditor($('table-review-diff'), { automaticLayout: true, readOnly: true, originalEditable: false, minimap: { enabled: false }, wordWrap: 'on', scrollBeyondLastLine: false });
      editor.setModel({ original: beforeModel, modified: afterModel });
    }
    beforeModel.setValue(data.before); afterModel.setValue(data.after); editor.layout();
    $('table-save').disabled = data.before === data.after;
    if (data.before === data.after) $('table-save-status').textContent = '정리할 서식 변경이 없습니다.';
  }
  async function compare(basic) {
    if (!documentData) return;
    const current = generation, version = revision; $('document-format-basic').disabled = $('document-format-review').disabled = true;
    try {
      const data = await api('/api/document-format/preview', { ...selection, hash: documentData.hash, basic, tables: 'keep', changes: Array.from(plans, ([index, widths]) => ({ index, widths: widths.slice() })) });
      if (current !== generation || version !== revision) return;
      review(data, basic);
    } catch (error) { notify(error.message, 'error'); }
    finally { updateControls(); }
  }
  $('document-format-basic').onclick = () => compare(true);
  $('document-format-review').onclick = () => compare(false);
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
  $('table-save').onclick = async () => {
    if (!planId) return;
    const approved = planId;
    $('table-save').disabled = true; $('table-review-close').disabled = true; setBusy(true);
    try {
      await api('/api/table-format/save', { planId: approved });
      dialog.close(); notify('문서 서식을 원본 파일에 저장했습니다.', 'success'); await refresh();
    } catch (error) { $('table-save-status').textContent = error.message; notify(error.message, 'error'); }
    finally { $('table-review-close').disabled = false; setBusy(false); }
  };
  $('table-review-close').onclick = () => dialog.close();
  return { clear, load(data, target) {
    clear(); documentData = data; selection = target;
    frame.onload = () => {
      if (documentData !== data) return;
      $('document-format-toggle').disabled = false;
      toggle.disabled = !data.tables?.some(t => t.editable);
      updateControls();
      post({ type: 'csync-table-edit', enabled });
    };
  } };
}
