import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,symlinkSync} from 'node:fs';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
import {workspace,configure,mockFetch} from './helpers/fixtures.mjs';import {bindScope} from './helpers/scope.mjs';
import {storeBaseline,readBaseline} from '../dist/sync/baseline.js';import {mappingPass} from '../dist/sync/pull.js';import {mappingPath} from '../dist/sync/metadata.js';
import {documentDiff,formatDocumentDiff} from '../dist/sync/diff.js';import {createWebSync} from '../dist/web/sync.js';

test('Pull mapping saves the exact original text; local diff is offline and leaves sources and baselines unchanged',async t=>{
 const original='---\ntitle: Doc\npageId: 201\n---\n# Original\n\nText\n';const {root,put}=workspace(t,{'a.md':original});bindScope(root);mockFetch(t,[]);
 await mappingPass(root,mappingPath(root),new Map([['201',join(root,'a.md')]]),new Map(),new Map([['201',1]]));
 const mapping=readFileSync(mappingPath(root),'utf8');put('a.md',original.replace('Text','Edited'));
 const result=await documentDiff(root,'a.md');assert.equal(result.source,'baseline');assert.equal(result.before,original);assert.match(result.after,/Edited/);assert.equal(readFileSync(mappingPath(root),'utf8'),mapping);
 const output=spawnSync(process.execPath,[resolve('dist/sync.js'),'diff','a.md','--base',root],{encoding:'utf8'});assert.equal(output.status,0,output.stderr);assert.match(output.stdout,/-Text\n\+Edited/);
});

test('new docs compare to empty; hash-only existing docs explicitly lack a text baseline and never call remote automatically',async t=>{
 const {root,put}=workspace(t,{'a.md':'# A','new.md':'# New'});bindScope(root);put('.csync/mapping.json',JSON.stringify({'a.md':{pageId:'201',hash:'old',remoteVersion:1}}));mockFetch(t,[]);
 assert.equal((await documentDiff(root,'new.md')).before,'');const old=await documentDiff(root,'a.md');assert.equal(old.before,null);assert.equal(old.canRemote,true);assert.equal(old.source,'unavailable');
});

test('explicit remote comparison makes exactly one body request and never updates mapping or sources',async t=>{
 configure(t);const {root,put}=workspace(t,{'a.md':'---\npageId: 201\n---\nLocal body'});bindScope(root);const mapping=JSON.stringify({'a.md':{pageId:'201',hash:'old',remoteVersion:1}});put('.csync/mapping.json',mapping);
 mockFetch(t,[{path:'/wiki/rest/api/content/201?expand=body.export_view,body.storage,version',body:{id:'201',type:'page',title:'A',version:{number:2},body:{export_view:{value:'<p>Remote body</p>'},storage:{value:'<p>Remote body</p>'}}}}]);
 const result=await documentDiff(root,'a.md',{remote:true});assert.equal(result.source,'remote');assert.match(result.before,/Remote body/);assert.equal(result.after,'Local body');assert.match(result.note,/v2/);assert.equal(readFileSync(mappingPath(root),'utf8'),mapping);
});

test('diff refuses out-of-scope and escaped paths; baseline integrity and symlink protection are verified',async t=>{
 const {root,put}=workspace(t,{'a.md':'# A','b.md':'# B','outside/file.md':'# Outside'});bindScope(root,{localScope:{path:'a.md',type:'file'}});
 assert.equal((await documentDiff(root,'b.md')).source,'new');await assert.rejects(documentDiff(root,'../outside.md'),/작업공간 밖/);
 const id=storeBaseline(root,'Original');put('.csync/objects/'+id+'.md','Tampered');assert.throws(()=>readBaseline(root,id),/손상/);
 const alias='b'.repeat(64);symlinkSync(join(root,'outside/file.md'),join(root,'.csync/objects/'+alias+'.md'));assert.throws(()=>readBaseline(root,alias),/일반 파일/);assert.throws(()=>readBaseline(root,'../alias'),/식별자/);
});

test('staging mutations update cached rows without reprocessing unrelated files',async t=>{
 const {root,put}=workspace(t,{'a.md':'# A','b.md':'# B'});bindScope(root);mockFetch(t,[]);const sync=createWebSync(async()=>0);const input={base:root,envId:''};
 await sync.staging(input);put('b.md','# B\n\n[[missing.pdf#page=99]]');
 const added=await sync.staging({...input,action:'add',paths:['a.md']});assert.equal(added.rows.find(r=>r.path==='a.md').staged,true);assert.equal(added.rows.length,2);
 const removed=await sync.staging({...input,action:'remove',paths:['a.md']});assert.equal(removed.rows.find(r=>r.path==='a.md').staged,false);
 await assert.rejects(sync.staging(input),/PDF/); // Full refresh still reports the unrelated invalid document.
});

