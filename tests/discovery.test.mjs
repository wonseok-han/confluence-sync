import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,existsSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {workspace,configure,mockFetch} from './helpers/fixtures.mjs';import {bindScope,scopeResponder} from './helpers/scope.mjs';
import {fetchRemote,readFetchSnapshot,FETCH_TTL_MS} from '../dist/sync/fetch.js';import {runPull,mappingPass} from '../dist/sync/pull.js';import {observeChanges,changeGroup} from '../dist/sync/changes.js';import {inspectStaging,loadIndex} from '../dist/sync/staging.js';import {mappingPath} from '../dist/sync/metadata.js';
const env={baseUrl:'https://example.invalid/wiki',email:'test@example.invalid',token:'test-token',spaceKey:'TEST'};
const page=(id,title,parentId='100',version=1)=>({id,title,parentId,spaceId:'space',version:{number:version}});
const list=pages=>({path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100',body:{results:pages}});
const body=(id,title,text=title)=>({path:`/wiki/rest/api/content/${id}?expand=body.export_view,body.storage,version`,body:{id,type:'page',title,version:{number:1},body:{export_view:{value:`<p>${text}</p>`},storage:{value:`<p>${text}</p>`}}}});
function setup(t,files={}){configure(t);const result=workspace(t,files);bindScope(result.root,{connection:{homepageId:'100'},scope:{id:'100',type:'page',path:'/'}});return result;}
const remote=(t,root,steps)=>mockFetch(t,steps,scopeResponder(root,steps));

test('an empty workspace discovers and receives pages with the same Fetch and Pull as populated workspaces',async t=>{
 const {root}=setup(t);const calls=remote(t,root,[list([page('100','Home',undefined),page('101','Child')]),body('100','Home'),body('101','Child')]);
 const result=await fetchRemote(root,env);assert.equal(result.snapshot.items.length,2);assert.ok(result.snapshot.items.every(item=>item.state==='new'));assert.equal(existsSync(join(root,'README.md')),false);assert.equal(existsSync(mappingPath(root)),false);
 let view=observeChanges(root,await inspectStaging(root),env);assert.equal(view.rows.filter(row=>changeGroup(row)==='receive').length,2);
 await runPull(['pull','--base',root]);assert.match(readFileSync(join(root,'README.md'),'utf8'),/Home/);assert.match(readFileSync(join(root,'Child.md'),'utf8'),/Child/);assert.ok(calls.every(call=>!String(call.url).includes('/child/page')&&!String(call.url).includes('/child/folder')));assert.deepEqual(loadIndex(root).entries,{});
 view=observeChanges(root,await inspectStaging(root),env);assert.ok(view.rows.every(row=>changeGroup(row)==='same'));assert.ok(readFetchSnapshot(root,env).items.every(item=>item.state==='unchanged'));
});

test('space enumeration includes detached top-level pages and missing folder ancestry is fetched only once',async t=>{
 const {root}=setup(t);const pages=[page('100','Home',undefined),page('101','Detached',null),page('102','A','900'),page('103','B','900')];
 const folder={path:'/wiki/rest/api/content/search?cql=id+in+%28900%29&expand=ancestors%2Cspace&limit=100',body:{results:[{id:'900',type:'folder',title:'Folder',space:{id:'space'},ancestors:[{id:'100',title:'Home'}] }]}};
 const calls=remote(t,root,[list(pages),folder,body('100','Home'),body('101','Detached'),body('102','A'),body('103','B')]);
 const snapshot=(await fetchRemote(root,env)).snapshot;assert.deepEqual(snapshot.folders,[{path:'Folder/',pageId:'900',title:'Folder'}]);await runPull(['pull','--base',root]);assert.match(readFileSync(join(root,'Detached.md'),'utf8'),/Detached/);assert.match(readFileSync(join(root,'Folder/A.md'),'utf8'),/A/);assert.equal(JSON.parse(readFileSync(mappingPath(root),'utf8'))['Folder/'].pageId,'900');assert.equal(calls.filter(call=>String(call.url).includes('/content/search?')).length,1);
});

test('remote page containers have stable paths when ancestors are listed before their folders',async t=>{
 const {root}=setup(t);const folder={path:'/wiki/rest/api/content/search?cql=id+in+%28900%29&expand=ancestors%2Cspace&limit=100',body:{results:[{id:'900',title:'Folder',type:'folder',space:{id:'space'},ancestors:[{id:'100',title:'Home'},{id:'101',title:'Parent'}] }]}};
 remote(t,root,[list([page('100','Home',null),page('101','Parent'),page('102','Leaf','900')]),folder,body('100','Home'),body('101','Parent'),body('102','Leaf')]);await runPull(['pull','--base',root]);assert.ok(existsSync(join(root,'Parent/README.md')));assert.ok(existsSync(join(root,'Parent/Folder/Leaf.md')));
});

test('remote new candidates do not overwrite local documents at the proposed path',async t=>{
 const {root}=setup(t,{'Child.md':'# My unrelated work'});remote(t,root,[list([page('101','Child')])]);await fetchRemote(root,env);const view=observeChanges(root,await inspectStaging(root),env);assert.equal(view.rows.find(row=>row.pageId==='101').remoteState,'new');assert.equal(changeGroup(view.rows.find(row=>row.pageId==='101')),'conflict');await runPull(['pull','--base',root]);assert.equal(readFileSync(join(root,'Child.md'),'utf8'),'# My unrelated work');assert.equal(existsSync(mappingPath(root)),false);
});

test('new remote pages are received while a mapped local deletion and local edits stay untouched',async t=>{
 const {root,put}=setup(t,{'README.md':'---\ntitle: Home\npageId: 100\n---\nHome','old.md':'---\ntitle: Old\npageId: 101\n---\nOriginal'});
 await mappingPass(root,mappingPath(root),new Map([['100',join(root,'README.md')],['101',join(root,'old.md')]]),new Map(),new Map([['100',1],['101',1]]));const before=JSON.parse(readFileSync(mappingPath(root),'utf8'));rmSync(join(root,'README.md'));put('old.md','# My edits');remote(t,root,[list([page('100','Home',null,2),page('101','Old','100',2),page('102','New')]),body('102','New')]);await runPull(['pull','--base',root]);assert.equal(existsSync(join(root,'README.md')),false);assert.equal(readFileSync(join(root,'old.md'),'utf8'),'# My edits');assert.match(readFileSync(join(root,'New.md'),'utf8'),/New/);const after=JSON.parse(readFileSync(mappingPath(root),'utf8'));assert.deepEqual(after['README.md'],before['README.md']);assert.deepEqual(after['old.md'],before['old.md']);
});

test('failed incoming body download applies no new documents and publishes no mapping',async t=>{
 const {root}=setup(t);remote(t,root,[list([page('101','One'),page('102','Two')]),body('101','One'),{...body('102','Two'),status:403}]);await assert.rejects(runPull(['pull','--base',root]),/403/);assert.equal(existsSync(join(root,'One.md')),false);assert.equal(existsSync(join(root,'Two.md')),false);assert.equal(existsSync(mappingPath(root)),false);
});

test('complete discovery preserves ignore rules and nested workspace boundaries without writing new mappings',async t=>{
 const {root}=setup(t,{'.csync/ignore':'Ignore.md\n','Nested/.csync/workspace.json':'{}'});const folder={path:'/wiki/rest/api/content/search?cql=id+in+%28900%29&expand=ancestors%2Cspace&limit=100',body:{results:[{id:'900',title:'Nested',type:'folder',space:{id:'space'},ancestors:[{id:'100',title:'Home'}] }]}};
 remote(t,root,[list([page('101','Ignore'),page('102','Secret','900'),page('103','Allowed')]),folder,body('103','Allowed')]);await runPull(['pull','--base',root]);assert.equal(existsSync(join(root,'Ignore.md')),false);assert.equal(existsSync(join(root,'Nested/Secret.md')),false);assert.ok(existsSync(join(root,'Allowed.md')));
});

test('editing a newly received child of an existing leaf page preserves its actual remote parent on Push',async t=>{
 const {root,put}=setup(t,{'Parent.md':'---\ntitle: Parent\npageId: 101\n---\nParent'});await mappingPass(root,mappingPath(root),new Map([['101',join(root,'Parent.md')]]),new Map(),new Map([['101',1]]));
 const steps=[list([page('101','Parent'),page('102','Child','101')]),body('102','Child'),{path:'/wiki/api/v2/pages/102',method:'PUT',body:{id:'102',version:{number:2}},check:init=>assert.equal(JSON.parse(init.body).parentId,undefined)}];
 const responder=scopeResponder(root,steps);mockFetch(t,steps,(url,init,step)=>{if(new URL(url).pathname==='/wiki/rest/api/content/102'&&new URL(url).searchParams.get('expand')==='ancestors,space,version')return {id:'102',type:'page',title:'Child',space:{id:'space'},ancestors:[{id:'100',title:'Home'},{id:'101',title:'Parent'}]};if(new URL(url).pathname==='/wiki/api/v2/pages/102'&&(init.method??'GET')==='GET')return {id:'102',spaceId:'space',parentId:'101',version:{number:1}};return responder(url,init,step)});
 await runPull(['pull','--base',root]);put('Child.md',readFileSync(join(root,'Child.md'),'utf8')+'\nLocal edit');const {runPush}=await import('../dist/sync/push.js');await runPush(['push','Child.md','--base',root]);assert.equal(JSON.parse(readFileSync(mappingPath(root),'utf8'))['Child.md'].remoteParentId,'101');
});

test('100 unresolved parent folders use one metadata batch rather than 100 individual requests',async t=>{
 const {root}=setup(t);const pages=Array.from({length:100},(_,i)=>page(String(1000+i),'Document '+i,String(2000+i)));
 const params=new URLSearchParams({cql:'id in ('+pages.map(p=>p.parentId).join(',')+')',expand:'ancestors,space',limit:'100'});
 const folders={path:'/wiki/rest/api/content/search?'+params,body:{results:pages.map((p,i)=>({id:p.parentId,title:'Folder '+i,type:'folder',space:{id:'space'},ancestors:[{id:'100',title:'Home'}]}))}};
 const calls=remote(t,root,[list(pages),folders]);const {snapshot,requests}=await fetchRemote(root,env);assert.equal(requests,2);assert.equal(calls.length,2);assert.equal(snapshot.items.length,100);assert.equal(snapshot.folders.length,100);assert.ok(calls.every(call=>!String(call.url).includes('body.')));
});

for(const fault of ['missing','foreign-space','wrong-type','unsafe-next','cycle'])test(`invalid folder discovery preserves previous cache: ${fault}`,async t=>{
 const {root}=setup(t);let now=Date.now();t.mock.method(Date,'now',()=>now);const data={results:[{id:'900',title:'Folder',type:'folder',space:{id:'space'},ancestors:[{id:'100',title:'Home'}]}]};
 if(fault==='missing')data.results=[];if(fault==='foreign-space')data.results[0].space.id='other';if(fault==='wrong-type')data.results[0].type='page';if(fault==='unsafe-next')data._links={next:'https://attacker.invalid/wiki/rest/api/content/search?start=1'};if(fault==='cycle')data.results[0].ancestors=[{id:'900',title:'Folder'}];
 remote(t,root,[list([]),list([page('101','Child','900')]),{path:'/wiki/rest/api/content/search?cql=id+in+%28900%29&expand=ancestors%2Cspace&limit=100',body:data}]);await fetchRemote(root,env);const prior=readFileSync(join(root,'.csync/remote.json'),'utf8');now+=FETCH_TTL_MS+1;await assert.rejects(fetchRemote(root,env));assert.equal(readFileSync(join(root,'.csync/remote.json'),'utf8'),prior);assert.equal(existsSync(mappingPath(root)),false);
});

test('malformed remote parent IDs cannot become CQL input',async t=>{
 const {root}=setup(t);remote(t,root,[list([page('101','Child','1) or type=page')])]);await assert.rejects(fetchRemote(root,env),/목록의 ID/);assert.equal(existsSync(join(root,'.csync/remote.json')),false);
});
