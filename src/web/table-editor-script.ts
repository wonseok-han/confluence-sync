/** Trusted bridge runs in an opaque-origin sandbox; document scripts are removed first. */
export function tableEditorBridge() {
  const channel = document.currentScript!.getAttribute('data-channel');
  let enabled = false, selected: HTMLTableElement | null = null, index = -1, widths: number[] = [];
  let handles: HTMLDivElement[] = [];
  const send = (type: string) => parent.postMessage({ type, channel, index, widths }, '*');
  const clear = () => { handles.forEach(h => h.remove()); handles = []; selected?.classList.remove('csync-selected'); };
  const place = () => {
    if (!selected) return;
    const rect = selected.getBoundingClientRect();
    const total = widths.reduce((a, b) => a + b, 0);
    let left = rect.left + scrollX;
    handles.forEach((h, i) => {
      left += widths[i] / total * rect.width;
      Object.assign(h.style, { left: (left - 5) + 'px', top: (rect.top + scrollY) + 'px', height: rect.height + 'px' });
    });
  };
  const apply = () => {
    if (!selected) return;
    for (const group of Array.from(selected.children).filter(el => el.tagName === 'COLGROUP')) group.remove();
    const group = document.createElement('colgroup');
    widths.forEach(width => { const col = document.createElement('col'); col.style.width = width + 'px'; group.append(col); });
    selected.prepend(group);
    selected.style.width = widths.reduce((a, b) => a + b, 0) + 'px';
    selected.style.tableLayout = 'fixed';
    place();
  };
  const select = (table: HTMLTableElement, next: number, values: number[]) => {
    clear(); selected = table; index = next; widths = values.slice();
    selected.classList.add('csync-selected');
    widths.slice(1).forEach((_, i) => {
      const h = document.createElement('div'); h.className = 'csync-resize'; h.title = '열 너비 조절';
      h.onpointerdown = event => {
        event.preventDefault();
        const start = event.clientX, original = widths.slice();
        const scale = original.reduce((a, b) => a + b, 0) / selected!.getBoundingClientRect().width;
        h.setPointerCapture(event.pointerId);
        h.onpointermove = move => {
          const delta = Math.round((move.clientX - start) * scale);
          const change = Math.max(40 - original[i], Math.min(original[i + 1] - 40, delta));
          widths[i] = original[i] + change; widths[i + 1] = original[i + 1] - change;
          apply(); send('csync-table-change');
        };
        const end = () => { h.onpointermove = null; h.onpointerup = null; h.onpointercancel = null; };
        h.onpointerup = end; h.onpointercancel = end;
      };
      document.body.append(h); handles.push(h);
    });
    apply();
  };
  document.addEventListener('click', event => {
    if (!enabled || !(event.target instanceof Element)) return;
    const table = event.target.closest<HTMLTableElement>('table[data-csync-table]');
    if (!table) return;
    index = Number(table.dataset.csyncTable); send('csync-table-select');
  });
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    const data = event.data;
    if (data.type === 'csync-table-edit') {
      enabled = data.enabled === true; document.body.classList.toggle('csync-editing', enabled);
      if (!enabled) { clear(); selected = null; }
    }
    if (data.type === 'csync-table-widths' && enabled && Number.isInteger(data.index)
      && Array.isArray(data.widths) && data.widths.length <= 32 && data.widths.every((w: unknown) => typeof w === 'number' && Number.isInteger(w) && w >= 40 && w <= 3000)) {
      const table = document.querySelector<HTMLTableElement>(`table[data-csync-table="${data.index}"]`);
      if (!table) return;
      if (table === selected) { widths = data.widths.slice(); apply(); }
      else select(table, data.index, data.widths);
    }
  });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place);
}
