import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { workspace, mockFetch, configure } from './helpers/fixtures.mjs';
import { bindScope, scopeResponder } from './helpers/scope.mjs';
import { configureScope, scopeTree } from '../dist/sync/scope.js';
import { loadWorkspace, requireScope } from '../dist/sync/workspace.js';
import { mappingPath, workspacePath } from '../dist/sync/metadata.js';
import { loadMapping, saveMapping } from '../dist/sync/mapping.js';
import { runPull } from '../dist/sync/pull.js';
import { runPush } from '../dist/sync/push.js';
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
 const responses=put('responses.json',JSON.stringify(steps)),calls=put('calls.jsonl','');
 const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CONFLUENCE_')));
 const result=spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',env:{...inherited,NO_COLOR:'1',NODE_OPTIONS:`--import=${preload}`,CSYNC_TEST_RESPONSES:responses,CSYNC_TEST_CALLS:calls,CSYNC_TEST_SCOPE_BASE:workspacePath(root)&&existsSync(workspacePath(root))&&loadWorkspace(root).version===2?root:'',CONFLUENCE_BASE_URL:env.baseUrl,CONFLUENCE_EMAIL:env.email,CONFLUENCE_API_TOKEN:env.token,CONFLUENCE_SPACE_KEY:env.spaceKey}});
 return {...result,calls:readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)};
}
const mockScoped=(t,root,steps)=>mockFetch(t,steps,scopeResponder(root,steps));

for(const args of [['--dry-run'],['--list'],[],['pull'],['pull','--space'],['remap']])test(`scope is mandatory without any implicit whole-space fallback: ${args}`,t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc'});const result=offline(root,put,[...args,'--base',root],[]);
 assert.equal(result.status,1);assert.match(result.stderr,/스코프가 설정되지/);assert.equal(existsSync(join(root,'.csync')),false);
});

test('legacy local scopes and parent settings never become a remote scope automatically',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc','.confluence-workspace.json':JSON.stringify({version:1,syncPaths:['.']}),'.env':'CONFLUENCE_PARENT_ID=123'});
 const result=offline(root,put,['--base',root,'--dry-run'],[]);assert.equal(result.status,1);assert.match(result.stderr,/자동 전환하지/);
 assert.equal(loadWorkspace(root).version,1);
});

test('explicit remote path selection resolves from the space homepage using metadata only',async t=>{
 const {root}=workspace(t);const calls=mockFetch(t,[space,...children('100',[{id:'200',title:'지식자산'}]),...children('200',[],[{id:'300',title:'특허출원'}]),info('300','특허출원','folder',[{id:'100',title:'Home'},{id:'200',title:'지식자산'}])]);
 const config=await configureScope(root,env,'지식자산/특허출원');
 assert.deepEqual(config.scope,{id:'300',type:'folder',path:'/지식자산/특허출원'});assert.equal(config.connection.spaceId,'space');
 assert.ok(calls.every(call=>(call.method??'GET')==='GET'&&!call.url.includes('body.')));assert.equal(existsSync(mappingPath(root)),false);
});

test('whole-space scope is selected explicitly with / and empty or dot input is refused',async t=>{
 const {root}=workspace(t);mockFetch(t,[space,info('100')]);
 await assert.rejects(configureScope(root,env,''),/명시적으로/);await assert.rejects(configureScope(root,env,'.'),/명시적으로/);
 const config=await configureScope(root,env,'/');assert.equal(requireScope(config).id,'100');assert.equal(config.scope.path,'/');
});

test('scope IDs outside the configured space tree are rejected without writing configuration',async t=>{
 const {root}=workspace(t);mockFetch(t,[space,info('999','Outside','page',[])]);
 await assert.rejects(configureScope(root,env,'id:999'),/하위 트리 밖/);assert.equal(existsSync(workspacePath(root)),false);
});

test('ambiguous remote titles require an explicit ID and never select the first result',async t=>{
 const {root}=workspace(t);mockFetch(t,[space,...children('100',[{id:'201',title:'Same'}],[{id:'202',title:'Same'}])]);
 await assert.rejects(configureScope(root,env,'Same'),/유일하게/);assert.equal(existsSync(workspacePath(root)),false);
});

test('existing mappings cannot be silently rebound to a different remote scope',async t=>{
 const {root}=workspace(t);selected(root);saveMapping(mappingPath(root),{'doc.md':{pageId:'101'}});
 const before=readFileSync(workspacePath(root),'utf8');mockFetch(t,[space,info('200','Patents','folder',[{id:'100',title:'Home'}])]);
 await assert.rejects(configureScope(root,env,'id:200'),/기존 매핑/);assert.equal(readFileSync(workspacePath(root),'utf8'),before);
});

