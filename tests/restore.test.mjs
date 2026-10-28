import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,existsSync,rmSync,symlinkSync,statSync,readdirSync} from 'node:fs';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
import {workspace,configure,mockFetch} from './helpers/fixtures.mjs';import {bindScope,scopeResponder} from './helpers/scope.mjs';
import {runRestore} from '../dist/sync/restore.js';import {saveMapping,loadMapping} from '../dist/sync/mapping.js';import {mappingPath} from '../dist/sync/metadata.js';import {inspectStaging,changeStaging,loadIndex} from '../dist/sync/staging.js';
const node=(id='100',html='<p>Latest dashboard</p>')=>({path:`/wiki/rest/api/content/${id}?expand=body.export_view,body.storage,version`,body:{id,type:'page',title:id==='100'?'Dashboard':'Child',version:{number:13},body:{export_view:{value:html},storage:{value:html}}}});
function fixture(t,files={}){
 configure(t);const result=workspace(t,{'other.md':'# Other\n\nLocal edits',...files});bindScope(result.root,{connection:{homepageId:'100'},scope:{id:'100',type:'page',path:'/'}});
 saveMapping(mappingPath(result.root),{'README.md':{pageId:'100',title:'Dashboard',hash:'old',remoteVersion:12},'other.md':{pageId:'201',hash:'old-other',remoteVersion:1}});return result;
}
function remote(t,root,steps){const seen=[];const responder=scopeResponder(root,steps);mockFetch(t,steps,(url,init,step)=>{seen.push({url:String(url),method:init.method??'GET'});assert.equal(init.method??'GET','GET');return responder(url,init,step)});return seen;}

test('restore downloads only the missing homepage, never scans its children or changes remote content',async t=>{
 const {root}=fixture(t),before=loadMapping(mappingPath(root))['other.md'],other=readFileSync(join(root,'other.md'),'utf8');const calls=remote(t,root,[node()]);
 await runRestore(['restore','README.md','--base',root]);assert.match(readFileSync(join(root,'README.md'),'utf8'),/Latest dashboard/);assert.equal(loadMapping(mappingPath(root))['README.md'].remoteVersion,13);assert.deepEqual(loadMapping(mappingPath(root))['other.md'],before);assert.equal(readFileSync(join(root,'other.md'),'utf8'),other);
 assert.ok(calls.every(c=>!c.url.includes('/child/page')&&!c.url.includes('/child/folder')&&!c.url.includes('/api/v2/pages?')));assert.deepEqual(loadIndex(root).entries,{});assert.equal((await inspectStaging(root)).find(r=>r.path==='README.md').status,'same');
});

for(const kind of ['existing','unmapped','excluded','nested','folder','pending','moved','symlink'])test(`restore refuses ${kind} targets before any API request`,async t=>{
 const {root,put}=fixture(t);let path='README.md';
 if(kind==='existing')put(path,'# Keep');
 if(kind==='unmapped')path='unknown.md';
 if(kind==='excluded')put('.csync/ignore','README.md\n');
 if(kind==='nested'){path='nested/doc.md';put('nested/.csync/workspace.json','{}');const map=loadMapping(mappingPath(root));map[path]={pageId:'202',remoteVersion:1};saveMapping(mappingPath(root),map);}
 if(kind==='folder'){path='folder/';const map=loadMapping(mappingPath(root));map[path]={pageId:'203',type:'folder'};saveMapping(mappingPath(root),map);}
 if(kind==='pending'){const map=loadMapping(mappingPath(root));map[path].pendingMove={parentKey:'x/'};saveMapping(mappingPath(root),map);}
 if(kind==='moved')put('moved.md','---\npageId: 100\n---\nMoved local document');
 if(kind==='symlink')symlinkSync(join(root,'absent.md'),join(root,path));
 mockFetch(t,[]);const before=readFileSync(mappingPath(root),'utf8');await assert.rejects(runRestore(['restore',path,'--base',root]),/이미|매핑|제외|이동/);assert.equal(readFileSync(mappingPath(root),'utf8'),before);if(kind==='existing')assert.equal(readFileSync(join(root,path),'utf8'),'# Keep');
});

test('a local document created while downloading is preserved with its original mapping',async t=>{
 const {root,put}=fixture(t);const before=readFileSync(mappingPath(root),'utf8');remote(t,root,[{...node(),check:()=>put('README.md','# Created during download')}]);
 await assert.rejects(runRestore(['restore','README.md','--base',root]),/로컬 파일이 변경|이미 존재/);assert.equal(readFileSync(join(root,'README.md'),'utf8'),'# Created during download');assert.equal(readFileSync(mappingPath(root),'utf8'),before);
});

test('successful restore clears only the restored document from the prior upload selection',async t=>{
 const {root,put}=fixture(t,{'README.md':'# Prior dashboard'});await changeStaging(root,['README.md','other.md'],'add');rmSync(join(root,'README.md'));remote(t,root,[node()]);
 await runRestore(['restore','README.md','--base',root]);assert.deepEqual(Object.keys(loadIndex(root).entries),['other.md']);assert.match(readFileSync(join(root,'README.md'),'utf8'),/Latest dashboard/);
});

