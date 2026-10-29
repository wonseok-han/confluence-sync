import {explicitPush} from './helpers/explicit-push.mjs';
const runPush = args => corePush(explicitPush(args));
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { workspace, mockFetch, configure } from './helpers/fixtures.mjs';
import { bindScope, scopeResponder } from './helpers/scope.mjs';
import { connectWorkspace } from '../dist/sync/scope.js';
import { loadWorkspace, requireScope } from '../dist/sync/workspace.js';
import { mappingPath, workspacePath } from '../dist/sync/metadata.js';
import { loadMapping, saveMapping } from '../dist/sync/mapping.js';
import { runPull } from '../dist/sync/pull.js';
import { runPush as corePush } from '../dist/sync/push.js';
import { buildTreeRenderer } from '../dist/sync/render.js';
import { docHash } from '../dist/documents/markdown.js';
import { collectMarkdown } from '../dist/documents/catalog.js';

const env = {baseUrl:'https://example.invalid/wiki',email:'test@example.invalid',token:'fake',spaceKey:'TEST'};
const cli=resolve('dist/sync.js'),preload=pathToFileURL(resolve('tests/helpers/fetch-preload.mjs')).href;
const space={path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space',homepageId:'100'}]}};
const info=(id,title='Home',type='page',ancestors=[])=>({path:`/wiki/rest/api/content/${id}?expand=ancestors,space,version`,body:{id,title,type,space:{id:'space'},ancestors}});
const remote=(id,title,body='<p>Remote</p>',number=1,type='page')=>({path:`/wiki/rest/api/content/${id}?expand=body.export_view,body.storage,version`,body:{id,title,type,body:{export_view:{value:body},storage:{value:body}},version:{number}}});
const children=(id,pages=[],folders=[])=>[{path:`/wiki/rest/api/content/${id}/child/folder?limit=100`,body:{results:folders}},{path:`/wiki/rest/api/content/${id}/child/page?limit=100`,body:{results:pages}}];
const selected=(root,scope={id:'100',type:'page',path:'/'})=>bindScope(root,{connection:{homepageId:'100'},scope});
function baseline(root, entries) {
 const rels=collectMarkdown(root).map(path=>path.slice(root.length+1).split('\\').join('/')),tree=buildTreeRenderer(root,rels),mapping={};
 for(const [rel,id] of Object.entries(entries)) {
  const doc=tree.docs[rel];mapping[rel]={pageId:id,title:doc.title,hash:docHash(doc.title,tree.render(rel,doc.body,doc.title)),remoteVersion:1};
 }
 saveMapping(mappingPath(root),mapping);return mapping;
}
function offline(root,put,args,steps) {
 if(args.includes('push'))args=explicitPush(args,true);
 const responses=put('responses.json',JSON.stringify(steps)),calls=put('calls.jsonl','');
 const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CONFLUENCE_')));
 const result=spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',env:{...inherited,NO_COLOR:'1',NODE_OPTIONS:`--import=${preload}`,CSYNC_TEST_RESPONSES:responses,CSYNC_TEST_CALLS:calls,CSYNC_TEST_SCOPE_BASE:workspacePath(root)&&existsSync(workspacePath(root))&&loadWorkspace(root).version===2?root:'',CONFLUENCE_BASE_URL:env.baseUrl,CONFLUENCE_EMAIL:env.email,CONFLUENCE_API_TOKEN:env.token,CONFLUENCE_SPACE_KEY:env.spaceKey}});
 return {...result,calls:readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)};
}
const discovery=(pages)=>({path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100',body:{results:pages.map(([id,title,parentId])=>({id,title,spaceId:'space',version:{number:1},...(parentId?{parentId}:{})}))}});
const mockScoped=(t,root,steps)=>mockFetch(t,steps,scopeResponder(root,steps));

for(const args of [['push','--dry-run'],['push','--list'],['push'],['remap']])test(`scope is mandatory without any implicit whole-space fallback: ${args}`,t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc'});const result=offline(root,put,[...args,'--base',root],[]);
 assert.equal(result.status,1);assert.match(result.stderr,/스페이스 연결이 없습니다/);assert.equal(existsSync(join(root,'.csync')),false);
});

test('legacy local scopes and parent settings never become a remote scope automatically',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc','.confluence-workspace.json':JSON.stringify({version:1,syncPaths:['.']}),'.env':'CONFLUENCE_PARENT_ID=123'});
 const result=offline(root,put,['push','--base',root,'--dry-run'],[]);assert.equal(result.status,1);assert.match(result.stderr,/스페이스 연결이 없습니다/);
 assert.equal(loadWorkspace(root).version,1);
});

