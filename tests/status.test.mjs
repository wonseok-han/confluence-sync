import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {workspace,configure,mockFetch} from './helpers/fixtures.mjs';
import {bindScope} from './helpers/scope.mjs';
import {mappingPath} from '../dist/sync/metadata.js';
import {mappingPass} from '../dist/sync/pull.js';
import {changeStaging} from '../dist/sync/staging.js';
import {fetchRemote,FETCH_TTL_MS} from '../dist/sync/fetch.js';
import {runStatus} from '../dist/cli/status.js';
import {observeChanges,changeGroup} from '../dist/sync/changes.js';
const env={baseUrl:'https://example.invalid/wiki',email:'test@example.invalid',token:'test-token',spaceKey:'TEST'};
async function fixture(t){
 configure(t);const {root,put}=workspace(t,{'incoming.md':'# Incoming','outgoing.md':'# Outgoing','both.md':'# Both','steady.md':'# Steady','missing.md':'# Missing'});
 bindScope(root,{scope:{id:'100',type:'page'},connection:{homepageId:'100'}});
 const ids=['101','102','103','104','105'];const paths=['incoming.md','outgoing.md','both.md','steady.md','missing.md'];
 await mappingPass(root,mappingPath(root),new Map(paths.map((p,i)=>[ids[i],join(root,p)])),new Map(),new Map(ids.map(id=>[id,1])));
 return {root,put,ids,paths};
}
function capture(t){const output=[];t.mock.method(console,'log',value=>output.push(String(value)));return ()=>output.join('\n');}
function batch(t,ids,versions={},omit=[]){return mockFetch(t,[{path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100',body:{results:ids.filter(id=>!omit.includes(id)).map(id=>({id,spaceId:'space',parentId:'100',version:{number:versions[id]??1}}))}}]);}

test('status shows incoming, outgoing, conflicts and staged state with zero extra remote calls or writes',async t=>{
 const {root,put,ids}=await fixture(t);const calls=batch(t,ids,{'101':2,'103':2});await fetchRemote(root,env);
 put('outgoing.md','# Outgoing\n\nEdit');put('both.md','# Both\n\nEdit');await changeStaging(root,['outgoing.md'],'add',{baseUrl:env.baseUrl});
 const paths=['.csync/mapping.json','.csync/workspace.json','.csync/index.json','.csync/remote.json','incoming.md','outgoing.md','both.md'];
 const before=paths.map(p=>readFileSync(join(root,p),'utf8'));const output=capture(t);
 await runStatus(['status','--base',root]);const result=output();assert.equal(calls.length,1);
 assert.match(result,/↓ 받을 변경 \(1개\)[\s\S]*incoming.md/);assert.match(result,/! 양쪽 변경 · 비교 필요 \(1개\)[\s\S]*both.md/);
 assert.match(result,/↑ 보낼 변경 · 로컬 작업 \(1개\)[\s\S]*\[추가됨\] outgoing.md/);assert.match(result,/업로드 선택: 1개/);assert.match(result,/이번 API 요청: 0회/);assert.match(result,/기준 v1 \/ 원격 v2/);
 assert.deepEqual(paths.map(p=>readFileSync(join(root,p),'utf8')),before);
});

test('status without Fetch reports unobserved remote state and does not claim remote is clean',async t=>{
 const {root}=await fixture(t);mockFetch(t,[]);const output=capture(t);await runStatus(['status','--base',root]);
 assert.match(output(),/원격 미확인/);assert.match(output(),/로컬 변경이 없습니다. 원격 상태는 아직 확인하지 않았습니다/);
});

test('expired Fetch stays visible as an old observation without a refresh request',async t=>{
 const {root,ids}=await fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);batch(t,ids,{'101':2});await fetchRemote(root,env);now+=FETCH_TTL_MS+1;
 const output=capture(t);await runStatus(['status','--base',root]);assert.match(output(),/이전 조회 결과\(2분 경과\)/);assert.match(output(),/incoming.md/);
});

test('status exposes stale staged files, local deletion and unavailable remote pages for attention',async t=>{
 const {root,put,ids}=await fixture(t);batch(t,ids,{},['104']);await fetchRemote(root,env);
 await changeStaging(root,['outgoing.md'],'add',{baseUrl:env.baseUrl});put('outgoing.md','# Post-add edit');rmSync(join(root,'missing.md'));
 const output=capture(t);await runStatus(['status','--base',root]);assert.match(output(),/! 확인 필요 \(3개\)/);assert.match(output(),/\[재추가 필요\] outgoing.md/);assert.match(output(),/missing.md · 로컬 파일 없음/);assert.match(output(),/원격에서 복구: csync restore \"missing.md\"/);assert.match(output(),/steady.md.*원격 조회 불가/);assert.match(output(),/삭제로 확정하지 않음/);
});

test('shared observations do not duplicate moved IDs and preserve ignored and nested boundaries',async t=>{
 const {root,put}=await fixture(t);put('.csync/ignore','missing.md\n');put('nested/.csync/workspace.json','{}');
 const mapping=JSON.parse(readFileSync(mappingPath(root),'utf8'));mapping['nested/private.md']={pageId:'900',hash:'old'};writeFileSync(mappingPath(root),JSON.stringify(mapping));
 const {inspectStaging}=await import('../dist/sync/staging.js');const rows=await inspectStaging(root,{baseUrl:env.baseUrl});
 rows.find(r=>r.path==='outgoing.md').path='moved.md';const view=observeChanges(root,rows,env);assert.equal(view.rows.filter(r=>r.pageId==='102').length,1);assert.ok(view.rows.every(r=>!['missing.md','nested/private.md'].includes(r.path)));
});

test('unknown or damaged Fetch metadata preserves local status and provides a refresh hint',async t=>{
 const {root,put}=await fixture(t);put('.csync/remote.json','bad json');put('outgoing.md','# Edited');mockFetch(t,[]);const output=capture(t);await runStatus(['status','--base',root]);assert.match(output(),/원격 미확인/);assert.match(output(),/outgoing.md/);
});

test('classification keeps version-unknown and missing files out of the safe incoming group',()=>{
 const row={path:'a.md',status:'same',staged:false,stale:false};
 assert.equal(changeGroup({...row,remoteState:'changed'}),'receive');assert.equal(changeGroup({...row,status:'changed',remoteState:'changed'}),'conflict');
 assert.equal(changeGroup({...row,remoteState:'unknown'}),'attention');assert.equal(changeGroup({...row,status:'unavailable',remoteState:'changed'}),'attention');
});

test('CLI status validates options and subcommand help works without a workspace',t=>{
 const {root}=workspace(t);const cli=resolve('dist/sync.js');
 for(const args of [['status','--base'],['status','--reference-root'],['status','--remote'],['status','doc.md']]){
  const result=spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/폴더|지원하지 않는/);
 }
 const result=spawnSync(process.execPath,[cli,'status','--help'],{cwd:root,encoding:'utf8'});assert.equal(result.status,0);assert.match(result.stdout,/이번|Confluence API 호출·파일 저장 없음/);assert.doesNotMatch(result.stdout,/--to obsidian/);
});
