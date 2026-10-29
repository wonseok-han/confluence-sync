/** Browser-only deployment: same CLI core inside isolated, short-lived file workspaces. */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm,readFile,writeFile,realpath} from 'node:fs/promises';
import {join,resolve,dirname,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {startWeb,deployedUi} from './server.js';
import {webPage} from './views/workspace.js';
import {tableEditorBridge} from './table-editor-script.js';
import {readPkgVersion} from '../shared/version.js';
import {snapshot,pathIn,virtualPath,permitted,safeRelative,digest,validateWorkspace,validateEnv,commitMirror,MAX_FILE,MAX_TOTAL,MAX_FILES,type Mount,type FileEntry} from './hosted-files.js';
import type {SyncRunner} from './sync.js';
type Core=Awaited<ReturnType<typeof startWeb>>;
type Session={id:string;token:string;root:string;mounts:Mount[];core:Core;baseline:FileEntry[];cache:Map<string,{stamp:string;hash:string}>;touched:number;busy:boolean;transaction?:{stage:string;manifest:FileEntry[];uploads:FileEntry[];received:Set<string>}};
const index=(files:FileEntry[])=>new Map(files.map(f=>[f.path,f]));
async function body(req:IncomingMessage,max=16*1024*1024){let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw Error('요청 크기 한도를 초과했습니다.');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}
const jsonBody=async(req:IncomingMessage)=>{if(!req.headers['content-type']?.startsWith('application/json'))throw Error('JSON 요청이 필요합니다.');return JSON.parse((await body(req)).toString('utf8'));};
export async function startHostedWeb(options:{port?:number;host?:string;publicUrl?:string;ttlMs?:number;maxSessions?:number;syncRunner?:SyncRunner}={}){
 const sessions=new Map<string,Session>();let creating=0;const ttl=options.ttlMs??30*60_000;
 const publicOrigin=options.publicUrl?deployedUi(options.publicUrl).origin:undefined;
 const assets=resolve(fileURLToPath(new URL('../../dist/web/assets/',import.meta.url)));
 const bridgeHash=createHash('sha256').update(`(${tableEditorBridge.toString()})()`).digest('base64');
 const dispose=async(s:Session)=>{sessions.delete(s.id);s.core.server.closeAllConnections();await new Promise<void>(r=>s.core.server.close(()=>r()));await rm(s.root,{recursive:true,force:true});};
 const changes=async(s:Session)=>{const files=await snapshot(s.mounts,s.cache),old=index(s.baseline),now=index(files);return {files:files.filter(f=>old.get(f.path)?.hash!==f.hash),removed:s.baseline.filter(f=>!now.has(f.path)).map(f=>f.path),snapshot:files};};
 const server=createServer(async(req,res)=>{
  const send=(code:number,value:unknown)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'sha256-${bridgeHash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  let session:Session|undefined,locked=false;
  try{
   const url=new URL(req.url??'/','http://localhost');
   if(req.headers.origin&&req.headers.origin!==(publicOrigin??`http://${req.headers.host}`)){send(403,{error:'같은 웹 화면에서만 요청할 수 있습니다.'});return;}
   if(req.method==='GET'&&url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(webPage('browser','browser'));return;}
   if(req.method==='GET'&&url.pathname==='/healthz'){send(200,{ok:true});return;}
   if(req.method==='GET'&&url.pathname.startsWith('/assets/')){
    const file=resolve(assets,decodeURIComponent(url.pathname.slice(8)));if(!file.startsWith(assets+'/'))throw Error('잘못된 파일 경로입니다.');const types:Record<string,string>={'.js':'text/javascript','.css':'text/css','.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};if(!types[extname(file)]){send(404,{});return;}res.setHeader('Content-Type',types[extname(file)]);res.end(await readFile(file));return;
   }
   if(url.pathname==='/api/browser/session'&&req.method==='POST'){
    const input=await jsonBody(req);if(sessions.size+creating>=(options.maxSessions??8)){send(503,{error:'현재 작업공간이 가득 찼습니다. 잠시 후 다시 시도하세요.'});return;}
    const name=String(input.name??'문서');if(!name||name.length>255)throw Error('폴더 이름을 확인하세요.');safeRelative(name);if(name.includes('/'))throw Error('폴더 이름을 확인하세요.');
    creating++;
    let root:string|undefined;
    try{root=await realpath(await mkdtemp(join(tmpdir(),'csync-browser-')));await mkdir(join(root,'workspace'));await mkdir(join(root,'output'));const core=await startWeb({start:join(root,'workspace'),port:0,syncRunner:options.syncRunner});const s:Session={id:randomUUID(),token:randomBytes(32).toString('hex'),root,core,mounts:[{virtual:'/workspace/'+name,root:join(root,'workspace')},{virtual:'/output',root:join(root,'output')}],baseline:[],cache:new Map(),busy:false,touched:Date.now()};sessions.set(s.id,s);send(201,{id:s.id,token:s.token,base:s.mounts[0].virtual,output:'/output',version:readPkgVersion()});}catch(e){if(root)await rm(root,{recursive:true,force:true});throw e;}finally{creating--;}return;
   }
   const id=String(req.headers['x-csync-session']??'');session=sessions.get(id);
   if(!session||req.headers['x-csync-token']!==session.token){send(401,{error:'브라우저 작업공간을 다시 연결하세요.'});return;}
   const s=session;if(Date.now()-s.touched>ttl&&!s.core.isRunning()){await dispose(s);send(410,{error:'임시 작업공간이 만료되었습니다. 폴더를 다시 여세요.'});return;}s.touched=Date.now();
   if(s.busy){send(409,{error:'다른 브라우저 요청이 진행 중입니다.'});return;}s.busy=true;locked=true;
   if(url.pathname==='/api/browser/session'&&req.method==='DELETE'){if(s.core.isRunning())throw Error('작업 완료 후 연결을 해제하세요.');await dispose(s);send(200,{ok:true});return;}
   if(url.pathname==='/api/browser/mount'&&req.method==='POST'){
    if(s.core.isRunning())throw Error('작업 완료 후 폴더를 추가하세요.');const input=await jsonBody(req);if(input.kind!=='reference')throw Error('폴더 종류를 확인하세요.');const n=s.mounts.filter(m=>m.readonly).length;if(n>=8)throw Error('참조 폴더는 8개까지 추가할 수 있습니다.');const mount={virtual:'/references/'+randomUUID(),root:join(s.root,'reference-'+n),readonly:true};await mkdir(mount.root);s.mounts.push(mount);send(201,{path:mount.virtual});return;
   }
   if(url.pathname==='/api/browser/mirror'&&req.method==='POST'){
    if(s.core.isRunning())throw Error('작업 중에는 파일을 다시 전송할 수 없습니다.');const pending=await changes(s);if(pending.files.length||pending.removed.length){send(409,{error:'서버 결과를 로컬에 먼저 반영하세요.',code:'APPLY_PENDING'});return;}
    const {files}=await jsonBody(req);if(!Array.isArray(files)||files.length>MAX_FILES)throw Error('파일 목록 한도를 확인하세요.');const seen=new Set<string>();let total=0;
    for(const f of files){if(typeof f.path!=='string'||!Number.isSafeInteger(f.size)||f.size<0||f.size>MAX_FILE||typeof f.hash!=='string'||!/^[a-f0-9]{64}$/.test(f.hash)||seen.has(f.path))throw Error('파일 목록을 확인하세요.');const file=pathIn(s.mounts,f.path);const mount=s.mounts.find(m=>file.startsWith(m.root+'/'))!;if(!mount||!permitted(f.path.slice(mount.virtual.length+1)))throw Error('지원하지 않는 파일 경로입니다.');seen.add(f.path);total+=f.size;}if(total>MAX_TOTAL)throw Error('작업공간이 512MiB를 초과했습니다.');
    if(s.transaction)await rm(s.transaction.stage,{recursive:true,force:true});const before=index(s.baseline),uploads=files.filter(f=>before.get(f.path)?.hash!==f.hash);s.transaction={stage:await mkdtemp(join(s.root,'mirror-')),manifest:files,uploads,received:new Set()};send(200,{uploads});return;
   }
   if(url.pathname==='/api/browser/file'&&req.method==='PUT'){
    const tx=s.transaction,path=url.searchParams.get('path')??'',at=tx?.uploads.findIndex(f=>f.path===path)??-1;if(!tx||at<0)throw Error('파일 전송을 다시 시작하세요.');const bytes=await body(req,MAX_FILE),file=tx.uploads[at];if(bytes.length!==file.size||digest(bytes)!==file.hash)throw Error('파일 전송 중 내용이 바뀌었습니다. 다시 시도하세요.');await writeFile(join(tx.stage,String(at)),bytes);tx.received.add(path);send(200,{ok:true});return;
   }
   if(url.pathname==='/api/browser/commit'&&req.method==='POST'){
    const tx=s.transaction;if(!tx||tx.received.size!==tx.uploads.length)throw Error('파일 전송을 먼저 완료하세요.');const remaining=new Set(tx.manifest.map(f=>f.path));await commitMirror(s.mounts,tx.stage,tx.uploads,s.baseline.filter(f=>!remaining.has(f.path)).map(f=>f.path));s.baseline=await snapshot(s.mounts,s.cache);await rm(tx.stage,{recursive:true,force:true});s.transaction=undefined;send(200,{ok:true});return;
   }
   if(url.pathname==='/api/browser/changes'&&req.method==='GET'){if(s.core.isRunning())throw Error('작업 완료 후 결과를 반영하세요.');const value=await changes(s);send(200,value);return;}
   if(url.pathname==='/api/browser/file'&&req.method==='GET'){const file=pathIn(s.mounts,url.searchParams.get('path')??'');const bytes=await readFile(file);if(bytes.length>MAX_FILE)throw Error('파일 크기를 확인하세요.');res.setHeader('Content-Type','application/octet-stream');res.end(bytes);return;}
   if(url.pathname==='/api/browser/ack'&&req.method==='POST'){const {files}=await jsonBody(req),now=await snapshot(s.mounts,s.cache);if(JSON.stringify(files)!==JSON.stringify(now))throw Error('반영 중 서버 파일이 바뀌었습니다. 다시 확인하세요.');s.baseline=now;send(200,{ok:true});return;}
   if(!url.pathname.startsWith('/api/')||!['GET','POST'].includes(req.method??'')){send(404,{});return;}
   if(s.transaction)throw Error('파일 전송을 먼저 완료하세요.');
   if(url.pathname!=='/api/sync/job'&&!s.core.isRunning()){const pending=await changes(s);if(pending.files.length||pending.removed.length){send(409,{error:'서버 결과를 로컬에 먼저 반영하세요.',code:'APPLY_PENDING'});return;}}
   if(['/api/pick-folder','/api/open'].includes(url.pathname))throw Error('브라우저에서 폴더를 선택하세요.');
   if(req.method==='POST'){
    const input=await jsonBody(req);if(url.pathname==='/api/sync/env/import')validateEnv(String(input.text??''));
    for(const key of ['base','file','out','start'])if(typeof input[key]==='string'){if(!input[key]&&['base','file'].includes(key))throw Error('브라우저 폴더를 먼저 선택하세요.');if(input[key])input[key]=pathIn(s.mounts,input[key]);}
    if(typeof input.path==='string'&&input.path.startsWith('/'))input.path=pathIn(s.mounts,input.path);
    if(input.base&&input.base!==s.mounts[0].root&&!input.base.startsWith(s.mounts[0].root+'/'))throw Error('문서 폴더를 기준으로 작업하세요.');
    if(input.referenceRoots)input.referenceRoots=input.referenceRoots.map((path:string)=>pathIn(s.mounts,path));
    if(url.pathname==='/api/convert'&&!input.out){input.out=s.mounts[1].root;}
    if(!['/api/sync/config'].includes(url.pathname))await validateWorkspace(s.mounts,url.pathname.startsWith('/api/sync/')&&!input.envId&&!url.pathname.endsWith('/env/import'),url.pathname!=='/api/sync/fetch'&&!(url.pathname==='/api/sync/staging'&&input?.remoteOnly===true));
    const response=await fetch(s.core.url+url.pathname,{method:'POST',headers:{'X-Csync-Token':s.core.token,'Content-Type':'application/json'},body:JSON.stringify(input)});const data=await response.json();
    const mask=(value:any):any=>typeof value==='string'?s.mounts.reduce((v,m)=>v.split(m.root).join(m.virtual),value).split(s.root).join('(임시 작업공간)'):Array.isArray(value)?value.map(mask):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,mask(v)])):value;send(response.status,mask(data));return;
   }
   if(url.pathname==='/api/browse'||url.pathname==='/api/search')url.searchParams.set('path',pathIn(s.mounts,url.searchParams.get('path')||s.mounts[0].virtual));
   const response=await fetch(s.core.url+url.pathname+url.search,{headers:{'X-Csync-Token':s.core.token}});const data:any=await response.json();
   const mask=(value:any):any=>typeof value==='string'?s.mounts.reduce((v,m)=>v.split(m.root).join(m.virtual),value).split(s.root).join('(임시 작업공간)'):Array.isArray(value)?value.map(mask):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,mask(v)])):value;
   if(url.pathname==='/api/browse'){data.parent=data.path===s.mounts[0].root?s.mounts[0].root:data.parent;data.home=s.mounts[0].root;}send(response.status,mask(data));
  }catch(error){if(!res.writableEnded){const value=String((error as Error).message);send(400,{error:session?value.split(session.root).join('(임시 작업공간)'):value});}}
  finally{if(locked&&session)session.busy=false;}
 });
 const timer=setInterval(()=>{for(const s of sessions.values())if(!s.busy&&!s.core.isRunning()&&Date.now()-s.touched>ttl)void dispose(s);},Math.min(ttl,60_000));timer.unref();
 await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(options.port??8080,options.host??'0.0.0.0',done);});
 return {server,url:`http://127.0.0.1:${(server.address() as any).port}`,close:async()=>{clearInterval(timer);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));for(const s of [...sessions.values()])await dispose(s);}};
}

export async function runHostedWeb(argv:string[]){
 const at=argv.indexOf('--port'),port=Number(at<0?8080:argv[at+1]);if(!Number.isInteger(port)||port<1||port>65535)throw Error('포트를 확인하세요.');
 const app=await startHostedWeb({port,publicUrl:process.env.CSYNC_PUBLIC_URL||undefined});console.log(`브라우저 작업공간 웹: 0.0.0.0:${port} (로컬 실행기 불필요)`);
 const stop=()=>void app.close();process.once('SIGTERM',stop);process.once('SIGINT',stop);await new Promise<void>(done=>app.server.once('close',done));process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
}
