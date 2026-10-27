import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {workspace,configure,mockFetch} from './helpers/fixtures.mjs';
import {bindScope,scopeResponder} from './helpers/scope.mjs';
import {preparePushTree} from '../dist/sync/prepare.js';
import {buildTreeRenderer} from '../dist/sync/render.js';
import {docHash} from '../dist/documents/markdown.js';
import {runPush} from '../dist/sync/push.js';
import {mappingPass} from '../dist/sync/pull.js';
import {mappingPath} from '../dist/sync/metadata.js';

function pdf(path) {
 const stream='1 0 0 rg 0 0 100 100 re f';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let text='%PDF-1.4\n',offsets=[];
 objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${object}\nendobj\n`});
 const xref=Buffer.byteLength(text);text+=`xref\n0 5\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 writeFileSync(path,text);
}
const rendered=(tree,rel='doc.md')=>{const doc=tree.docs[rel];return tree.render(rel,doc.body,doc.title)};
const snapshot=root=>Object.fromEntries(readdirSync(root,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const file=join(e.parentPath,e.name);return [file,readFileSync(file).toString('base64')]}));

test('automatic Push preparation matches convert then render, including footnotes, PDF pages, tables and links',async t=>{
 const {root,put}=workspace(t,{'input/doc.md':'---\npageId: 123\n---\n# Doc\n\n[[Other#Section|Related]] ![[image.png]]\n\nEvidence[^pdf].\n\n[^pdf]: [[source.pdf#page=1|Source]]\n\n![[source.pdf#page=1|Embedded]]\n\n<table><tr><td colspan="2">![Image](image.png)</td></tr></table>\n','input/Other.md':'# Other\n\n## Section\n','input/image.png':'image'});
 const base=join(root,'input'),out=join(root,'manual');pdf(join(base,'source.pdf'));const before=snapshot(base);
 execFileSync(process.execPath,[resolve('dist/sync.js'),'convert','--to','markdown','--base',base,'--out',out],{stdio:'pipe'});
 const manual=buildTreeRenderer(out,['doc.md','Other.md']);
 const first=await preparePushTree(base,['doc.md','Other.md'],['doc.md','Other.md']);
 let hash,paths;
 try {
  const r=rendered(first),expected=rendered(manual);hash=docHash('Doc',r);paths=r.attachments.map(a=>a.abs);
  assert.equal(r.storage,expected.storage);assert.equal(hash,docHash('Doc',expected));
  assert.equal(first.docs['doc.md'].fm.pageId,'123');assert.match(r.storage,/각주-1/);assert.match(r.storage,/pdfjs-/);assert.match(r.storage,/colspan="2"/);assert.equal(r.deadAnchors.length,0);
  assert.ok(paths.every(existsSync));
 }finally{first.dispose()}
 assert.ok(paths.every(path=>!existsSync(path)));assert.deepEqual(snapshot(base),before);
 const second=await preparePushTree(base,['doc.md','Other.md'],['doc.md','Other.md']);
 try{assert.equal(docHash('Doc',rendered(second)),hash)}finally{second.dispose()}
});

test('only selected documents are converted; invalid PDFs outside scope do not block Push',async t=>{
 const {root}=workspace(t,{'doc.md':'# Doc\n\n[[Other]]','Other.md':'# Other\n\n[[missing.pdf#page=99]]'});
 const tree=await preparePushTree(root,['doc.md','Other.md'],['doc.md']);
 try{assert.match(rendered(tree).storage,/ri:content-title="Other"/)}finally{tree.dispose()}
});

test('preparation failure cleans its temporary directory and leaves source files unchanged',t=>{
 const {root}=workspace(t,{'source/doc.md':'# Doc\n\n[[missing.pdf#page=1]]','scratch/.keep':''});
 const before=snapshot(join(root,'source'));
 const code=`import {preparePushTree} from ${JSON.stringify(new URL('../dist/sync/prepare.js',import.meta.url).href)};try{await preparePushTree(process.argv[1],['doc.md'],['doc.md']);process.exitCode=2}catch(e){console.log(e.message)}`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',code,join(root,'source')],{encoding:'utf8',env:{...process.env,TMPDIR:join(root,'scratch'),TMP:join(root,'scratch'),TEMP:join(root,'scratch')}});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PDF 위키링크/);assert.deepEqual(readdirSync(join(root,'scratch')),['.keep']);assert.deepEqual(snapshot(join(root,'source')),before);
});