test('manually composed documents can be pushed without any pull after explicit scope selection',t=>{
 const {root,put}=workspace(t,{'idea.md':'# Idea\n\nLocal text'});selected(root,{id:'200',type:'folder',path:'/Patents'});
 const result=offline(root,put,['--base',root],[space,{path:'/wiki/api/v2/pages',method:'POST',body:{id:'201',version:{number:1}}}]);
 assert.equal(result.status,0,result.stderr);assert.equal(result.calls.at(-1).body.parentId,'200');assert.match(result.calls.at(-1).body.body.value,/Local text/);
 assert.equal(loadMapping(mappingPath(root))['idea.md'].remoteVersion,1);
});

test('an unbound root README cannot overwrite the selected remote page on first push',t=>{
 const {root,put}=workspace(t,{'README.md':'# Local'});selected(root);
 const result=offline(root,put,['--base',root],[]);assert.equal(result.status,1);assert.match(result.stderr,/루트 README/);
});

test('an existing mapped page outside the selected remote scope cannot be updated',async t=>{
 configure(t);const {root}=workspace(t,{'doc.md':'# Doc'});selected(root,{id:'200',type:'folder',path:'/Patents'});baseline(root,{'doc.md':'999'});
 mockFetch(t,[space,info('200','Patents','folder',[{id:'100',title:'Home'}]),info('999','Outside','page',[{id:'100',title:'Home'}])]);
 await assert.rejects(runPush(['--base',root]),/원격 스코프 밖/);assert.equal(loadMapping(mappingPath(root))['doc.md'].remoteVersion,1);
});

test('scope browse is metadata only and foreign parent IDs cannot escape the space',async t=>{
 const calls=mockFetch(t,[space,info('100'),...children('100',[{id:'200',title:'Patents'}]),space,info('999','Other','folder',[])]);
 const tree=await scopeTree(env);assert.equal(tree.parent.path,'/');assert.equal(tree.children[0].path,'/Patents');
 await assert.rejects(scopeTree(env,'999'),/하위 트리 밖/);assert.ok(calls.every(call=>(call.method??'GET')==='GET'));
});

test('outer synchronization excludes a separately configured nested workspace',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc','nested/private.md':'# Private','nested/.confluence-sync.json':'{}'});selected(root);
 const result=offline(root,put,['--base',root,'--dry-run'],[]);assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/private.md/);
});

test('pull→push keeps the scope as the root and new root documents stay under the selected scope',async t=>{
 configure(t);const {root,put}=workspace(t);selected(root);
 const steps=[space,remote('100','Home'),...children('100',[{id:'101',title:'Child'}]),remote('101','Child'),...children('101')];mockScoped(t,root,steps);
 await runPull(['pull','--base',root]);assert.ok(existsSync(join(root,'README.md')));assert.equal(existsSync(join(root,'Home')),false);
 let result=offline(root,put,['--base',root],[space]);assert.equal(result.status,0,result.stderr);
 put('New.md','# New');result=offline(root,put,['--base',root],[space,{path:'/wiki/api/v2/pages',method:'POST',body:{id:'102'}}]);
 assert.equal(result.status,0,result.stderr);assert.equal(result.calls.at(-1).body.parentId,'100');
});

test('all changed pages are checked before creating a new page',t=>{
 const {root,put}=workspace(t,{'z.md':'# Z'});selected(root,{id:'200',type:'folder',path:'/Patents'});baseline(root,{'z.md':'201'});put('z.md','# Z\n\nEdit');put('a.md','# New');
 const result=offline(root,put,['--base',root],[space,{path:'/wiki/api/v2/pages/201',body:{version:{number:2}}}]);
 assert.equal(result.status,1);assert.match(result.stderr,/원격 변경 충돌/);assert.ok(result.calls.every(call=>call.method==='GET'));
});

test('remote changes after preflight are checked again before writing',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc'});selected(root,{id:'200',type:'folder',path:'/Patents'});baseline(root,{'doc.md':'201'});put('doc.md','# Doc\n\nEdit');
 const result=offline(root,put,['--base',root],[space,{path:'/wiki/api/v2/pages/201',body:{version:{number:1}}},{path:'/wiki/api/v2/pages/201',body:{version:{number:2}}}]);
 assert.equal(result.status,1);assert.ok(result.calls.every(call=>call.method==='GET'));assert.equal(loadMapping(mappingPath(root))['doc.md'].remoteVersion,1);
});

