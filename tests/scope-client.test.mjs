import test from 'node:test';
import assert from 'node:assert/strict';
import { initSync } from '../src/web/client/sync.js';

function setup(t, api) {
 const ids=['scope-review-dialog','scope-review-transition','scope-review-counts','scope-review-items','scope-review-cancel','scope-review-confirm','sync-log-empty','sync-direction-push','sync-direction-pull','sync-push-options','sync-pull','sync-pull-note','sync-direction-label','sync-direction-note','sync-status','sync-env-base-mode','sync-env-import-mode','sync-env-import-controls','sync-env-file','sync-env-file-name','sync-env-source-note','sync-env-choose','sync-env-save','sync-env-confirm','sync-env-confirm-save','sync-env-confirm-cancel','sync-verify','sync-references','sync-config','sync-config-status','sync-scope-browse','sync-scope-tree','sync-scope-save','sync-scope-saved','sync-scope-candidate','sync-load','sync-add-reference','sync-preview','sync-push','sync-target','sync-reconnect'];
 const node=()=>({disabled:false,hidden:false,open:false,showModal(){this.open=true},close(){this.open=false},value:'',checked:false,textContent:'',children:[],attributes:{},setAttribute(key,value){this.attributes[key]=value},classList:{toggle(){}},addEventListener(){},append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items;this.value=items[0]?.value??''}});
 const nodes=new Map(ids.map(id=>[id,node()]));nodes.get('sync-env-base-mode').checked=true;
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


function all(node) { return [node,...node.children.flatMap(all)]; }
function button(nodes, text) { return all(nodes.get('sync-scope-tree')).find(node=>node.children?.some(child=>child.textContent===text)); }
function toggle(nodes, name) { return all(nodes.get('sync-scope-tree')).find(node=>node.attributes?.['aria-label']===name); }

test('web tree has no default selection and requires explicit save before preview',async t=>{
 const calls=[];const {nodes}=setup(t,async(path,body)=>{calls.push({path,body});return path.endsWith('/scopes')?tree:config;});
 assert.equal(nodes.get('sync-preview').disabled,true);assert.equal(nodes.get('sync-scope-save').disabled,true);
 await nodes.get('sync-scope-browse').onclick();
 assert.equal(nodes.get('sync-scope-candidate').textContent,'아직 선택하지 않았습니다.');assert.equal(nodes.get('sync-scope-save').disabled,true);
 button(nodes,'Patents').onclick();assert.equal(nodes.get('sync-scope-save').disabled,false);assert.equal(nodes.get('sync-preview').disabled,true);
 await nodes.get('sync-scope-save').onclick();assert.equal(nodes.get('sync-preview').disabled,false);
 assert.deepEqual(calls.at(-1),{path:'/api/sync/scope',body:{base:'/docs',envId:'',scopeId:'200'}});
 assert.match(nodes.get('sync-scope-saved').textContent,/Patents/);
});

test('expanding lazily preserves candidate; collapse and reopening use cached children',async t=>{
 const calls=[];const {nodes,context,controller}=setup(t,async(path,body)=>{
  calls.push({path,body});return path.endsWith('/scopes')?(body.parentId?{parent:tree.children[0],children:[{id:'300',path:'/Patents/Idea',title:'Idea',type:'page'}]}:tree):config;
 });
 await nodes.get('sync-scope-browse').onclick();button(nodes,'Patents').onclick();
 await toggle(nodes,'Patents 펼치기').onclick();assert.match(nodes.get('sync-scope-candidate').textContent,/Patents/);assert.ok(button(nodes,'Idea'));
 await toggle(nodes,'Patents 접기').onclick();assert.equal(button(nodes,'Idea'),undefined);
 await toggle(nodes,'Patents 펼치기').onclick();assert.ok(button(nodes,'Idea'));assert.equal(calls.length,2);
 await nodes.get('sync-scope-save').onclick();assert.equal(nodes.get('sync-preview').disabled,false);
 context.base='/other';controller.update(false);assert.equal(nodes.get('sync-preview').disabled,true);assert.equal(nodes.get('sync-scope-save').disabled,true);assert.equal(button(nodes,'Patents'),undefined);
});

test('stale tree responses do not populate a different local workspace',async t=>{
 let finish;const {nodes,context,controller}=setup(t,()=>new Promise(resolve=>{finish=resolve;}));
 const request=nodes.get('sync-scope-browse').onclick();context.base='/other';controller.update(true);finish(tree);await request;
 assert.equal(nodes.get('sync-scope-save').disabled,true);assert.equal(button(nodes,'Patents'),undefined);
});

