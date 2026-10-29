import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverwriteDialog } from '../src/web/client/overwrite-dialog.js';
function setup() {
 const nodes = new Map(['overwrite-dialog','overwrite-title','overwrite-path','overwrite-warning','overwrite-files','overwrite-cancel','overwrite-confirm'].map(id => [id, { open:false, listeners:{}, textContent:'', addEventListener(name,fn){this.listeners[name]=fn;}, showModal(){this.open=true;}, close(){this.open=false;this.listeners.close?.();}, focus(){this.focused=true;}, replaceChildren(...items){this.items=items;} }]));
 const ask = createOverwriteDialog({getElementById:id=>nodes.get(id),createElement:()=>({textContent:''})});
 return {nodes,ask};
}
const input={inPlace:true,output:'/docs',conflicts:[{path:'a.md'},{path:'<img onerror=alert(1)>.md'}]};
test('overwrite dialog lists paths as text and waits for explicit approval', async()=>{
 const {nodes,ask}=setup();let done=false;const promise=ask(input).then(value=>{done=true;return value;});await Promise.resolve();assert.equal(done,false);assert.equal(nodes.get('overwrite-dialog').open,true);assert.equal(nodes.get('overwrite-cancel').focused,true);assert.deepEqual(nodes.get('overwrite-files').items.map(i=>i.textContent),input.conflicts.map(i=>i.path));assert.match(nodes.get('overwrite-warning').textContent,/원본이 바뀌면/);
 nodes.get('overwrite-confirm').onclick();assert.equal(await promise,true);assert.equal(nodes.get('overwrite-dialog').open,false);
});
for(const action of ['cancel','escape','close'])test(`overwrite ${action} never approves and allows retry`,async()=>{
 const {nodes,ask}=setup();const promise=ask(input),dialog=nodes.get('overwrite-dialog');
 if(action==='cancel')nodes.get('overwrite-cancel').onclick();else if(action==='escape')dialog.listeners.cancel({preventDefault(){}});else dialog.close();
 assert.equal(await promise,false);const retry=ask({...input,inPlace:false});nodes.get('overwrite-confirm').onclick();assert.equal(await retry,true);
});
