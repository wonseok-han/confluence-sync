import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {join} from 'node:path';
import {startHostedWeb} from '../dist/web/hosted.js';import {createBrowserWorkspace} from '../src/web/client/browser-workspace.js';import {workspace} from './helpers/fixtures.mjs';import {bindScope} from './helpers/scope.mjs';
class Dir{
 constructor(name){this.name=name;this.kind='directory';this.items=new Map();}
 async *entries(){yield* this.items.entries()}
 async getDirectoryHandle(name,{create=false}={}){if(create&&!this.items.has(name))this.items.set(name,new Dir(name));const item=this.items.get(name);if(item?.kind!=='directory')throw Object.assign(Error('not found'),{name:'NotFoundError'});return item;}
 async getFileHandle(name,{create=false}={}){if(create&&!this.items.has(name))this.put(name,'');const item=this.items.get(name);if(item?.kind!=='file')throw Object.assign(Error('not found'),{name:'NotFoundError'});return item;}
 async removeEntry(name){this.items.delete(name)}
 put(name,text){const item={name,kind:'file',bytes:new TextEncoder().encode(text),stamp:1,async getFile(){return new File([this.bytes],name,{lastModified:this.stamp})},async createWritable(){let bytes;return {write:async value=>{bytes=new Uint8Array(value)},close:async()=>{item.bytes=bytes;item.stamp++},abort:async()=>{}}}};this.items.set(name,item);return item;}
 text(name){return new TextDecoder().decode(this.items.get(name).bytes)}
 async isSameEntry(other){return this===other}async resolve(other){return this===other?[]:null}async queryPermission(){return 'granted'}async requestPermission(){return 'granted'}
}
function browser(app,pickers,options={}){
 const ids=['browser-folder-dialog','browser-folder-status','browser-folder-open','browser-folder-resume','browser-apply-dialog','browser-apply-status','browser-apply-retry','workspace-interface','local-disconnect','local-connection-status','root-path-editor','out-input','open'];const nodes=new Map(ids.map(id=>[id,{hidden:false,disabled:false,open:false,value:'',shown:0,showModal(){this.shown++;this.open=true},close(){this.open=false},addEventListener(){}}]));const values=options.values??new Map(),states=options.states??new Map(),calls=[],optionsHook=options.afterFetch;
 const storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},location={reload(){this.reloaded=true}};
 const api=createBrowserWorkspace({document:{getElementById:id=>nodes.get(id)},window:{isSecureContext:true,showDirectoryPicker(){},addEventListener(){}},location,storage,remember:async(value,key)=>{if(value===undefined)return states.get(key);if(value===null)states.delete(key);else states.set(key,value)},pickDirectory:async()=>pickers.shift(),fetch:async(path,options)=>{calls.push(path);const response=await fetch(app.url+path,options);await optionsHook?.(path,options,response);return response;}});
 return {api,nodes,location,states,calls,async choose(){await new Promise(r=>setImmediate(r));await nodes.get('browser-folder-open').onclick();await api.ready;},async request(path,body){const response=await api.request(path,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}};
}
test('browser controller uploads a selected folder, converts through the shared server and writes only into the selected output folder',async t=>{
 const app=await startHostedWeb({port:0,host:'127.0.0.1'});t.after(()=>app.close());const source=new Dir('docs'),out=new Dir('result');source.put('a.md','# A\n\n[[b]]');const nested=await source.getDirectoryHandle('sub',{create:true});nested.put('b.md','# B');const b=browser(app,[source,out]);await b.choose();const listing=await b.request('/api/browse');assert.equal(listing.path,'/workspace/docs');
 const error=await b.api.request('/api/convert',{body:JSON.stringify({base:'/workspace/docs',file:'/workspace/docs',scope:'folder',to:'markdown',fix:false,preview:false})});assert.equal(error.status,400);assert.match((await error.json()).error,/출력 폴더/);
 await b.request('/api/pick-folder',{kind:'out'});const result=await b.request('/api/convert',{base:'/workspace/docs',file:'/workspace/docs',out:'/output',scope:'folder',to:'markdown',fix:false,preview:false});assert.equal(result.documentCount,2);assert.equal(out.text('a.md'),'# A\n\n[b](sub/b.md)');assert.equal((await out.getDirectoryHandle('sub')).text('b.md'),'# B');assert.equal(source.text('a.md'),'# A\n\n[[b]]');assert.equal((await b.request('/api/browser/changes')).files.length,0);
});
test('browser table editing applies a changed source back to the chosen directory and disconnect clears its workspace',async t=>{
 const app=await startHostedWeb({port:0,host:'127.0.0.1'});t.after(()=>app.close());const source=new Dir('docs');source.put('a.md','| A | B |\n|---|---|\n| 1 | 2 |');const b=browser(app,[source]);await b.choose();const doc=await b.request('/api/document-preview',{base:'/workspace/docs',file:'/workspace/docs/a.md'});const preview=await b.request('/api/table-format/preview',{base:'/workspace/docs',file:'/workspace/docs/a.md',hash:doc.hash,index:0,widths:[200,560]});await b.request('/api/table-format/save',{planId:preview.planId});assert.match(source.text('a.md'),/width: 760px/);await b.nodes.get('local-disconnect').onclick();assert.equal(b.location.reloaded,true);assert.equal(b.states.size,0);
});
test('browser refreshes edited output before saving and preserves the existing overwrite confirmation',async t=>{
 const app=await startHostedWeb({port:0,host:'127.0.0.1'});t.after(()=>app.close());const source=new Dir('docs'),out=new Dir('result');source.put('a.md','# A');out.put('a.md','old');const b=browser(app,[source,out]);await b.choose();await b.request('/api/pick-folder',{kind:'out'});
 const pending=await b.request('/api/convert',{base:'/workspace/docs',file:'/workspace/docs/a.md',out:'/output',scope:'file',to:'markdown',fix:false,preview:true});assert.equal(pending.documentCount,1);
 out.items.get('a.md').bytes=new TextEncoder().encode('user edit');out.items.get('a.md').stamp++;
 const refused=await b.api.request('/api/convert',{body:JSON.stringify({base:'/workspace/docs',file:'/workspace/docs/a.md',out:'/output',scope:'file',to:'markdown',fix:false,preview:false})});assert.equal(refused.status,409);assert.equal(out.text('a.md'),'user edit');
});
test('separate browser tabs retain independent folder handles and session baselines',async t=>{
 const app=await startHostedWeb({port:0,host:'127.0.0.1'});t.after(()=>app.close());const states=new Map(),a=new Dir('alpha'),b=new Dir('beta');a.put('a.md','A');b.put('b.md','B');const first=browser(app,[a],{states}),second=browser(app,[b],{states});await first.choose();await second.choose();assert.equal(states.size,2);assert.equal((await first.request('/api/browse')).entries[0].name,'a.md');assert.equal((await second.request('/api/browse')).entries[0].name,'b.md');
});

