import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';
import {workspace,configure,mockFetch} from './helpers/fixtures.mjs';import {bindScope,scopeResponder} from './helpers/scope.mjs';
import {runPull} from '../dist/sync/pull.js';import {runRestore} from '../dist/sync/restore.js';import {inspectStaging,changeStaging,loadIndex} from '../dist/sync/staging.js';import {observeChanges,changeGroup} from '../dist/sync/changes.js';import {mappingPath} from '../dist/sync/metadata.js';import {saveMapping} from '../dist/sync/mapping.js';
const env={baseUrl:'https://example.invalid/wiki',email:'test@example.invalid',token:'test-token',spaceKey:'TEST'};
const listing={path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100',body:{results:[{id:'101',title:'Plan (PoC)',parentId:'100',spaceId:'space',version:{number:1}}]}};
const body=(html='<p>Remote body</p>')=>({path:'/wiki/rest/api/content/101?expand=body.export_view,body.storage,version',body:{id:'101',type:'page',title:'Plan (PoC)',version:{number:1},body:{export_view:{value:html},storage:{value:html}}}});
function setup(t,files={}){configure(t);const result=workspace(t,files);bindScope(result.root,{connection:{homepageId:'100'},scope:{id:'100',type:'page',path:'/'}});return result;}
const remote=(t,root,steps)=>mockFetch(t,steps,scopeResponder(root,steps));
const assetSteps=[{path:'/wiki/rest/api/content/101/child/attachment?limit=100',body:{results:[{title:'mmd-diagram.svg',_links:{download:'/download/mmd.svg'}}]}},{path:'/wiki/download/mmd.svg',bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>remote</text></svg>')}];

for(const htmlTable of [false,true])test(`Pull calculates a complete baseline for SVG attachments under parenthesized paths: htmlTable=${htmlTable}`,async t=>{
 const {root}=setup(t);const image='<img src="/download/attachments/101/mmd-diagram.svg"/>';const html=htmlTable?`<table data-table-width="760"><colgroup><col style="width:760px"/></colgroup><tbody><tr><td>${image}</td></tr></tbody></table>`:image;
 remote(t,root,[listing,body(html),...assetSteps]);await runPull(['pull','--base',root]);assert.ok(fs.existsSync(join(root,'attachments/Plan (PoC)/mmd-diagram.svg')));const map=JSON.parse(fs.readFileSync(mappingPath(root),'utf8'));assert.equal(map['Plan (PoC).md'].pageId,'101');assert.ok(map['Plan (PoC).md'].localHash);assert.equal((await inspectStaging(root)).find(row=>row.path==='Plan (PoC).md').status,'same');
});

test('a baseline persistence failure rolls back all new document and attachment files',async t=>{
 const {root}=setup(t,{'.csync/objects':'blocked objects directory'});remote(t,root,[listing,body('<img src="/download/attachments/101/mmd-diagram.svg"/>'),...assetSteps]);await assert.rejects(runPull(['pull','--base',root]),/비교 기준 폴더/);assert.equal(fs.existsSync(join(root,'Plan (PoC).md')),false);assert.equal(fs.existsSync(join(root,'attachments')),false);assert.equal(fs.existsSync(mappingPath(root)),false);assert.equal(fs.readFileSync(join(root,'.csync/objects'),'utf8'),'blocked objects directory');
});

test('failed overwrite restores the original document, attachment, mapping and upload selection',async t=>{
 const {root}=setup(t,{'Plan (PoC).md':'# My edits','attachments/Plan (PoC)/mmd-diagram.svg':'local SVG','.csync/objects':'blocked'});saveMapping(mappingPath(root),{'Plan (PoC).md':{pageId:'101',remoteVersion:1,hash:'old'}});await changeStaging(root,['Plan (PoC).md'],'add');const before=fs.readFileSync(mappingPath(root),'utf8'),index=loadIndex(root);
 remote(t,root,[body('<img src="/download/attachments/101/mmd-diagram.svg"/>'),...assetSteps]);await assert.rejects(runRestore(['restore','Plan (PoC).md','--overwrite','--base',root]),/비교 기준 폴더/);assert.equal(fs.readFileSync(join(root,'Plan (PoC).md'),'utf8'),'# My edits');assert.equal(fs.readFileSync(join(root,'attachments/Plan (PoC)/mmd-diagram.svg'),'utf8'),'local SVG');assert.equal(fs.readFileSync(mappingPath(root),'utf8'),before);assert.deepEqual(loadIndex(root),index);
});

for(const changed of [false,true])test(`retry verifies existing unmapped Pull output before adopting a baseline: changed=${changed}`,async t=>{
 const {root,put}=setup(t);remote(t,root,[listing,body()]);await runPull(['pull','--base',root]);const text=fs.readFileSync(join(root,'Plan (PoC).md'),'utf8');fs.rmSync(mappingPath(root));if(changed)put('Plan (PoC).md',text+'\nMy newer edit');const original=fs.readFileSync(join(root,'Plan (PoC).md'),'utf8');const stamp=fs.statSync(join(root,'Plan (PoC).md')).mtimeMs;
 const inspected=await inspectStaging(root),view=observeChanges(root,inspected,env);assert.equal(view.rows.length,1);assert.equal(view.rows[0].unmapped,true);assert.equal(view.rows[0].pageId,'101');assert.equal(changeGroup(view.rows[0]),'receive');
 remote(t,root,[body()]);if(changed){await assert.rejects(runPull(['pull','--base',root]),/原|원격과 다릅니다/);assert.equal(fs.existsSync(mappingPath(root)),false);}else{await runPull(['pull','--base',root]);assert.equal((await inspectStaging(root))[0].status,'same');assert.equal(JSON.parse(fs.readFileSync(mappingPath(root),'utf8'))['Plan (PoC).md'].remoteVersion,1);}
 assert.equal(fs.readFileSync(join(root,'Plan (PoC).md'),'utf8'),original);assert.equal(fs.statSync(join(root,'Plan (PoC).md')).mtimeMs,stamp);
});

test('a frontmatter page ID for a different space cannot authorize recovery',async t=>{
 const {root}=setup(t,{'Plan (PoC).md':'---\npageId: 101\nspaceKey: OTHER\n---\nMy source'});remote(t,root,[listing]);await runPull(['pull','--base',root]);assert.match(fs.readFileSync(join(root,'Plan (PoC).md'),'utf8'),/My source/);assert.equal(fs.existsSync(mappingPath(root)),false);
});

test('concurrent edits during baseline finalization are preserved while new untouched files roll back',async t=>{
 const {root}=setup(t);saveMapping(mappingPath(root),{});const mappingBefore=fs.readFileSync(mappingPath(root),'utf8'),read=fs.readFileSync;let edited=false;
 t.mock.method(fs,'readFileSync',function(path,...args){if(!edited&&String(path)===mappingPath(root)&&fs.existsSync(join(root,'Plan (PoC).md'))){edited=true;fs.writeFileSync(join(root,'Plan (PoC).md'),'# Concurrent edit');}return read.call(this,path,...args)});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 remote(t,root,[listing,body()]);await assert.rejects(runPull(['pull','--base',root]),/기준 계산 중 로컬 문서가 변경/);assert.equal(edited,true);assert.equal(fs.readFileSync(join(root,'Plan (PoC).md'),'utf8'),'# Concurrent edit');assert.equal(fs.readFileSync(mappingPath(root),'utf8'),mappingBefore);
});

test('atomic mapping replacement preserves the old mapping if rename fails',t=>{
 const {root}=setup(t);saveMapping(mappingPath(root),{'old.md':{pageId:'1'}});const prior=fs.readFileSync(mappingPath(root),'utf8'),rename=fs.renameSync;
 t.mock.method(fs,'renameSync',function(from,to){if(to===mappingPath(root))throw Error('synthetic rename failure');return rename.call(this,from,to)});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});assert.throws(()=>saveMapping(mappingPath(root),{'new.md':{pageId:'2'}}),/rename failure/);assert.equal(fs.readFileSync(mappingPath(root),'utf8'),prior);assert.equal(fs.readdirSync(join(root,'.csync')).some(file=>file.endsWith('.tmp')),false);
});

test('an exclusive-copy race never deletes a file created by another process',async t=>{
 const {root}=setup(t),copy=fs.copyFileSync,target=join(root,'Plan (PoC).md');t.mock.method(fs,'copyFileSync',function(from,to,...args){if(to===target){fs.writeFileSync(target,'# Created concurrently');const error=Error('destination exists');error.code='EEXIST';throw error;}return copy.call(this,from,to,...args)});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 remote(t,root,[listing,body()]);await assert.rejects(runPull(['pull','--base',root]),/destination exists/);assert.equal(fs.readFileSync(target,'utf8'),'# Created concurrently');assert.equal(fs.existsSync(mappingPath(root)),false);
});