test('initial connection uses the space homepage without filtering existing local documents',async t=>{
 const {root}=workspace(t,{'지식자산/특허출원/doc.md':'# Doc'});const calls=mockFetch(t,[space]);
 const config=await connectWorkspace(root,env);assert.equal(config.scope,undefined);assert.equal(config.remoteRoot.id,'100');assert.equal(calls.length,1);assert.equal(existsSync(mappingPath(root)),false);
});

test('a root README bound elsewhere prevents silently rebinding the workspace',async t=>{
 const {root}=workspace(t,{'README.md':'# Local'});saveMapping(mappingPath(root),{'README.md':{pageId:'999'}});mockFetch(t,[space]);
 await assert.rejects(connectWorkspace(root,env),/다른 원격 페이지/);assert.equal(existsSync(workspacePath(root)),false);
});

test('manually composed documents can be pushed without any pull after explicit scope selection',t=>{
 const {root,put}=workspace(t,{'idea.md':'# Idea\n\nLocal text'});selected(root,{id:'200',type:'folder',path:'/Patents'});
 const result=offline(root,put,['push','--base',root],[space,{path:'/wiki/api/v2/pages',method:'POST',body:{id:'201',version:{number:1}}}]);
 assert.equal(result.status,0,result.stderr);assert.equal(result.calls.at(-1).body.parentId,'200');assert.match(result.calls.at(-1).body.body.value,/Local text/);
 assert.equal(loadMapping(mappingPath(root))['idea.md'].remoteVersion,1);
});

test('an unbound root README cannot overwrite the selected remote page on first push',t=>{
 const {root,put}=workspace(t,{'README.md':'# Local'});selected(root);
 const result=offline(root,put,['push','--base',root],[]);assert.equal(result.status,1);assert.match(result.stderr,/루트 README/);
});

test('an existing mapped page outside the selected remote scope cannot be updated',async t=>{
 configure(t);const {root}=workspace(t,{'doc.md':'# Doc'});selected(root,{id:'200',type:'folder',path:'/Patents'});baseline(root,{'doc.md':'999'});
 mockFetch(t,[space,info('200','Patents','folder',[{id:'100',title:'Home'}]),info('999','Outside','page',[{id:'100',title:'Home'}])]);
 await assert.rejects(runPush(['--base',root,'--verify']),/원격 스코프 밖/);assert.equal(loadMapping(mappingPath(root))['doc.md'].remoteVersion,1);
});

test('outer synchronization excludes a separately configured nested workspace',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc','nested/private.md':'# Private','nested/.confluence-sync.json':'{}'});selected(root);
 const result=offline(root,put,['push','--base',root,'--dry-run'],[]);assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/private.md/);
});

test('pull→push keeps the scope as the root and new root documents stay under the selected scope',async t=>{
 configure(t);const {root,put}=workspace(t);selected(root);
 const steps=[discovery([['100','Home'],['101','Child','100']]),space,remote('100','Home'),remote('101','Child')];mockScoped(t,root,steps);
 await runPull(['pull','--base',root]);assert.ok(existsSync(join(root,'README.md')));assert.equal(existsSync(join(root,'Home')),false);
 let result=offline(root,put,['push','--base',root],[]);assert.equal(result.status,0,result.stderr);
 put('New.md','# New');result=offline(root,put,['push','--base',root],[space,{path:'/wiki/api/v2/pages',method:'POST',body:{id:'102'}}]);
 assert.equal(result.status,0,result.stderr);assert.equal(result.calls.at(-1).body.parentId,'100');
});

