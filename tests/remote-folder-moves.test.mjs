import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {workspace,mockFetch,configure} from './helpers/fixtures.mjs';
import {bindScope,scopeResponder} from './helpers/scope.mjs';
import {mappingPass,runPull} from '../dist/sync/pull.js';
import {fetchRemote,readFetchSnapshot} from '../dist/sync/fetch.js';
import {mappingPath} from '../dist/sync/metadata.js';

const env={baseUrl:'https://example.invalid/wiki',email:'test@example.invalid',token:'test-token',spaceKey:'TEST'};
const listing={path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100',body:{results:[['10','Old','100'],['20','New','100'],['1','A','30'],['2','B','30']].map(([id,title,parentId])=>({id,title,parentId,spaceId:'space',version:{number:1}}))}};
const folders={path:'/wiki/rest/api/content/search?'+new URLSearchParams({cql:'id in (30)',expand:'ancestors,space',limit:'100'}),body:{results:[{id:'30',title:'Folder',type:'folder',space:{id:'space'},ancestors:[{id:'100',title:'Home'},{id:'20',title:'New'}]}]}};
const body=(id,title)=>({path:`/wiki/rest/api/content/${id}?expand=body.export_view,body.storage,version`,body:{id,title,type:'page',version:{number:1},body:{export_view:{value:`<p>${title} remote</p>`},storage:{value:`<p>${title} remote</p>`}}}});
const location=id=>({path:`/wiki/rest/api/content/${id}?expand=ancestors,space,version`,body:{id,title:id,type:'page',space:{id:'space'},ancestors:[{id:'100',title:'Home'},{id:'20',title:'New'},{id:'30',title:'Folder'}],version:{number:1}}});
async function setup(t){
 configure(t);const w=workspace(t,{'old/README.md':'# Old','new/README.md':'# New','old/Folder/a.md':'# A\n\nA original','old/Folder/b.md':'# B\n\nB original','old/Folder/local.txt':'Unmapped local data'});
 bindScope(w.root,{connection:{homepageId:'100'},scope:{id:'100',type:'page',path:'/'}});
 await mappingPass(w.root,mappingPath(w.root),new Map([['10',join(w.root,'old/README.md')],['20',join(w.root,'new/README.md')],['1',join(w.root,'old/Folder/a.md')],['2',join(w.root,'old/Folder/b.md')]]),new Map([[join(w.root,'old/Folder'),'30']]),new Map([['10',1],['20',1],['1',1],['2',1]]),new Map([['10','100'],['20','100'],['1','30'],['2','30'],['30','10']]));
 return {...w,before:fs.readFileSync(mappingPath(w.root),'utf8')};
}
const remote=(t,root,steps)=>mockFetch(t,steps,scopeResponder(root,steps));

test('Fetch detects a moved ancestor folder with unchanged document versions and direct parents',async t=>{
 const {root,before}=await setup(t);const calls=remote(t,root,[listing,folders]);
 const {snapshot}=await fetchRemote(root,env);
 assert.equal(calls.length,2);assert.equal(snapshot.items.filter(i=>i.state==='changed').length,2);
 assert.ok(snapshot.items.filter(i=>i.state==='changed').every(i=>i.reasons.some(reason=>reason.includes('원격 상위 폴더 위치 변경')&&reason.includes('old/Folder/ → new/Folder/'))));
 assert.deepEqual(snapshot.folders,[{path:'new/Folder/',previousPath:'old/Folder/',pageId:'30',title:'Folder',parentId:'20'}]);
 assert.equal(readFetchSnapshot(root,env).items.filter(i=>i.state==='changed').length,2);
 assert.equal(fs.readFileSync(mappingPath(root),'utf8'),before);assert.ok(fs.existsSync(join(root,'old/Folder/a.md')));
});

test('Pull moves a clean local folder, keeps unmapped files, updates mappings and consumes the move observation',async t=>{
 const {root}=await setup(t);remote(t,root,[listing,folders,location('1'),body('1','A'),location('2'),body('2','B'),folders]);
 await runPull(['pull','--base',root]);
 assert.equal(fs.existsSync(join(root,'old/Folder')),false);assert.match(fs.readFileSync(join(root,'new/Folder/a.md'),'utf8'),/A remote/);
 assert.equal(fs.readFileSync(join(root,'new/Folder/local.txt'),'utf8'),'Unmapped local data');
 const mapping=JSON.parse(fs.readFileSync(mappingPath(root),'utf8'));assert.equal(mapping['old/Folder/'],undefined);assert.equal(mapping['new/Folder/'].remoteParentId,'20');assert.equal(mapping['new/Folder/a.md'].pageId,'1');
 assert.equal(readFetchSnapshot(root,env).items.filter(i=>i.state==='changed').length,0);
});

for(const missing of [false,true])test(`Pull preserves the whole folder when a descendant is ${missing?'deleted':'edited'} locally`,async t=>{
 const {root,put,before}=await setup(t);if(missing)fs.rmSync(join(root,'old/Folder/a.md'));else put('old/Folder/a.md','# My local edit');
 remote(t,root,[listing,folders]);await runPull(['pull','--base',root]);
 assert.ok(fs.existsSync(join(root,'old/Folder/b.md')));assert.equal(fs.existsSync(join(root,'new/Folder')),false);assert.equal(fs.readFileSync(mappingPath(root),'utf8'),before);
});

test('an occupied move destination is never merged with or overwritten by Pull',async t=>{
 const {root,put,before}=await setup(t);put('new/Folder/keep.txt','Existing destination');remote(t,root,[listing,folders]);
 await assert.rejects(runPull(['pull','--base',root]),/경로가 이미 존재/);
 assert.equal(fs.readFileSync(join(root,'new/Folder/keep.txt'),'utf8'),'Existing destination');assert.ok(fs.existsSync(join(root,'old/Folder/a.md')));assert.equal(fs.readFileSync(mappingPath(root),'utf8'),before);
});

test('baseline write failure rolls back both the directory move and document replacements',async t=>{
 const {root,before}=await setup(t),original=fs.readFileSync(join(root,'old/Folder/a.md'),'utf8'),rename=fs.renameSync;
 remote(t,root,[listing,folders,location('1'),body('1','A'),location('2'),body('2','B'),folders]);
 t.mock.method(fs,'renameSync',function(from,to){if(to===mappingPath(root))throw Error('synthetic mapping failure');return rename.call(this,from,to)});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()});
 await assert.rejects(runPull(['pull','--base',root]),/mapping failure/);
 assert.equal(fs.readFileSync(join(root,'old/Folder/a.md'),'utf8'),original);assert.equal(fs.existsSync(join(root,'new/Folder')),false);assert.equal(fs.readFileSync(mappingPath(root),'utf8'),before);
});