test('failed lazy expansion is retryable without losing the selected candidate',async t=>{
 let fail=true;const {nodes}=setup(t,async(path,body)=>{
  if(body.parentId){if(fail)throw Error('조회 실패');return {parent:tree.children[0],children:[]};}return tree;
 });
 await nodes.get('sync-scope-browse').onclick();button(nodes,'Patents').onclick();await toggle(nodes,'Patents 펼치기').onclick();
 assert.match(nodes.get('sync-status').textContent,/조회 실패/);assert.match(nodes.get('sync-scope-candidate').textContent,/Patents/);
 fail=false;await toggle(nodes,'Patents 펼치기').onclick();assert.equal(toggle(nodes,'Patents 하위 항목 없음').disabled,true);
});

test('web direction controls separate upload and pull and allow pull without selecting a local document',async t=>{
 const {nodes,context,controller}=setup(t,async()=>config);
 context.file='';await nodes.get('sync-load').onclick();controller.update(false);
 assert.equal(nodes.get('sync-preview').disabled,false);assert.equal(nodes.get('sync-pull').hidden,true);
 nodes.get('sync-direction-pull').onclick();assert.equal(nodes.get('sync-preview').hidden,true);assert.equal(nodes.get('sync-push').hidden,true);assert.equal(nodes.get('sync-pull').hidden,false);assert.equal(nodes.get('sync-pull').disabled,false);assert.equal(nodes.get('sync-push-options').hidden,true);assert.match(nodes.get('sync-direction-label').textContent,/Confluence → 로컬/);
 nodes.get('sync-direction-push').onclick();assert.equal(nodes.get('sync-preview').hidden,false);assert.equal(nodes.get('sync-pull').hidden,true);assert.equal(nodes.get('sync-push-options').hidden,false);
});


test('web upload always sends the base workspace, independent of explorer file and folder',async t=>{
 const calls=[];const {nodes,context,controller}=setup(t,async(path,body)=>{calls.push({path,body});if(path.endsWith('/preview'))throw Error('stop before execution');if(path.endsWith('/job'))return {job:null};return config;});
 await nodes.get('sync-load').onclick();controller.update(false);
 for (const [file,folder] of [['/docs/one.md','/docs/nested'],['/docs/other.md','/docs/elsewhere'],['','/docs']]) {
  context.file=file;context.folder=folder;controller.update(false);await nodes.get('sync-preview').onclick();const sent=calls.findLast(call=>call.path.endsWith('/preview')).body;assert.equal(sent.base,'/docs');assert.equal(sent.target,'');
 }
});

test('scope change review can be cancelled and only confirmation saves the new binding',async t=>{
 const calls=[],token='a'.repeat(64),review={token,previous:{path:'/'},next:{id:'200',path:'/Patents'},summary:{total:1,aligned:0,outside:1,rootConflict:0,pageMove:0,folderConflict:0},entries:[{path:'old.md',pageId:'1',status:'outside',remotePath:'/Old'}]};
 const {nodes}=setup(t,async(path,body)=>{calls.push({path,body});if(path.endsWith('/scopes'))return tree;return body.confirmation?{...config,scopeCheckRequired:true}:{confirmationRequired:true,review};});
 await nodes.get('sync-scope-browse').onclick();button(nodes,'Patents').onclick();await nodes.get('sync-scope-save').onclick();
 assert.equal(nodes.get('scope-review-dialog').open,true);assert.equal(nodes.get('sync-preview').disabled,true);assert.match(nodes.get('scope-review-items').children[0].textContent,/old.md.*스코프 밖/);
 nodes.get('scope-review-cancel').onclick();assert.equal(nodes.get('scope-review-dialog').open,false);assert.equal(calls.length,2);
 await nodes.get('sync-scope-save').onclick();await nodes.get('scope-review-confirm').onclick();assert.equal(calls.at(-1).body.confirmation,token);assert.equal(nodes.get('scope-review-dialog').open,false);assert.equal(nodes.get('sync-preview').disabled,false);assert.equal(nodes.get('sync-verify').checked,true);
});

test('scope review cannot apply to a different base after the dialog was opened',async t=>{
 const calls=[];const {nodes,context,controller}=setup(t,async(path,body)=>{calls.push({path,body});return path.endsWith('/scopes')?tree:{confirmationRequired:true,review:{token:'a'.repeat(64),previous:{path:'/'},next:{id:'200',path:'/Patents'},summary:{total:0,aligned:0,outside:0,rootConflict:0,pageMove:0,folderConflict:0},entries:[]}};});
 await nodes.get('sync-scope-browse').onclick();button(nodes,'Patents').onclick();await nodes.get('sync-scope-save').onclick();assert.equal(nodes.get('scope-review-dialog').open,true);
 context.base='/other';controller.update(false);assert.equal(nodes.get('scope-review-dialog').open,false);await nodes.get('scope-review-confirm').onclick();assert.equal(calls.length,2);
});