test('all changed pages are checked before creating a new page',t=>{
 const {root,put}=workspace(t,{'z.md':'# Z'});selected(root,{id:'200',type:'folder',path:'/Patents'});baseline(root,{'z.md':'201'});put('z.md','# Z\n\nEdit');put('a.md','# New');
 const result=offline(root,put,['push','--base',root],[space,{path:'/wiki/api/v2/pages/201',body:{version:{number:2}}}]);
 assert.equal(result.status,1);assert.match(result.stderr,/원격 변경 충돌/);assert.ok(result.calls.every(call=>call.method==='GET'));
});

test('remote changes after preflight are checked again before writing',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc'});selected(root,{id:'200',type:'folder',path:'/Patents'});baseline(root,{'doc.md':'201'});put('doc.md','# Doc\n\nEdit');
 const result=offline(root,put,['push','--base',root],[space,{path:'/wiki/api/v2/pages/201',body:{version:{number:1}}},{path:'/wiki/api/v2/pages/201',body:{version:{number:2}}}]);
 assert.equal(result.status,1);assert.ok(result.calls.every(call=>call.method==='GET'));assert.equal(loadMapping(mappingPath(root))['doc.md'].remoteVersion,1);
});

test('pull preserves dirty local documents and their prior baseline',async t=>{
 configure(t);const {root,put}=workspace(t,{'README.md':'# Home'});selected(root);baseline(root,{'README.md':'100'});put('README.md','# Home\n\nLocal edit');
 const steps=[space,remote('100','Home','<p>Remote edit</p>',2),...children('100')];mockScoped(t,root,steps);
 await assert.rejects(runPull(['pull','--full','--base',root]),/로컬 변경 충돌/);assert.match(readFileSync(join(root,'README.md'),'utf8'),/Local edit/);assert.equal(loadMapping(mappingPath(root))['README.md'].remoteVersion,1);
});

test('a failed descendant download applies none of the staged documents',async t=>{
 configure(t);const {root}=workspace(t,{'README.md':'# Home'});selected(root);baseline(root,{'README.md':'100'});const before=readFileSync(join(root,'README.md'),'utf8');
 const steps=[space,remote('100','Home','<p>Changed</p>',2),...children('100',[{id:'101',title:'Child'}]),{...remote('101','Child'),status:403}];mockScoped(t,root,steps);
 await assert.rejects(runPull(['pull','--full','--base',root]),/403/);assert.equal(readFileSync(join(root,'README.md'),'utf8'),before);assert.equal(loadMapping(mappingPath(root))['README.md'].remoteVersion,1);
});

test('pull path collisions are rejected before applying a new root README',async t=>{
 configure(t);const {root}=workspace(t);selected(root);
 const steps=[discovery([['100','Home'],['101','A/B','100'],['102','A:B','100']]),space,remote('100','Home'),remote('101','A/B'),remote('102','A:B')];mockScoped(t,root,steps);
 await assert.rejects(runPull(['pull','--base',root]),/같은 로컬 경로/);assert.equal(existsSync(join(root,'README.md')),false);
});

test('removed root and no-mapping options fail before any remote access',async t=>{
 configure(t);const {root}=workspace(t);selected(root);mockFetch(t,[]);
 await assert.rejects(runPull(['pull','--no-mapping','--base',root]),/매핑을 유지/);
 await assert.rejects(runPull(['pull','--root','--base',root]),/제거/);
});

test('read-only validation never initializes the workspace or rewrites mapping',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc'});selected(root,{id:'200',type:'folder',path:'/Patents'});baseline(root,{'doc.md':'201'});
 const before=readFileSync(mappingPath(root),'utf8'),config=readFileSync(workspacePath(root),'utf8');
 const result=offline(root,put,['push','--base',root,'--dry-run','--verify'],[space,{path:'/wiki/api/v2/pages/201',body:{version:{number:1}}}]);
 assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.equal(readFileSync(workspacePath(root),'utf8'),config);
});

test('existing site bindings prevent using the same page IDs against a different site',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc'});bindScope(root,{connection:{baseUrl:'https://other.invalid/wiki'}});
 const result=offline(root,put,['push','--base',root],[]);assert.equal(result.status,1);assert.match(result.stderr,/사이트·스페이스/);
});

