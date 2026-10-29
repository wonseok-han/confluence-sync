import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {footnotesToLinks,linksToFootnotes} from '../dist/conversion/footnotes.js';
import {buildTreeRenderer} from '../dist/sync/render.js';
import {docHash,hashOf} from '../dist/documents/markdown.js';
import {htmlToMarkdown} from '../dist/documents/html-to-markdown.js';
import {footnotesToStorage,footnoteStorageComments} from '../dist/documents/footnote-roundtrip.js';
import {preparePushTree} from '../dist/sync/prepare.js';
import {runPull} from '../dist/sync/pull.js';
import {loadMapping} from '../dist/sync/mapping.js';
import {mappingPath} from '../dist/sync/metadata.js';
import {workspace,configure,mockFetch} from './helpers/fixtures.mjs';
import {bindScope,scopeResponder} from './helpers/scope.mjs';
import {panelExport} from './helpers/callout-export.mjs';

function render(t,source) {
 const {root,put}=workspace(t,{'a.md':footnotesToLinks(source)});
 const tree=buildTreeRenderer(root,['a.md']),d=tree.docs['a.md'],r=tree.render('a.md',d.body,d.title);
 return {root,put,storage:r.storage,html:panelExport(r.storage),r};
}
for(const source of [
 'Text[^law] again[^law].\n\n[^law]: **Note**\n    continued\n\n    Second paragraph.\n',
 'Text^[Inline **note** and [a link](https://example.com)].\n',
 'Named[^한글] inline^[With `code` and [nested](https://example.com)].\n\n[^한글]: Body\n',
 '> [!summary]- Custom\n> Text[^law] inline^[Inline note].\n\n[^law]: Footnote body\n',
 'Text[^law]\n\n[^law]: ```md\n    [^law] code example\n    ```\n',
])test('footnotes survive prepare → storage → export → both Pull formats: '+source.split('\n')[0],t=>{
 const {storage,html}=render(t,source);assert.match(storage,/csync-footnote-v1-start-/);assert.doesNotMatch(storage,/<!-- csync-footnote/);
 const obsidian=htmlToMarkdown(html,{storage,obsidian:true,codeLangs:['md']});
 assert.match(obsidian,source.includes('[^law]')?/\[\^law\]/:source.includes('[^한글]')?/\[\^한글\]/:/\^\[/);assert.doesNotMatch(obsidian,/csync-|각주 1/);
 if(source.includes('^[Inline'))assert.match(obsidian,/\^\[Inline/);
 const markdown=htmlToMarkdown(html,{storage,codeLangs:['md']});assert.match(markdown,/<sup>\[\d+\]\(#각주-/);assert.match(markdown,/###### 각주/);assert.match(markdown,/<!-- csync-footnote:v1/);
 if(!source.includes('[!summary]'))assert.equal(linksToFootnotes(markdown),obsidian);
});
test('inline extraction respects code, escaped syntax, balanced links and synthetic-label collisions',()=>{
 const source='Live^[With `code` and [label](https://example.com)] `^[code]` \\^[escaped]\n\n```md\n^[literal]\n```\n\nExisting[^csync-inline-1]\n\n[^csync-inline-1]: Keep\n';
 const converted=footnotesToLinks(source),back=linksToFootnotes(converted);assert.match(back,/Live\^\[With `code` and \[label\]/);assert.match(back,/`\^\[code\]` \\\^\[escaped\]/);assert.match(back,/```md\n\^\[literal\]\n```/);assert.match(back,/\[\^csync-inline-1\]: Keep/);assert.doesNotMatch(back,/csync-inline-2/);assert.equal(footnotesToLinks(converted),converted);
});
test('remote note edits survive, while an orphaned inline note is preserved as a definition',t=>{
 const {storage,html}=render(t,'A^[Original] B[^ref]\n\n[^ref]: Original definition\n');
 const edited=html.replace('Original definition','Edited definition').replace('Original','Edited inline');
 const restored=htmlToMarkdown(edited,{storage,obsidian:true});assert.match(restored,/A\^\[Edited inline\]/);assert.match(restored,/\[\^ref\]: Edited definition/);
 const orphan=edited.replace(/A<sup>[\s\S]*?<\/sup>/,'A');assert.match(htmlToMarkdown(orphan,{storage,obsidian:true}),/\[\^csync-inline-1\]: Edited inline/);
});
test('metadata hashes remain compatible and code samples never become restoration anchors',t=>{
 const {r}=render(t,'A[^a]\n\n[^a]: Body\n');const old=footnoteStorageComments(r.storage);assert.match(old,/<!-- csync-footnote:v1/);assert.equal(docHash('A',r),hashOf('A\0'+old));assert.equal(footnotesToStorage(old),r.storage);
 const example='<![CDATA['+old+']]>';assert.equal(footnotesToStorage(example),example);assert.equal(footnoteStorageComments(example),example);
});
test('incomplete or malformed remote metadata preserves readable sections; external links and ordinary superscripts stay intact',t=>{
 const {storage,html}=render(t,'A[^a]\n\n[^a]: Body\n');
 const broken=html.replace(/<span[^>]*id="csync-footnote-v1-end-[^"]*"[^>]*><\/span>/,'');
 const result=htmlToMarkdown(broken,{storage,obsidian:true});assert.match(result,/Body/);assert.match(result,/###### 각주/);assert.doesNotMatch(result,/csync-footnote-marker/);
 const external=html.replace('href="#Page각주-1"','href="https://example.com/wiki/spaces/TEST/pages/999/Other#Page각주-1"');assert.match(htmlToMarkdown(external,{storage,obsidian:true,pageId:'123'}),/pages\/999\/Other#Page각주-1/);
 const invalid='<!-- csync-footnote:v1 bnVsbA== -->\n###### 각주 1\n\nBody\n<!-- /csync-footnote -->';assert.equal(linksToFootnotes(invalid),invalid);
 assert.equal(htmlToMarkdown('<p>x<sup>2</sup></p>'),'x<sup>2</sup>\n');
});
for(const obsidian of [false,true])test(`real shared Pull restores footnotes, updates the baseline and preserves image paths: ${obsidian}`,async t=>{
 configure(t);const {root,put}=workspace(t,{'a.md':'Text[^law] inline^[Inline].\n\n[^law]: Note ![Image](image.png)\n','image.png':'synthetic-image'});bindScope(root);
 const tree=await preparePushTree(root,['a.md'],['a.md']);let storage;try{const d=tree.docs['a.md'];storage=tree.render('a.md',d.body,d.title).storage;}finally{tree.dispose()}
 put('.csync/mapping.json',JSON.stringify({'Received.md':{pageId:'123'}}));const html=panelExport(storage);
 const steps=[{path:'/wiki/rest/api/content/123?expand=body.export_view,body.storage,version',body:{id:'123',type:'page',title:'Received',version:{number:1},body:{export_view:{value:html},storage:{value:storage}}}},{path:'/wiki/rest/api/content/123/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/123/child/page?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/123/child/attachment?limit=100',body:{results:[{title:'image.png',_links:{download:'/download/image.png'}}]}},{path:'/wiki/download/image.png',bytes:new Uint8Array([1,2,3])}];
 mockFetch(t,steps,scopeResponder(root,steps));await runPull(['pull','123','--out',root,...(obsidian?['--obsidian']:[])]);
 const text=readFileSync(join(root,'Received.md'),'utf8');assert.match(text,obsidian?/\[\^law\]: Note/:/###### 각주 1/);if(obsidian){assert.match(text,/inline\^\[Inline\]/);assert.doesNotMatch(text,/csync-/)}assert.match(text,/attachments\/Received\/image.png/);assert.deepEqual(readFileSync(join(root,'attachments/Received/image.png')),Buffer.from([1,2,3]));assert.equal(loadMapping(mappingPath(root))['Received.md'].remoteVersion,1);
});

test('inline text expanded to multiple paragraphs remotely falls back to a definition without losing content',t=>{
 const {storage,html}=render(t,'Text^[Note].\n');const changed=html.replace('<p>Note</p>','<p>First</p><p>Second</p>');const result=htmlToMarkdown(changed,{storage,obsidian:true});assert.match(result,/Text\[\^csync-inline-1\]/);assert.match(result,/\[\^csync-inline-1\]: First\n    \n    Second/);
});

test('user-authored HTML attributes cannot impersonate internal footnote metadata',()=>{
 assert.equal(htmlToMarkdown('<span data-csync-footnote="malformed">Safe</span>',{obsidian:true}),'Safe\n');
});