test('pull preserves dirty local documents and their prior baseline',async t=>{
 configure(t);const {root,put}=workspace(t,{'README.md':'# Home'});selected(root);baseline(root,{'README.md':'100'});put('README.md','# Home\n\nLocal edit');
 const steps=[space,remote('100','Home','<p>Remote edit</p>',2),...children('100')];mockScoped(t,root,steps);
 await assert.rejects(runPull(['pull','--base',root]),/로컬 변경 충돌/);assert.match(readFileSync(join(root,'README.md'),'utf8'),/Local edit/);assert.equal(loadMapping(mappingPath(root))['README.md'].remoteVersion,1);
});

test('a failed descendant download applies none of the staged documents',async t=>{
 configure(t);const {root}=workspace(t,{'README.md':'# Home'});selected(root);baseline(root,{'README.md':'100'});const before=readFileSync(join(root,'README.md'),'utf8');
 const steps=[space,remote('100','Home','<p>Changed</p>',2),...children('100',[{id:'101',title:'Child'}]),{...remote('101','Child'),status:403}];mockScoped(t,root,steps);
 await assert.rejects(runPull(['pull','--base',root]),/403/);assert.equal(readFileSync(join(root,'README.md'),'utf8'),before);assert.equal(loadMapping(mappingPath(root))['README.md'].remoteVersion,1);
});

test('pull path collisions are rejected before applying a new root README',async t=>{
 configure(t);const {root}=workspace(t);selected(root);
 const steps=[space,remote('100','Home'),...children('100',[{id:'101',title:'A/B'},{id:'102',title:'A:B'}]),remote('101','A/B'),...children('101'),remote('102','A:B'),...children('102')];mockScoped(t,root,steps);
 await assert.rejects(runPull(['pull','--base',root]),/같은 로컬 경로/);assert.equal(existsSync(join(root,'README.md')),false);
});

test('pull cannot expand a subtree into whole-space mode or drop mapping protections',async t=>{
 configure(t);const {root}=workspace(t);selected(root,{id:'200',type:'folder',path:'/Patents'});mockFetch(t,[]);
 await assert.rejects(runPull(['pull','--space','--base',root]),/사용자가 \/ 스코프/);
 await assert.rejects(runPull(['pull','--no-mapping','--base',root]),/매핑을 유지/);
 await assert.rejects(runPull(['pull','--root','--base',root]),/init --scope/);
});

test('read-only validation never initializes the workspace or rewrites mapping',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc'});selected(root,{id:'200',type:'folder',path:'/Patents'});baseline(root,{'doc.md':'201'});
 const before=readFileSync(mappingPath(root),'utf8'),config=readFileSync(workspacePath(root),'utf8');
 const result=offline(root,put,['--base',root,'--dry-run','--verify'],[space,{path:'/wiki/api/v2/pages/201',body:{version:{number:1}}}]);
 assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.equal(readFileSync(workspacePath(root),'utf8'),config);
});

test('existing site bindings prevent using the same page IDs against a different site',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc'});bindScope(root,{connection:{baseUrl:'https://other.invalid/wiki'}});
 const result=offline(root,put,['--base',root],[]);assert.equal(result.status,1);assert.match(result.stderr,/사이트·스페이스/);
});

test('CLI init requires an explicit remote scope and preserves the existing env file',t=>{
 const original='CONFLUENCE_PARENT_ID=old-setting\n';const {root,put}=workspace(t,{'.env':original});
 let result=offline(root,put,['init','--base',root,'--scope'],[]);assert.equal(result.status,1);assert.equal(existsSync(workspacePath(root)),false);
 result=offline(root,put,['init','--base',root,'--scope','id:200'],[space,info('200','Patents','folder',[{id:'100',title:'Home'}])]);
 assert.equal(result.status,0,result.stderr);assert.equal(loadWorkspace(root).scope.id,'200');assert.equal(readFileSync(join(root,'.env'),'utf8'),original);assert.ok(result.calls.every(call=>call.method==='GET'));
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
 await runPull(['pull','--base',root]);await runPull(['pull','--base',root]);
 assert.equal(readFileSync(join(root,'attachments/README/image.png'),'utf8'),'second');put('attachments/README/image.png','local edit');
 await assert.rejects(runPull(['pull','--base',root]),/로컬 변경 충돌|첨부 파일 충돌/);assert.equal(readFileSync(join(root,'attachments/README/image.png'),'utf8'),'local edit');assert.equal(loadMapping(mappingPath(root))['README.md'].remoteVersion,2);
});

test('scope arguments on sync and pull are never silently ignored',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc'});selected(root);
 for(const args of [['sync'],['pull']]) {
  const result=offline(root,put,[...args,'--base',root,'--scope','/Other'],[]);assert.equal(result.status,1);assert.match(result.stderr,/init --scope/);
 }
});
