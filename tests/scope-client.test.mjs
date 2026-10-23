import test from 'node:test';
import assert from 'node:assert/strict';
import { initSync } from '../src/web/client/sync.js';

function setup(t, api) {
 const ids=['sync-status','sync-scope','sync-env','sync-verify','sync-references','sync-config','sync-config-status','sync-scope-browse','sync-remote-scope','sync-scope-up','sync-scope-open','sync-scope-save','sync-scope-location','sync-load','sync-add-reference','sync-preview','sync-push','sync-target','sync-reconnect'];
 const node=()=>({disabled:false,hidden:false,value:'',checked:false,textContent:'',children:[],classList:{toggle(){}},addEventListener(){},append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items;this.value=items[0]?.value??''}});
 const nodes=new Map(ids.map(id=>[id,node()]));nodes.get('sync-scope').value='all';
 const oldDocument=globalThis.document,oldOption=globalThis.Option;
 globalThis.document={getElementById:id=>nodes.get(id),createElement:node};globalThis.Option=function(text,value){this.textContent=text;this.value=value;};
 t.after(()=>{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;if(oldOption===undefined)delete globalThis.Option;else globalThis.Option=oldOption;});
 const context={base:'/docs',file:'/docs/doc.md',folder:'/docs'};
 let controller;const busy=value=>controller.update(value);
 controller=initSync({api,context:()=>context,setBusy:busy,showSync:async()=>{}});controller.update(false);
 return {nodes,context,controller};
}
const tree={parent:{id:'100',path:'/',type:'page',title:'Home',parentId:null},children:[{id:'200',path:'/Patents',type:'folder',title:'Patents'}]};
const config={source:'.env',baseUrl:'https://example.invalid/wiki',email:'demo',spaceKey:'TEST',hasToken:true,missing:[],scope:{id:'200',path:'/Patents',type:'folder'}};

test('web never preselects even the whole-space scope and requires explicit save before preview',async t=>{
 const calls=[];const {nodes}=setup(t,async(path,body)=>{calls.push({path,body});return path.endsWith('/scopes')?tree:config;});
 assert.equal(nodes.get('sync-preview').disabled,true);assert.equal(nodes.get('sync-scope-save').disabled,true);
 await nodes.get('sync-scope-browse').onclick();
 assert.equal(nodes.get('sync-remote-scope').value,'');assert.equal(nodes.get('sync-scope-save').disabled,true);assert.equal(nodes.get('sync-preview').disabled,true);
 nodes.get('sync-remote-scope').value='200';nodes.get('sync-remote-scope').onchange();assert.equal(nodes.get('sync-scope-save').disabled,false);
 await nodes.get('sync-scope-save').onclick();assert.equal(nodes.get('sync-preview').disabled,false);
 assert.deepEqual(calls.at(-1),{path:'/api/sync/scope',body:{base:'/docs',envFile:'',scopeId:'200'}});
});

test('opening child scopes clears selection; changing local base invalidates scope and preview',async t=>{
 const {nodes,context,controller}=setup(t,async path=>path.endsWith('/scopes')?tree:config);
 await nodes.get('sync-scope-browse').onclick();nodes.get('sync-remote-scope').value='200';nodes.get('sync-remote-scope').onchange();
 await nodes.get('sync-scope-open').onclick();assert.equal(nodes.get('sync-remote-scope').value,'');assert.equal(nodes.get('sync-scope-save').disabled,true);
 nodes.get('sync-remote-scope').value='200';await nodes.get('sync-scope-save').onclick();assert.equal(nodes.get('sync-preview').disabled,false);
 context.base='/other';controller.update(false);assert.equal(nodes.get('sync-preview').disabled,true);assert.equal(nodes.get('sync-remote-scope').value,'');assert.equal(nodes.get('sync-scope-save').disabled,true);
});

test('stale tree responses do not populate a different local workspace',async t=>{
 let finish;const {nodes,context,controller}=setup(t,()=>new Promise(resolve=>{finish=resolve;}));
 const request=nodes.get('sync-scope-browse').onclick();context.base='/other';controller.update(true);finish(tree);await request;
 assert.equal(nodes.get('sync-scope-save').disabled,true);assert.equal(nodes.get('sync-remote-scope').children.length,0);
});
