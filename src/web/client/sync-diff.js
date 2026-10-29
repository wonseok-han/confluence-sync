/** Opening a diff reads the selected current remote body; new documents compare to empty. */
export function createSyncDiff({api,selection,monaco,loadMonaco=async()=>monaco,notify}) {
  const $=id=>document.getElementById(id);
  let path='',generation=0,editor,beforeModel,afterModel;
  function close(){generation++;$('sync-diff-dialog').close();}
  $('sync-diff-close').onclick=close;
  $('sync-diff-dialog').addEventListener('cancel',()=>{generation++;});
  async function load(remote=false) {
    const current=++generation,request={...selection(),path,remote};
    $('sync-diff-note').textContent=remote?'선택한 페이지 본문만 조회하고 있습니다…':'저장된 로컬 비교 기준을 확인하고 있습니다…';
    if(remote)$('sync-diff-remote').textContent='원격 비교 다시 시도';
    $('sync-diff-remote').disabled=true;$('sync-diff-editor').hidden=true;$('sync-diff-labels').hidden=true;
    try {
      let data=await api('/api/sync/diff',request);
      if(current!==generation||!$('sync-diff-dialog').open)return;
      if(!remote && data.before===null && data.canRemote){
        $('sync-diff-note').textContent='저장된 기준본이 없어 선택한 원격 페이지 본문을 조회하고 있습니다…';
        $('sync-diff-remote').hidden=false;
        $('sync-diff-remote').textContent='원격 비교 다시 시도';
        data=await api('/api/sync/diff',{...request,remote:true});
        if(current!==generation||!$('sync-diff-dialog').open)return;
      }
      $('sync-diff-note').textContent=data.note;
      $('sync-diff-before-label').textContent=data.source==='remote'?'현재 원격 본문 (근사 변환)':data.source==='new'?'새 문서 (원격 없음)':'마지막 동기화 기준';
      $('sync-diff-remote').hidden=!data.canRemote;
      $('sync-diff-remote').textContent=data.source==='remote'?'원격 새로고침':'원격과 비교 · 본문 1회 조회';
      if(data.before===null)return;
      $('sync-diff-editor').hidden=false;$('sync-diff-labels').hidden=false;
      if(!editor){
        const monaco=await loadMonaco();
        if(current!==generation||!$('sync-diff-dialog').open)return;
        beforeModel=monaco.editor.createModel('','markdown');afterModel=monaco.editor.createModel('','markdown');
        editor=monaco.editor.createDiffEditor($('sync-diff-editor'),{automaticLayout:true,readOnly:true,originalEditable:false,ignoreTrimWhitespace:false,renderSideBySide:true,useInlineViewWhenSpaceIsLimited:true,renderSideBySideInlineBreakpoint:700,minimap:{enabled:false},wordWrap:'on',scrollBeyondLastLine:false,fontSize:12});
        editor.setModel({original:beforeModel,modified:afterModel});
        editor.getOriginalEditor().updateOptions({ariaLabel:'기준 Markdown'});editor.getModifiedEditor().updateOptions({ariaLabel:'현재 로컬 Markdown'});
      }
      beforeModel.setValue(data.before);afterModel.setValue(data.after);editor.layout();
    }catch(error){if(current===generation){$('sync-diff-note').textContent=error.message;notify(error.message,'error');}}
    finally{if(current===generation)$('sync-diff-remote').disabled=false;}
  }
  $('sync-diff-remote').onclick=()=>load(true);
  return {open:async (selected,remote=true)=>{path=selected;$('sync-diff-path').textContent=path;$('sync-diff-remote').hidden=!remote;$('sync-diff-dialog').showModal();await load(remote);}};
}
