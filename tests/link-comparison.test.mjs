import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {basename,join} from 'node:path';
import {workspace,configure,mockFetch} from './helpers/fixtures.mjs';
import {bindScope} from './helpers/scope.mjs';
import {mappingPass} from '../dist/sync/pull.js';
import {mappingPath} from '../dist/sync/metadata.js';
import {inspectStaging,changeStaging} from '../dist/sync/staging.js';
import {localStateHash,matchesLocalState} from '../dist/sync/local-state.js';
import {storeBaseline} from '../dist/sync/baseline.js';
import {preparePushTree} from '../dist/sync/prepare.js';
import {runPush} from '../dist/sync/push.js';
import {documentDiff} from '../dist/sync/diff.js';

const path='archive/[폐기]_topic/a.md',target='archive/[폐기]_topic/target.md';
const original='# A\n\n[[target#Section|Read]]\n';
const expanded=root=>`Vault/${basename(root)}/archive/[폐기]_topic/target`;

test('Obsidian automatic link paths remain clean, render the same nearby document and never rewrite local baselines',async t=>{
 configure(t);const {root,put}=workspace(t,{[path]:original,[target]:'# Target\n\n## Section\n','a/target.md':'# Duplicate'});bindScope(root);mockFetch(t,[]);
 await mappingPass(root,mappingPath(root),new Map([['201',join(root,path)],['202',join(root,target)],['203',join(root,'a/target.md')]]),new Map());
 const mapping=readFileSync(mappingPath(root),'utf8'),updated=original.replace('target#',expanded(root)+'#');put(path,updated);
 const rows=await inspectStaging(root,{},[path]);assert.equal(rows[0].status,'same');
 assert.equal(readFileSync(join(root,path),'utf8'),updated);assert.equal(readFileSync(mappingPath(root),'utf8'),mapping);
 await changeStaging(root,[path],'add');const lines=[];t.mock.method(console,'log',(...args)=>lines.push(args.join(' ')));await runPush(['--base',root,'--dry-run']);assert.match(lines.join('\n'),/동일/);
 const prepared=await preparePushTree(root,[path,target,'a/target.md'],[path]);try{assert.doesNotMatch(prepared.docs[path].body,/\[\[/);assert.match(prepared.docs[path].body,/target\.md#section/);}finally{prepared.dispose();}
});

for(const change of ['alias','fragment','target','body','frontmatter','code','asset'])test(`automatic path normalization still detects actual changes: ${change}`,t=>{
 const before=(change==='frontmatter'?'---\ntitle: A\n---\n':'')+original+(change==='code'?'\n`[[target|Read]]`\n':'');
 const {root,put}=workspace(t,{[path]:before,[target]:'# Target','archive/[폐기]_topic/other.md':'# Other','asset.bin':'old'});bindScope(root);
 const rendered={attachments:change==='asset'?[{filename:'asset.bin',abs:join(root,'asset.bin')}]:[]};
 const entry={sourceObject:storeBaseline(root,before),localHash:localStateHash(root,path,rendered),localHashVersion:2};
 let after=before.replace('target#',expanded(root)+'#');
 if(change==='alias')after=after.replace('|Read','|Changed');
 if(change==='fragment')after=after.replace('#Section','#Other');
 if(change==='target')after=after.replace('/target#','/other#');
 if(change==='body')after+='New text\n';
 if(change==='frontmatter')after=after.replace('title: A','title: B');
 if(change==='code')after=after.replace('`[[target|Read]]`','`[['+expanded(root)+'|Read]]`');
 if(change==='asset')put('asset.bin','changed');
 put(path,after);assert.equal(matchesLocalState(root,path,rendered,entry,[path,target,'archive/[폐기]_topic/other.md']),false);
});

test('automatic Markdown note paths remain clean with balanced parentheses and code labels',t=>{
 const before='# A\n\n[`Read`](target.md)\n',folder='archive/(topic)',file=folder+'/a.md',linked=folder+'/target.md';
 const {root,put}=workspace(t,{[file]:before,[linked]:'# Target'});bindScope(root);
 const rendered={attachments:[]},entry={sourceObject:storeBaseline(root,before),localHash:localStateHash(root,file,rendered),localHashVersion:2};
 put(file,`# A\n\n[\`Read\`](Vault/${basename(root)}/${linked})\n`);
 assert.equal(matchesLocalState(root,file,rendered,entry,[file,linked]),true);
});

test('legacy attachment hashes defer to an unchanged Markdown baseline while versioned hashes detect bytes',t=>{
 const source='# A\n\n![asset](asset.bin)\n';
 const {root,put}=workspace(t,{[path]:source,'asset.bin':'old'});bindScope(root);
 const rendered={attachments:[{filename:'asset.bin',abs:join(root,'asset.bin')}]};
 const entry={sourceObject:storeBaseline(root,source),localHash:localStateHash(root,path,rendered)};
 put('asset.bin','changed');
 assert.equal(matchesLocalState(root,path,rendered,entry,[path]),true);
 assert.equal(matchesLocalState(root,path,rendered,{...entry,localHashVersion:2},[path]),false);
});

for(const wiki of [false,true])for(const changed of [false,true])test(`remote diff resolves equivalent links but detects target edits: wiki=${wiki}, changed=${changed}`,async t=>{
 configure(t);const {root,put}=workspace(t,{[path]:'placeholder',[target]:'# Target\n\n## Section\n','other.md':'# Other\n'});bindScope(root);
 put('.csync/mapping.json',JSON.stringify({[path]:{pageId:'201'},[target]:{pageId:'202'},'other.md':{pageId:'203'}}));
 const local=wiki?'[['+expanded(root)+'#Section|Read]]\n':'[Read](target.md#section)\n';put(path,'---\npageId: 201\n---\n\n'+local);
 const html=`<p><a href="https://example.invalid/wiki/spaces/S/pages/${changed?'203':'202'}/Target#Target-Section">Read</a></p>`;
 mockFetch(t,[{path:'/wiki/rest/api/content/201?expand=body.export_view,body.storage,version',body:{id:'201',type:'page',title:'A',version:{number:1},body:{export_view:{value:html},storage:{value:html}}}}]);
 const source=readFileSync(join(root,path),'utf8'),mapping=readFileSync(mappingPath(root),'utf8');
 const result=await documentDiff(root,path,{remote:true});assert.equal(result.before===result.after,!changed);
 assert.equal(readFileSync(join(root,path),'utf8'),source);assert.equal(readFileSync(mappingPath(root),'utf8'),mapping);
});


test('automatic explicit alias preserves an originally implicit link label',t=>{
 const before='# A\n\n[[target]]\n';const {root,put}=workspace(t,{[path]:before,[target]:'# Target'});bindScope(root);
 const rendered={attachments:[]},entry={localHash:localStateHash(root,path,rendered),sourceObject:storeBaseline(root,before)};
 put(path,'# A\n\n[['+expanded(root)+'|target]]\n');assert.equal(matchesLocalState(root,path,rendered,entry,[path,target]),true);
});

test('generated PDF page bytes do not create local edits across renderers',t=>{
 const source='# A\n\n[PDF](source.pdf#page=2)\n',filename='pdfjs-1234567890abcdef12345678-2.png';
 const {root,put}=workspace(t,{[path]:source,'page.png':'renderer one'});bindScope(root);
 const rendered={attachments:[{filename,abs:join(root,'page.png')}]},first=localStateHash(root,path,rendered);
 put('page.png','renderer two');assert.equal(localStateHash(root,path,rendered),first);
 assert.notEqual(localStateHash(root,path,{attachments:[{filename:'pdfjs-abcdef1234567890abcdef12-2.png',abs:join(root,'page.png')}]}),first);
 const legacy={localHash:'0'.repeat(64),sourceObject:storeBaseline(root,source)};
 assert.equal(matchesLocalState(root,path,rendered,legacy,[path]),true);
 assert.equal(matchesLocalState(root,path,rendered,{...legacy,localHashVersion:2},[path]),false);
});

test('publishing a topic folder resolves all seven mixed vault-root and short navigation links with duplicate filenames elsewhere',async t=>{
 const names=['001_개요와_판정','002_기술_문제와_처리_구조','003_선행조사','004_청구항_초안','005_검토_의견과_반례','006_명세서_구체화_자료','007_변리사_전달_문서'];
 const topic='지식자산/특허출원/특허출원_아이디에이션/권한_규칙_변경_뒤_위임_재판정과_소급_처리';
 const {root,put}=workspace(t);const rels=names.map(name=>topic+'/'+name+'.md');
 for(const [i,rel] of rels.entries()){put(rel,'---\ntitle: Topic '+i+'\n---\n\n# Topic '+i+'\n');put('other/'+names[i]+'.md','# Other '+i);}
 const navigation='구성: '+names.map((name,i)=>`[[${[0,1,2,4].includes(i)?'002_이노그리드/'+basename(root)+'/'+topic+'/':''}${name}|문서 ${i}]]`).join(' · ');
 const source='---\ntitle: Topic 0\n---\n\n'+navigation+'\n';put(rels[0],source);
 const all=[...rels,...names.map(name=>'other/'+name+'.md')];
 const prepared=await preparePushTree(root,all,rels);
 try{
  const doc=prepared.docs[rels[0]],storage=prepared.render(rels[0],doc.body,doc.title).storage;
  assert.doesNotMatch(doc.body,/\[\[/);assert.doesNotMatch(storage,/\[\[/);
  for(let i=0;i<7;i++)assert.match(storage,new RegExp('ri:content-title="Topic '+i+'"'));
  assert.doesNotMatch(storage,/ri:content-title="Other/);
  assert.equal(readFileSync(join(root,rels[0]),'utf8'),source);
 }finally{prepared.dispose();}
});
