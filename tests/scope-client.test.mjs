import test from 'node:test';
import assert from 'node:assert/strict';
import { initSync } from '../src/web/client/sync.js';

function setup(t, api) {
 const ids=['sync-job-summary','sync-log','sync-job-state','sync-log-empty','sync-direction-push','sync-direction-pull','sync-push-options','sync-pull','sync-pull-note','sync-direction-label','sync-direction-note','sync-status','sync-env-base-mode','sync-env-import-mode','sync-env-import-controls','sync-env-file','sync-env-file-name','sync-env-source-note','sync-env-choose','sync-env-save','sync-env-confirm','sync-env-confirm-save','sync-env-confirm-cancel','sync-verify','sync-references','sync-config','sync-config-status','sync-scope-save','sync-scope-saved','sync-scope-candidate','sync-load','sync-add-reference','sync-preview','sync-push','sync-target','sync-reconnect'];
 const node=()=>({disabled:false,hidden:false,open:false,showModal(){this.open=true},close(){this.open=false},value:'',checked:false,textContent:'',children:[],attributes:{},setAttribute(key,value){this.attributes[key]=value},classList:{toggle(){}},addEventListener(){},append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items;this.value=items[0]?.value??''}});
 const nodes=new Map(ids.map(id=>[id,node()]));nodes.get('sync-env-base-mode').checked=true;
 const oldDocument=globalThis.document,oldOption=globalThis.Option;
 globalThis.document={getElementById:id=>nodes.get(id),createElement:node,createDocumentFragment:node};globalThis.Option=function(text,value){this.textContent=text;this.value=value;};
 t.after(()=>{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;if(oldOption===undefined)delete globalThis.Option;else globalThis.Option=oldOption;});
 const context={base:'/docs',file:'/docs/doc.md',folder:'/docs'};
 const notifications=[];
 let controller;const busy=value=>controller.update(value);
 controller=initSync({api,notify:(text,kind)=>notifications.push({text,kind}),context:()=>context,setBusy:busy,showSync:async()=>{}});controller.update(false);
 return {nodes,context,controller,notifications};
}
const config={source:'.env',baseUrl:'https://example.invalid/wiki',email:'demo',spaceKey:'TEST',hasToken:true,missing:[],scope:{path:'doc.md',type:'file'}};

test('explorer selection becomes a scope only after explicit save; file, folder and root are supported',async t=>{
 const calls=[];const {nodes,context,controller}=setup(t,async(path,body)=>{calls.push({path,body});return {...config,scope:{path:body.scopePath,type:context.directory?'folder':'file'}};});
 context.file='';controller.update(false);assert.equal(nodes.get('sync-scope-save').disabled,true);
 context.file='/docs/doc.md';controller.update(false);assert.equal(calls.length,0);assert.match(nodes.get('sync-scope-candidate').textContent,/doc.md.*파일 하나/);
 await nodes.get('sync-scope-save').onclick();assert.deepEqual(calls.at(-1).body,{base:'/docs',envId:'',scopePath:'doc.md'});
 assert.match(nodes.get('sync-scope-saved').textContent,/doc.md/);
 context.file='/docs/nested';context.directory=true;controller.update(false);
 assert.equal(calls.length,1);assert.match(nodes.get('sync-scope-candidate').textContent,/nested.*폴더와 하위 문서/);assert.match(nodes.get('sync-scope-saved').textContent,/doc.md/);
 await nodes.get('sync-scope-save').onclick();assert.equal(calls.at(-1).body.scopePath,'nested');
 context.file='/docs';controller.update(false);await nodes.get('sync-scope-save').onclick();assert.equal(calls.at(-1).body.scopePath,'/');
 context.base='/other';controller.update(false);assert.equal(nodes.get('sync-scope-save').disabled,true);assert.doesNotMatch(nodes.get('sync-scope-saved').textContent,/nested/);
});

test('explorer scopes normalize Windows paths without accepting sibling folders',async t=>{
 const calls=[];const {nodes,context,controller}=setup(t,async(path,body)=>{calls.push(body);return config;});
 context.base='C:\\docs';context.file='C:\\docs\\nested\\doc.md';controller.update(false);
 await nodes.get('sync-scope-save').onclick();assert.equal(calls.at(-1).scopePath,'nested/doc.md');
 context.file='C:\\docs_backup\\doc.md';controller.update(false);assert.equal(nodes.get('sync-scope-save').disabled,true);
});

test('late scope save responses cannot configure a different base',async t=>{
 let finish;const {nodes,context,controller}=setup(t,()=>new Promise(resolve=>{finish=resolve}));
 const pending=nodes.get('sync-scope-save').onclick();context.base='/other';context.file='';controller.update(true);finish(config);await pending;
 assert.equal(nodes.get('sync-preview').disabled,true);assert.doesNotMatch(nodes.get('sync-scope-saved').textContent,/doc.md/);
});

