import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {browserPlatform} from '../scripts/browser-platform.mjs';
import {tableEditorBridge} from '../dist/web/table-editor-script.js';
import {workspace as diskWorkspace} from './helpers/fixtures.mjs';
import {inspectStaging,changeStaging} from '../dist/sync/staging.js';
const result=await build({entryPoints:['src/runtime/browser/engine.js'],bundle:true,platform:'browser',format:'esm',minify:true,write:false,logLevel:'silent',plugins:[browserPlatform()],inject:['src/runtime/browser/globals.js'],define:{__CSYNC_VERSION__:'"2.0.0"',__CSYNC_TABLE_BRIDGE__:JSON.stringify(tableEditorBridge.toString())}});
const {createStandaloneEngine}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const env='CONFLUENCE_BASE_URL=https://example.atlassian.net/wiki\nCONFLUENCE_EMAIL=demo@example.com\nCONFLUENCE_API_TOKEN=synthetic-secret\nCONFLUENCE_SPACE_KEY=TEST\n';
const workspace={version:2,connection:{baseUrl:'https://example.atlassian.net/wiki',spaceKey:'TEST',spaceId:'space',homepageId:'100'},remoteRoot:{id:'100',type:'page',path:'/'}};
test('browser reads a legacy empty local-path index without modifying it',async()=>{
 const c=await client(),index=JSON.stringify({version:1,binding:'0'.repeat(64),entries:{}});
 await c.mirror({'.env':env,'.csync/workspace.json':JSON.stringify(workspace),'.csync/index.json':index,'a.md':'# A'});
 const rows=await c.api('/api/sync/staging',{base:c.session.base,envId:''});assert.equal(rows.status,200,rows.error);assert.equal(rows.rows[0].stale,false);assert.equal(await c.read(c.session.base+'/.csync/index.json'),index);
});
test('CLI and browser share portable upload selection without assuming the same absolute path',async t=>{
 const files={'.env':env,'.csync/workspace.json':JSON.stringify(workspace),'a.md':'# A'},disk=diskWorkspace(t,files);
 await changeStaging(disk.root,['a.md'],'add',{baseUrl:workspace.connection.baseUrl});
 const index=readFileSync(disk.root+'/.csync/index.json','utf8');assert.equal(JSON.parse(index).version,2);
 const c=await client();await c.mirror({...files,'.csync/index.json':index});
 const rows=await c.api('/api/sync/staging',{base:c.session.base,envId:''});assert.equal(rows.status,200,rows.error);assert.equal(rows.rows[0].staged,true);assert.equal(rows.rows[0].stale,false);assert.equal(await c.read(c.session.base+'/.csync/index.json'),index);
});
test('local staging accepts exported Confluence page and profile links in README',async t=>{
 const c=await client(),text='# Recent updates\n\n[Report](/wiki/spaces/TEST/pages/201/report.pdf#page=1 "Space")\n\n[Author](/wiki/display/~712020%3Auser)\n\n[Next](/wiki/plugins/recently-updated/changes.action?startIndex=10)\n\n<table><tr><td><a href="/wiki/spaces/TEST/pages/201/Report">Page</a></td></tr></table>';
 await c.mirror({'.env':env,'.csync/workspace.json':JSON.stringify(workspace),'README.md':text});
 t.mock.method(globalThis,'fetch',async()=>{throw Error('Local staging must remain offline')});
 const staged=await c.api('/api/sync/staging',{base:c.session.base,envId:''});assert.equal(staged.status,200,staged.error);assert.equal(staged.rows[0].path,'README.md');assert.equal(staged.rows[0].localUnverified,undefined);assert.equal(await c.read(c.session.base+'/README.md'),text);
 for(const invalid of ['![Image](/wiki/spaces/TEST/pages/201/image.png)','<img src="/wiki/spaces/TEST/pages/201/image.png">','[Bad](/wiki/spaces/TEST/%252e%252e/private)','[File](/Users/example/private.pdf)']){
  await c.mirror({'.env':env,'.csync/workspace.json':JSON.stringify(workspace),'README.md':invalid});
  const result=await c.api('/api/sync/staging',{base:c.session.base,envId:''});assert.equal(result.status,400,invalid);assert.match(result.error,/절대 경로/);
 }
});
test('Fetch ignores document link targets while retaining env and mapping validation',async t=>{
 const c=await client(),files={'.env':env,'.csync/workspace.json':JSON.stringify(workspace),'a.md':'[Attachment](/Users/example/private.pdf)'};
 await c.mirror(files);const calls=[];
 t.mock.method(globalThis,'fetch',async(input,options={})=>{const url=new URL(input);calls.push(options.method??'GET');if(url.pathname.endsWith('/api/v2/pages'))return Response.json({results:[]});throw Error('Unexpected request '+url);});
 const fetched=await c.api('/api/sync/fetch',{base:c.session.base,envId:''});assert.equal(fetched.status,202,fetched.error);
 const done=await c.finish();assert.equal(done.state,'succeeded',done.log);assert.ok(calls.length>0);assert.ok(calls.every(method=>method==='GET'));assert.equal(await c.read(c.session.base+'/a.md'),files['a.md']);await c.ack();
 await c.mirror({...files,'.env':env.replace('https://example.atlassian.net/wiki','http://localhost/wiki')});
 const unsafeEnv=await c.api('/api/sync/fetch',{base:c.session.base,envId:''});assert.equal(unsafeEnv.status,400);assert.match(unsafeEnv.error,/Atlassian/);
 await c.mirror({...files,'.csync/mapping.json':JSON.stringify({'/etc/private':{pageId:'201'}})});
 const unsafeMapping=await c.api('/api/sync/fetch',{base:c.session.base,envId:''});assert.equal(unsafeMapping.status,400);assert.match(unsafeMapping.error,/파일 경로/);
});
test('folder navigation lists documents with absolute links without following those links',async()=>{
 const c=await client();await c.mirror({'a.md':'[Local attachment](/Users/example/private.pdf)'});
 const listing=await c.api('/api/browse');assert.equal(listing.status,200,listing.error);assert.equal(listing.entries[0].name,'a.md');
 const search=await c.api('/api/search?q=a');assert.equal(search.status,200,search.error);assert.equal(search.entries[0].name,'a.md');
 const convert=await c.api('/api/convert',{base:c.session.base,file:c.session.base+'/a.md',to:'markdown',preview:true});assert.equal(convert.status,400);assert.match(convert.error,/절대 경로/);
});
async function client(store){let engine=createStandaloneEngine({store,fetch:(...args)=>globalThis.fetch(...args)}),session;
 const api=async(path,body,method=body?'POST':'GET')=>{const response=await engine({path,method,headers:session?{'x-csync-session':session.id,'x-csync-token':session.token}:{},body:body instanceof ArrayBuffer?body:body?JSON.stringify(body):undefined});return {status:response.status,...JSON.parse(response.body)};};
 session=await api('/api/browser/session',{name:'notes'});assert.equal(session.status,201);
 return {session,api,restart(){engine=createStandaloneEngine({store,fetch:(...args)=>globalThis.fetch(...args)});},async read(path){const r=await engine({path:'/api/browser/file?path='+encodeURIComponent(path),headers:{'x-csync-session':session.id,'x-csync-token':session.token}});assert.equal(r.status,200,typeof r.body==='string'?r.body:'');return Buffer.from(r.body).toString();},async mirror(files){const manifest=Object.entries(files).map(([path,value])=>{const bytes=Buffer.from(value);return {path:path.startsWith('/')?path:session.base+'/'+path,size:bytes.length,hash:hash(bytes)};});const plan=await api('/api/browser/mirror',{files:manifest});assert.equal(plan.status,200,plan.error);for(const f of plan.uploads){const bytes=Buffer.from(files[f.path]??files[f.path.slice(session.base.length+1)]);const r=await api('/api/browser/file?path='+encodeURIComponent(f.path),bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'PUT');assert.equal(r.status,200,r.error);}const r=await api('/api/browser/commit',{});assert.equal(r.status,200,r.error);return manifest;},async ack(){const c=await api('/api/browser/changes');assert.equal(c.status,200,c.error);const r=await api('/api/browser/ack',{files:c.snapshot});assert.equal(r.status,200,r.error);return c;},async finish(){for(let n=0;n<300;n++){const r=await api('/api/sync/job');if(r.job?.state!=='running')return r.job;await new Promise(r=>setTimeout(r,2));}assert.fail('job did not finish');}};
}
test('browser bundle runs shared preview, formatting and Obsidian conversion without a server',async()=>{
 const c=await client();await c.mirror({'a.md':'# A\n\n[[sub/b]]\n\n> [!summary]\n> Hello\n','sub/b.md':'# B\n'});
 const p=await c.api('/api/document-preview',{base:c.session.base,file:c.session.base+'/a.md'});assert.equal(p.status,200,p.error);assert.match(p.html,/A/);assert.equal(p.hash,hash('# A\n\n[[sub/b]]\n\n> [!summary]\n> Hello\n'));
 const formatted=await c.api('/api/document-format/preview',{base:c.session.base,file:c.session.base+'/a.md',hash:p.hash,basic:true,tables:'keep',changes:[]});assert.equal(formatted.status,200,formatted.error);
 const r=await c.api('/api/convert',{base:c.session.base,file:c.session.base,scope:'folder',out:'/output',to:'markdown',fix:false,preview:false});assert.equal(r.status,200,r.error);assert.equal(r.documentCount,2);assert.match(await c.read('/output/a.md'),/\[sub\/b\]\(sub\/b.md\)/);const changed=await c.ack();assert.equal(changed.files.length,2);
});
test('standalone mirror rejects corrupt uploads and traversal and resumes local state after worker restart',async()=>{
 const data=new Map(),store=async(key,value)=>{if(value===undefined)return structuredClone(data.get(key));if(value===null)data.delete(key);else data.set(key,structuredClone(value));};
 const c=await client(store);await c.mirror({'a.md':'# Private local'});c.restart();const listing=await c.api('/api/browse');assert.equal(listing.status,200,listing.error);assert.equal(listing.entries[0].name,'a.md');assert.match(await c.read(c.session.base+'/a.md'),/Private local/);
 assert.equal((await c.api('/api/browse?path=/etc')).status,400);
 const plan=await c.api('/api/browser/mirror',{files:[{path:c.session.base+'/a.md',size:1,hash:hash('X')}]});assert.equal(plan.status,200);assert.equal((await c.api('/api/browser/file?path='+c.session.base+'/a.md',new TextEncoder().encode('Y').buffer,'PUT')).status,400);assert.equal((await c.api('/api/browser/commit',{})).status,400);assert.match(await c.read(c.session.base+'/a.md'),/Private local/);
});
test('browser and Node CLI produce identical publication and source hashes for round-trip syntax',async t=>{
 const files={'.env':env,'.csync/workspace.json':JSON.stringify(workspace),'a.md':'---\ntitle: 검증 문서\n---\n\n# A\n\n> [!summary]- 요약\n> 본문입니다.\n\n[[b#Section|다른 문서]]\n\n각주[^n]\n\n[^n]: 각주 내용\n\n![[attachments/image.png]]\n\n| 값 | 설명 |\n| --- | --- |\n| 1 | 테스트 |\n','b.md':'# B\n\n## Section\n','attachments/image.png':Buffer.from([137,80,78,71,13,10,26,10])};
 const disk=diskWorkspace(t,files),native=await inspectStaging(disk.root,{baseUrl:workspace.connection.baseUrl}),c=await client();await c.mirror(files);
 const result=await c.api('/api/sync/staging',{base:c.session.base,envId:'',paths:['a.md'],action:'add',referenceRoots:[]});assert.equal(result.status,200,result.error);
 const index=JSON.parse(await c.read(c.session.base+'/.csync/index.json'));
 assert.deepEqual(index.entries['a.md'],native.find(row=>row.path==='a.md').entry);
});
test('imported connection survives worker restart without writing an env file',async()=>{
 const data=new Map(),store=async(id,value)=>{if(value===undefined)return structuredClone(data.get(id));if(value===null)data.delete(id);else data.set(id,structuredClone(value));};
 const c=await client(store);await c.mirror({'a.md':'# A'});
 const imported=await c.api('/api/sync/env/import',{base:c.session.base,text:env,name:'connection.env'});assert.equal(imported.status,200,imported.error);
 c.restart();const config=await c.api('/api/sync/config',{base:c.session.base,envId:imported.envId});assert.equal(config.status,200,config.error);assert.equal(config.hasToken,true);assert.deepEqual(config.missing,[]);assert.equal((await c.api('/api/browser/changes')).files.length,0);
});
test('browser uses shared staging, dry-run approval, push and automatic fetch with only Confluence requests',async t=>{
 const c=await client();await c.mirror({'.env':env,'.csync/workspace.json':JSON.stringify(workspace),'a.md':'# A\n\nBody'});
 const calls=[];t.mock.method(globalThis,'fetch',async(input,options={})=>{const url=new URL(input),method=options.method??'GET';calls.push([method,url.pathname+url.search]);if(url.pathname.endsWith('/api/v2/spaces'))return Response.json({results:[{id:'space',homepageId:'100'}]});if(url.pathname.endsWith('/api/v2/pages')&&method==='POST')return Response.json({id:'201'});if(url.pathname.endsWith('/api/v2/pages'))return Response.json({results:[{id:'201',title:'A',spaceId:'space',parentId:'100',version:{number:1}}]});if(url.search.includes('expand=ancestors'))return Response.json({id:url.pathname.split('/').at(-1),type:'page',space:{id:'space'},ancestors:[],version:{number:1}});throw Error('Unexpected request '+url);});
 const request={base:c.session.base,envId:'',target:'',verify:false,referenceRoots:[]};
 const rows=await c.api('/api/sync/staging',request);assert.equal(rows.status,200,rows.error);assert.equal(calls.length,0);
 const staged=await c.api('/api/sync/staging',{...request,paths:['a.md'],action:'add'});assert.equal(staged.status,200,staged.error);await c.ack();
 const preview=await c.api('/api/sync/preview',request);assert.equal(preview.status,202,preview.error);const ready=await c.finish();assert.equal(ready.state,'succeeded',ready.log);assert.equal(calls.length,0);assert.ok(ready.planId);await c.ack();
 const push=await c.api('/api/sync/push',{planId:ready.planId});assert.equal(push.status,202,push.error);const done=await c.finish();assert.equal(done.state,'succeeded',done.log);assert.match(done.log,/자동 Fetch/);assert.equal(JSON.parse(await c.read(c.session.base+'/.csync/mapping.json'))['a.md'].pageId,'201');assert.ok(calls.some(([method])=>method==='POST'));assert.equal(calls.filter(([method])=>method==='DELETE').length,0);
});
test('browser pull writes shared baseline and restore requires an explicit overwrite approval',async t=>{
 const c=await client();await c.mirror({'.env':env,'.csync/workspace.json':JSON.stringify(workspace)});
 const calls=[];t.mock.method(globalThis,'fetch',async(input,options={})=>{const url=new URL(input);calls.push(options.method??'GET');if(url.pathname.endsWith('/api/v2/spaces'))return Response.json({results:[{id:'space',homepageId:'100'}]});if(url.search.includes('expand=ancestors'))return Response.json({id:url.pathname.split('/').at(-1),type:'page',space:{id:'space'},ancestors:[{id:'100'}],version:{number:1}});if(url.pathname.endsWith('/api/v2/pages'))return Response.json({results:[{id:'201',title:'New',spaceId:'space',parentId:'100',version:{number:1}}]});if(url.pathname.endsWith('/rest/api/content/201'))return Response.json({id:'201',type:'page',title:'New',version:{number:1},body:{export_view:{value:'<p>Remote</p>'},storage:{value:'<p>Remote</p>'}}});throw Error('Unexpected request '+url);});
 const r=await c.api('/api/sync/pull',{base:c.session.base,envId:'',remoteOnly:true});assert.equal(r.status,202,r.error);const done=await c.finish();assert.equal(done.state,'succeeded',done.log);assert.match(await c.read(c.session.base+'/New.md'),/Remote/);const map=JSON.parse(await c.read(c.session.base+'/.csync/mapping.json'));assert.equal(map['New.md'].pageId,'201');assert.ok(map['New.md'].localHash);await c.ack();assert.ok(calls.every(method=>method==='GET'));
 const restore=await c.api('/api/sync/restore',{base:c.session.base,envId:'',path:'New.md',overwrite:true});assert.equal(restore.status,200,restore.error);assert.ok(restore.confirmationId);
});


