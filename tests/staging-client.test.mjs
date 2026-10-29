import test from 'node:test';import assert from 'node:assert/strict';
import {createStaging} from '../src/web/client/staging.js';
function setup(t){
 const previous={document:globalThis.document,localStorage:globalThis.localStorage};const values=new Map();
 globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 function node(type){return {type,children:[],disabled:false,textContent:'',value:'',checked:false,classList:{toggle(){}},setAttribute(){},append(...nodes){this.children.push(...nodes)},replaceChildren(...nodes){this.children=nodes},querySelectorAll(selector){return this.children.flatMap(child=>[child,...child.querySelectorAll('*')]).filter(child=>selector==='*'||selector==='input:checked'?selector==='*'||child.type==='checkbox'&&child.checked:selector==='input'?child.type==='checkbox':selector==='button'?child.type==='button':false)}};}
 const selection={base:'/docs',envId:'private-session-handle',verify:false,referenceRoots:[]};let scope='/',nodes;
 const make=(api,extras={})=>{
  nodes=new Map(['sync-stage-list','sync-stage-note','sync-stage-count','sync-stage-scan','sync-stage-add','sync-stage-remove'].map(id=>[id,node('div')]));globalThis.document={getElementById:id=>nodes.get(id),createElement:type=>node(type)};
  let control;control=createStaging({api,selection:()=>selection,scopeKey:()=>scope,changed(){},busy:value=>control.update(value),status(){},update:()=>control.update(false),compare(){},...extras});control.update(false);return control;
 };
 t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 return {values,selection,make,get nodes(){return nodes},setScope:value=>{scope=value}};
}
const rows=[{path:'a.md',status:'changed',staged:true,stale:false},{path:'b.md',status:'new',staged:false,stale:false}];

test('refresh restores the last list without requests or approval; another scan is required',async t=>{
 const s=setup(t);let calls=0;let control=s.make(async()=>{calls++;return {rows}});await control.reload();assert.equal(control.ready(),true);
 const saved=[...s.values.values()].join('');assert.doesNotMatch(saved,/private-session-handle|envId|token/);
 control=s.make(async()=>{calls++;return {rows}});assert.equal(calls,1);assert.equal(s.nodes.get('sync-stage-list').querySelectorAll('input').length,2);assert.match(s.nodes.get('sync-stage-note').textContent,/이전 조회 결과/);assert.equal(control.ready(),false);assert.equal(s.nodes.get('sync-stage-add').disabled,true);
 await s.nodes.get('sync-stage-add').onclick();assert.equal(calls,1);
 await control.reload();assert.equal(calls,2);assert.equal(control.ready(),true);assert.doesNotMatch(s.nodes.get('sync-stage-note').textContent,/이전 조회 결과/);
});

test('failed refresh preserves the old list and marks it stale',async t=>{
 const s=setup(t);let fail=false;const control=s.make(async()=>{if(fail)throw Error('failed');return {rows}});await control.reload();fail=true;await control.reload();
 assert.equal(s.nodes.get('sync-stage-list').querySelectorAll('input').length,2);assert.match(s.nodes.get('sync-stage-note').textContent,/이전 조회 결과/);assert.equal(control.ready(),false);
});

test('different base folders keep separate views; scope changes invalidate freshness without hiding rows',async t=>{
 const s=setup(t);const control=s.make(async()=>({rows}));await control.reload();s.setScope('nested');control.update(false);assert.equal(control.ready(),false);assert.equal(s.nodes.get('sync-stage-list').querySelectorAll('input').length,2);
 s.selection.base='/other';control.update(false);assert.equal(s.nodes.get('sync-stage-list').children.length,0);
 s.selection.base='/docs';control.update(false);assert.equal(s.nodes.get('sync-stage-list').querySelectorAll('input').length,2);assert.equal(control.ready(),false);
});

test('a fresh empty result replaces the previously listed changes',async t=>{
 const s=setup(t);let current=rows;const control=s.make(async()=>({rows:current}));await control.reload();current=[];await control.reload();assert.equal(s.nodes.get('sync-stage-list').children.length,0);
 s.make(async()=>{throw Error('automatic lookup prohibited')});assert.equal(s.nodes.get('sync-stage-list').children.length,0);assert.match(s.nodes.get('sync-stage-note').textContent,/이전 조회 결과/);
});

