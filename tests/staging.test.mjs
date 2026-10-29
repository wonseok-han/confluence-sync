import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {workspace, configure, mockFetch} from './helpers/fixtures.mjs';
import {bindScope, scopeResponder} from './helpers/scope.mjs';
import {changeStaging, inspectStaging, loadIndex} from '../dist/sync/staging.js';
import {runPush} from '../dist/sync/push.js';
import {saveMapping, loadMapping} from '../dist/sync/mapping.js';
import {mappingPath} from '../dist/sync/metadata.js';
import {createWebSync} from '../dist/web/sync.js';
const options={baseUrl:'https://example.invalid/wiki'};

test('bare Push with an empty index fails closed without remote calls',async t=>{
 configure(t);const {root}=workspace(t,{'a.md':'# A'});bindScope(root);mockFetch(t,[]);
 await assert.rejects(runPush(['--base',root,'--dry-run']),/업로드 대상이 없습니다/);
 await assert.rejects(runPush(['--base',root]),/업로드 대상이 없습니다/);
});

test('add and unstage expand folders, include all workspace paths, and never change sources',async t=>{
 const {root}=workspace(t,{'a.md':'# A','sub/b.md':'# B','sub/c.md':'# C','nested/d.md':'# D'});bindScope(root,{localScope:{path:'sub',type:'folder'}});
 mockFetch(t,[]);await changeStaging(root,['sub'],'add',options);
 assert.deepEqual(Object.keys(loadIndex(root).entries).sort(),['sub/b.md','sub/c.md']);
 await changeStaging(root,['a.md'],'add',options);await changeStaging(root,['a.md'],'remove');
 await assert.rejects(changeStaging(root,['../outside'],'add',options),/기준 폴더 밖/);
 await changeStaging(root,['sub/b.md'],'remove');assert.deepEqual(Object.keys(loadIndex(root).entries),['sub/c.md']);
 assert.equal(readFileSync(join(root,'sub/b.md'),'utf8'),'# B');
});

for(const [path,after] of [['a.md','# A\n\nEdited'],['image.png','second']])test(`post-add changes require re-add: ${path}`,async t=>{
 configure(t);const {root,put}=workspace(t,{'a.md':'# A\n\n![](image.png)','image.png':'first'});bindScope(root);mockFetch(t,[]);
 await changeStaging(root,['a.md'],'add',options);put(path,after);
 const rows=await inspectStaging(root,options);assert.equal(rows[0].stale,true);
 await assert.rejects(runPush(['--base',root]),/다시 추가/);
 assert.equal(Object.keys(loadIndex(root).entries).length,1);
 await changeStaging(root,['a.md'],'add',options);await runPush(['--base',root,'--dry-run']);
 assert.equal(Object.keys(loadIndex(root).entries).length,1);
});

test('staged unchanged documents make zero remote calls and clear only their index entries',async t=>{
 configure(t);const {root}=workspace(t,{'a.md':'# A','b.md':'# B'});bindScope(root);
 await changeStaging(root,['a.md'],'add',options);const hash=loadIndex(root).entries['a.md'].hash;
 saveMapping(mappingPath(root),{'a.md':{pageId:'201',title:'A',hash,remoteVersion:1}});mockFetch(t,[]);
 await runPush(['--base',root]);assert.deepEqual(loadIndex(root).entries,{});
 assert.equal(loadMapping(mappingPath(root))['a.md'].remoteVersion,1);
});

test('only staged documents upload; failures remain staged and successful documents are removed',async t=>{
 configure(t);const {root}=workspace(t,{'a.md':'# A','b.md':'# B','c.md':'# C'});bindScope(root);
 await changeStaging(root,['a.md','b.md'],'add',options);
 const steps=[{path:'/wiki/api/v2/pages',method:'POST',body:{id:'201',version:{number:1}},check:init=>assert.equal(JSON.parse(init.body).title,'A')},
 {path:'/wiki/api/v2/pages',method:'POST',status:400,body:{message:'rejected'},check:init=>assert.equal(JSON.parse(init.body).title,'B')}];
 mockFetch(t,steps,scopeResponder(root,steps));
 const old=process.exitCode;try{await runPush(['--base',root]);assert.equal(process.exitCode,1)}finally{process.exitCode=old}
 assert.deepEqual(Object.keys(loadIndex(root).entries),['b.md']);assert.equal(loadMapping(mappingPath(root))['c.md'],undefined);
});