test('CLI connects without a local scope and preserves the env file',t=>{
 const original='CONFLUENCE_PARENT_ID=old-setting\n';const {root,put}=workspace(t,{'.env':original,'Patents/doc.md':'# Doc'});
 let result=offline(root,put,['init','--base',root,'--scope','Patents'],[]);assert.equal(result.status,1);assert.match(result.stderr,/제거/);
 result=offline(root,put,['init','--base',root,'--connect'],[space]);
 assert.equal(result.status,0,result.stderr);assert.equal(loadWorkspace(root).scope,undefined);assert.equal(loadWorkspace(root).remoteRoot.id,'100');assert.equal(readFileSync(join(root,'.env'),'utf8'),original);assert.ok(result.calls.every(call=>call.method==='GET'));
});

test('a mapped remote node outside the scope cannot be pulled even when its ID is supplied explicitly',async t=>{
 configure(t);const {root}=workspace(t);selected(root,{id:'200',type:'folder',path:'/Patents'});saveMapping(mappingPath(root),{'outside.md':{pageId:'999'}});
 mockFetch(t,[space,info('200','Patents','folder',[{id:'100',title:'Home'}]),info('999','Outside','page',[{id:'100',title:'Home'}])]);
 await assert.rejects(runPull(['pull','999','--base',root]),/원격 스코프 밖/);assert.equal(existsSync(join(root,'outside.md')),false);
});

test('a remote attachment can be pulled when clean, while local attachment edits stop the whole pull',async t=>{
 configure(t);const {root,put}=workspace(t);selected(root);
 const download=bytes=>[{path:'/wiki/rest/api/content/100/child/attachment?limit=100',body:{results:[{title:'image.png',_links:{download:'/download/image.png'}}]}},{path:'/wiki/download/image.png',bytes:Buffer.from(bytes)}];
 const cycle=(number,bytes)=>[space,remote('100','Home','<p>Remote</p><img src="/download/attachments/100/image.png"/>',number),...children('100'),...download(bytes)];
 const steps=[...cycle(1,'first'),...cycle(2,'second'),...cycle(3,'third')];mockScoped(t,root,steps);
 await runPull(['pull','--full','--base',root]);await runPull(['pull','--full','--base',root]);
 assert.equal(readFileSync(join(root,'attachments/README/image.png'),'utf8'),'second');put('attachments/README/image.png','local edit');
 await assert.rejects(runPull(['pull','--full','--base',root]),/로컬 변경 충돌|첨부 파일 충돌/);assert.equal(readFileSync(join(root,'attachments/README/image.png'),'utf8'),'local edit');assert.equal(loadMapping(mappingPath(root))['README.md'].remoteVersion,2);
});

test('scope arguments on push and pull are never silently ignored',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc'});selected(root);
 for(const args of [['push'],['pull']]) {
  const result=offline(root,put,[...args,'--base',root,'--scope','/Other'],[]);assert.equal(result.status,1);assert.match(result.stderr,/제거/);
 }
});


test('initial Pull auto-connects an env-only workspace and keeps a single root layout',async t=>{
 configure(t);const {root}=workspace(t);const steps=[space,discovery([['100','Home'],['101','Child','100']]),space,info('100'),info('100'),remote('100','Home'),info('101','Child','page',[{id:'100'}]),remote('101','Child')];mockFetch(t,steps);
 await runPull(['pull','--out',root]);assert.equal(loadWorkspace(root).remoteRoot.id,'100');assert.equal(loadWorkspace(root).scope,undefined);assert.equal(existsSync(join(root,'README.md')),true);assert.equal(existsSync(join(root,'Child.md')),true);assert.equal(existsSync(join(root,'Home')),false);
});

test('connected workspaces need no local scope field to stage one file from anywhere in the tree',async t=>{
 const {root,put}=workspace(t,{'a.md':'# A','other/b.md':'# B'});selected(root);const config=JSON.parse(readFileSync(workspacePath(root),'utf8'));delete config.scope;put('.csync/workspace.json',JSON.stringify(config));
 const {changeStaging,loadIndex}=await import('../dist/sync/staging.js');mockFetch(t,[]);await changeStaging(root,['other/b.md'],'add');
 assert.deepEqual(Object.keys(loadIndex(root).entries),['other/b.md']);assert.equal(requireScope(loadWorkspace(root)).id,'100');
});
