/** Confirmation only; saving starts after the caller receives explicit approval. */
export function createOverwriteDialog(document = globalThis.document) {
  const $ = id => document.getElementById(id), dialog = $('overwrite-dialog');
  let pending;
  const finish = approved => {
    const resolve = pending;
    pending = undefined;
    dialog.close();
    resolve?.(approved);
  };
  $('overwrite-cancel').onclick = () => finish(false);
  $('overwrite-confirm').onclick = () => finish(true);
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
  dialog.addEventListener('close', () => { const resolve = pending; pending = undefined; resolve?.(false); });
  return ({ conflicts, inPlace, output }) => {
    if (pending) throw Error('덮어쓰기 확인이 이미 진행 중입니다.');
    $('overwrite-title').textContent = `${inPlace ? '원본' : '기존'} 파일 ${conflicts.length}개 덮어쓰기`;
    $('overwrite-path').textContent = output;
    $('overwrite-warning').textContent = `${inPlace ? '선택한 원본' : '출력 폴더의 기존'} 내용이 변환 결과로 교체됩니다.${inPlace ? ' 확인 이후 원본이 바뀌면 저장을 중단합니다.' : ''} 취소하면 저장하지 않습니다.`;
    $('overwrite-files').replaceChildren(...conflicts.map(({ path }) => {
      const item = document.createElement('li'); item.textContent = path; return item;
    }));
    return new Promise(resolve => { pending = resolve; dialog.showModal(); $('overwrite-cancel').focus(); });
  };
}
