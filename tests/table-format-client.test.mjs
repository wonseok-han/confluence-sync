import test from 'node:test';
import assert from 'node:assert/strict';
import {initTableFormatting} from '../src/web/client/table-format.js';

test('table editor enables only after frame load, rejects spoofed messages and saves a reviewed plan',async t=>{
 const ids=['document-preview-frame','table-edit-toggle','table-format-controls','table-review-dialog','table-format-status','table-save','table-total-width','table-equal','table-fit','table-review','table-revert','table-total-label','table-save-status','table-review-close','table-review-diff'];
 const nodes=new Map(ids.map(id=>[id,{disabled:false,hidden:false,textContent:'',open:false,setAttribute(){},showModal(){this.open=true},close(){this.open=false}}]));
 const frame=nodes.get('document-preview-frame');const sent=[];frame.contentWindow={postMessage:data=>sent.push(data)};
 const originalDocument=globalThis.document,originalWindow=globalThis.window;const handlers=[];
 globalThis.document={getElementById:id=>nodes.get(id)};globalThis.window={addEventListener:(type,listener)=>handlers.push(listener)};
 t.after(()=>{if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;});
 const calls=[];let refreshed=false;
 const api=async(path,body)=>{calls.push({path,body});return path.endsWith('/preview')?{planId:'reviewed',before:'old',after:'new'}:{saved:'/doc.md'}};
 const model=()=>({setValue(){}});const monaco={editor:{createModel:model,createDiffEditor:()=>({setModel(){},layout(){}})}};
 const editor=initTableFormatting({api,monaco,refresh:async()=>{refreshed=true},setBusy:()=>{}});
 editor.load({channel:'private',hash:'hash',tables:[{index:0,editable:true,widths:[200,560],contentWeights:[1,4]}]},{base:'/docs',file:'/docs/doc.md'});
 assert.equal(nodes.get('table-edit-toggle').disabled,true);frame.onload();assert.equal(nodes.get('table-edit-toggle').disabled,false);
 nodes.get('table-edit-toggle').onclick();
 const emit=(source,channel)=>handlers[0]({source,data:{type:'csync-table-select',channel,index:0}});
 emit({},'private');assert.equal(nodes.get('table-review').disabled,true);
 emit(frame.contentWindow,'wrong');assert.equal(nodes.get('table-review').disabled,true);
 emit(frame.contentWindow,'private');assert.equal(nodes.get('table-review').disabled,false);
 nodes.get('table-equal').onclick();assert.deepEqual(sent.at(-1).widths,[380,380]);
 nodes.get('table-fit').onclick();assert.deepEqual(sent.at(-1).widths,[176,584]);
 await nodes.get('table-review').onclick();assert.equal(nodes.get('table-review-dialog').open,true);assert.equal(nodes.get('table-save').disabled,false);
 await nodes.get('table-save').onclick();assert.equal(refreshed,true);assert.deepEqual(calls.at(-1),{path:'/api/table-format/save',body:{planId:'reviewed'}});
 editor.clear();assert.equal(nodes.get('table-edit-toggle').disabled,true);assert.equal(frame.onload,null);
});
