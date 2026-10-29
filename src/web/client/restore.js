/** Explicit, confirmed remote recovery. Opening or cancelling never writes documents. */
export function createRestore({api,selection,setBusy,isBusy,status,start}) {
  const $=id=>document.getElementById(id);
  const dialog=$('sync-restore-dialog');
  let approval;
  const identity=()=>JSON.stringify(selection());
  function reset(){approval=undefined;dialog.close();}
  async function open(path,overwrite){
    if(isBusy())return;
    const origin=identity(),request=selection();setBusy(true);
    try {
      const result=await api('/api/sync/restore',{...request,path,overwrite});
      if(origin!==identity())return;
      approval={request,confirmationId:result.confirmationId,identity:origin};
      $('sync-restore-title').textContent=overwrite?'로컬 수정을 버리고 원격 최신으로 되돌릴까요?':'누락된 문서를 원격에서 다시 받을까요?';
      $('sync-restore-path').textContent=result.path;
      $('sync-restore-warning').textContent=overwrite?'이 문서와 원격에서 참조하는 첨부의 로컬 수정이 사라집니다. 원격 최신 내용으로 교체하며 다른 문서는 유지합니다.':'지정한 문서와 참조 첨부만 다시 받습니다. 기존 파일과 내용이 다른 기존 첨부는 덮어쓰지 않습니다.';
      $('sync-restore-warning').textContent+=` 가져오기 형식: ${request.format==='obsidian'?'Obsidian':'Markdown'}.`;
      $('sync-restore-confirm').textContent=overwrite?'로컬 수정 버리고 원복':'원격에서 복구';
      dialog.showModal();$('sync-restore-cancel').focus();
    }catch(error){status(error.message,true);}finally{setBusy(false);}
  }
  $('sync-restore-cancel').onclick=reset;
  dialog.addEventListener('cancel',reset);
  $('sync-restore-confirm').onclick=async()=>{
    if(!approval||isBusy())return;
    if(approval.identity!==identity()){reset();status('대상이나 연결 설정이 바뀌었습니다. 복구 대상을 다시 선택하세요.',true);return;}
    const approved=approval;reset();
    await start('restore',{...approved.request,confirmationId:approved.confirmationId});
  };
  return {open};
}
