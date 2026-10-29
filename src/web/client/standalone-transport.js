/** Request-compatible transport into a dedicated worker. Documents never go to this site's API. */
import { renderBrowserPdf } from './pdf-renderer.js';
export function createStandaloneTransport({worker=new Worker('/assets/workspace.worker.js',{type:'module'}),timeoutMs=180_000}={}){
 let next=0,failed=false;const pending=new Map();
 const fail=message=>{failed=true;for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error(message));}pending.clear();};
 worker.addEventListener('error',()=>fail('브라우저 실행기를 시작할 수 없습니다. 페이지를 새로고침하세요.'));
 worker.addEventListener('message',async({data})=>{
  if(data.kind==='pdf'){try{const pages=await renderBrowserPdf(data.request);worker.postMessage({kind:'pdf-result',id:data.id,pages},pages);}catch(error){worker.postMessage({kind:'pdf-result',id:data.id,error:error.message});}return;}
  const item=pending.get(data.id);if(!item)return;pending.delete(data.id);clearTimeout(item.timer);if(data.error)item.reject(Error(data.error));else item.resolve(new Response(data.body,{status:data.status,headers:data.headers}));});
 return async(path,options={})=>{
  if(failed)throw Error('브라우저 실행기가 중단되었습니다. 페이지를 새로고침하세요.');
  const url=new URL(path,'https://local.invalid');if(url.origin!=='https://local.invalid'||!url.pathname.startsWith('/api/'))throw Error('잘못된 브라우저 요청입니다.');
  let body=options.body;if(body instanceof Blob)body=await body.arrayBuffer();
  const id=++next;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('브라우저 요청이 지연되고 있습니다. 작업 내역을 확인한 후 다시 시도하세요.'));},timeoutMs);pending.set(id,{resolve,reject,timer});worker.postMessage({id,path,method:options.method??'GET',headers:Object.fromEntries(new Headers(options.headers)),body},body instanceof ArrayBuffer?[body]:[]);});
 };
}
