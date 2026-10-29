import { createBrowserWorkspace } from './browser-workspace.js';
import { createStandaloneTransport } from './standalone-transport.js';
/** Static UI ↔ explicitly trusted loopback runner. No document data passes through hosting. */
export function loopbackEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('로컬 실행기 주소는 http://127.0.0.1:포트 형식이어야 합니다.');
  return url.origin;
}
export function createConnection({document=globalThis.document, location=globalThis.location, history=globalThis.history, storage=globalThis.sessionStorage, fetch=globalThis.fetch}={}) {
  const explicitConnector=new URLSearchParams(location.hash?.slice(1)).has('csyncEndpoint')||storage?.getItem('csync.connector.v1');
  if(document.querySelector('meta[name="csync-runtime"]')?.content==='standalone'&&!explicitConnector)return {...createBrowserWorkspace({fetch:createStandaloneTransport()}),standalone:true};
  if(document.querySelector('meta[name="csync-runtime"]')?.content==='browser')return createBrowserWorkspace();
  const $=id=>document.getElementById(id);
  const localToken=document.querySelector('meta[name="csync-token"]').content;
  let active=localToken?{endpoint:'',token:localToken}:null, resolveReady;
  const ready=active?Promise.resolve():new Promise(resolve=>{resolveReady=resolve});
  const key='csync.connector.v1';
  const request=(path,options={})=>{
    if(!active)throw new Error('먼저 로컬 실행기를 연결하세요.');
    if(!path.startsWith('/api/') || path.startsWith('//'))throw new Error('로컬 API 경로를 확인하세요.');
    return fetch(active.endpoint+path,{...options,headers:{...options.headers,'X-Csync-Token':active.token},credentials:'omit',redirect:'error',...(active.endpoint?{targetAddressSpace:'loopback'}:{})});
  };
  const disconnect=()=>{try{storage.removeItem(key)}catch{}active=null;location.reload();};
  $('local-disconnect').onclick=disconnect;
  if(active)return {ready,request,remote:false};
  $('local-disconnect').hidden=false;
  const dialog=$('local-connect-dialog'),form=$('local-connect-form'),note=$('local-connect-note');
  $('local-connect-command').textContent=`csync web --ui ${JSON.stringify(location.origin+location.pathname)} --base "/문서폴더"`;
  let pending=false;
  async function connect(endpoint,token) {
    if(pending)return;
    pending=true;$('local-connect-submit').disabled=true;note.textContent='로컬 실행기에 연결하는 중…';
    try {
      endpoint=loopbackEndpoint(endpoint);
      if(!/^[a-f0-9]{64}$/.test(token))throw new Error('csync가 출력한 연결 링크를 사용하거나 연결 키를 입력하세요.');
      const response=await fetch(endpoint+'/api/connection',{headers:{'X-Csync-Token':token},credentials:'omit',redirect:'error',targetAddressSpace:'loopback',signal:AbortSignal.timeout(15000)});
      const data=await response.json();if(!response.ok)throw new Error(data.error||'연결 권한을 확인하세요.');
      if(data.mode!=='connector')throw new Error('csync web --ui로 실행한 로컬 실행기에 연결하세요.');
      const expected=document.querySelector('meta[name="csync-version"]').content;
      if(data.version!==expected)throw new Error(`웹(v${expected})과 로컬 실행기(v${data.version}) 버전이 다릅니다. 같은 버전으로 실행하세요.`);
      active={endpoint,token};try{storage.setItem(key,JSON.stringify(active))}catch{}
      $('local-connection-status').textContent='내 컴퓨터에 연결됨';dialog.close();$('workspace-interface').inert=false;resolveReady();
    } catch(error) {
      active=null;try{storage.removeItem(key)}catch{}
      note.textContent=error.name==='TypeError'||error.name==='TimeoutError'?'연결할 수 없습니다. 로컬 csync 실행 여부와 브라우저의 로컬 네트워크 접근 권한을 확인하세요.':error.message;
      dialog.showModal();
    } finally {pending=false;$('local-connect-submit').disabled=false;}
  }
  dialog.addEventListener('cancel',event=>event.preventDefault());
  form.onsubmit=event=>{event.preventDefault();return connect($('local-connect-endpoint').value.trim(),$('local-connect-token').value.trim());};
  $('workspace-interface').inert=true;
  const hash=new URLSearchParams(location.hash.slice(1));
  const endpoint=hash.get('csyncEndpoint'),token=hash.get('csyncToken');
  if(endpoint!==null||token!==null){
    history.replaceState(null,'',location.pathname+location.search);
    $('local-connect-endpoint').value=endpoint??'';$('local-connect-token').value=token??'';
    dialog.showModal();
  }else{
    let saved;try{saved=JSON.parse(storage.getItem(key))}catch{}
    if(saved?.endpoint&&saved?.token)connect(saved.endpoint,saved.token);
    else dialog.showModal();
  }
  return {ready,request,remote:true};
}
