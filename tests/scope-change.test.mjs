import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {workspace,configure} from './helpers/fixtures.mjs';
import {bindScope} from './helpers/scope.mjs';
import {mappingPath,workspacePath} from '../dist/sync/metadata.js';
import {saveMapping,loadMapping} from '../dist/sync/mapping.js';
import {previewScope,configureScope,ScopeReviewRequired,inspectScopeMapping,scopeClient} from '../dist/sync/scope.js';
import {runPush} from '../dist/sync/push.js';
import {readDoc} from '../dist/documents/catalog.js';
import {buildTreeRenderer} from '../dist/sync/render.js';
import {docHash} from '../dist/documents/markdown.js';
const env={baseUrl:'https://example.invalid/wiki',email:'test@example.invalid',token:'fake',spaceKey:'TEST'};
const scope=(id='200',type='folder',path='/Assets')=>({connection:{homepageId:'100'},scope:{id,type,path}});
function fixture(t){
 const files={'common/a.md':'---\npageId: 401\ntitle: A\n---\nBody'};
 const w=workspace(t,files);bindScope(w.root,scope());saveMapping(mappingPath(w.root),{'common/':{pageId:'400',type:'folder'},'common/a.md':{pageId:'401',title:'A',hash:'kept',remoteVersion:1}});return w;
}
function remote(t,allowMove=false){
 const nodes={
  '100':{title:'Home',type:'page',ancestors:[]},
  '200':{title:'Assets',type:'folder',ancestors:['100']},
  '300':{title:'Patents',type:'folder',ancestors:['100','200']},
  '400':{title:'common',type:'folder',ancestors:['100','200','300']},
  '401':{title:'A',type:'page',ancestors:['100','200','300','400'],version:1,storage:'<p>Body</p>\n'},
  '500':{title:'Archive',type:'folder',ancestors:['100']},
 };
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,init={})=>{
  const path=new URL(url).pathname+new URL(url).search,method=init.method??'GET';calls.push({path,method});let body;
  if(path==='/wiki/api/v2/spaces?keys=TEST')body={results:[{id:'space',homepageId:'100'}]};
  else if(path.includes('?expand=ancestors,space,version')){
   const id=path.split('/content/')[1].split('?')[0],n=nodes[id];assert.ok(n,path);body={id,title:n.title,type:n.type,space:{id:'space'},ancestors:n.ancestors.map(id=>({id,title:nodes[id].title}))};
  }else if(path.startsWith('/wiki/api/v2/pages/')){
   const id=path.split('/pages/')[1].split('?')[0],n=nodes[id];assert.equal(method,'GET');body={id,title:n.title,spaceId:'space',parentId:n.ancestors.at(-1),version:{number:n.version},body:{storage:{value:n.storage}}};
  }else if(allowMove&&path==='/wiki/rest/api/content/401/move/append/100'&&method==='PUT'){
   nodes['401'].ancestors=['100'];nodes['401'].version++;body={pageId:'401'};
  }else assert.fail(`Unexpected ${method} ${path}`);
  return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
 });return {nodes,calls};
}

test('an incorrect ancestor binding can be corrected after review while documents and mapping stay unchanged',async t=>{
 const {root}=fixture(t),{calls}=remote(t),before=readFileSync(workspacePath(root),'utf8'),mapping=readFileSync(mappingPath(root),'utf8'),doc=readFileSync(join(root,'common/a.md'),'utf8');
 let review;await assert.rejects(configureScope(root,env,'id:300'),error=>{assert.ok(error instanceof ScopeReviewRequired);review=error.review;return true;});
 assert.equal(review.summary.aligned,2);assert.equal(readFileSync(workspacePath(root),'utf8'),before);
 const saved=await configureScope(root,env,'id:300',review.token);assert.equal(saved.scope.id,'300');assert.equal(saved.scopeCheckRequired,true);assert.equal(readFileSync(mappingPath(root),'utf8'),mapping);assert.equal(readFileSync(join(root,'common/a.md'),'utf8'),doc);assert.ok(calls.every(c=>c.method==='GET'));
});

for(const [id,status] of [['100','folderConflict'],['500','outside']])test(`scope can change to ${id}, while ${status} blocks Push before any mutation`,async t=>{
 configure(t);const {root}=fixture(t),{calls}=remote(t);const plan=await previewScope(root,env,`id:${id}`);assert.ok(plan.summary[status]>0);
 await configureScope(root,env,`id:${id}`,plan.token);assert.equal(JSON.parse(readFileSync(workspacePath(root),'utf8')).scope.id,id);
 const before=readFileSync(mappingPath(root),'utf8');await assert.rejects(runPush(['--base',root]),/원격 변경 전 중단/);assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.ok(calls.every(c=>c.method==='GET'));
});

for(const kind of ['mapping','tree','remote'])test(`scope approval is stale after ${kind} changes`,async t=>{
 const {root,put}=fixture(t),{nodes}=remote(t),before=readFileSync(workspacePath(root),'utf8');const plan=await previewScope(root,env,'id:300');
 if(kind==='mapping'){const m=loadMapping(mappingPath(root));m['common/a.md'].hash='external';saveMapping(mappingPath(root),m);}
 if(kind==='tree')put('common/README.md','# Parent');
 if(kind==='remote')nodes['401'].ancestors=['100','500'];
 await assert.rejects(configureScope(root,env,'id:300',plan.token),/다시 확인/);assert.equal(readFileSync(workspacePath(root),'utf8'),before);
});

