import {explicitPush} from './helpers/explicit-push.mjs';
const runPush = args => corePush(explicitPush(args));
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {workspace,configure,mockFetch} from './helpers/fixtures.mjs';
import {bindScope,scopeResponder} from './helpers/scope.mjs';
import {connectWorkspace} from '../dist/sync/scope.js';
import {loadWorkspace,inScope,requireScope} from '../dist/sync/workspace.js';
import {workspacePath,mappingPath} from '../dist/sync/metadata.js';
import {saveMapping,loadMapping} from '../dist/sync/mapping.js';
import {runPush as corePush} from '../dist/sync/push.js';
import {runPull} from '../dist/sync/pull.js';
const env={baseUrl:'https://example.invalid/wiki',email:'test@example.invalid',token:'fake',spaceKey:'TEST'};

test('reconnecting retires legacy local scopes while retaining documents, every mapping and remote binding',async t=>{
 const {root}=workspace(t,{'docs/a.md':'# A','other/c.md':'# C'});bindScope(root,{localScope:{path:'docs',type:'folder'}});
 saveMapping(mappingPath(root),{'docs/a.md':{pageId:'201',hash:'a'},'other/c.md':{pageId:'301',hash:'c'}});
 const before=readFileSync(mappingPath(root),'utf8');t.mock.method(globalThis,'fetch',()=>assert.fail('existing connection requires no remote rescan'));
 const w=await connectWorkspace(root,env);assert.equal(w.scope,undefined);assert.equal(inScope('other/c.md',w),true);
 assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.equal(JSON.parse(readFileSync(workspacePath(root),'utf8')).scope,undefined);
});

test('legacy remote bindings remain boundaries rather than local filters',t=>{
 const {root,put}=workspace(t);put('.csync/workspace.json',JSON.stringify({version:2,connection:{baseUrl:env.baseUrl,spaceKey:'TEST',spaceId:'space',homepageId:'100'},scope:{id:'200',type:'folder',path:'/old'}}));
 const w=loadWorkspace(root);assert.equal(requireScope(w).id,'200');assert.equal(w.scope,undefined);assert.equal(inScope('other/doc.md',w),true);
});

test('explicit file Push preview selects only that file despite retired local scope metadata',async t=>{
 const {root}=workspace(t,{'a.md':'# A','b.md':'# B'});configure(t);bindScope(root,{localScope:{path:'b.md',type:'file'}});
 saveMapping(mappingPath(root),{'a.md':{pageId:'201',hash:'a'},'b.md':{pageId:'202',hash:'b'}});
 const before=readFileSync(mappingPath(root),'utf8'),logs=[];t.mock.method(console,'log',line=>logs.push(line));t.mock.method(globalThis,'fetch',()=>assert.fail('local preview must not fetch'));
 await runPush(['a.md','--base',root,'--dry-run']);assert.ok(logs.some(line=>line.includes('a.md')));assert.equal(logs.some(line=>line.includes('b.md')),false);assert.equal(readFileSync(mappingPath(root),'utf8'),before);
});

function baseline(root, rows) {
 return import('../dist/sync/render.js').then(async({buildTreeRenderer})=>{
  const {docHash}=await import('../dist/documents/markdown.js');const tree=buildTreeRenderer(root,Object.keys(rows));
  return Object.fromEntries(Object.entries(rows).map(([path,id])=>[path,{pageId:id,hash:docHash(tree.docs[path].title,tree.render(path,tree.docs[path].body,tree.docs[path].title)),remoteVersion:1}]));
 });
}

test('actual file Push only updates the selected page while ancestor and sibling mappings stay intact',async t=>{
 configure(t);const {root,put}=workspace(t,{'README.md':'# Home','docs/README.md':'# Docs','docs/a.md':'# A','docs/b.md':'# B'});
 bindScope(root,{connection:{homepageId:'100'},scope:{id:'100',type:'page'},localScope:{path:'docs/a.md',type:'file'}});
 const before=await baseline(root,{'README.md':'100','docs/README.md':'200','docs/a.md':'201','docs/b.md':'202'});saveMapping(mappingPath(root),before);put('docs/a.md','# A\n\nChanged');put('docs/b.md','# B\n\nMust not upload');
 const steps=[{path:'/wiki/api/v2/pages/201',method:'PUT',body:{id:'201'},check:init=>{const body=JSON.parse(init.body);assert.match(body.body.value,/Changed/);assert.equal(body.parentId,undefined)}}];
 const extra=scopeResponder(root,steps);const calls=mockFetch(t,steps,(url,init,step)=>{assert.ok(!String(url).includes('/202'),'must not inspect out-of-scope sibling');return extra(url,init,step)});
 await runPush(['docs/a.md','--base',root]);assert.equal(calls.length,1);const after=loadMapping(mappingPath(root));for(const key of ['README.md','docs/README.md','docs/b.md'])assert.deepEqual(after[key],before[key]);assert.equal(after['docs/a.md'].remoteVersion,2);
});

test('explicit subtree Pull keeps original paths, includes new children and retains untouched mappings',async t=>{
 configure(t);const {root}=workspace(t,{'docs/README.md':'# Docs','docs/a.md':'# A','other/c.md':'# C'});
 bindScope(root,{connection:{homepageId:'100'},scope:{id:'100',type:'page'},localScope:{path:'docs',type:'folder'}});
 const before=await baseline(root,{'docs/README.md':'200','docs/a.md':'201','other/c.md':'999'});saveMapping(mappingPath(root),before);
 const node=(id,title)=>({path:`/wiki/rest/api/content/${id}?expand=body.export_view,body.storage,version`,body:{id,type:'page',title,version:{number:2},body:{export_view:{value:`<p>Remote ${title}</p>`}}}});
 const kids=(id,pages=[])=>[{path:`/wiki/rest/api/content/${id}/child/folder?limit=100`,body:{results:[]}},{path:`/wiki/rest/api/content/${id}/child/page?limit=100`,body:{results:pages}}];
 const steps=[node('200','Docs'),...kids('200',[{id:'201',title:'A'},{id:'202',title:'New'}]),node('201','A'),...kids('201'),node('202','New'),...kids('202')];mockFetch(t,steps,scopeResponder(root,steps));
 await runPull(['pull','200','--base',root]);assert.match(readFileSync(join(root,'docs/README.md'),'utf8'),/Remote Docs/);assert.match(readFileSync(join(root,'docs/New.md'),'utf8'),/Remote New/);assert.equal(readFileSync(join(root,'other/c.md'),'utf8'),'# C');assert.deepEqual(loadMapping(mappingPath(root))['other/c.md'],before['other/c.md']);
});

test('file scope never remaps a moved ancestor README outside its scope',async t=>{
 configure(t);const {root}=workspace(t,{'docs/README.md':'---\npageId: 200\n---\n# Docs','docs/a.md':'---\npageId: 201\n---\n# A'});
 bindScope(root,{connection:{homepageId:'100'},scope:{id:'100',type:'page'},localScope:{path:'docs/a.md',type:'file'}});
 saveMapping(mappingPath(root),{'old/README.md':{pageId:'200',hash:'keep',remoteVersion:1},'docs/a.md':{pageId:'201',hash:'old',remoteVersion:1}});
 const before=readFileSync(mappingPath(root),'utf8');t.mock.method(globalThis,'fetch',()=>assert.fail('must stop before remote writes'));
 await assert.rejects(runPush(['docs/a.md','--base',root,'--dry-run']),/상위 문서/);assert.equal(readFileSync(mappingPath(root),'utf8'),before);
});
