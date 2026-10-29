import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePages } from '../dist/sync/reconcile.js';
import { workspace } from './helpers/fixtures.mjs';
const scope={id:'100',type:'folder'};
const fm=id=>`---\npageId: ${id}\n---\nBody`;

test('automatic reconciliation preserves remote baseline and hash across a local move without mutating input',t=>{
 const {root}=workspace(t,{'new/a.md':fm('1')});
 const mapping={'old/a.md':{pageId:'1',hash:'original',remoteVersion:7}};
 const result=reconcilePages(root,mapping,['new/a.md'],['new/a.md'],scope);
 assert.equal(result['old/a.md'],undefined);
 assert.deepEqual(result['new/a.md'],{...mapping['old/a.md'],pendingMove:{parentKey:'new/'}});
 assert.equal(mapping['new/a.md'],undefined);
});

test('copying a page with the same ID blocks automatic sync',t=>{
 const {root}=workspace(t,{'a.md':fm('1'),'b.md':fm('1')});
 assert.throws(()=>reconcilePages(root,{'a.md':{pageId:'1'}},['a.md','b.md'],['b.md'],scope),/중복/);
});

test('a move cannot adopt an ignored original that still exists',t=>{
 const {root}=workspace(t,{'old.md':fm('1'),'new.md':fm('1')});
 assert.throws(()=>reconcilePages(root,{'old.md':{pageId:'1'}},['new.md'],['new.md'],scope),/경로가 남아/);
});

test('partial sync leaves unselected moved page mappings untouched',t=>{
 const {root}=workspace(t,{'new.md':fm('1'),'other.md':'Body'});
 const original={'old.md':{pageId:'1',remoteVersion:2}};
 assert.deepEqual(reconcilePages(root,original,['new.md','other.md'],['other.md'],scope),original);
});

test('adding a README parent automatically plans a move for an existing child',t=>{
 const {root}=workspace(t,{'parent/a.md':fm('1'),'parent/README.md':fm('2')});
 const result=reconcilePages(root,{'parent/a.md':{pageId:'1',remoteVersion:2}},['parent/a.md','parent/README.md'],['parent/a.md'],scope);
 assert.deepEqual(result['parent/a.md'].pendingMove,{parentKey:'parent/README.md'});
});

test('renaming a file within the same parent relinks metadata without planning a remote move',t=>{
 const {root}=workspace(t,{'folder/002_기술.md':fm('1')});
 const original={'folder/긴_원격_제목.md':{pageId:'1',title:'Keep title',hash:'body',remoteVersion:3,remoteParentId:'200'},'folder/':{pageId:'200',type:'folder'}};
 const result=reconcilePages(root,original,['folder/002_기술.md'],['folder/002_기술.md'],scope);
 assert.equal(result['folder/긴_원격_제목.md'],undefined);assert.deepEqual(result['folder/002_기술.md'],original['folder/긴_원격_제목.md']);assert.equal(original['folder/002_기술.md'],undefined);
});

test('changing a parent source key with the same recorded parent ID needs no remote move',t=>{
 const {root}=workspace(t,{'new/a.md':fm('1'),'new/README.md':fm('2')});
 const result=reconcilePages(root,{'old/a.md':{pageId:'1',remoteParentId:'2'},'old/README.md':{pageId:'2'}},['new/a.md','new/README.md'],['new/a.md'],scope);
 assert.equal(result['new/a.md'].pendingMove,undefined);
});

test('an existing pending remote verification is retained even on a same-parent rename',t=>{
 const {root}=workspace(t,{'renamed.md':fm('1')});
 const result=reconcilePages(root,{'old.md':{pageId:'1',pendingMove:{parentKey:null}}},['renamed.md'],['renamed.md'],scope);
 assert.deepEqual(result['renamed.md'].pendingMove,{parentKey:null});
});