test('failed restore applies none of the selected files and cleans temporary downloads',async t=>{
 const {root}=fixture(t),scratch=workspace(t).root;const priorTmp=process.env.TMPDIR;process.env.TMPDIR=scratch;t.after(()=>{if(priorTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=priorTmp;});
 const map=loadMapping(mappingPath(root));map['child.md']={pageId:'202',remoteVersion:1};saveMapping(mappingPath(root),map);const before=readFileSync(mappingPath(root),'utf8');remote(t,root,[node(),{...node('202'),status:403}]);
 await assert.rejects(runRestore(['restore','README.md','child.md','--base',root]),/403/);assert.equal(existsSync(join(root,'README.md')),false);assert.equal(existsSync(join(root,'child.md')),false);assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.deepEqual(readdirSync(scratch),[]);
});

for(const identical of [true,false])test(`restore preserves existing attachments: identical=${identical}`,async t=>{
 const {root}=fixture(t,{'attachments/README/image.png':'existing'});const attachment=join(root,'attachments/README/image.png'),stamp=statSync(attachment).mtimeMs;
 remote(t,root,[node('100','<p>Dashboard</p><img src="/download/attachments/100/image.png"/>'),{path:'/wiki/rest/api/content/100/child/attachment?limit=100',body:{results:[{title:'image.png',_links:{download:'/download/image.png'}}]}},{path:'/wiki/download/image.png',bytes:Buffer.from(identical?'existing':'different')}]);
 if(identical)await runRestore(['restore','README.md','--base',root]);else await assert.rejects(runRestore(['restore','README.md','--base',root]),/첨부 파일 충돌/);
 assert.equal(readFileSync(attachment,'utf8'),'existing');assert.equal(statSync(attachment).mtimeMs,stamp);assert.equal(existsSync(join(root,'README.md')),identical);
});

for(const malformed of ['folder','wrong-id'])test(`restore does not expand invalid remote response: ${malformed}`,async t=>{
 const {root}=fixture(t);const response=node();if(malformed==='folder')response.body.type='folder';else response.body.id='999';remote(t,root,[response]);await assert.rejects(runRestore(['restore','README.md','--base',root]),/매핑된 원격 페이지/);assert.equal(existsSync(join(root,'README.md')),false);
});

test('CLI restore help is independent of credentials and invalid options cannot write',t=>{
 const {root}=workspace(t);const cli=resolve('dist/sync.js');const help=spawnSync(process.execPath,[cli,'restore','--help'],{cwd:root,encoding:'utf8'});assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/누락|삭제/);assert.match(help.stdout,/하위 페이지·전체 스페이스는 탐색하지 않습니다/);
 for(const args of [['restore','--base'],['restore','README.md','--full']]){const result=spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8'});assert.equal(result.status,1);assert.equal(existsSync(join(root,'.csync')),false);}
});

for(const version of [11,undefined])test(`restore refuses bodies older than the baseline or missing a version: ${version}`,async t=>{
 const {root}=fixture(t);const response=node();if(version===undefined)delete response.body.version;else response.body.version.number=version;remote(t,root,[response]);
 const before=readFileSync(mappingPath(root),'utf8');await assert.rejects(runRestore(['restore','README.md','--base',root]),/Fetch보다 이전|버전/);assert.equal(existsSync(join(root,'README.md')),false);assert.equal(readFileSync(mappingPath(root),'utf8'),before);
});

for(const overwrite of [false,true])test(`CLI restore dispatch uses GET-only requests: overwrite=${overwrite}`,t=>{
 const {root,put}=fixture(t,overwrite?{'README.md':'# Discard these edits'}:{});const responses=put('responses.json',JSON.stringify([node()])),calls=put('calls.jsonl','');
 const result=spawnSync(process.execPath,[resolve('dist/sync.js'),'restore','README.md',...(overwrite?['--overwrite']:[]),'--base',root],{cwd:root,encoding:'utf8',env:{...process.env,NO_COLOR:'1',NODE_OPTIONS:`--import=${new URL('./helpers/fetch-preload.mjs',import.meta.url).href}`,CSYNC_TEST_RESPONSES:responses,CSYNC_TEST_CALLS:calls,CSYNC_TEST_SCOPE_BASE:root}});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/하위 항목 탐색 없음/);assert.match(readFileSync(join(root,'README.md'),'utf8'),/Latest dashboard/);assert.ok(readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse).every(call=>call.method==='GET'));assert.equal(loadMapping(mappingPath(root))['README.md'].remoteVersion,13);
});