test('changed remote baseline blocks staged Push before any mutation and retains the selection',async t=>{
 configure(t);const {root}=workspace(t,{'a.md':'# A changed'});bindScope(root);
 saveMapping(mappingPath(root),{'a.md':{pageId:'201',title:'A',hash:'old',remoteVersion:1}});
 await changeStaging(root,['a.md'],'add',options);
 const steps=[{path:'/wiki/api/v2/pages/201',body:{id:'201',version:{number:2}}}];mockFetch(t,steps,scopeResponder(root,steps));
 await assert.rejects(runPush(['--base',root]),/충돌/);assert.equal(Object.keys(loadIndex(root).entries).length,1);
});

test('retired scope fields never change the explicitly staged selection',async t=>{
 configure(t);const {root}=workspace(t,{'a.md':'# A','b.md':'# B'});bindScope(root);await changeStaging(root,['a.md'],'add',options);
 bindScope(root,{localScope:{path:'b.md',type:'file'}});mockFetch(t,[]);
 await runPush(['--base',root,'--dry-run']);assert.deepEqual(Object.keys(loadIndex(root).entries),['a.md']);
 await changeStaging(root,['a.md'],'remove');assert.deepEqual(loadIndex(root).entries,{});
});

test('symlink index and foreign-workspace index are refused',async t=>{
 const {root,put}=workspace(t,{'a.md':'# A','outside.json':'{}'});bindScope(root);symlinkSync(join(root,'outside.json'),join(root,'.csync/index.json'));
 assert.throws(()=>loadIndex(root),/일반 파일/);
});

test('web uses persistent CLI staging and adding documents invalidates an approved preview',async t=>{
 const {root}=workspace(t,{'a.md':'# A'});bindScope(root);const sync=createWebSync(async()=>0);
 const input={base:root,target:'',envId:'',verify:false};
 await assert.rejects(sync.preview(input),/업로드 대상이 없습니다/);
 const result=await sync.staging({...input,action:'add',paths:['a.md']});assert.equal(result.rows[0].staged,true);
 await sync.preview(input);while(sync.running())await new Promise(r=>setTimeout(r,5));const id=sync.current().planId;
 await sync.staging({...input,action:'remove',paths:['a.md']});await assert.rejects(sync.push(id),/미리보기/);
});

test('CLI dispatch persists add/status/unstage, with no implicit whole-scope Push',async t=>{
 const {spawnSync}=await import('node:child_process');const {resolve}=await import('node:path');
 const {root}=workspace(t,{'a.md':'# A','b.md':'# B'});bindScope(root);
 const run=(...args)=>spawnSync(process.execPath,[resolve('dist/sync.js'),...args,'--base',root],{cwd:root,encoding:'utf8'});
 assert.equal(run('add','a.md').status,0);assert.deepEqual(Object.keys(loadIndex(root).entries),['a.md']);
 const status=run('status');assert.equal(status.status,0);assert.match(status.stdout,/\[추가됨\].*a.md/);assert.match(status.stdout,/\[미선택\].*b.md/);
 const preview=run('push','--dry-run');assert.equal(preview.status,0);assert.match(preview.stdout,/a.md/);assert.doesNotMatch(preview.stdout,/b.md/);
 assert.equal(run('unstage','.').status,0);assert.match(run('push','--dry-run').stderr,/업로드 대상이 없습니다/);
});

test('add only prepares selected documents; an invalid PDF in another document does not block it',async t=>{
 const {root}=workspace(t,{'a.md':'# A','b.md':'# B\n\n[[missing.pdf#page=999]]'});bindScope(root);mockFetch(t,[]);
 await changeStaging(root,['a.md'],'add',options);await runPush(['--base',root,'--dry-run']);assert.deepEqual(Object.keys(loadIndex(root).entries),['a.md']);
});

