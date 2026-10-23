import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnvSettings} from '../src/web/client/env-settings.js';
function setup(t,api){
 const ids=['sync-env-base-mode','sync-env-import-mode','sync-env-import-controls','sync-env-file','sync-env-file-name','sync-env-source-note','sync-env-choose','sync-env-save','sync-env-confirm','sync-env-confirm-path','sync-env-confirm-save','sync-env-confirm-cancel'];
 const nodes=new Map(ids.map(id=>[id,{checked:false,hidden:false,value:'',open:false,addEventListener(){},click(){this.clicked=true},showModal(){this.open=true},close(){this.open=false}}]));
 nodes.get('sync-env-base-mode').checked=true;const old=globalThis.document;globalThis.document={getElementById:id=>nodes.get(id)};t.after(()=>{globalThis.document=old;});
 const context={base:'/docs'},configs=[],messages=[];let control;let changes=0;
 control=createEnvSettings({api,context:()=>context,setBusy:value=>control.update(value),changed:()=>{changes++},renderConfig:config=>configs.push(config),status:text=>messages.push(text)});control.update(false);
 const mode=()=>{nodes.get('sync-env-base-mode').checked=false;nodes.get('sync-env-import-mode').checked=true;nodes.get('sync-env-import-mode').onchange();};
 const file=async()=>{nodes.get('sync-env-file').files=[{name:'.env.demo',size:20,text:async()=> 'secret-file-text'}];await nodes.get('sync-env-file').onchange();};
 return {nodes,context,control,configs,messages,mode,file,get changes(){return changes}};
}

test('import applies a session handle, resets file input and never saves until separately requested',async t=>{
 const calls=[];const s=setup(t,async(path,body)=>{calls.push({path,body});return {envId:'handle',config:{hasToken:true}};});
 assert.deepEqual(s.control.request(),{base:'/docs',envId:''});s.mode();assert.equal(s.nodes.get('sync-env-save').disabled,true);
 await s.file();assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/sync/env/import');assert.deepEqual(s.control.request(),{base:'/docs',envId:'handle'});assert.equal(s.nodes.get('sync-env-file').value,'');assert.equal(s.configs.length,1);
 s.context.base='/other';s.control.update(false);assert.deepEqual(s.control.request(),{base:'/other',envId:''});assert.equal(s.nodes.get('sync-env-import-controls').hidden,true);assert.equal(s.nodes.get('sync-env-file-name').textContent,'선택한 파일 없음');
});

test('existing env save opens confirmation and cancelling performs no write',async t=>{
 const calls=[];const s=setup(t,async(path,body)=>{calls.push({path,body});return path.endsWith('/import')?{envId:'handle',config:{}}:{needsConfirmation:true,expectedHash:'old-hash',path:'/docs/.env'};});
 s.mode();await s.file();await s.nodes.get('sync-env-save').onclick();assert.equal(s.nodes.get('sync-env-confirm').open,true);assert.equal(calls.length,2);
 s.nodes.get('sync-env-confirm-cancel').onclick();assert.equal(s.nodes.get('sync-env-confirm').open,false);assert.equal(calls.length,2);
 await s.nodes.get('sync-env-save').onclick();await s.nodes.get('sync-env-confirm-save').onclick();assert.equal(calls.at(-1).body.expectedHash,'old-hash');assert.equal(s.nodes.get('sync-env-base-mode').checked,true);
});
