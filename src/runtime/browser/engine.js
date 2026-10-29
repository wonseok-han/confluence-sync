import { createWorkspaceApi } from '../../web/workspace-api.js';
import { convert, runSyncCLI } from './runner.js';
import { resetFilesystem, mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, exportFilesystem, importFilesystem, filesystemRevision } from './filesystem.js';
import { sessionStore } from './session-store.js';
import { bindConfluenceTransport } from './network.js';
import { snapshot, digest, safeRelative, pathIn, permitted, commitMirror, validateWorkspace, validateEnv, MAX_FILE, MAX_TOTAL, MAX_FILES } from '../../web/hosted-files.js';
import { process } from './globals.js';

/** One engine per worker/tab, with the same mirror/apply protocol as hosted mode. */
export function createStandaloneEngine({store=sessionStore,fetch}={}){
 bindConfluenceTransport(fetch);
 let session,api,mounts=[],baseline=[],transaction,lastJob=null,lastSaved='',imports=[];
 const setup=()=>{process.chdir(session.base);api=createWorkspaceApi({start:session.base,syncRunner:runSyncCLI,connectionImports:imports,convert,open:async()=>{},pickFolder:async()=>{throw Error('브라우저 폴더 선택을 사용하세요.');}});};
 const cache=new Map();
 const changes=async()=>{const files=await snapshot(mounts,cache),before=new Map(baseline.map(f=>[f.path,f.hash])),after=new Set(files.map(f=>f.path));return {files:files.filter(f=>before.get(f.path)!==f.hash),removed:baseline.filter(f=>!after.has(f.path)).map(f=>f.path),snapshot:files};};
 const respond=(status,value)=>({status,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
 const dispatch=async({path,method='GET',headers={},body})=>{
  try{
   const url=new URL(path,'https://local.invalid');let input=typeof body==='string'?JSON.parse(body):body;
   if(url.pathname==='/api/browser/session'&&method==='POST'){
    if(api?.isRunning())throw Error('작업 완료 후 폴더를 변경하세요.');
    const name=safeRelative(String(input.name??'문서'));if(name.includes('/'))throw Error('폴더 이름을 확인하세요.');
    resetFilesystem();cache.clear();transaction=undefined;mkdirSync('/workspace');mkdirSync('/workspace/'+name);mkdirSync('/output');
    process.chdir('/workspace/'+name);session={id:crypto.randomUUID(),token:crypto.randomUUID(),base:'/workspace/'+name,output:'/output',version:__CSYNC_VERSION__};
    mounts=[{virtual:session.base,root:session.base},{virtual:'/output',root:'/output'}];baseline=[];
    lastJob=null;lastSaved='';imports=[];setup();
    return respond(201,session);
   }
   if(!session&&headers['x-csync-session']){const saved=await store(headers['x-csync-session']);if(saved&&saved.session.token===headers['x-csync-token']){({session,mounts,baseline,lastJob}=saved);imports=saved.imports??[];importFilesystem(saved.files);setup();if(lastJob?.state==='running')lastJob={...lastJob,state:'failed',planId:null,log:lastJob.log+'\n브라우저 종료로 작업이 중단되었습니다. Fetch로 원격 상태를 확인한 후 다시 시도하세요.\n'};}}
   if(!session||headers['x-csync-session']!==session.id||headers['x-csync-token']!==session.token)return respond(401,{error:'브라우저 작업공간을 다시 연결하세요.'});
   if(url.pathname==='/api/browser/session'&&method==='DELETE'){if(api.isRunning())throw Error('작업 완료 후 연결을 해제하세요.');await store(session.id,null);resetFilesystem();session=undefined;return respond(200,{ok:true});}
   if(url.pathname==='/api/browser/changes'){if(api.isRunning())throw Error('작업 완료 후 결과를 반영하세요.');return respond(200,await changes());}
   if(url.pathname==='/api/browser/file'&&method==='GET'){const bytes=readFileSync(pathIn(mounts,url.searchParams.get('path')??''));return {status:200,headers:{'Content-Type':'application/octet-stream'},body:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};}
   if(api.isRunning()&&url.pathname!=='/api/sync/job')return respond(409,{error:'다른 작업이 진행 중입니다.'});
   if(url.pathname==='/api/browser/mount'&&method==='POST'){
    if(input.kind!=='reference'||mounts.filter(m=>m.readonly).length>=8)throw Error('참조 폴더를 확인하세요.');
    const root='/references/'+crypto.randomUUID();mkdirSync(root,{recursive:true});mounts.push({virtual:root,root,readonly:true});return respond(201,{path:root});
   }
   if(url.pathname==='/api/browser/ack'&&method==='POST'){
    const value=await changes();if(JSON.stringify(input.files)!==JSON.stringify(value.snapshot))throw Error('결과 파일이 바뀌었습니다. 다시 확인하세요.');baseline=value.snapshot;return respond(200,{ok:true});
   }
   if(url.pathname==='/api/browser/mirror'&&method==='POST'){
    const pending=await changes();if(pending.files.length||pending.removed.length)return respond(409,{error:'실행 결과를 로컬에 먼저 반영하세요.',code:'APPLY_PENDING'});
    if(!Array.isArray(input.files)||input.files.length>MAX_FILES)throw Error('파일 목록 한도를 확인하세요.');
    const seen=new Set();let total=0;
    for(const f of input.files){if(typeof f.path!=='string'||!Number.isSafeInteger(f.size)||f.size<0||f.size>MAX_FILE||!/^[a-f0-9]{64}$/.test(f.hash)||seen.has(f.path))throw Error('파일 목록을 확인하세요.');pathIn(mounts,f.path);const mount=mounts.find(m=>f.path.startsWith(m.virtual+'/'));if(!mount||!permitted(f.path.slice(mount.virtual.length+1)))throw Error('지원하지 않는 파일 경로입니다.');seen.add(f.path);total+=f.size;}
    if(total>MAX_TOTAL)throw Error('작업공간이 512MiB를 초과했습니다.');
    if(transaction)rmSync(transaction.stage,{recursive:true,force:true});const old=new Map(baseline.map(f=>[f.path,f.hash]));transaction={stage:mkdtempSync('/tmp/mirror-'),manifest:input.files,uploads:input.files.filter(f=>old.get(f.path)!==f.hash),received:new Set()};return respond(200,{uploads:transaction.uploads});
   }
   if(url.pathname==='/api/browser/file'&&method==='PUT'){
    const at=transaction?.uploads.findIndex(f=>f.path===url.searchParams.get('path'))??-1;if(at<0)throw Error('파일 전송을 다시 시작하세요.');
    const bytes=new Uint8Array(body),file=transaction.uploads[at];if(bytes.length!==file.size||digest(bytes)!==file.hash)throw Error('파일 전송 중 내용이 바뀌었습니다.');writeFileSync(transaction.stage+'/'+at,bytes);transaction.received.add(file.path);return respond(200,{ok:true});
   }
   if(url.pathname==='/api/browser/commit'&&method==='POST'){
    if(!transaction||transaction.received.size!==transaction.uploads.length)throw Error('파일 전송을 먼저 완료하세요.');const keep=new Set(transaction.manifest.map(f=>f.path));await commitMirror(mounts,transaction.stage,transaction.uploads,baseline.filter(f=>!keep.has(f.path)).map(f=>f.path));baseline=await snapshot(mounts,cache);rmSync(transaction.stage,{recursive:true,force:true});transaction=undefined;return respond(200,{ok:true});
   }
   if(url.pathname==='/api/sync/env/import')validateEnv(input.text);
   if(input)for(const field of ['base','file','out'])if(typeof input[field]==='string'&&input[field])pathIn(mounts,input[field]);
   if(input?.base&&input.base!==session.base&&!input.base.startsWith(session.base+'/'))throw Error('문서 폴더를 기준으로 작업하세요.');
   if(input?.out&&mounts.some(m=>m.readonly&&(input.out===m.root||input.out.startsWith(m.root+'/'))))throw Error('참조 폴더는 읽기 전용입니다.');
   if(typeof input?.path==='string'&&input.path.startsWith('/'))pathIn(mounts,input.path);
   if(input?.referenceRoots)for(const root of input.referenceRoots)pathIn(mounts,root);
   if(url.pathname==='/api/browse'||url.pathname==='/api/search')pathIn(mounts,url.searchParams.get('path')||session.base);
   // Listing names does not follow document links. Validate their targets only
   // when processing documents, so one unrelated link cannot block navigation.
   if(!['/api/sync/config','/api/sync/job','/api/browse','/api/search'].includes(url.pathname))await validateWorkspace(mounts,url.pathname.startsWith('/api/sync/')&&!input?.envId&&!url.pathname.endsWith('/env/import'),url.pathname!=='/api/sync/fetch'&&!(url.pathname==='/api/sync/staging'&&input?.remoteOnly===true));
   const response=await api.request(method,url,input);
   if(url.pathname==='/api/browse'&&response.body.path===session.base){response.body.parent=session.base;response.body.home=session.base;}
   if(response.body?.job)lastJob=response.body.job;
   if(url.pathname==='/api/sync/job'&&!response.body.job)response.body.job=lastJob?{...lastJob,planId:null}:null;
   return respond(response.status,response.body);
  }catch(error){return respond(400,{error:error.message,code:error.code});}
 };
 return async request=>{const response=await dispatch(request);if(session&&!transaction&&(!api.isRunning()||/\/api\/sync\/(push|pull|preview|fetch|restore)$/.test(request.path))){
  imports=api.connectionImports();const signature=JSON.stringify([filesystemRevision(),baseline,lastJob,imports]);
  if(signature!==lastSaved){await store(session.id,{session,mounts,baseline,lastJob,imports,files:exportFilesystem()});lastSaved=signature;}
 }return response;};
}
