import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../src/web/client/app.js',import.meta.url),'utf8');
const preferences=source.slice(source.indexOf('const explorerState ='),source.indexOf('function loadPreferences()'));
const handler=source.slice(source.indexOf('async function pickFolder(kind)'),source.indexOf("$('choose-base').onclick"));
function fixture({browser=true,cancel=false}={}) {
 const nodes=new Map(['base-input','out-input','sync-references','direction','fix','sync-verify','sync-pull-format','side-by-side'].map(id=>[id,{value:'/workspace/old/selected',dataset:{path:'/workspace/old/selected'}}]));
 const calls=[],saved=[];
 const ctx={connection:{browser,folderName:path=>path==='/workspace/new'?'선택한 출력 폴더':''},busy:false,base:'/workspace/old',folder:'/workspace/old/sub',file:'/workspace/old/sub/a.md',parent:'/workspace/old',selectedDirectory:true,
  mode:'sync',restoring:false,convertKind:'file',navigation:0,entries:[{name:'old.md'}],treeCache:new Map(),expanded:new Set(['/workspace/old']),treeLoading:new Set(),workspaces:{convert:{base:'/workspace/old'},sync:{base:'/workspace/old'}},
  $:id=>nodes.get(id),controls(){},render(){},status:()=>{},clearSearch(){},reset(){calls.push('reset');},
  api:async()=>cancel?{}:{path:'/workspace/new'},browse:async(...args)=>{calls.push(['browse',...args]);},
  localStorage:{setItem(key,value){assert.equal(key,'csync.workspace.v1');saved.push(JSON.parse(value));calls.push('save');}},
  location:{reload(){calls.push('reload');}},
 };
 runInNewContext(preferences+handler+'\nglobalThis.pick=pickFolder;',ctx);
 return {ctx,nodes,calls,saved};
}

test('browser base change saves only the new workspace before reloading, without browsing an obsolete session',async()=>{
 const s=fixture();await s.ctx.pick('base');
 assert.deepEqual(s.calls,['save','reload']);assert.equal(s.ctx.busy,false);
 assert.deepEqual(s.saved[0].workspaces,{convert:{base:'/workspace/old'},sync:{base:'/workspace/new',folder:'/workspace/new',file:null,selectedDirectory:false,baseInput:'/workspace/new',expanded:[]}});
 assert.equal(s.saved[0].out,'/workspace/old/selected');assert.equal(s.saved[0].referenceRoots,'');
 assert.equal(s.ctx.selectedDirectory,false);assert.equal(s.ctx.treeCache.size,0);assert.equal(s.ctx.entries.length,0);
});

test('native base changes and browser output choices keep the existing flow',async()=>{
 const native=fixture({browser:false});await native.ctx.pick('base');assert.deepEqual(native.calls,[['browse','/workspace/new',true]]);
 const output=fixture();await output.ctx.pick('out');assert.deepEqual(output.calls,['reset']);assert.equal(output.nodes.get('out-input').value,'선택한 출력 폴더');assert.equal(output.nodes.get('out-input').dataset.path,'/workspace/new');
});

test('cancelled selection keeps both explorers and mount preferences intact',async()=>{
 const cancelled=fixture({cancel:true});await cancelled.ctx.pick('base');
 assert.equal(cancelled.ctx.base,'/workspace/old');assert.equal(cancelled.nodes.get('out-input').value,'/workspace/old/selected');assert.deepEqual(cancelled.calls,[]);
});


test('browser output labels stay separate from persisted virtual paths, while native paths remain editable',async()=>{
 const browser=fixture();await browser.ctx.pick('out');browser.ctx.savePreferences();
 assert.equal(browser.nodes.get('out-input').value,'선택한 출력 폴더');assert.equal(browser.saved[0].out,'/workspace/new');
 const native=fixture({browser:false});await native.ctx.pick('out');native.ctx.savePreferences();
 assert.equal(native.nodes.get('out-input').value,'/workspace/new');assert.equal(native.saved[0].out,'/workspace/new');
});

test('changing the conversion base keeps the Confluence explorer and reference folders',async()=>{
 const s=fixture();s.ctx.mode='convert';await s.ctx.pick('base');
 assert.deepEqual(s.saved[0].workspaces.sync,{base:'/workspace/old'});assert.equal(s.saved[0].workspaces.convert.base,'/workspace/new');
 assert.equal(s.saved[0].referenceRoots,'/workspace/old/selected');assert.equal(s.saved[0].out,'');
});

for(const browser of [false,true])test(`switching workflow restores its own explorer: browser=${browser}`,async()=>{
 const s=fixture({browser}),show=source.slice(source.indexOf('async function showMode(next)'),source.indexOf("for (const name of ['convert', 'sync']) {",source.indexOf('async function showMode(next)')));
 s.ctx.workspaces.convert={base:'/workspace/convert-root'};
 s.ctx.loadPreferences=()=>s.saved.at(-1);s.ctx.displayMode=next=>{s.ctx.mode=next;};s.ctx.restoreExplorer=async saved=>{s.calls.push(['restore',saved.base]);};
 runInNewContext(show+'\nglobalThis.switchMode=showMode;',s.ctx);await s.ctx.switchMode('convert');
 if(browser){assert.equal(s.saved.at(-1).mode,'convert');assert.equal(s.saved.at(-1).workspaces.sync.base,'/workspace/old');assert.equal(s.saved.at(-1).workspaces.convert.base,'/workspace/convert-root');assert.equal(s.calls.at(-1),'reload');}
 else{assert.ok(s.calls.some(call=>Array.isArray(call)&&call[0]==='restore'&&call[1]==='/workspace/convert-root'));assert.ok(!s.calls.includes('reload'));}
});
