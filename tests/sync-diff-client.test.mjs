import test from 'node:test';import assert from 'node:assert/strict';import {createSyncDiff} from '../src/web/client/sync-diff.js';
function setup(t,api,lazy){
 const prior=globalThis.document;
 const nodes=new Map(['sync-diff-close','sync-diff-dialog','sync-diff-remote','sync-diff-path','sync-diff-note','sync-diff-editor','sync-diff-labels','sync-diff-before-label'].map(id=>[id,{hidden:false,disabled:false,open:false,textContent:'',showModal(){this.open=true},close(){this.open=false},addEventListener(){}}]));
 globalThis.document={getElementById:id=>nodes.get(id)};t.after(()=>{globalThis.document=prior});
 const models=[],notifications=[];
 const monaco={editor:{
  createModel(){const model={value:'',setValue(value){this.value=value}};models.push(model);return model},
  createDiffEditor(){return {setModel(){},getOriginalEditor:()=>({updateOptions(){}}),getModifiedEditor:()=>({updateOptions(){}}),layout(){}}},
 }};
 const ui=createSyncDiff({api,selection:()=>({base:'/docs',envId:''}),monaco,loadMonaco:lazy?()=>lazy(monaco):undefined,notify:text=>notifications.push(text)});return {ui,nodes,models,notifications};
}
const unavailable={before:null,after:'Local',canRemote:true,source:'unavailable',note:'No stored baseline'};
const remote={before:'Remote',after:'Local',canRemote:true,source:'remote',note:'Current remote comparison'};

test('opening a diff immediately reads the current remote body once',async t=>{
 const calls=[];const s=setup(t,async(path,body)=>{calls.push(body);return body.remote?remote:unavailable});await s.ui.open('a.md');
 assert.deepEqual(calls.map(c=>[c.path,c.remote]),[['a.md',true]]);assert.equal(s.nodes.get('sync-diff-editor').hidden,false);assert.deepEqual(s.models.map(m=>m.value),['Remote','Local']);assert.match(s.nodes.get('sync-diff-before-label').textContent,/현재 원격/);
});

test('explicit baseline comparison stays offline and new documents display an empty remote',async t=>{
 for(const source of ['baseline','new']){let calls=0;const s=setup(t,async(_path,body)=>{calls++;assert.equal(body.remote,false);return {...remote,source,before:source==='new'?'':'Original',canRemote:source==='baseline'}});await s.ui.open('a.md',false);assert.equal(calls,1);assert.equal(s.nodes.get('sync-diff-editor').hidden,false);}
});

test('failed automatic comparison shows an error and allows one explicit retry',async t=>{
 let reads=0;const s=setup(t,async(_path,body)=>{if(!body.remote)return unavailable;if(++reads===1)throw Error('Network failure');return remote});await s.ui.open('a.md');
 assert.equal(reads,1);assert.equal(s.nodes.get('sync-diff-remote').hidden,false);assert.equal(s.nodes.get('sync-diff-remote').disabled,false);assert.match(s.nodes.get('sync-diff-note').textContent,/Network failure/);
 await s.nodes.get('sync-diff-remote').onclick();assert.equal(reads,2);assert.equal(s.nodes.get('sync-diff-editor').hidden,false);
});

test('closing before the local lookup finishes never starts a remote request',async t=>{
 let finish,calls=0;const s=setup(t,()=>{calls++;return new Promise(resolve=>{finish=resolve})});const pending=s.ui.open('a.md');s.nodes.get('sync-diff-close').onclick();finish(unavailable);await pending;assert.equal(calls,1);assert.equal(s.models.length,0);
});

test('default diff compares current remote even when a saved baseline exists',async t=>{
 const calls=[];const s=setup(t,async(_path,body)=>{calls.push(body);return body.remote?{...remote,before:'한글_제목',after:'한글_제목'}:{...remote,source:'baseline',before:'한글\\_제목',after:'한글_제목'}});
 await s.ui.open('a.md');assert.deepEqual(calls.map(c=>c.remote),[true]);assert.deepEqual(s.models.map(m=>m.value),['한글_제목','한글_제목']);
});
test('closing while the lazy editor loads does not render a stale comparison',async t=>{
 let finish,started;const loading=new Promise(resolve=>{started=resolve});
 const s=setup(t,async()=>remote,monaco=>{started();return new Promise(resolve=>{finish=()=>resolve(monaco)});});
 const opened=s.ui.open('a.md');await loading;assert.equal(s.models.length,0);s.nodes.get('sync-diff-close').onclick();finish();await opened;assert.equal(s.models.length,0);assert.equal(s.nodes.get('sync-diff-dialog').open,false);
});