test('the browser adapter sends env and sync requests to its own session and uses the shared CLI runner',async t=>{
 const calls=[];const app=await startHostedWeb({port:0,host:'127.0.0.1',syncRunner:async(args,env,log)=>{calls.push({args,env});log('browser-secret');return 0}});t.after(()=>app.close());const {root}=workspace(t,{});bindScope(root,{connection:{baseUrl:'https://team.atlassian.net/wiki'}});const source=new Dir('docs');source.put('a.md','# A');const meta=await source.getDirectoryHandle('.csync',{create:true});meta.put('workspace.json',readFileSync(join(root,'.csync/workspace.json'),'utf8'));source.put('.env','CONFLUENCE_BASE_URL=https://team.atlassian.net/wiki\nCONFLUENCE_EMAIL=demo@example.invalid\nCONFLUENCE_API_TOKEN=browser-secret\nCONFLUENCE_SPACE_KEY=TEST\n');
 const b=browser(app,[source]);await b.choose();const config=await b.request('/api/sync/config',{base:'/workspace/docs',envId:''});assert.equal(config.connected,true);await b.request('/api/sync/fetch',{base:'/workspace/docs',envId:''});let job;for(let i=0;i<20;i++){job=(await b.request('/api/sync/job')).job;if(job.state!=='running')break;await new Promise(r=>setTimeout(r,5));}assert.equal(job.state,'succeeded');assert.equal(calls.length,1);assert.equal(calls[0].args[0],'fetch');assert.equal(calls[0].env.CONFLUENCE_API_TOKEN,'browser-secret');assert.doesNotMatch(job.log,/browser-secret/);assert.match(source.text('.env'),/browser-secret/);
});