test('unified diff handles empty files and final-newline changes',()=>{
 assert.match(formatDocumentDiff('','new\n','a.md'),/@@ -0,0 \+1,1 @@\n\+new/);
 assert.match(formatDocumentDiff('a','a\n','a.md'),/-a\n\\ No newline at end of file\n\+a/);
 assert.match(formatDocumentDiff('same','same','a.md'),/변경 없음/);
});

test('Push stores the uploaded source baseline even if the working file changes during the request',async t=>{
 configure(t);const {scopeResponder}=await import('./helpers/scope.mjs');const {changeStaging}=await import('../dist/sync/staging.js');const {runPush}=await import('../dist/sync/push.js');
 const original='# A\n\nUploaded body\n';const {root,put}=workspace(t,{'a.md':original});bindScope(root);await changeStaging(root,['a.md'],'add',{baseUrl:'https://example.invalid/wiki'});
 const steps=[{path:'/wiki/api/v2/pages',method:'POST',body:{id:'201',version:{number:1}},check:init=>{assert.match(JSON.parse(init.body).body.value,/Uploaded body/);put('a.md','# A\n\nEdited while uploading\n')}}];mockFetch(t,steps,scopeResponder(root,steps));
 await runPush(['--base',root]);const result=await documentDiff(root,'a.md');assert.equal(result.before,original);assert.match(result.after,/Edited while uploading/);
});

test('local inspection overlays Fetch observations without extra API calls or baseline updates',async t=>{
 configure(t);const {fetchRemote,readFetchSnapshot}=await import('../dist/sync/fetch.js');
 const {root,put}=workspace(t,{'a.md':'# A','b.md':'# B','c.md':'# C','.env':'CONFLUENCE_BASE_URL=https://example.invalid/wiki\nCONFLUENCE_EMAIL=test@example.invalid\nCONFLUENCE_API_TOKEN=test-token\nCONFLUENCE_SPACE_KEY=TEST\n'});
 bindScope(root,{connection:{homepageId:'100'},scope:{id:'100',type:'page',path:'/'}});
 await mappingPass(root,mappingPath(root),new Map(['a','b','c'].map((p,i)=>[String(101+i),join(root,p+'.md')])),new Map(),new Map([['101',1],['102',1],['103',1]]));
 put('a.md','# A\n\nLocal edit');put('c.md','# C\n\nLocal edit');const baseline=readFileSync(mappingPath(root),'utf8');
 const apiEnv={baseUrl:'https://example.invalid/wiki',email:'test@example.invalid',token:'test-token',spaceKey:'TEST'};
 const sync=createWebSync(async()=>0),input={base:root,envId:''};const before=await sync.staging(input);assert.equal(before.remoteCheckedAt,null);
 const calls=mockFetch(t,[{path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100',body:{results:[101,102,103].map(id=>({id:String(id),spaceId:'space',title:String.fromCharCode(65+id-101),parentId:'100',version:{number:id===103?1:2}}))}}]);
 await fetchRemote(root,apiEnv);assert.ok(readFetchSnapshot(root,apiEnv));
 const after=await sync.staging(input);assert.equal(after.rows.find(r=>r.path==='a.md').status,'changed');assert.equal(after.rows.find(r=>r.path==='a.md').remoteState,'changed');assert.equal(after.rows.find(r=>r.path==='b.md').status,'same');assert.equal(after.rows.find(r=>r.path==='b.md').remoteState,'changed');assert.equal(after.rows.find(r=>r.path==='c.md').remoteState,'unchanged');
 assert.ok(after.remoteCheckedAt);assert.equal(calls.length,1);assert.equal(readFileSync(mappingPath(root),'utf8'),baseline);
 const again=await sync.staging(input);assert.equal(again.revision,after.revision);assert.equal(calls.length,1);
});

for(const [name,source,expected] of [
 ['generated separator','---\npageId: 201\n---\n\n## Heading\n','## Heading\n'],
 ['CRLF separator','---\r\npageId: 201\r\n---\r\n\r\n## Heading','## Heading'],
 ['intentional extra blank','---\npageId: 201\n---\n\n\n## Heading','\n## Heading'],
 ['no separator','---\npageId: 201\n---\n## Heading','## Heading'],
 ['no frontmatter','\n## Heading','\n## Heading'],
 ['indented code','---\npageId: 201\n---\n\n    code','    code'],
])test(`remote diff removes only the frontmatter separator: ${name}`,async t=>{
 configure(t);const {root,put}=workspace(t,{'a.md':source});bindScope(root);put('.csync/mapping.json',JSON.stringify({'a.md':{pageId:'201',remoteVersion:1}}));
 mockFetch(t,[{path:'/wiki/rest/api/content/201?expand=body.export_view,body.storage,version',body:{id:'201',type:'page',title:'A',version:{number:1},body:{export_view:{value:'<h2>Heading</h2>'},storage:{value:'<h2>Heading</h2>'}}}}]);
 const result=await documentDiff(root,'a.md',{remote:true});assert.equal(result.after,expected);if(name==='generated separator')assert.equal(result.before,result.after);assert.equal(readFileSync(join(root,'a.md'),'utf8'),source);
});