test('remote changes remain readable when local document validation blocks staging',async t=>{
 const c=await client(),mapping={},files={'.env':env,'.csync/workspace.json':JSON.stringify(workspace)};
 for(let i=0;i<5;i++){const path=`doc${i}.md`;mapping[path]={pageId:String(201+i),remoteVersion:1,title:`Doc ${i}`};files[path]=i?'# Local':'[Attachment](/Users/example/private.pdf)';}
 files['.csync/mapping.json']=JSON.stringify(mapping);await c.mirror(files);let requests=0;
 t.mock.method(globalThis,'fetch',async input=>{requests++;const url=new URL(input);if(url.pathname.endsWith('/api/v2/pages'))return Response.json({results:Array.from({length:6},(_,i)=>({id:String(201+i),title:i===5?'New':`Doc ${i}`,spaceId:'space',parentId:'100',version:{number:2}}))});throw Error('Unexpected request '+url);});
 assert.equal((await c.api('/api/sync/fetch',{base:c.session.base,envId:''})).status,202);assert.equal((await c.finish()).state,'succeeded');await c.ack();
 const blocked=await c.api('/api/sync/staging',{base:c.session.base,envId:''});assert.equal(blocked.status,400);assert.match(blocked.error,/doc0.md/);
 const before=requests,remote=await c.api('/api/sync/staging',{base:c.session.base,envId:'',remoteOnly:true});assert.equal(remote.status,200,remote.error);assert.equal(requests,before);assert.equal(remote.rows.length,6);assert.equal(remote.rows.filter(row=>row.remoteState==='changed').length,5);assert.equal(remote.rows.filter(row=>row.remoteState==='new').length,1);assert.ok(remote.rows.filter(row=>row.remoteState==='changed').every(row=>row.localUnverified));
 const rejected=await c.api('/api/sync/staging',{base:c.session.base,envId:'',remoteOnly:true,action:'add',paths:['doc0.md']});assert.equal(rejected.status,400);assert.match(rejected.error,/업로드 선택/);
});