test('attachment failure retains the staged document for retry',async t=>{
 configure(t);const {root}=workspace(t,{'a.md':'# A\n\n[Evidence](report.pdf)','report.pdf':'synthetic attachment'});bindScope(root);await changeStaging(root,['a.md'],'add',options);
 const steps=[{path:'/wiki/api/v2/pages',method:'POST',body:{id:'201',version:{number:1}}},
 {path:'/wiki/rest/api/content/201/child/attachment?filename=report.pdf',body:{results:[]}},
 {path:'/wiki/rest/api/content/201/child/attachment',method:'POST',status:400}];mockFetch(t,steps,scopeResponder(root,steps));
 const old=process.exitCode;try{await runPush(['--base',root]);assert.equal(process.exitCode,1)}finally{process.exitCode=old}
 assert.equal(Object.keys(loadIndex(root).entries).length,1);assert.equal(loadMapping(mappingPath(root))['a.md'].hash,undefined);
});

test('legacy baseline does not list or upload unchanged files solely because preprocessing changed',async t=>{
 configure(t);const {buildTreeRenderer}=await import('../dist/sync/render.js');const {docHash}=await import('../dist/documents/markdown.js');
 const {root}=workspace(t,{'a.md':'# A\n\nEvidence[^n].\n\n[^n]: Note'});bindScope(root);
 const tree=buildTreeRenderer(root,['a.md']),doc=tree.docs['a.md'];saveMapping(mappingPath(root),{'a.md':{pageId:'201',title:'A',hash:docHash(doc.title,tree.render('a.md',doc.body,doc.title)),remoteVersion:1}});
 assert.equal((await inspectStaging(root,options))[0].status,'same');
 await changeStaging(root,['a.md'],'add',options);mockFetch(t,[]);await runPush(['--base',root]);assert.deepEqual(loadIndex(root).entries,{});
});

test('pre-callout baseline recognizes untouched quotes while real edits remain changed',async t=>{
 configure(t);const {hashOf}=await import('../dist/documents/markdown.js');
 const {root,put}=workspace(t,{'a.md':'---\ntitle: A\n---\n> [!summary]\n> Original'});bindScope(root);
 const oldStorage='<blockquote>\n<p>[!summary]\nOriginal</p>\n</blockquote>\n';
 saveMapping(mappingPath(root),{'a.md':{pageId:'201',title:'A',hash:hashOf('A\0'+oldStorage),remoteVersion:1}});
 assert.equal((await inspectStaging(root,options))[0].status,'same');
 await changeStaging(root,['a.md'],'add',options);mockFetch(t,[]);await runPush(['--base',root]);assert.deepEqual(loadIndex(root).entries,{});
 put('a.md','---\ntitle: A\n---\n> [!summary]\n> Actually edited');
 assert.equal((await inspectStaging(root,options))[0].status,'changed');
});

test('forced upgrade of a pre-callout baseline uploads the modern panel format',async t=>{
 configure(t);const {hashOf}=await import('../dist/documents/markdown.js');
 const {root}=workspace(t,{'a.md':'---\ntitle: A\n---\n> [!summary]\n> Original'});bindScope(root);
 saveMapping(mappingPath(root),{'a.md':{pageId:'201',title:'A',hash:hashOf('A\0<blockquote>\n<p>[!summary]\nOriginal</p>\n</blockquote>\n'),remoteVersion:1}});
 await changeStaging(root,['a.md'],'add',options);
 const steps=[{path:'/wiki/api/v2/pages/201',method:'PUT',body:{id:'201',version:{number:2}},check:init=>{const body=JSON.parse(init.body);assert.match(body.body.value,/ac:name="panel"/);assert.doesNotMatch(body.body.value,/\[!summary\]/);}}];
 mockFetch(t,steps,scopeResponder(root,steps));await runPush(['--base',root,'--force']);assert.deepEqual(loadIndex(root).entries,{});
});

