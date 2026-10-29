import test from 'node:test';
import assert from 'node:assert/strict';
import {initTableFormatting} from '../src/web/client/table-format.js';

test('grouped document toolbar reviews manual and bulk table edits together with basic formatting',async t=>{
 const ids=['format-summary','table-revert-all','document-format-toggle','document-format-controls','document-format-review','document-format-basic','document-format-tables','table-review-title','format-review-note','document-preview-frame','table-edit-toggle','table-format-controls','table-review-dialog','table-format-status','table-save','table-total-width','table-equal','table-fit','table-revert','table-total-label','table-save-status','table-review-close','table-review-diff'];
 const nodes=new Map(ids.map(id=>[id,{disabled:false,hidden:false,textContent:'',open:false,lastChild:{textContent:''},attrs:{},setAttribute(k,v){this.attrs[k]=v},showModal(){this.open=true},close(){this.open=false}}]));
 const frame=nodes.get('document-preview-frame'),sent=[];frame.contentWindow={postMessage:data=>sent.push(data)};
 const originalDocument=globalThis.document,originalWindow=globalThis.window,handlers=[];
 globalThis.document={getElementById:id=>nodes.get(id)};globalThis.window={addEventListener:(type,listener)=>handlers.push(listener)};
 t.after(()=>{globalThis.document=originalDocument;globalThis.window=originalWindow;});
 const calls=[];let refreshed=false;
 const api=async(path,body)=>{calls.push({path,body});return path.endsWith('/preview')?{planId:'reviewed',before:'old',after:'new'}:{saved:'/doc.md'}};
 const monaco={editor:{createModel:()=>({setValue(){}}),createDiffEditor:()=>({setModel(){},layout(){}})}};
 const editor=initTableFormatting({api,monaco,refresh:async()=>{refreshed=true},setBusy:()=>{}});
 editor.load({channel:'private',hash:'hash',tables:[{index:0,editable:true,widths:[200,560],contentWeights:[1,4]},{index:1,editable:true,widths:[100,500],contentWeights:[1,3]}]},{base:'/docs',file:'/docs/doc.md'});
 assert.equal(nodes.get('table-edit-toggle').disabled,true);frame.onload();assert.equal(nodes.get('document-format-review').disabled,true);assert.equal(nodes.get('document-format-basic').disabled,false);
 nodes.get('document-format-toggle').onclick();assert.equal(nodes.get('document-format-controls').hidden,false);nodes.get('table-edit-toggle').onclick();
 const emit=(source,channel)=>handlers[0]({source,data:{type:'csync-table-select',channel,index:0}});
 emit({},'private');assert.equal(nodes.get('table-fit').disabled,true);emit(frame.contentWindow,'wrong');assert.equal(nodes.get('table-fit').disabled,true);emit(frame.contentWindow,'private');assert.equal(nodes.get('table-fit').disabled,false);
 nodes.get('table-fit').onclick();assert.deepEqual(sent.at(-1).widths,[176,584]);
 await nodes.get('document-format-basic').onclick();assert.equal(calls.at(-1).path,'/api/document-format/preview');assert.equal(calls.at(-1).body.basic,true);assert.deepEqual(calls.at(-1).body.changes,[{index:0,widths:[176,584]}]);
 nodes.get('table-review-close').onclick();nodes.get('document-format-tables').value='equal';nodes.get('document-format-tables').onchange();
 await nodes.get('document-format-review').onclick();assert.equal(calls.at(-1).body.basic,false);assert.deepEqual(calls.at(-1).body.changes,[{index:0,widths:[380,380]},{index:1,widths:[300,300]}]);
 assert.equal(nodes.get('table-review-title').textContent,'문서 서식 변경 확인');await nodes.get('table-save').onclick();assert.equal(refreshed,true);assert.equal(calls.at(-1).path,'/api/table-format/save');
 nodes.get('table-revert-all').onclick();assert.equal(nodes.get('document-format-tables').value,'keep');assert.equal(nodes.get('table-revert-all').disabled,true);
 nodes.get('document-format-toggle').onclick();assert.equal(nodes.get('table-edit-toggle').attrs['aria-pressed'],'false');assert.equal(nodes.get('document-format-controls').hidden,true);
 editor.clear();assert.equal(nodes.get('document-format-review').disabled,true);assert.equal(frame.onload,null);
});
