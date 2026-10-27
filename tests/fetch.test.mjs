import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {workspace} from './helpers/fixtures.mjs';
import {bindScope} from './helpers/scope.mjs';
import {mappingPath,workspacePath} from '../dist/sync/metadata.js';
import {fetchRemote,FETCH_TTL_MS} from '../dist/sync/fetch.js';
const env={baseUrl:'https://example.invalid/wiki',email:'demo@example.invalid',token:'synthetic-secret',spaceKey:'TEST'};
const page=(id,number=1,extra={})=>({id:String(id),spaceId:'space',title:`Page ${id}`,parentId:'100',version:{number},...extra});
function setup(t,entries){
 const {root,put}=workspace(t,{'doc.md':'# Original'});bindScope(root,{scope:{id:'100',type:'page',path:'/'},connection:{homepageId:'100'}});
 put('.csync/mapping.json',JSON.stringify(entries));return {root,put,cache:join(root,'.csync/remote.json')};
}
function intercept(t,respond){
 const calls=[];t.mock.method(globalThis,'fetch',async(url,init={})=>{const parsed=new URL(url);assert.equal(parsed.pathname,'/wiki/api/v2/pages');assert.equal(init.method??'GET','GET');assert.equal(parsed.searchParams.has('body-format'),false);calls.push(parsed);return respond(parsed,calls.length)});return calls;
}
const response=(results,extra={})=>new Response(JSON.stringify({results,...extra}),{status:200});

test('metadata-only fetch batches IDs, classifies observations, and preserves docs and baselines',async t=>{
 const {root,cache}=setup(t,{'a.md':{pageId:'1',title:'Page 1',remoteVersion:1,hash:'one'},'b.md':{pageId:'2',remoteVersion:1},'c.md':{pageId:'3',remoteVersion:1},'d.md':{pageId:'4'},'e.md':{pageId:'5',title:'Old',remoteVersion:1},'f.md':{pageId:'6',remoteVersion:1}});
 const mapping=readFileSync(mappingPath(root),'utf8'),config=readFileSync(workspacePath(root),'utf8'),source=readFileSync(join(root,'doc.md'),'utf8');
 const calls=intercept(t,url=>{assert.equal(url.searchParams.get('id'),'1,2,3,4,5,6');return response([page(1),page(2,2),page(4),page(5),page(6,1,{parentId:'999'})])});
 const result=await fetchRemote(root,env);assert.equal(calls.length,1);assert.equal(result.requests,1);assert.deepEqual(result.snapshot.items.map(item=>item.state),['unchanged','changed','unavailable','unknown','changed','changed']);
 assert.match(result.snapshot.items[2].reasons[0],/삭제·권한/);assert.equal(readFileSync(mappingPath(root),'utf8'),mapping);assert.equal(readFileSync(workspacePath(root),'utf8'),config);assert.equal(readFileSync(join(root,'doc.md'),'utf8'),source);assert.ok(!readFileSync(cache,'utf8').includes(env.token));
 const cached=await fetchRemote(root,env);assert.equal(cached.cached,true);assert.equal(cached.requests,0);assert.equal(calls.length,1);
});

test('scope, ignores and independent workspaces constrain IDs; folder nodes are skipped',async t=>{
 const {root,put}=setup(t,{'area/a.md':{pageId:'1',remoteVersion:1},'other/b.md':{pageId:'2',remoteVersion:1},'area/ignored.md':{pageId:'3'},'area/nested/x.md':{pageId:'4'},'area/':{pageId:'5',type:'folder'}});
 const config=JSON.parse(readFileSync(workspacePath(root),'utf8'));config.scope={path:'area',type:'folder'};put('.csync/workspace.json',JSON.stringify(config));put('.csync/ignore','area/ignored.md');put('area/nested/.csync/workspace.json','{}');
 intercept(t,url=>{assert.equal(url.searchParams.get('id'),'1');return response([page(1)])});
 const {snapshot}=await fetchRemote(root,env);assert.equal(snapshot.items.length,1);assert.equal(snapshot.foldersSkipped,1);
});

test('101 pages require two batch requests rather than 101 calls',async t=>{
 const entries=Object.fromEntries(Array.from({length:101},(_,i)=>[`${String(i).padStart(3,'0')}.md`,{pageId:String(i+1),remoteVersion:1}]));const {root}=setup(t,entries);
 const calls=intercept(t,url=>{const ids=url.searchParams.get('id').split(',');assert.ok(ids.length<=100);return response(ids.map(id=>page(id)))});
 const result=await fetchRemote(root,env);assert.equal(calls.length,2);assert.equal(result.snapshot.items.length,101);
});

for(const useHeader of [false,true])test(`pagination follows ${useHeader?'Link header':'JSON links'} with original ID filters`,async t=>{
 const {root}=setup(t,{'a.md':{pageId:'1',remoteVersion:1},'b.md':{pageId:'2',remoteVersion:1}});
 const calls=intercept(t,(url,n)=>{
  assert.equal(url.searchParams.get('id'),'1,2');assert.equal(url.searchParams.get('space-id'),'space');
  if(n===1){const next='/wiki/api/v2/pages?cursor=next';return useHeader?new Response(JSON.stringify({results:[page(1)]}),{headers:{Link:`<${next}>; rel="next"`}}):response([page(1)],{_links:{next}})}
  assert.equal(url.searchParams.get('cursor'),'next');return response([page(2)]);
 });const result=await fetchRemote(root,env);assert.equal(result.requests,2);assert.ok(result.snapshot.items.every(item=>item.state==='unchanged'));
});