test('invalid PDF fails before any remote request, source or mapping mutation',async t=>{
 configure(t);const {root,put}=workspace(t,{'doc.md':'# Doc\n\n[[source.pdf#page=2]]'});pdf(join(root,'source.pdf'));bindScope(root);put('.csync/mapping.json','{}');const before=snapshot(root);
 t.mock.method(globalThis,'fetch',()=>{throw Error('Remote call before preprocessing completed')});
 await assert.rejects(runPush(['--base',root]),/PDF 쪽 범위 초과/);assert.deepEqual(snapshot(root),before);
});

test('actual Push uploads generated PNG bytes and keeps the Obsidian source intact',async t=>{
 configure(t);const {root}=workspace(t,{'doc.md':'# Doc\n\nEvidence[^a]\n\n[^a]: [[source.pdf#page=1|PDF]]'});pdf(join(root,'source.pdf'));bindScope(root);
 const original=readFileSync(join(root,'doc.md'),'utf8');const prepared=await preparePushTree(root,['doc.md'],['doc.md']);
 let expected,filename,hash;
 try{expected=rendered(prepared);hash=docHash('Doc',expected);filename=expected.attachments[0].filename;}finally{prepared.dispose()}
 const steps=[{path:'/wiki/api/v2/pages',method:'POST',body:{id:'page'},check:init=>assert.equal(JSON.parse(init.body).body.value,expected.storage)},
 {path:`/wiki/rest/api/content/page/child/attachment?filename=${encodeURIComponent(filename)}`,body:{results:[]}},
 {path:'/wiki/rest/api/content/page/child/attachment',method:'POST',check:init=>{const file=init.body.get('file');assert.equal(file.name,filename);assert.ok(file.size>0)}}];
 mockFetch(t,steps,scopeResponder(root,steps));await runPush(['--base',root]);
 assert.equal(readFileSync(join(root,'doc.md'),'utf8'),original);assert.equal(existsSync(join(root,'attachments')),false);
 const entry=JSON.parse(readFileSync(mappingPath(root),'utf8'))['doc.md'];assert.equal(entry.hash,hash);
 mockFetch(t,[],scopeResponder(root,[]));await runPush(['--base',root]);assert.equal(JSON.parse(readFileSync(mappingPath(root),'utf8'))['doc.md'].hash,hash);
});

test('Pull baseline uses the same prepared hash as Push for Obsidian footnotes and PDF references',async t=>{
 const {root}=workspace(t,{'doc.md':'# Doc\n\nEvidence[^a]\n\n[^a]: [[source.pdf#page=1|PDF]]'});pdf(join(root,'source.pdf'));
 await mappingPass(root,mappingPath(root),new Map([['1',join(root,'doc.md')]]),new Map());
 const tree=await preparePushTree(root,['doc.md'],['doc.md']);
 try{assert.equal(JSON.parse(readFileSync(mappingPath(root),'utf8'))['doc.md'].hash,docHash('Doc',rendered(tree)))}finally{tree.dispose()}
});


test('already converted documents do not need a PDF original that is absent after Pull',async t=>{
 const {root,put}=workspace(t,{'source/doc.md':'# Doc\n\n[[source.pdf#page=1|PDF]]'});const base=join(root,'source');pdf(join(base,'source.pdf'));
 const out=join(root,'converted');execFileSync(process.execPath,[resolve('dist/sync.js'),'convert','--to','markdown','--base',base,'--out',out],{stdio:'pipe'});
 const {rmSync}=await import('node:fs');rmSync(join(out,'attachments/doc/source.pdf'));
 const before=readFileSync(join(out,'doc.md'),'utf8'),tree=await preparePushTree(out,['doc.md'],['doc.md']);
 try{assert.match(rendered(tree).storage,/pdfjs-/);assert.equal(readFileSync(join(out,'doc.md'),'utf8'),before)}finally{tree.dispose()}
});
