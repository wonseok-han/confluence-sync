import test from 'node:test';
import assert from 'node:assert/strict';
import { initSync } from '../src/web/client/sync.js';

function setup(t, api, activity) {
 const ids=['sync-pull-format','sync-pull-format-help','sync-log-download','sync-view','sync-restore-dialog','sync-restore-title','sync-restore-path','sync-restore-warning','sync-restore-confirm','sync-restore-cancel','sync-stage-heading','sync-pull-remote','sync-diff-close','sync-diff-dialog','sync-diff-remote','sync-diff-path','sync-diff-note','sync-diff-editor','sync-diff-labels','sync-env-toggle','sync-env-body','sync-env-chevron','sync-env-toggle-label','sync-stage-list','sync-stage-count','sync-stage-scan','sync-stage-add','sync-stage-remove','sync-stage-note','sync-results','sync-fetch','sync-job-summary','sync-log','sync-job-state','sync-log-empty','sync-push-options','sync-status','sync-env-base-mode','sync-env-import-mode','sync-env-import-controls','sync-env-file','sync-env-file-name','sync-env-source-note','sync-env-choose','sync-env-save','sync-env-confirm','sync-env-confirm-save','sync-env-confirm-cancel','sync-verify','sync-references','sync-config','sync-config-status','sync-scope-save','sync-scope-saved','sync-scope-candidate','sync-load','sync-connect','sync-add-reference','sync-preview','sync-push','sync-target','sync-reconnect'];
 const node=()=>({querySelectorAll(){return []},scrollIntoView(){this.scrolled=true},disabled:false,hidden:false,open:false,showModal(){this.open=true},close(){this.open=false},value:'',checked:false,textContent:'',children:[],attributes:{},getAttribute(key){return this.attributes[key]},setAttribute(key,value){this.attributes[key]=value},classList:{toggle(){}},addEventListener(){},append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items;this.value=items[0]?.value??''}});
 const nodes=new Map(ids.map(id=>[id,node()]));nodes.get('sync-env-base-mode').checked=true;
 const oldDocument=globalThis.document,oldOption=globalThis.Option;
 globalThis.document={getElementById:id=>nodes.get(id),createElement:node,createDocumentFragment:node};globalThis.Option=function(text,value){this.textContent=text;this.value=value;};
 t.after(()=>{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;if(oldOption===undefined)delete globalThis.Option;else globalThis.Option=oldOption;});
 const context={base:'/docs',file:'/docs/doc.md',folder:'/docs'};
 const notifications=[];
 let controller;const busy=value=>controller.update(value);
 controller=initSync({api,activity,notify:(text,kind)=>notifications.push({text,kind}),context:()=>context,setBusy:busy,showSync:async()=>{}});controller.update(false);
 return {nodes,context,controller,notifications};
}
const config={source:'.env',baseUrl:'https://example.invalid/wiki',email:'demo',spaceKey:'TEST',hasToken:true,missing:[],connected:true};

test('workspace connection is explicit and independent of explorer selection',async t=>{
 const calls=[];const {nodes,context,controller}=setup(t,async(path,body)=>{calls.push({path,body});return path.endsWith('/config')?{...config,connected:false}:config;});
 await nodes.get('sync-load').onclick();assert.equal(nodes.get('sync-connect').disabled,false);assert.equal(nodes.get('sync-fetch').disabled,true);
 context.file='/docs/nested/doc.md';controller.update(false);assert.equal(calls.length,1);
 await nodes.get('sync-connect').onclick();assert.deepEqual(calls.at(-1),{path:'/api/sync/connect',body:{base:'/docs',envId:''}});assert.equal(nodes.get('sync-connect').disabled,true);assert.equal(nodes.get('sync-fetch').disabled,false);
});

test('late connection responses cannot configure a different base',async t=>{
 let finish;const {nodes,context,controller}=setup(t,(path)=>path.endsWith('/config')?Promise.resolve({...config,connected:false}):new Promise(resolve=>{finish=resolve}));
 await nodes.get('sync-load').onclick();const pending=nodes.get('sync-connect').onclick();context.base='/other';controller.update(true);finish(config);await pending;
 assert.equal(nodes.get('sync-fetch').disabled,true);assert.equal(nodes.get('sync-preview').disabled,true);
});

test('upload and initial full import are available together without direction switching',async t=>{
 const {nodes,context,controller}=setup(t,async()=>config);
 context.file='';await nodes.get('sync-load').onclick();controller.update(false);
 assert.equal(nodes.get('sync-preview').disabled,true);assert.equal(nodes.get('sync-fetch').disabled,false);
 assert.equal(nodes.get('sync-push').disabled,true);
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
 assert.equal(s.nodes.get('sync-job-state').textContent,'완료 (경고)');assert.equal(s.nodes.get('sync-job-state').getAttribute('data-state'),'warning');assert.equal(s.notifications[0].kind,'warning');assert.match(s.notifications[0].text,/첨부 2개/);
});

