import test from 'node:test';
import assert from 'node:assert/strict';
import { initSnackbars } from '../src/web/client/snackbar.js';

test('error snackbars persist, deduplicate visible failures, render text safely and close individually', t => {
 const node=()=>({children:[],attributes:{},setAttribute(k,v){this.attributes[k]=v},append(...items){for(const item of items){item.parent=this;this.children.push(item)}},remove(){this.parent.children=this.parent.children.filter(item=>item!==this)}});
 const region=node(), old=globalThis.document;
 globalThis.document={getElementById:()=>region,createElement:node};t.after(()=>{globalThis.document=old});
 const notify=initSnackbars();
 // A timeout would violate the manual-dismiss-only contract.
 t.mock.method(globalThis,'setTimeout',()=>assert.fail('snackbars must not auto-dismiss'));
 notify('<img src=x onerror=bad()>','error');notify('<img src=x onerror=bad()>','error');notify('Another failure','error');
 assert.equal(region.children.length,2);
 const first=region.children[0];assert.equal(first.attributes.role,'alert');assert.equal(first.children[1].children[1].textContent,'<img src=x onerror=bad()>');
 first.children[2].onclick();assert.equal(region.children.length,1);assert.equal(region.children[0].children[1].children[1].textContent,'Another failure');
 notify('<img src=x onerror=bad()>','error');assert.equal(region.children.length,2);
 for(const kind of ['success','warning','info']) { notify('Result',kind); const card=region.children.at(-1); assert.equal(card.className,'snackbar snackbar-'+kind); assert.equal(card.attributes.role,kind==='warning'?'alert':'status'); card.children[2].onclick(); }
 assert.equal(region.children.length,2);
});
