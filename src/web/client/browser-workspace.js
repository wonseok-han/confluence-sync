/** Browser-owned files, shared by the local worker and optional hosted execution transport. */
export const sha256=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
const allowed=path=>!path.split('/').some((p,i)=>p==='node_modules'||p==='.git'||(p.startsWith('.')&&!(i===0&&['.csync','.env','.confluence-sync.json','.confluence-workspace.json','.confluence-syncignore'].includes(p))));
const MAX_FILE=100*1024*1024,MAX_TOTAL=512*1024*1024;
function relativeFile(mounts,path){const mount=mounts.find(m=>path.startsWith(m.virtual+'/'));if(!mount)throw Error('선택한 폴더 밖의 파일입니다.');const parts=path.slice(mount.virtual.length+1).split('/');if(parts.some(p=>!p||p==='.'||p==='..'||p.includes('\\')))throw Error('잘못된 파일 경로입니다.');return {mount,parts};}
async function fileHandle(mounts,path,create=false){const {mount,parts}=relativeFile(mounts,path);let directory=mount.handle;for(const part of parts.slice(0,-1))directory=await directory.getDirectoryHandle(part,{create});return {directory,name:parts.at(-1),handle:await directory.getFileHandle(parts.at(-1),{create})};}
const notFound=error=>error.name==='NotFoundError';
async function current(mounts,path){try{return new Uint8Array(await(await(await fileHandle(mounts,path)).handle.getFile()).arrayBuffer());}catch(error){if(notFound(error))return null;throw error;}}
async function write(mounts,path,bytes){const {handle}=await fileHandle(mounts,path,true);const stream=await handle.createWritable();try{await stream.write(bytes);await stream.close();}catch(error){await stream.abort().catch(()=>{});throw error;}}
async function remove(mounts,path){const {directory,name}=await fileHandle(mounts,path);await directory.removeEntry(name);}
export async function scanBrowserFiles(mounts,cache=new Map(),force=false){
 const entries=[];let total=0;
 async function walk(mount,directory,parents=[]){for await(const [name,handle] of directory.entries()){
  const rel=[...parents,name].join('/');if((mount.readonly&&rel==='.env')||!allowed(rel))continue;if(handle.kind==='directory'){await walk(mount,handle,[...parents,name]);continue;}
  const file=await handle.getFile();total+=file.size;if(file.size>MAX_FILE||total>MAX_TOTAL||entries.length>=20000)throw Error('작업공간 한도를 초과했습니다(파일 100MiB, 전체 512MiB, 20,000개).');
  const path=mount.virtual+'/'+rel,stamp=`${file.size}:${file.lastModified}`,prior=cache.get(path);const hash=!force&&prior?.stamp===stamp?prior.hash:await sha256(await file.arrayBuffer());cache.set(path,{stamp,hash});entries.push({path,size:file.size,hash,file});
 }}for(const mount of mounts)await walk(mount,mount.handle);return entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
/** Preflight all affected files; on partial failure roll back only unchanged writes. */
export async function applyBrowserChanges(mounts,baseline,changes,download){
 const old=new Map(baseline.map(f=>[f.path,f.hash])),writes=[];const plan=[...changes.files.map(f=>({...f,remove:false})),...changes.removed.map(path=>({path,remove:true}))];
 plan.sort((a,b)=>(a.path.includes('/.csync/')?3:a.path.endsWith('.md')?2:1)-(b.path.includes('/.csync/')?3:b.path.endsWith('.md')?2:1));
 for(const item of plan){const {mount}=relativeFile(mounts,item.path);if(mount.readonly)throw Error('참조 폴더는 수정할 수 없습니다.');const before=await current(mounts,item.path),hash=before?await sha256(before):undefined;if((!item.remove&&hash===item.hash)||(item.remove&&!before)){item.skip=true;continue;}if(hash!==old.get(item.path))throw Error(`작업 중 로컬 파일이 바뀌었습니다: ${item.path}`);item.before=before;item.beforeHash=hash;if(!item.remove){item.bytes=new Uint8Array(await download(item.path));if(await sha256(item.bytes)!==item.hash)throw Error('결과 파일이 바뀌었습니다. 다시 시도하세요.');}}
 try{for(const item of plan){if(item.skip)continue;const now=await current(mounts,item.path);if((now?await sha256(now):undefined)!==item.beforeHash)throw Error(`저장 직전 로컬 파일이 바뀌었습니다: ${item.path}`);writes.push(item);if(item.remove){if(now)await remove(mounts,item.path);}else await write(mounts,item.path,item.bytes);}}
 catch(error){const incomplete=[];for(const item of writes.reverse()){try{const now=await current(mounts,item.path);const hash=now?await sha256(now):undefined;if(hash===item.beforeHash)continue;if(hash!==(item.remove?undefined:item.hash)){incomplete.push(item.path);continue;}if(item.before)await write(mounts,item.path,item.before);else if(now)await remove(mounts,item.path);}catch{incomplete.push(item.path);}}if(incomplete.length)throw Error(`${error.message} 추가 편집 또는 복원 실패로 확인이 필요한 파일: ${incomplete.join(', ')}`);throw error;}
}
function database(){return new Promise((resolve,reject)=>{const request=indexedDB.open('csync.browser-folders',1);request.onupgradeneeded=()=>request.result.createObjectStore('workspace');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function remembered(value,key='active'){const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('workspace',value===undefined?'readonly':'readwrite'),store=tx.objectStore('workspace'),request=value===undefined?store.get(key):value===null?store.delete(key):store.put(value,key);let result;request.onsuccess=()=>{result=request.result};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);});}finally{db.close();}}
export function createBrowserWorkspace({document=globalThis.document,window=globalThis.window,location=globalThis.location,storage=globalThis.sessionStorage,fetch=globalThis.fetch,remember=remembered,pickDirectory=options=>window.showDirectoryPicker(options)}={}){
 const $=id=>document.getElementById(id),dialog=$('browser-folder-dialog'),note=$('browser-folder-status'),applyDialog=$('browser-apply-dialog');
 let session,mounts=[],baseline=[],running=false,queue=Promise.resolve(),cache=new Map(),resolveReady,pending=false;
 const ready=new Promise(resolve=>{resolveReady=resolve}),sessionKey='csync.browser-session.v1';
 const enqueue=task=>{const next=queue.catch(()=>{}).then(task);queue=next;return next;};
 const save=async()=>{storage.setItem(sessionKey,JSON.stringify(session));await remember({mounts,baseline},session.id);};
 const grant=async(handle,readonly=false)=>{const mode=readonly?'read':'readwrite';if(await handle.queryPermission({mode})!=='granted'&&await handle.requestPermission({mode})!=='granted')throw Error('선택한 폴더의 읽기·쓰기 권한을 허용하세요.');};
 async function raw(path,body,method=body?'POST':'GET'){
  const response=await fetch(path,{method,credentials:'omit',headers:{...(session?{'X-Csync-Session':session.id,'X-Csync-Token':session.token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'작업 요청에 실패했습니다.'),{code:data.code,status:response.status,conflicts:data.conflicts,inPlace:data.inPlace,output:data.output});return data;
 }
 const headers=()=>({'X-Csync-Session':session.id,'X-Csync-Token':session.token});
 async function flush(){
  const changes=await raw('/api/browser/changes');if(!changes.files.length&&!changes.removed.length)return;
  try{pending=true;await applyBrowserChanges(mounts,baseline,changes,async path=>{const response=await fetch('/api/browser/file?path='+encodeURIComponent(path),{headers:headers(),credentials:'omit'});if(!response.ok)throw Error('결과 파일을 받지 못했습니다.');return response.arrayBuffer();});await raw('/api/browser/ack',{files:changes.snapshot});baseline=changes.snapshot;cache.clear();await save();pending=false;applyDialog.close();}
  catch(error){$('browser-apply-status').textContent=error.message;if(!applyDialog.open)applyDialog.showModal();throw error;}
 }
 $('browser-apply-retry').onclick=async()=>{if(running)return;try{for(const m of mounts)if(!m.readonly)await grant(m.handle);await enqueue(flush);}catch(error){$('browser-apply-status').textContent=error.message;}};
 applyDialog.addEventListener('cancel',event=>event.preventDefault());
 async function mirror(force=false){
  if(pending)throw Error('보류 중인 로컬 파일 적용을 먼저 완료하세요.');await flush();const files=await scanBrowserFiles(mounts,cache,force),manifest=files.map(({path,size,hash})=>({path,size,hash}));if(JSON.stringify(manifest)===JSON.stringify(baseline))return;
  const plan=await raw('/api/browser/mirror',{files:manifest});
  for(const item of plan.uploads){const source=files.find(f=>f.path===item.path);const response=await fetch('/api/browser/file?path='+encodeURIComponent(item.path),{method:'PUT',headers:headers(),credentials:'omit',body:source.file});if(!response.ok){const data=await response.json();throw Error(data.error||'파일 전송에 실패했습니다.');}}
  await raw('/api/browser/commit',{});baseline=manifest;await save();
 }
 const unlock=()=>{$('workspace-interface').inert=false;$('local-connection-status').textContent=mounts[0].handle.name+' · 브라우저 폴더';dialog.close();resolveReady();};
 const open=async()=>{await mirror();unlock();};
 const resume=async()=>{const job=await raw('/api/sync/job');running=job.job?.state==='running';if(running)unlock();else await open();};
 async function chooseBase(handle){
  if(running||pending)throw Error('진행 중인 작업을 먼저 완료하세요.');$('browser-folder-open').disabled=true;note.textContent='선택한 문서·첨부를 임시 작업공간에 준비하는 중…';
  try{
   if(session){await flush();await raw('/api/browser/session',undefined,'DELETE');await remember(null,session.id);}
   session=await raw('/api/browser/session',{name:handle.name});mounts=[{virtual:session.base,handle}];baseline=[];cache.clear();await save();await open();return {path:session.base};
  }finally{$('browser-folder-open').disabled=false;}
 }
 const chooseMount=async(kind,handle)=>{
  if(running||pending)throw Error('진행 중인 작업을 먼저 완료하세요.');
  if(kind==='out'&&await mounts[0].handle.isSameEntry(handle))return {path:session.base};
  for(const m of mounts){if(kind==='out'&&m.virtual===session.output)continue;if(kind==='reference'&&m.readonly&&await m.handle.isSameEntry(handle))return {path:m.virtual};if(await m.handle.isSameEntry(handle)||await m.handle.resolve(handle)!==null||await handle.resolve(m.handle)!==null)throw Error('문서·출력·참조 폴더는 서로 겹치지 않는 별도 폴더로 선택하세요.');}
  const virtual=kind==='out'?session.output:(await raw('/api/browser/mount',{kind:'reference'})).path;
  mounts=mounts.filter(m=>m.virtual!==virtual);mounts.push({virtual,handle,readonly:kind==='reference'});await save();await mirror();return {path:virtual};
 };
 // Keep the native picker in the user's gesture; queue only state changes and
 // file transfer, including restoration, so mirrors cannot replace one another.
 const selectFolder=async kind=>{
  const handle=await pickDirectory({mode:kind==='reference'?'read':'readwrite'});await grant(handle,kind==='reference');
  return enqueue(()=>kind==='base'?chooseBase(handle):chooseMount(kind,handle));
 };
 async function operation(path,options){
  if(pending)throw Error('보류 중인 로컬 파일 적용을 먼저 완료하세요.');
  const route=path.split('?')[0],body=options.body?JSON.parse(options.body):undefined;
  if(route==='/api/open')return {ok:true,name:(body.path?.startsWith(session.base)?mounts[0]:mounts.find(m=>m.virtual===session.output))?.handle.name??'출력 폴더'};
  if(route==='/api/convert'&&!body.preview&&body.out!==body.base&&!mounts.some(m=>m.virtual===session.output))throw Error('변환 결과를 저장할 출력 폴더를 먼저 선택하세요.');
  if(route!=='/api/sync/job'&&!running)await mirror(route!=='/api/sync/staging');
  let result;
  try{result=await raw(path,body,options.method??(body?'POST':'GET'));}catch(error){if(!running)await flush();throw error;}
  if(result.job)running=result.job.state==='running';
  if(!running)await flush();return result;
 }
 const request=(path,options={})=>{
  if(path==='/api/pick-folder'){
   const {kind}=JSON.parse(options.body);return (async()=>{if(running||pending)throw Error('진행 중인 작업을 먼저 완료하세요.');if(kind==='base'){const result=await selectFolder('base');location.reload();return new Response(JSON.stringify(result));}return new Response(JSON.stringify(await selectFolder(kind)));})();
  }
  const next=enqueue(()=>operation(path,options));return next.then(result=>new Response(JSON.stringify(result))).catch(error=>new Response(JSON.stringify({error:error.message,code:error.code,conflicts:error.conflicts,inPlace:error.inPlace,output:error.output}),{status:error.status??400}));
 };
 $('local-disconnect').hidden=false;$('local-disconnect').textContent='폴더 연결 해제';$('local-disconnect').onclick=()=>enqueue(async()=>{try{if(running||pending)throw Error('작업과 로컬 파일 적용을 먼저 완료하세요.');if(session){await raw('/api/browser/session',undefined,'DELETE');await remember(null,session.id);}storage.removeItem(sessionKey);location.reload();}catch(error){note.textContent=error.message;dialog.showModal();}});
 const outputHint=$('out-mode-hint');if(outputHint)outputHint.textContent='별도 폴더 또는 원본 덮어쓰기';
 $('workspace-interface').inert=true;dialog.addEventListener('cancel',event=>event.preventDefault());$('root-path-editor').hidden=true;$('out-input').readOnly=true;$('out-input').placeholder='브라우저에서 출력 폴더를 선택하세요';$('open').textContent='저장 위치 확인';
 $('browser-folder-open').onclick=()=>selectFolder('base').catch(error=>{if(error.name!=='AbortError')note.textContent=error.message;});
 $('browser-folder-resume').onclick=async()=>{try{for(const mount of mounts)await grant(mount.handle,mount.readonly);await enqueue(resume);}catch(error){note.textContent=error.message;}};
 window.addEventListener('beforeunload',event=>{if(running||pending){event.preventDefault();event.returnValue='';}});
 if(!window.isSecureContext||!window.showDirectoryPicker){note.textContent='폴더 읽기·쓰기를 지원하는 데스크톱 Chrome 또는 Edge에서 HTTPS 주소로 접속하세요.';$('browser-folder-open').disabled=true;dialog.showModal();}
 else{
  $('local-connection-status').textContent='저장된 폴더 연결을 확인하는 중…';
  enqueue(async()=>{
   let stored;
   try{session=JSON.parse(storage.getItem(sessionKey));stored=session?await remember(undefined,session.id):undefined;}
   catch{note.textContent='저장된 폴더 연결 정보를 확인할 수 없습니다. 폴더를 다시 선택하세요.';}
   if(!session||!stored?.mounts?.length){$('local-connection-status').textContent='브라우저 폴더 선택 필요';dialog.showModal();return;}
   mounts=stored.mounts;baseline=stored.baseline??[];
   let granted=true;for(const mount of mounts)if(await mount.handle.queryPermission({mode:mount.readonly?'read':'readwrite'})!=='granted')granted=false;
   if(!granted){$('local-connection-status').textContent='폴더 접근 권한 확인 필요';$('browser-folder-resume').hidden=false;note.textContent='이전에 선택한 폴더가 저장되어 있습니다. 다시 선택할 필요 없이 접근 권한을 허용하세요.';dialog.showModal();return;}
   $('local-connection-status').textContent=mounts[0].handle.name+' · 연결을 복원하는 중…';
   try{await resume();}
   catch(error){
    if([401,410].includes(error.status)){await remember(null,session.id);session=undefined;baseline=[];storage.removeItem(sessionKey);note.textContent='작업공간을 다시 연결해야 합니다. 폴더를 다시 선택하세요.';}
    else note.textContent='이전 폴더 연결을 복원하지 못했습니다: '+error.message;
    $('local-connection-status').textContent='폴더 연결 확인 필요';dialog.showModal();
   }
  }).catch(error=>{note.textContent=error.message;$('local-connection-status').textContent='폴더 연결 확인 필요';dialog.showModal();});
 }
 return {ready,request,browser:true,remote:false};
}