function previewApi({state='succeeded',missing=[],rejectPush=false}={}) {
 let job, pushes=0;
 return {get pushes(){return pushes},api:async(path,body)=>{
  if(path.endsWith('/config'))return config;
  if(path.endsWith('/preview'))return {job:job={id:'preview-job',kind:'preview',state,log:'',planId:state==='succeeded'?'approved':null,config:{...config,missing},selection:{base:'/docs'}}};
  if(path.endsWith('/job'))return {job};
  if(path.endsWith('/push')){pushes++;if(rejectPush)throw Error('consumed');return {job:job={...job,id:'push-job',kind:'push',planId:null,state:'succeeded'}};}
  if(path.endsWith('/connect'))return config;
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

test('option and connection changes each require another preview',async t=>{
 const mock=previewApi(),{nodes,controller}=setup(t,mock.api);await nodes.get('sync-load').onclick();
 for(const change of [async()=>{nodes.get('sync-verify').checked=!nodes.get('sync-verify').checked;controller.update(false)},async()=>{await nodes.get('sync-load').onclick()}]){
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

test('Fetch is explicit beside changes and cannot enable upload',async t=>{
 const calls=[];let job;const s=setup(t,async(path,body)=>{
  calls.push({path,body});if(path.endsWith('/staging'))return {rows:[]};if(path.endsWith('/config'))return config;
  if(path.endsWith('/fetch'))return {job:job={id:'fetch-one',kind:'fetch',state:'succeeded',log:'원격 변경 1',config,selection:{base:'/docs'},planId:null}};
  if(path.endsWith('/job'))return {job};throw Error(path);
 });
 assert.equal(s.nodes.get('sync-fetch').disabled,true);await s.nodes.get('sync-load').onclick();assert.equal(s.nodes.get('sync-fetch').disabled,false);
 assert.equal(calls.some(call=>call.path.endsWith('/fetch')),false);
 await s.nodes.get('sync-fetch').onclick();
 assert.deepEqual(calls.find(call=>call.path.endsWith('/fetch')).body,{base:'/docs',envId:''});
 assert.equal(s.nodes.get('sync-stage-heading').scrolled,true);assert.match(s.nodes.get('sync-job-summary').textContent,/원격 변경 확인/);assert.match(s.notifications.at(-1).text,/동기화 기준은 유지/);assert.equal(s.nodes.get('sync-push').disabled,true);
});

test('workspace has no separate initial or whole-space import control',async()=>{
 const {syncPanel}=await import('../dist/web/views/sync-panel.js');assert.doesNotMatch(syncPanel,/id="sync-pull"|최초 다운로드|스페이스 전체 가져오기|sync-direction/);assert.match(syncPanel,/id="sync-pull-remote"/);
});

function activitySpy(){const tasks=[];return {tasks,begin(options){const task={options,updates:[],ended:false,update(value){this.updates.push(value)},end(){this.ended=true}};tasks.push(task);return task}};}

test('job loading survives POST and running polls, and ends only after result refresh',async t=>{
 const timers=[];t.mock.method(globalThis,'setTimeout',fn=>{timers.push(fn);return fn});t.mock.method(globalThis,'clearTimeout',()=>{});
 const activity=activitySpy();let state='running';const calls=[];
 const job=()=>({id:'loading-job',kind:'fetch',state,startedAt:'2026-10-27T00:00:00Z',config,selection:{base:'/docs'},log:'페이지 메타데이터 확인'});
 const s=setup(t,async(path,body,_signal,options)=>{calls.push({path,options});if(path.endsWith('/config'))return config;if(path.endsWith('/staging')){assert.equal(activity.tasks[0].ended,false);return {rows:[]};}return {job:job()};},activity);
 await s.nodes.get('sync-load').onclick();await s.nodes.get('sync-fetch').onclick();assert.equal(activity.tasks.length,1);assert.equal(activity.tasks[0].ended,false);assert.equal(s.nodes.get('sync-fetch').disabled,true);assert.equal(activity.tasks[0].updates.at(-1).startedAt,'2026-10-27T00:00:00Z');
 state='succeeded';await timers.shift()();assert.equal(activity.tasks[0].ended,true);assert.equal(s.nodes.get('sync-fetch').disabled,false);assert.equal(calls.find(c=>c.path.endsWith('/staging')).options.background,true);
});

test('polling failure retains uncertain loading and retry completes the same operation',async t=>{
 const activity=activitySpy();let fail=true;const job={id:'retry-job',kind:'fetch',state:'running',config,selection:{base:'/docs'},log:''};
 const s=setup(t,async(path)=>{if(path.endsWith('/config'))return config;if(path.endsWith('/job')){if(fail)throw Error('offline');return {job:{...job,state:'succeeded'}};}if(path.endsWith('/staging'))return {rows:[]};return {job};},activity);
 await s.nodes.get('sync-load').onclick();await s.nodes.get('sync-fetch').onclick();assert.equal(activity.tasks[0].ended,false);assert.equal(activity.tasks[0].updates.at(-1).uncertain,true);assert.equal(s.nodes.get('sync-reconnect').hidden,false);assert.equal(s.nodes.get('sync-fetch').disabled,true);
 fail=false;await s.nodes.get('sync-reconnect').onclick();assert.equal(activity.tasks[0].ended,true);assert.equal(s.nodes.get('sync-fetch').disabled,false);
});

test('single Pull button submits the same request for all workspace states',async t=>{
 const timers=[];t.mock.method(globalThis,'setTimeout',fn=>{timers.push(fn);return fn});t.mock.method(globalThis,'clearTimeout',()=>{});const calls=[];let job;
 const s=setup(t,async(path,body)=>{calls.push({path,body});if(path.endsWith('/config'))return config;if(path.endsWith('/staging'))return {rows:[{path:'incoming.md',pageId:'123',status:'same',staged:false,stale:false,remoteState:'changed'}]};if(path.endsWith('/pull'))return {job:job={id:'incoming-job',kind:'pull',state:'succeeded',config,selection:{base:'/docs'},log:''}};return {job}});
 await s.nodes.get('sync-load').onclick();assert.equal(s.nodes.get('sync-pull-remote').disabled,true);const stop=s.controller.watch();await timers.shift()();assert.equal(s.nodes.get('sync-pull-remote').disabled,false);assert.match(s.nodes.get('sync-pull-remote').textContent,/1개/);
 await s.nodes.get('sync-pull-remote').onclick();assert.deepEqual(calls.findLast(call=>call.path.endsWith('/pull')).body,{base:'/docs',envId:'',remoteOnly:true,format:'markdown'});
 s.nodes.get('sync-pull-format').value='obsidian';s.nodes.get('sync-pull-format').onchange();assert.match(s.nodes.get('sync-pull-format-help').textContent,/위키링크|\[\[/);await s.nodes.get('sync-pull-remote').onclick();assert.equal(calls.findLast(call=>call.path.endsWith('/pull')).body.format,'obsidian');s.controller.update(true);assert.equal(s.nodes.get('sync-pull-format').disabled,true);stop();
});

test('log download is disabled without output and exports a local snapshot without another API request',async t=>{
 const calls=[];const job={id:'download-job',kind:'pull',state:'failed',startedAt:'2026-10-28T00:00:00Z',config,selection:{base:'/docs'},log:'Failed attachment: [비공개]\n'};const s=setup(t,async path=>{calls.push(path);return {job}});assert.equal(s.nodes.get('sync-log-download').disabled,true);assert.equal(s.nodes.get('sync-job-state').hidden,true);await s.controller.resume();assert.equal(s.nodes.get('sync-log-download').disabled,false);assert.equal(s.nodes.get('sync-job-state').hidden,false);assert.equal(s.nodes.get('sync-job-state').getAttribute('data-state'),'failed');const priorCalls=calls.length,blobs=[];const original=document.createElement;document.body={append(){}};t.mock.method(document,'createElement',type=>type==='a'?{click(){this.clicked=true},remove(){}}:original(type));t.mock.method(URL,'createObjectURL',blob=>{blobs.push(blob);return 'blob:log'});t.mock.method(URL,'revokeObjectURL',()=>{});t.mock.method(globalThis,'setTimeout',()=>1);
 await s.nodes.get('sync-log-download').onclick();assert.equal(calls.length,priorCalls);assert.match(await blobs[0].text(),/Failed attachment: \[비공개\]/);assert.equal(s.notifications.at(-1).kind,'success');assert.equal(s.nodes.get('sync-push').disabled,true);
});

test('successful Pull with a failed follow-up Fetch shows a distinct warning',async t=>{
 const job={id:'post-fetch-failed',kind:'pull',state:'succeeded',refreshFailed:true,config,selection:{base:'/docs'},log:'[후속 Fetch 실패] Offline'};
 const s=setup(t,async()=>({job}));await s.controller.resume();assert.equal(s.nodes.get('sync-job-state').textContent,'완료 (경고)');assert.match(s.notifications.at(-1).text,/가져오기는 완료했지만 후속 Fetch에 실패/);assert.equal(s.notifications.at(-1).kind,'warning');
});