test('overwrite restores an existing edited document even at the same remote version and unstages only that document',async t=>{
 const {root}=fixture(t,{'README.md':'---\npageId: 100\n---\n# My dashboard edits'});await changeStaging(root,['README.md','other.md'],'add');
 const other=readFileSync(join(root,'other.md'),'utf8'),before=loadMapping(mappingPath(root))['other.md'];const response=node();response.body.version.number=12;const calls=remote(t,root,[response]);
 await runRestore(['restore','README.md','--overwrite','--base',root]);assert.match(readFileSync(join(root,'README.md'),'utf8'),/Latest dashboard/);assert.doesNotMatch(readFileSync(join(root,'README.md'),'utf8'),/My dashboard edits/);assert.equal((await inspectStaging(root)).find(r=>r.path==='README.md').status,'same');assert.deepEqual(Object.keys(loadIndex(root).entries),['other.md']);assert.equal(readFileSync(join(root,'other.md'),'utf8'),other);assert.deepEqual(loadMapping(mappingPath(root))['other.md'],before);assert.ok(calls.every(c=>c.method==='GET'&&!c.url.includes('/child/page')&&!c.url.includes('/child/folder')));
});

test('overwrite replaces only selected documents and their remotely referenced attachments, retaining other assets',async t=>{
 const {root}=fixture(t,{'README.md':'# Local dashboard','attachments/README/image.png':'local edit','attachments/README/old.png':'keep unreferenced','attachments/other/image.png':'keep other'});
 remote(t,root,[node('100','<p>Dashboard</p><img src="/download/attachments/100/image.png"/>'),{path:'/wiki/rest/api/content/100/child/attachment?limit=100',body:{results:[{title:'image.png',_links:{download:'/download/image.png'}}]}},{path:'/wiki/download/image.png',bytes:Buffer.from('remote image')}]);
 await runRestore(['restore','README.md','--overwrite','--base',root]);assert.equal(readFileSync(join(root,'attachments/README/image.png'),'utf8'),'remote image');assert.equal(readFileSync(join(root,'attachments/README/old.png'),'utf8'),'keep unreferenced');assert.equal(readFileSync(join(root,'attachments/other/image.png'),'utf8'),'keep other');assert.equal((await inspectStaging(root)).find(r=>r.path==='README.md').status,'same');
});

for(const kind of ['document','attachment'])test(`overwrite preserves ${kind} edited during download and leaves selection and mapping untouched`,async t=>{
 const {root,put}=fixture(t,{'README.md':'# Before download','attachments/README/image.png':'original image'});await changeStaging(root,['README.md'],'add');const before=readFileSync(mappingPath(root),'utf8'),index=loadIndex(root);
 remote(t,root,[{...node('100','<p>Dashboard</p><img src="/download/attachments/100/image.png"/>'),check:()=>put(kind==='document'?'README.md':'attachments/README/image.png','New edit during download')},{path:'/wiki/rest/api/content/100/child/attachment?limit=100',body:{results:[{title:'image.png',_links:{download:'/download/image.png'}}]}},{path:'/wiki/download/image.png',bytes:Buffer.from('remote image')}]);
 await assert.rejects(runRestore(['restore','README.md','--overwrite','--base',root]),/로컬 파일이 변경/);assert.equal(readFileSync(join(root,'README.md'),'utf8'),kind==='document'?'New edit during download':'# Before download');assert.equal(readFileSync(join(root,'attachments/README/image.png'),'utf8'),kind==='attachment'?'New edit during download':'original image');assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.deepEqual(loadIndex(root),index);
});

for(const kind of ['symlink','wrong-page','duplicate-page','excluded'])test(`overwrite cannot bypass ${kind} protection`,async t=>{
 const {root,put}=fixture(t);if(kind==='symlink'){put('keep.md','Preserve');symlinkSync(join(root,'keep.md'),join(root,'README.md'));}else put('README.md',kind==='wrong-page'?'---\npageId: 999\n---\nKeep':'---\npageId: 100\n---\nKeep');
 if(kind==='duplicate-page')put('moved.md','---\npageId: 100\n---\nMoved');if(kind==='excluded')put('.csync/ignore','README.md\n');mockFetch(t,[]);const before=readFileSync(mappingPath(root),'utf8');await assert.rejects(runRestore(['restore','README.md','--overwrite','--base',root]),/이미|pageId|제외/);assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.match(readFileSync(join(root,'README.md'),'utf8'),/Preserve|Keep/);
});

test('failed overwrite download preserves all original edits and staging',async t=>{
 const {root}=fixture(t,{'README.md':'# Dashboard edits','child.md':'# Child edits'});const map=loadMapping(mappingPath(root));map['child.md']={pageId:'202',remoteVersion:1};saveMapping(mappingPath(root),map);await changeStaging(root,['README.md','child.md'],'add');const before=readFileSync(mappingPath(root),'utf8'),index=loadIndex(root);remote(t,root,[node(),{...node('202'),status:403}]);
 await assert.rejects(runRestore(['restore','README.md','child.md','--overwrite','--base',root]),/403/);assert.equal(readFileSync(join(root,'README.md'),'utf8'),'# Dashboard edits');assert.equal(readFileSync(join(root,'child.md'),'utf8'),'# Child edits');assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.deepEqual(loadIndex(root),index);
});