test('minified browser staging supports inline and referenced footnotes without rewriting sources',async()=>{
 const c=await client(),text='# Notes\n\nInline^[balanced [label](https://example.com) note] and reference[^law].\n\n[^law]: Referenced note\n';
 await c.mirror({'.env':env,'.csync/workspace.json':JSON.stringify(workspace),'a.md':text});
 const rows=await c.api('/api/sync/staging',{base:c.session.base,envId:''});assert.equal(rows.status,200,rows.error);assert.equal(rows.rows.length,1);assert.equal(await c.read(c.session.base+'/a.md'),text);
});


test('minified browser conversion ignores unrelated input and output links but blocks selected unsafe documents',async()=>{
 const c=await client();await c.mirror({'selected/a.md':'# Selected','other.md':'![unselected](/etc/passwd)','/output/existing.md':'[existing](file:///etc/passwd)'});
 const request={base:c.session.base,file:c.session.base+'/selected',scope:'folder',out:'/output',to:'markdown',fix:false,preview:false};
 const converted=await c.api('/api/convert',request);assert.equal(converted.status,200,converted.error);assert.equal(converted.documentCount,1);
 assert.equal(await c.read('/output/a.md'),'# Selected');assert.equal(await c.read('/output/existing.md'),'[existing](file:///etc/passwd)');await c.ack();
 const blocked=await c.api('/api/convert',{...request,file:c.session.base+'/other.md',scope:'file',preview:true});
 assert.equal(blocked.status,400);assert.match(blocked.error,/절대 경로/);
});