test('blocked browser storage does not prevent a fresh scan',async t=>{
 const s=setup(t);globalThis.localStorage={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}};const control=s.make(async()=>({rows}));await control.reload();assert.equal(control.ready(),true);assert.equal(s.nodes.get('sync-stage-list').querySelectorAll('input').length,2);
});

test('checkboxes reflect saved inclusion and toggling immediately saves only that document',async t=>{
 const s=setup(t),calls=[];let current=structuredClone(rows);
 const control=s.make(async(_url,body)=>{calls.push(body);if(body.action)current=current.map(row=>body.paths.includes(row.path)?{...row,staged:body.action==='add',stale:false}:row);return {rows:current}});await control.reload();
 let inputs=s.nodes.get('sync-stage-list').querySelectorAll('input');assert.deepEqual(inputs.map(i=>i.checked),[true,false]);
 inputs[0].checked=false;await inputs[0].onchange();assert.equal(calls.at(-1).action,'remove');assert.deepEqual(calls.at(-1).paths,['a.md']);assert.equal(control.ready(),false);
 inputs=s.nodes.get('sync-stage-list').querySelectorAll('input');inputs[1].checked=true;await inputs[1].onchange();assert.equal(calls.at(-1).action,'add');assert.deepEqual(calls.at(-1).paths,['b.md']);assert.equal(control.ready(),true);assert.deepEqual(s.nodes.get('sync-stage-list').querySelectorAll('input').map(i=>i.checked),[false,true]);
});

test('bulk include and exclude act on all eligible documents without a second checkbox-selection state',async t=>{
 const s=setup(t),calls=[];let current=structuredClone(rows);
 const control=s.make(async(_url,body)=>{calls.push(body);if(body.action)current=current.map(row=>body.paths.includes(row.path)?{...row,staged:body.action==='add',stale:false}:row);return {rows:current}});await control.reload();
 await s.nodes.get('sync-stage-add').onclick();assert.deepEqual(calls.at(-1).paths,['b.md']);assert.deepEqual(s.nodes.get('sync-stage-list').querySelectorAll('input').map(i=>i.checked),[true,true]);
 await s.nodes.get('sync-stage-remove').onclick();assert.deepEqual(calls.at(-1).paths,['a.md','b.md']);assert.deepEqual(s.nodes.get('sync-stage-list').querySelectorAll('input').map(i=>i.checked),[false,false]);
});

test('a failed checkbox save restores the last known check state and requires a refresh',async t=>{
 const s=setup(t);const control=s.make(async(_url,body)=>{if(body.action)throw Error('lost response');return {rows}});await control.reload();
 const input=s.nodes.get('sync-stage-list').querySelectorAll('input')[0];input.checked=false;await input.onchange();
 assert.equal(s.nodes.get('sync-stage-list').querySelectorAll('input')[0].checked,true);assert.equal(control.ready(),false);assert.match(s.nodes.get('sync-stage-note').textContent,/이전 조회 결과/);
});

test('automatic local checks never fetch remote and unchanged revisions preserve preview approval',async t=>{
 const s=setup(t),timers=[];let revision='first',invalidations=0,calls=0,busyCalls=0;
 t.mock.method(globalThis,'setTimeout',callback=>{timers.push(callback);return timers.length});t.mock.method(globalThis,'clearTimeout',()=>{});
 s.make(async()=>({rows}));
 const control=createStaging({api:async(path,body)=>{calls++;assert.equal(path,'/api/sync/staging');assert.equal(body.action,undefined);return {rows,revision}},selection:()=>s.selection,scopeKey:()=>'',changed:()=>invalidations++,busy:value=>{busyCalls++;control.update(value)},status(){},update:()=>control.update(false),compare(){}});
 // Initialize the DOM through the helper, then install the controller under test.
 control.update(false);const stop=control.startWatching(()=>true);
 await timers.shift()();assert.equal(calls,1);assert.equal(invalidations,1);await timers.shift()();assert.equal(calls,2);assert.equal(invalidations,1);
 revision='second';await timers.shift()();assert.equal(invalidations,2);assert.equal(busyCalls,0);stop();
});

