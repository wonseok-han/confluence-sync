import test from 'node:test';
import assert from 'node:assert/strict';
import {workspace,configure,mockFetch} from './helpers/fixtures.mjs';
import {bindScope} from './helpers/scope.mjs';
import {preparePushTree} from '../dist/sync/prepare.js';
import {docHash} from '../dist/documents/markdown.js';
import {changeStaging} from '../dist/sync/staging.js';
import {runPush} from '../dist/sync/push.js';
const files={
 'topic/source.md':'# Source\n\n[[target#Section|Read]]\n',
 'topic/target.md':'# Target\n\n## Section\n\nBody\n',
 'other/target.md':'# Other target\n\n## Section\n',
};

test('publication hash and incoming anchors do not depend on which referencing notes are prepared',async t=>{
 const {root}=workspace(t,files),hashes=[];bindScope(root);
 for(const selected of [['topic/target.md'],['topic/source.md','topic/target.md'],Object.keys(files)]){
  const tree=await preparePushTree(root,Object.keys(files),selected,{referenceRoots:[]});
  try{const doc=tree.docs['topic/target.md'],rendered=tree.render('topic/target.md',doc.body,doc.title);assert.equal(rendered.anchorsPlaced,1);hashes.push(docHash(doc.title,rendered));}finally{tree.dispose();}
 }
 assert.equal(new Set(hashes).size,1);
});

test('adding target and referring note separately permits preview while genuine source edits still require re-add',async t=>{
 configure(t);const {root,put}=workspace(t,files);bindScope(root);mockFetch(t,[]);
 await changeStaging(root,['topic/target.md'],'add');await changeStaging(root,['topic/source.md'],'add');
 await assert.doesNotReject(runPush(['--base',root,'--dry-run']));
 put('topic/target.md',files['topic/target.md']+'Edited\n');
 await assert.rejects(runPush(['--base',root,'--dry-run']),/추가 후 문서·첨부·링크가 변경/);
});

test('adding one note reads workspace metadata once and writes only the selected temporary Markdown',async t=>{
 const fs=await import('node:fs'),{syncBuiltinESMExports}=await import('node:module'),{inspectStaging}=await import('../dist/sync/staging.js');
 const docs={'chosen.md':'# Chosen'};for(let i=0;i<40;i++)docs[`background/${i}.md`]='# Background '+i+'\n\nBody\n';
 const {root}=workspace(t,docs);bindScope(root);const read=fs.default.readFileSync,write=fs.default.writeFileSync;let reads=0,writes=0;
 try{
  fs.default.readFileSync=function(path,...args){if(String(path).startsWith(root)&&String(path).endsWith('.md'))reads++;return read.call(this,path,...args);};
  fs.default.writeFileSync=function(path,...args){if(String(path).includes('csync-push-')&&String(path).endsWith('.md'))writes++;return write.call(this,path,...args);};syncBuiltinESMExports();
  const rows=await inspectStaging(root,{},['chosen.md']);assert.equal(rows.length,1);assert.equal(writes,1);assert.ok(reads<=Object.keys(docs).length+8,`document reads: ${reads}`);
 }finally{fs.default.readFileSync=read;fs.default.writeFileSync=write;syncBuiltinESMExports();}
});