test('panel-era baseline remains clean after metadata support and still detects edits',async t=>{
 configure(t);const {toStorage,hashOf}=await import('../dist/documents/markdown.js');const source='> [!summary]\n> Original';const {root,put}=workspace(t,{'a.md':'---\ntitle: A\n---\n'+source});bindScope(root);
 const old=toStorage(source,'a.md',{},root,{legacyCallouts:'panels'}).storage;
 saveMapping(mappingPath(root),{'a.md':{pageId:'201',title:'A',hash:hashOf('A\0'+old),remoteVersion:1}});assert.equal((await inspectStaging(root,options))[0].status,'same');
 await changeStaging(root,['a.md'],'add',options);mockFetch(t,[]);await runPush(['--base',root]);assert.deepEqual(loadIndex(root).entries,{});
 put('a.md','---\ntitle: A\n---\n> [!summary]\n> Real edit');assert.equal((await inspectStaging(root,options))[0].status,'changed');
});

test('footnote comment-era baseline stays clean after anchor metadata support',async t=>{
 configure(t);const {hashOf}=await import('../dist/documents/markdown.js');const {footnoteStorageComments}=await import('../dist/documents/footnote-roundtrip.js');const {preparePushTree}=await import('../dist/sync/prepare.js');
 const {root,put}=workspace(t,{'a.md':'---\ntitle: A\n---\nText[^law]\n\n[^law]: Original'});bindScope(root);const tree=await preparePushTree(root,['a.md'],['a.md']);let old;try{const d=tree.docs['a.md'];old=footnoteStorageComments(tree.render('a.md',d.body,d.title).storage);}finally{tree.dispose()}
 saveMapping(mappingPath(root),{'a.md':{pageId:'201',title:'A',hash:hashOf('A\0'+old),remoteVersion:1}});assert.equal((await inspectStaging(root,options))[0].status,'same');await changeStaging(root,['a.md'],'add',options);mockFetch(t,[]);await runPush(['--base',root]);assert.deepEqual(loadIndex(root).entries,{});
 put('a.md','---\ntitle: A\n---\nText[^law]\n\n[^law]: Edited');assert.equal((await inspectStaging(root,options))[0].status,'changed');
});

test('a filename-only rename preserves title and uploads no remote body, while relinking the stored path',async t=>{
 configure(t);const source='---\npageId: 201\ntitle: Fixed remote title\n---\n\nBody\n';const {root,put}=workspace(t,{'folder/002_doc.md':source});bindScope(root);mockFetch(t,[]);
 const {preparePushTree}=await import('../dist/sync/prepare.js');const {docHash}=await import('../dist/documents/markdown.js');const {localStateHash}=await import('../dist/sync/local-state.js');
 const prepared=await preparePushTree(root,['folder/002_doc.md'],['folder/002_doc.md']);const doc=prepared.docs['folder/002_doc.md'],rendered=prepared.render('folder/002_doc.md',doc.body,doc.title);
 const original={pageId:'201',title:doc.title,hash:docHash(doc.title,rendered),localHash:localStateHash(root,'folder/002_doc.md',rendered),remoteVersion:5,remoteParentId:'202'};prepared.dispose();
 saveMapping(mappingPath(root),{'folder/Original_title.md':original,'folder/':{pageId:'202',type:'folder'}});
 const before=readFileSync(mappingPath(root),'utf8');const row=(await inspectStaging(root,options))[0];assert.equal(row.status,'changed');assert.equal(row.renamed,true);assert.equal(readFileSync(mappingPath(root),'utf8'),before);
 await changeStaging(root,['folder/002_doc.md'],'add',options);await runPush(['--base',root,'--dry-run']);assert.equal(readFileSync(mappingPath(root),'utf8'),before);
 await runPush(['--base',root]);const mapping=loadMapping(mappingPath(root));assert.equal(mapping['folder/Original_title.md'],undefined);assert.deepEqual(mapping['folder/002_doc.md'],original);assert.equal(loadIndex(root).entries['folder/002_doc.md'],undefined);assert.equal(readFileSync(join(root,'folder/002_doc.md'),'utf8'),source);
 assert.equal((await inspectStaging(root,options))[0].status,'same');
});