test('scope save errors preserve the saved range and allow retry',async t=>{
 let fail=false;const {nodes,context,controller,notifications}=setup(t,async()=>{if(fail)throw Error('denied');return config;});
 await nodes.get('sync-load').onclick();fail=true;context.file='/docs/nested';context.directory=true;controller.update(false);
 await nodes.get('sync-scope-save').onclick();assert.match(notifications.at(-1).text,/denied/);assert.match(nodes.get('sync-scope-saved').textContent,/doc.md/);assert.equal(nodes.get('sync-scope-save').disabled,false);
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

for (const [kind,state,tone] of [['pull','succeeded','success'],['push','succeeded','success'],['preview','succeeded','warning'],['pull','failed','error']]) test(`${kind} ${state} notifies once per job and allows a new job result`,async t=>{
 let job={id:'one',kind,state,log:'',selection:{base:'/docs'},config:{...config,missing:kind==='preview'?['TOKEN']:[]}};
 const s=setup(t,async()=>({job}));
 await s.controller.resume();await s.controller.resume();
 assert.equal(s.notifications.length,1);assert.equal(s.notifications[0].kind,tone);
 job={...job,id:'two'};await s.controller.resume();assert.equal(s.notifications.length,2);
});

test('Pull with missing remote attachments shows a warning instead of an ordinary success',async t=>{
 const job={id:'warning-job',kind:'pull',state:'succeeded',warningCount:2,log:'',selection:{base:'/docs'},config};
 const s=setup(t,async()=>({job}));await s.controller.resume();
 assert.equal(s.nodes.get('sync-job-state').textContent,'완료 (경고)');assert.equal(s.notifications[0].kind,'warning');assert.match(s.notifications[0].text,/첨부 2개/);
});

function previewApi({state='succeeded',missing=[],rejectPush=false}={}) {
 let job, pushes=0;
 return {get pushes(){return pushes},api:async(path,body)=>{
  if(path.endsWith('/config'))return config;
  if(path.endsWith('/preview'))return {job:job={id:'preview-job',kind:'preview',state,log:'',planId:state==='succeeded'?'approved':null,config:{...config,missing},selection:{base:'/docs'}}};
  if(path.endsWith('/job'))return {job};
  if(path.endsWith('/push')){pushes++;if(rejectPush)throw Error('consumed');return {job:job={...job,id:'push-job',kind:'push',planId:null,state:'succeeded'}};}
  if(path.endsWith('/scope'))return {...config,scope:{path:body.scopePath,type:'file'}};
  throw Error(path);
 }};
}

test('upload requires successful preview in this session and becomes disabled after upload',async t=>{
 const mock=previewApi(),{nodes}=setup(t,mock.api);
 assert.equal(nodes.get('sync-push').disabled,true);
 await nodes.get('sync-load').onclick();assert.equal(nodes.get('sync-push').disabled,true);
 await nodes.get('sync-push').onclick();assert.equal(mock.pushes,0);
 await nodes.get('sync-preview').onclick();assert.equal(nodes.get('sync-push').disabled,false);
 await nodes.get('sync-push').onclick();assert.equal(mock.pushes,1);assert.equal(nodes.get('sync-push').disabled,true);
 await nodes.get('sync-push').onclick();assert.equal(mock.pushes,1);
});

for(const options of [{state:'failed'},{missing:['TOKEN']}])test(`failed or incomplete preview never enables upload: ${JSON.stringify(options)}`,async t=>{
 const mock=previewApi(options),{nodes}=setup(t,mock.api);await nodes.get('sync-load').onclick();await nodes.get('sync-preview').onclick();
 assert.equal(nodes.get('sync-push').disabled,true);await nodes.get('sync-push').onclick();assert.equal(mock.pushes,0);
});

test('options, scope save, configuration reload and direction changes each require another preview',async t=>{
 const mock=previewApi(),{nodes,controller}=setup(t,mock.api);await nodes.get('sync-load').onclick();
 for(const change of [async()=>{nodes.get('sync-verify').checked=!nodes.get('sync-verify').checked;controller.update(false)},async()=>{await nodes.get('sync-scope-save').onclick()},async()=>{await nodes.get('sync-load').onclick()},async()=>{nodes.get('sync-direction-pull').onclick();nodes.get('sync-direction-push').onclick()}]){
  await nodes.get('sync-preview').onclick();assert.equal(nodes.get('sync-push').disabled,false);
  await change();assert.equal(nodes.get('sync-push').disabled,true);
  await controller.resume();controller.update(false);assert.equal(nodes.get('sync-push').disabled,true);
 }
});

test('failed upload cannot revive a consumed preview through a stale job response',async t=>{
 const mock=previewApi({rejectPush:true}),{nodes,controller}=setup(t,mock.api);await nodes.get('sync-load').onclick();await nodes.get('sync-preview').onclick();
 await nodes.get('sync-push').onclick();await controller.resume();controller.update(false);
 assert.equal(nodes.get('sync-push').disabled,true);await nodes.get('sync-push').onclick();assert.equal(mock.pushes,1);
});

test('resuming a previous preview does not enable upload before a new preview',async t=>{
 const mock=previewApi(),s=setup(t,mock.api);await mock.api('/api/sync/preview');await s.nodes.get('sync-load').onclick();await s.controller.resume();s.controller.update(false);
 assert.equal(s.nodes.get('sync-push').disabled,true);
});