test('TTL, scope, baseline and credential changes invalidate cache',async t=>{
 const {root,put}=setup(t,{'doc.md':{pageId:'1',remoteVersion:1}});let now=Date.now();t.mock.method(Date,'now',()=>now);
 const calls=intercept(t,()=>response([page(1,2)]));await fetchRemote(root,env);await fetchRemote(root,env);assert.equal(calls.length,1);
 now+=FETCH_TTL_MS+1;await fetchRemote(root,env);assert.equal(calls.length,2);
 put('.csync/mapping.json',JSON.stringify({'doc.md':{pageId:'1',remoteVersion:2}}));assert.equal((await fetchRemote(root,env)).snapshot.items[0].state,'unchanged');assert.equal(calls.length,3);
 await fetchRemote(root,{...env,token:'different-secret'});assert.equal(calls.length,4);
 const config=JSON.parse(readFileSync(workspacePath(root),'utf8'));config.scope={path:'doc.md',type:'file'};put('.csync/workspace.json',JSON.stringify(config));await fetchRemote(root,env);assert.equal(calls.length,5);
});

for(const fault of ['429','network','foreign-id','foreign-space','repeat','malformed'])test(`${fault} preserves the prior complete cache and mapping`,async t=>{
 const {root,cache}=setup(t,{'doc.md':{pageId:'1',remoteVersion:1}});let now=Date.now();t.mock.method(Date,'now',()=>now);let fail=false;
 intercept(t,()=>{
  if(!fail)return response([page(1)]);
  if(fault==='429')return new Response('rate limited',{status:429});
  if(fault==='network')throw Error('network failure');
  if(fault==='foreign-id')return response([page(99)]);
  if(fault==='foreign-space')return response([page(1,1,{spaceId:'other'})]);
  if(fault==='repeat')return response([],{_links:{next:'?cursor=loop'}});
  return response(null);
 });await fetchRemote(root,env);const before=readFileSync(cache,'utf8'),mapping=readFileSync(mappingPath(root),'utf8');now+=FETCH_TTL_MS+1;fail=true;
 await assert.rejects(fetchRemote(root,env));assert.equal(readFileSync(cache,'utf8'),before);assert.equal(readFileSync(mappingPath(root),'utf8'),mapping);
});

test('request budget stops pagination at 20 without publishing partial cache',async t=>{
 const {root,cache}=setup(t,{'doc.md':{pageId:'1',remoteVersion:1}});
 const calls=intercept(t,(_url,n)=>response([],{_links:{next:`?cursor=${n}`}}));await assert.rejects(fetchRemote(root,env),/20회/);assert.equal(calls.length,20);assert.equal(existsSync(cache),false);
});

test('unsafe pagination links never receive credentials',async t=>{
 const {root}=setup(t,{'doc.md':{pageId:'1',remoteVersion:1}});const calls=intercept(t,()=>response([],{_links:{next:'https://attacker.invalid/api/v2/pages?cursor=next'}}));await assert.rejects(fetchRemote(root,env),/다음 페이지/);assert.equal(calls.length,1);
});

test('empty mapping uses zero calls; malformed cache is replaced and symlinks rejected',async t=>{
 const {root,put,cache}=setup(t,{});let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('unexpected')});put('.csync/remote.json','null');const result=await fetchRemote(root,env);assert.equal(result.requests,0);assert.equal(calls,0);assert.equal(result.snapshot.items.length,0);
 const {rmSync}=await import('node:fs');rmSync(cache);const target=put('outside.json','{}');symlinkSync(target,cache);await assert.rejects(fetchRemote(root,env),/일반 파일/);
});

test('CLI fetch dispatch uses metadata batch API and reuses the saved cache',t=>{
 const {root,put}=setup(t,{'doc.md':{pageId:'1',remoteVersion:1}});
 const responses=put('responses.json',JSON.stringify([{path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100&id=1',body:{results:[page(1,2)]}}])),calls=put('calls.jsonl','');
 const options={encoding:'utf8',env:{...process.env,CONFLUENCE_BASE_URL:env.baseUrl,CONFLUENCE_EMAIL:env.email,CONFLUENCE_API_TOKEN:env.token,CONFLUENCE_SPACE_KEY:env.spaceKey,NODE_OPTIONS:`--import=${new URL('./helpers/fetch-preload.mjs',import.meta.url).href}`,CSYNC_TEST_RESPONSES:responses,CSYNC_TEST_CALLS:calls}};
 const result=spawnSync(process.execPath,[resolve('dist/sync.js'),'fetch','--base',root],options);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/원격 변경 1/);assert.match(result.stdout,/API 요청: 1회/);
 writeFileSync(responses,'[]');const cached=spawnSync(process.execPath,[resolve('dist/sync.js'),'fetch','--base',root],options);assert.equal(cached.status,0,cached.stderr);assert.match(cached.stdout,/캐시 사용/);assert.match(cached.stdout,/API 요청: 0회/);
});