test('denied browser write permission prevents any files from being sent',async t=>{
 const app=await startHostedWeb({port:0,host:'127.0.0.1'});t.after(()=>app.close());const source=new Dir('docs');source.put('a.md','Private');source.queryPermission=async()=> 'prompt';source.requestPermission=async()=> 'denied';const b=browser(app,[source]);await new Promise(r=>setImmediate(r));await b.nodes.get('browser-folder-open').onclick();assert.match(b.nodes.get('browser-folder-status').textContent,/권한/);assert.equal(b.calls.length,0);assert.equal(b.nodes.get('workspace-interface').inert,true);
});

test('browser in-place repair confirms originals and saves without a separate output mount', async t => {
 const app=await startHostedWeb({port:0,host:'127.0.0.1'});t.after(()=>app.close());
 const source=new Dir('docs');source.put('a.md','# 한글\\_제목');const b=browser(app,[source]);await b.choose();
 const body={base:'/workspace/docs',file:'/workspace/docs',out:'/workspace/docs',scope:'folder',to:'repair',fix:false,preview:false};
 const first=await b.api.request('/api/convert',{body:JSON.stringify(body)});assert.equal(first.status,409);
 const pending=await first.json();assert.equal(pending.inPlace,true);assert.equal(source.text('a.md'),'# 한글\\_제목');
 const approvedOverwrites=Object.fromEntries(pending.conflicts.map(item=>[item.path,item.hash]));
 const result=await b.request('/api/convert',{...body,approvedOverwrites});assert.equal(result.inPlace,true);
 assert.equal(source.text('a.md'),'# 한글_제목');assert.equal((await b.request('/api/browser/changes')).files.length,0);
});


test('folder selection and background browsing never overlap mirror transactions',async t=>{
 const app=await startHostedWeb({port:0,host:'127.0.0.1'});t.after(()=>app.close());
 const source=new Dir('docs'),out=new Dir('result');source.put('a.md','old');out.put('b.md','output');
 let hold=false,entered,release;const started=new Promise(resolve=>{entered=resolve});
 const b=browser(app,[source,out],{afterFetch:async path=>{if(hold&&path==='/api/browser/mirror'){hold=false;entered();await new Promise(resolve=>{release=resolve});}}});
 await b.choose();source.put('a.md','changed');hold=true;
 const picked=b.api.request('/api/pick-folder',{body:JSON.stringify({kind:'out'})});await started;
 const browsing=b.api.request('/api/browse');
 const timer=setTimeout(()=>release(),100);browsing.finally(()=>release());
 const responses=await Promise.all([picked,browsing]);clearTimeout(timer);
 for(const response of responses)assert.equal(response.status,200,JSON.stringify(await response.json()));
});


test('refresh silently restores a saved folder without opening the picker dialog', {timeout:2000},async t=>{
 const app=await startHostedWeb({port:0,host:'127.0.0.1'});t.after(()=>app.close());
 const source=new Dir('docs');source.put('a.md','# Saved');const states=new Map(),values=new Map();
 const initial=browser(app,[source],{states,values});await initial.choose();
 const restored=browser(app,[],{states,values});assert.equal(restored.nodes.get('browser-folder-dialog').open,false);
 await restored.api.ready;assert.equal(restored.nodes.get('browser-folder-dialog').shown,0);assert.equal(restored.nodes.get('workspace-interface').inert,false);
 assert.equal((await restored.request('/api/browse')).entries[0].name,'a.md');
});

test('revoked folder permission offers the saved handle instead of requiring another picker', {timeout:2000},async t=>{
 const app=await startHostedWeb({port:0,host:'127.0.0.1'});t.after(()=>app.close());
 const source=new Dir('docs');source.put('a.md','# Saved');const states=new Map(),values=new Map();
 const initial=browser(app,[source],{states,values});await initial.choose();
 let permission='prompt',grants=0;source.queryPermission=async()=>permission;source.requestPermission=async()=>{grants++;return permission='granted'};
 const restored=browser(app,[],{states,values});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(restored.nodes.get('browser-folder-dialog').open,true);assert.equal(restored.nodes.get('browser-folder-resume').hidden,false);assert.equal(grants,0);
 await restored.nodes.get('browser-folder-resume').onclick();await restored.api.ready;
 assert.equal(grants,1);assert.equal(restored.nodes.get('browser-folder-dialog').open,false);assert.equal(restored.nodes.get('workspace-interface').inert,false);
});