test('first binding also reviews an ancestor scope whose folder layout does not match',async t=>{
 const {root,put}=fixture(t);remote(t);put('.csync/workspace.json',JSON.stringify({version:1}));
 const plan=await previewScope(root,env,'id:200');assert.equal(plan.previous,null);assert.equal(plan.summary.folderConflict,1);assert.equal(plan.requiresConfirmation,true);
 await assert.rejects(configureScope(root,env,'id:200'),ScopeReviewRequired);assert.equal(JSON.parse(readFileSync(workspacePath(root),'utf8')).version,1);
});

test('scope-root mapping conflicts can be reviewed and saved without rewriting their IDs',async t=>{
 const {root}=fixture(t);remote(t);const plan=await previewScope(root,env,'id:400');assert.equal(plan.summary.rootConflict,1);
 await configureScope(root,env,'id:400',plan.token);assert.equal(loadMapping(mappingPath(root))['common/'].pageId,'400');
});

test('only an explicit Push applies an in-scope page move after scope change, and a repeat does not move again',async t=>{
 configure(t);const {root}=workspace(t,{'a.md':'---\npageId: 401\ntitle: A\n---\nBody'});bindScope(root,scope('300','folder','/Assets/Patents'));const {nodes,calls}=remote(t,true);
 const d=readDoc(root,'a.md'),rendered=buildTreeRenderer(root,['a.md']).render('a.md',d.body,d.title),hash=docHash(d.title,rendered);nodes['401'].storage=rendered.storage;
 saveMapping(mappingPath(root),{'a.md':{pageId:'401',title:'A',hash,remoteVersion:1}});
 const plan=await previewScope(root,env,'/');assert.equal(plan.summary.pageMove,1);await configureScope(root,env,'/',plan.token);assert.ok(calls.every(c=>c.method==='GET'));
 const before=readFileSync(mappingPath(root),'utf8');await runPush(['--base',root,'--dry-run','--verify']);assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.ok(calls.every(c=>c.method==='GET'));
 await runPush(['--base',root]);assert.equal(calls.filter(c=>c.method==='PUT').length,1);assert.equal(loadMapping(mappingPath(root))['a.md'].remoteVersion,2);assert.equal(loadMapping(mappingPath(root))['a.md'].pendingMove,undefined);
 await runPush(['--base',root]);assert.equal(calls.filter(c=>c.method==='PUT').length,1);
});

test('CLI scope dry-run gives an approval token and confirmation changes only the workspace binding',async t=>{
 const {spawnSync}=await import('node:child_process');const {pathToFileURL}=await import('node:url');const {resolve}=await import('node:path');
 const {root,put}=fixture(t),before=readFileSync(mappingPath(root),'utf8');
 const metadata=(id,title,type,ids)=>({path:`/wiki/rest/api/content/${id}?expand=ancestors,space,version`,body:{id,title,type,space:{id:'space'},ancestors:ids.map(id=>({id,title:id}))}});
 const steps=[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space',homepageId:'100'}]}},metadata('300','Patents','folder',['100','200']),metadata('400','common','folder',['100','200','300']),metadata('401','A','page',['100','200','300','400'])];
 const responses=put('responses.json',JSON.stringify(steps)),calls=put('calls.jsonl','');
 const args=['init','--base',root,'--scope','id:300'];const run=extra=>spawnSync(process.execPath,[resolve('dist/sync.js'),...args,...extra],{cwd:root,encoding:'utf8',env:{...process.env,NODE_OPTIONS:'--import='+pathToFileURL(resolve('tests/helpers/fetch-preload.mjs')).href,CSYNC_TEST_RESPONSES:responses,CSYNC_TEST_CALLS:calls,CONFLUENCE_BASE_URL:env.baseUrl,CONFLUENCE_EMAIL:env.email,CONFLUENCE_API_TOKEN:env.token,CONFLUENCE_SPACE_KEY:env.spaceKey}});
 const preview=run(['--dry-run']);assert.equal(preview.status,0,preview.stderr);const token=preview.stdout.match(/확인 토큰: ([a-f0-9]{64})/)[1];assert.equal(JSON.parse(readFileSync(workspacePath(root),'utf8')).scope.id,'200');
 const unconfirmed=run([]);assert.equal(unconfirmed.status,1);assert.match(unconfirmed.stderr,/--confirm-scope/);assert.equal(JSON.parse(readFileSync(workspacePath(root),'utf8')).scope.id,'200');
 const saved=run(['--confirm-scope',token]);assert.equal(saved.status,0,saved.stderr);assert.equal(JSON.parse(readFileSync(workspacePath(root),'utf8')).scope.id,'300');assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.ok(readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse).every(call=>call.method==='GET'));
});

 test('single-file scope inspection resolves parents from the full mapping without inspecting unselected entries',async t=>{
 const {calls}=remote(t);
 const result=await inspectScopeMapping(scopeClient(env),{version:2,connection:{spaceId:'space',homepageId:'100'},scope:{id:'300',type:'folder',path:'/Assets/Patents'}},{'common/a.md':{pageId:'401'}},['common/README.md','common/a.md'],{'common/README.md':{pageId:'400'},'common/a.md':{pageId:'401'}});
 assert.equal(result[0].status,'aligned');assert.equal(result[0].expectedParent,'400');assert.equal(calls.length,1);
});
