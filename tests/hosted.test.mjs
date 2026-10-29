import test from 'node:test';import assert from 'node:assert/strict';
import {startHostedWeb} from '../dist/web/hosted.js';import {digest} from '../dist/web/hosted-files.js';
async function hosted(t,options={}){const app=await startHostedWeb({port:0,host:'127.0.0.1',...options});t.after(()=>app.close());return app;}
test('hosted Fetch does not validate unrelated document link targets',async t=>{
 const commands=[],app=await hosted(t,{syncRunner:async args=>{commands.push(args[0]);return 0}}),c=await client(app);
 await c.mirror({'.env':'CONFLUENCE_BASE_URL=https://example.atlassian.net/wiki\nCONFLUENCE_EMAIL=demo@example.com\nCONFLUENCE_API_TOKEN=test-token\nCONFLUENCE_SPACE_KEY=TEST\n','.csync/workspace.json':JSON.stringify({version:2,connection:{baseUrl:'https://example.atlassian.net/wiki',spaceKey:'TEST',spaceId:'space',homepageId:'100'},remoteRoot:{id:'100',type:'page',path:'/'}}),'a.md':'[Attachment](/Users/example/private.pdf)'});
 const fetched=await c.api('/api/sync/fetch',{base:c.session.base,envId:''});assert.equal(fetched.status,202,fetched.error);
 let job;for(let n=0;n<100;n++){job=(await c.api('/api/sync/job')).job;if(job?.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.equal(job.state,'succeeded',job.log);assert.deepEqual(commands,['fetch']);
 const metadata=await c.api('/api/sync/staging',{base:c.session.base,envId:'',remoteOnly:true});assert.equal(metadata.status,200,metadata.error);assert.deepEqual(metadata.rows,[]);
 const rejected=await c.api('/api/sync/staging',{base:c.session.base,envId:'',remoteOnly:true,action:'add',paths:['a.md']});assert.equal(rejected.status,400);assert.match(rejected.error,/업로드 선택/);
 const convert=await c.api('/api/convert',{base:c.session.base,file:c.session.base+'/a.md',to:'markdown',preview:true});assert.equal(convert.status,400);assert.match(convert.error,/절대 경로/);
});
async function client(app,name='docs'){
 const request=async(path,body,method=body?'POST':'GET',headers={})=>fetch(app.url+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 const response=await request('/api/browser/session',{name});assert.equal(response.status,201);const session=await response.json(),headers={'X-Csync-Session':session.id,'X-Csync-Token':session.token};
 return {session,headers,raw:request,async api(path,body,method){const r=await request(path,body,method,headers);const data=await r.json();return {status:r.status,...data};},async mirror(files){const manifest=Object.entries(files).map(([path,text])=>({path:session.base+'/'+path,size:Buffer.byteLength(text),hash:digest(Buffer.from(text))}));const plan=await this.api('/api/browser/mirror',{files:manifest});assert.equal(plan.status,200);for(const f of plan.uploads){const text=files[f.path.slice(session.base.length+1)];const r=await fetch(app.url+'/api/browser/file?path='+encodeURIComponent(f.path),{method:'PUT',headers,body:text});assert.equal(r.status,200,await r.text());}const committed=await this.api('/api/browser/commit',{});assert.equal(committed.status,200);return manifest;}};
}
test('hosted web starts without a local connector and keeps browser sessions isolated',async t=>{
 const app=await hosted(t),page=await(await fetch(app.url)).text();assert.match(page,/name="csync-runtime" content="browser"/);assert.match(page,/browser-folder-open/);assert.equal((await fetch(app.url+'/assets/app.js')).status,200);const a=await client(app),b=await client(app);await a.mirror({'a.md':'# Private A'});assert.equal((await a.api('/api/browse')).entries[0].name,'a.md');assert.deepEqual((await b.api('/api/browse')).entries,[]);
 const response=await a.raw('/api/browse',undefined,'GET',{'X-Csync-Session':a.session.id,'X-Csync-Token':b.session.token});assert.equal(response.status,401);assert.equal((await fetch(app.url+'/api/browse')).status,401);
});
test('browser transport reuses real preview/conversion, exposes virtual paths, and requires acknowledgement before new operations',async t=>{
 const app=await hosted(t),c=await client(app);await c.mirror({'a.md':'# A\n\n[[b]]','sub/b.md':'# B'});const listing=await c.api('/api/browse');assert.equal(listing.path,c.session.base);assert.equal(listing.parent,c.session.base);assert.equal(listing.home,c.session.base);const preview=await c.api('/api/document-preview',{base:c.session.base,file:c.session.base+'/a.md'});assert.equal(preview.status,200);assert.match(preview.html,/A/);
 const converted=await c.api('/api/convert',{base:c.session.base,file:c.session.base,scope:'folder',out:c.session.output,to:'markdown',fix:false,preview:false});assert.equal(converted.status,200);assert.equal(converted.documentCount,2);assert.equal(converted.output,'/output');const changed=await c.api('/api/browser/changes');assert.equal(changed.files.length,2);assert.ok(changed.files.every(f=>f.path.startsWith('/output/')));assert.equal((await c.api('/api/sync/config',{base:c.session.base,envId:''})).code,'APPLY_PENDING');
 for(const file of changed.files){const r=await fetch(app.url+'/api/browser/file?path='+encodeURIComponent(file.path),{headers:c.headers});assert.equal(digest(new Uint8Array(await r.arrayBuffer())),file.hash);}
 assert.equal((await c.api('/api/browser/ack',{files:changed.snapshot})).status,200);assert.equal((await c.api('/api/browser/changes')).files.length,0);
});
test('host paths, traversal, filesystem-reading links and arbitrary Cloud targets are rejected',async t=>{
 const app=await hosted(t),c=await client(app);await c.mirror({'a.md':'# A'});
 for(const path of ['/etc','../etc',''])assert.equal((await c.api('/api/sync/config',{base:path,envId:''})).status,400);
 assert.equal((await c.api('/api/browse?path=/etc')).status,400);assert.equal((await c.api('/api/browser/mirror',{files:[{path:c.session.base+'/../outside',size:1,hash:'a'.repeat(64)}]})).status,400);
 for(const source of ['[leak](file:///etc/passwd)','![[file:///etc/passwd]]','![[/etc/passwd]]','![leak](/etc/passwd)','![leak](../../../etc/passwd)','<table><tr><td><img src="/etc/passwd"></td></tr></table>']){await c.mirror({'a.md':source});const result=await c.api('/api/document-preview',{base:c.session.base,file:c.session.base+'/a.md'});assert.equal(result.status,400);}
 await c.mirror({'a.md':'```md\n![literal](/etc/passwd)\n```'});assert.equal((await c.api('/api/document-preview',{base:c.session.base,file:c.session.base+'/a.md'})).status,200);
 assert.equal((await c.api('/api/sync/env/import',{base:c.session.base,text:'CONFLUENCE_BASE_URL=https://127.0.0.1/secret',name:'.env'})).status,400);
});
test('an interrupted or corrupt upload is not committed and a complete retry succeeds',async t=>{
 const app=await hosted(t),c=await client(app);const f={path:c.session.base+'/a.md',size:1,hash:digest(Buffer.from('A'))};assert.equal((await c.api('/api/browser/mirror',{files:[f]})).status,200);assert.equal((await c.api('/api/browser/commit',{})).status,400);const wrong=await fetch(app.url+'/api/browser/file?path='+encodeURIComponent(f.path),{method:'PUT',headers:c.headers,body:'B'});assert.equal(wrong.status,400);await c.mirror({'a.md':'A'});assert.equal((await c.api('/api/browse')).entries[0].name,'a.md');
});
test('expired and deleted sessions lose access while the server remains usable',async t=>{
 const app=await hosted(t,{ttlMs:1000}),a=await client(app);await new Promise(r=>setTimeout(r,1050));assert.ok([401,410].includes((await a.api('/api/browse')).status));const b=await client(app);assert.equal((await b.api('/api/browser/session',undefined,'DELETE')).status,200);assert.equal((await b.api('/api/browse')).status,401);
});
test('foreign origins are rejected and HTTPS reverse proxy origin is explicit',async t=>{
 const app=await hosted(t,{publicUrl:'https://csync.example'});const body=JSON.stringify({name:'docs'});assert.equal((await fetch(app.url+'/api/browser/session',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body})).status,403);assert.equal((await fetch(app.url+'/api/browser/session',{method:'POST',headers:{Origin:'https://csync.example','Content-Type':'application/json'},body})).status,201);
});

test('concurrent session creation respects the server capacity before allocating workspaces',async t=>{
 const app=await hosted(t,{maxSessions:1});const results=await Promise.all([1,2].map(()=>fetch(app.url+'/api/browser/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'docs'})})));assert.deepEqual(results.map(r=>r.status).sort(),[201,503]);
});