test('a concurrent local edit during download prevents any directory relocation',async t=>{
 const {root,put,before}=await setup(t);const changed=body('1','A');changed.check=()=>put('old/Folder/local.txt','Concurrent edit');
 remote(t,root,[listing,folders,location('1'),changed,location('2'),body('2','B'),folders]);
 await assert.rejects(runPull(['pull','--base',root]),/이동할 폴더가 변경/);
 assert.equal(fs.readFileSync(join(root,'old/Folder/local.txt'),'utf8'),'Concurrent edit');assert.equal(fs.existsSync(join(root,'new/Folder')),false);assert.equal(fs.readFileSync(mappingPath(root),'utf8'),before);
});

test('inaccessible mapped folders produce an attention state rather than an unchanged baseline',async t=>{
 const {root}=await setup(t);remote(t,root,[listing,{...folders,body:{results:[]}}]);
 const {snapshot}=await fetchRemote(root,env);assert.equal(snapshot.items.filter(i=>i.path.startsWith('old/Folder/')&&i.state==='unknown').length,2);
 const mapping=JSON.parse(fs.readFileSync(mappingPath(root),'utf8'));mapping['old/Folder/a.md'].hash='new baseline hash';fs.writeFileSync(mappingPath(root),JSON.stringify(mapping));
 assert.equal(readFetchSnapshot(root,env).items.filter(i=>i.path.startsWith('old/Folder/')&&i.state==='unknown').length,2);
});


test('another remote folder move during downloads aborts before relocating local files',async t=>{
 const {root,before}=await setup(t);
 const changed={...folders,body:{results:[{id:'30',title:'Folder',type:'folder',space:{id:'space'},ancestors:[{id:'100',title:'Home'},{id:'99',title:'Moved again'}]}]}};
 remote(t,root,[listing,folders,location('1'),body('1','A'),location('2'),body('2','B'),changed]);
 await assert.rejects(runPull(['pull','--base',root]),/원격 폴더 위치가 바뀌/);
 assert.ok(fs.existsSync(join(root,'old/Folder/a.md')));assert.equal(fs.existsSync(join(root,'new/Folder')),false);assert.equal(fs.readFileSync(mappingPath(root),'utf8'),before);
});


for(const version of [1,2])test(`deleted historical folders do not mask current remote parents or version v${version}`,async t=>{
 const {root}=await setup(t);const mapping=JSON.parse(fs.readFileSync(mappingPath(root),'utf8'));
 mapping['old/Folder/a.md'].remoteParentId='20';mapping['old/Folder/b.md'].remoteParentId='20';fs.writeFileSync(mappingPath(root),JSON.stringify(mapping));
 const current={...listing,body:{results:listing.body.results.map(page=>['1','2'].includes(page.id)?{...page,parentId:'20',version:{number:page.id==='1'?version:1}}:page)}};
 remote(t,root,[current,{...folders,body:{results:[]}}]);const {snapshot}=await fetchRemote(root,env);
 const a=snapshot.items.find(item=>item.pageId==='1'),b=snapshot.items.find(item=>item.pageId==='2');
 assert.equal(a.state,version===1?'unchanged':'changed');assert.equal(b.state,'unchanged');assert.ok(!snapshot.items.some(item=>item.state==='unknown'));
});