for(const reason of ['원격 부모 위치 변경','부모 위치 변경 또는 로컬 이동 대기'])test(`a remote move is labelled as a position change, not a body edit: ${reason}`,async t=>{
 const s=setup(t);const control=s.make(async()=>({rows:[{path:'a.md',status:'same',staged:false,stale:false,remoteState:'changed',remoteReasons:[reason]}]}));await control.reload();
 const texts=s.nodes.get('sync-stage-list').querySelectorAll('*').map(n=>n.textContent);assert.ok(texts.includes('원격 위치 변경'));assert.equal(texts.includes('원격 수정'),false);
});


test('remote recovery has a separate row action, excludes new and moved documents and requires a fresh view',async t=>{
 const s=setup(t),restored=[];const listed=[{path:'edit.md',pageId:'1',status:'changed',staged:false,stale:false},{path:'missing.md',pageId:'2',status:'unavailable',staged:false,stale:false},{path:'new.md',status:'new',staged:false,stale:false},{path:'move.md',pageId:'3',status:'moved',staged:false,stale:false}];
 let control=s.make(async()=>({rows:listed}),{restore:(...args)=>restored.push(args),canRestore:()=>true});await control.reload();let buttons=s.nodes.get('sync-stage-list').querySelectorAll('button').filter(button=>button.isRestore);assert.equal(buttons.length,2);await buttons[0].onclick();await buttons[1].onclick();assert.deepEqual(restored,[['edit.md',true],['missing.md',false]]);
 control=s.make(async()=>({rows:listed}),{restore:(...args)=>restored.push(args),canRestore:()=>true});buttons=s.nodes.get('sync-stage-list').querySelectorAll('button').filter(button=>button.isRestore);assert.equal(buttons.every(button=>button.disabled),true);await buttons[0].onclick();assert.equal(restored.length,2);
});

test('interrupted Pull documents appear once as incomplete recovery, never as uploadable local new files',async t=>{
 const s=setup(t);const control=s.make(async()=>({rows:[{path:'partial.md',pageId:'101',status:'new',unmapped:true,recoverable:true,remoteState:'new',staged:false,stale:false}]}));await control.reload();assert.equal(s.nodes.get('sync-stage-list').querySelectorAll('input').length,1);assert.equal(s.nodes.get('sync-stage-list').querySelectorAll('input')[0].disabled,true);assert.equal(s.nodes.get('sync-stage-add').disabled,true);assert.equal(control.remoteOnlyCount(),1);assert.equal(control.ready(),false);assert.match(s.nodes.get('sync-stage-note').textContent,/받기 미완료/);
});


test('failed local inspection displays cached remote changes without granting upload approval',async t=>{
 const s=setup(t),calls=[];let fail=true;
 const remoteRows=[{path:'a.md',pageId:'201',status:'unavailable',staged:false,stale:false,remoteState:'changed',localUnverified:true},{path:'new.md',pageId:'202',status:'unavailable',staged:false,stale:false,remoteState:'new',localUnverified:false}];
 const control=s.make(async(path,body)=>{calls.push(body);if(body.remoteOnly)return {rows:remoteRows,remoteCheckedAt:'2026-10-29T06:04:29.298Z',revision:'remote'};if(fail)throw Error('a.md: absolute link');return {rows,revision:'local'};});
 await control.reload(true);assert.deepEqual(calls.map(body=>!!body.remoteOnly),[false,true]);assert.equal(s.nodes.get('sync-stage-list').querySelectorAll('input').length,2);assert.match(s.nodes.get('sync-stage-note').textContent,/a.md: absolute link/);assert.equal(control.ready(),false);assert.equal(control.remoteOnlyCount(),1);assert.ok(s.nodes.get('sync-stage-list').querySelectorAll('input').every(input=>input.disabled));
 fail=false;await control.reload(true);assert.equal(control.ready(),true);assert.doesNotMatch(s.nodes.get('sync-stage-note').textContent,/absolute link/);
});
