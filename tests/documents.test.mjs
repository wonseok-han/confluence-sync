import test from 'node:test';
import assert from 'node:assert/strict';
import {join,relative} from 'node:path';
import {readFileSync} from 'node:fs';
import {workspace} from './helpers/fixtures.mjs';
import {collectHeadings,slugifyHeading,matchConfluenceAnchor,wikilinkAnchorToSlug,collectLinkAnchors} from '../dist/anchors.js';
import {splitFrontmatter,buildFrontmatter,resolveWikilinks,linksToWikilinks} from '../dist/obsidian.js';
import {collectMarkdown,collectAssets,readDoc,buildVault,vaultResolver,buildFolderIndex,parentKeyOf,neededFolderDirs,sortForSync,resolveSelection,withParents} from '../dist/docs.js';
import {buildTreeRenderer} from '../dist/render.js';
import {docHash,toStorage} from '../dist/markdown.js';
import {buildIgnorer} from '../dist/ignore.js';
import {loadMapping,saveMapping} from '../dist/mapping.js';
import {repairMarkdown,totalFixes} from '../dist/repair.js';
import {htmlToMarkdown,codeLanguagesFromStorage} from '../dist/html2md.js';

test('headings ignore fenced examples and retain duplicate, Korean, and C# anchors',()=>{
 const h=collectHeadings('# Title\n## **한글** Guide\n```md\n# Hidden\n```\n## **한글** Guide\n### C# ###');
 assert.deepEqual(h.map(x=>x.slug),['title','한글-guide','한글-guide-1','c']);
 assert.equal(h.at(-1).text,'C#');assert.equal(slugifyHeading('A  ·  B'),'a----b');
 assert.equal(matchConfluenceAnchor('Page한글Guide',h,'Page')?.slug,'한글-guide');
 assert.equal(matchConfluenceAnchor('not-here',h,'Page'),null);
 assert.equal(wikilinkAnchorToSlug('Parent#Child Heading'),'child-heading');
 assert.equal(wikilinkAnchorToSlug('^block'),null);
});

test('frontmatter keeps quoted values and body separate',()=>{
 const fm={title:'A: B',pageId:'123',spaceKey:'TEST'};
 const parsed=splitFrontmatter(buildFrontmatter(fm)+'## Body\n');
 assert.deepEqual(parsed.data,fm);assert.equal(parsed.body.trim(),'## Body');
 assert.deepEqual(splitFrontmatter('plain'),{data:{},body:'plain'});
});

test('wikilinks handle table aliases, self anchors, unknown targets and code examples',()=>{
 const input='[[Other#Section\\|alias]] [[#Self heading]] [[Unknown]] `[[Other]]`\n```md\n[[Other]]\n```';
 const result=resolveWikilinks(input,target=>target==='Other'?'other.md':null);
 assert.match(result,/\[alias\]\(other.md#section\)/);assert.match(result,/\[Self heading\]\(#self-heading\)/);
 assert.match(result,/\[\[Unknown\]\]/);assert.match(result,/`\[\[Other\]\]`/);assert.match(result,/```md\n\[\[Other\]\]\n```/);
 assert.equal(linksToWikilinks('[Other](other.md) ![image](image.png)',(d,l)=>`[[${l}]]`),'[[Other]] ![image](image.png)');
});

test('file discovery excludes configuration and dependencies, title metadata wins',t=>{
 const {root}=workspace(t,{'doc.md':'---\ntitle: Preferred\npageId: 12\n---\n# Heading\n\n## Section','nested/a.MD':'# A','img.png':'bytes','.obsidian/hidden.md':'# Hidden','node_modules/no.md':'# No'});
 assert.equal(collectMarkdown(root).length,2);assert.deepEqual(collectAssets(root).map(p=>relative(root,p)),['img.png']);
 const doc=readDoc(root,'doc.md');assert.equal(doc.title,'Preferred');assert.equal(doc.fm.pageId,'12');assert.doesNotMatch(doc.body,/# Heading/);assert.ok(doc.anchors.has('heading'));assert.deepEqual(doc.bodySlugs,['section']);
});

test('vault aliases and explicit paths resolve nested assets',()=>{
 const vault=buildVault(['a/Note.md','b/Other.md'],['images/screen.png']);
 assert.equal(vaultResolver('b/Other.md',vault)('Note',false),'../a/Note.md');
 assert.equal(vaultResolver('b/Other.md',vault)('screen.png',true),'../images/screen.png');
 assert.equal(vaultResolver('b/Other.md',vault)('Missing',false),null);
});

test('folder hierarchy and selected files carry only required parent READMEs',t=>{
 const {root}=workspace(t);const rels=['README.md','guide/README.md','guide/a.md','bare/deep/b.md'];const idx=buildFolderIndex(rels);
 assert.equal(parentKeyOf('guide/a.md',idx),'guide/README.md');assert.equal(parentKeyOf('guide/README.md',idx),null);
 assert.deepEqual(new Set(neededFolderDirs(rels,idx)),new Set(['bare','bare/deep']));
 assert.deepEqual(new Set(withParents(['guide/a.md'],idx)),new Set(['guide/a.md','guide/README.md']));
 assert.deepEqual(resolveSelection(rels,['guide'],root),['guide/README.md','guide/a.md']);
 const sorted=sortForSync(rels);assert.ok(sorted.indexOf('guide/README.md')<sorted.indexOf('guide/a.md'));
});

test('ignore file negation and command exclusions combine',t=>{
 const {root}=workspace(t,{'.confluence-syncignore':'*.draft.md\n!keep.draft.md\nprivate/\n'});
 const ignore=buildIgnorer(root,['temp/']);assert.ok(ignore.active);assert.ok(ignore.ignores('a.draft.md'));assert.equal(ignore.ignores('keep.draft.md'),false);assert.ok(ignore.ignores('temp/a.md'));assert.ok(ignore.ignores('private/a.md'));
});

test('mapping writes stable data and missing files start empty',t=>{
 const {root}=workspace(t);const path=join(root,'.confluence-sync.json');assert.deepEqual(loadMapping(path),{});
 const data={'a.md':{pageId:'12',hash:'abc'},'folder/':{pageId:'13',type:'folder'}};saveMapping(path,data);assert.deepEqual(loadMapping(path),data);assert.ok(readFileSync(path,'utf8').endsWith('\n'));
});

test('tree rendering links cross-page and self anchors with matching macros',t=>{
 const {root}=workspace(t,{'a.md':'# A\n\n[B](nested/b.md#section) [Self](#local)\n\n## Local','nested/b.md':'# B\n\n## Section'});
 const tree=buildTreeRenderer(root,['a.md','nested/b.md']);const a=tree.docs['a.md'],b=tree.docs['nested/b.md'];
 const ar=tree.render('a.md',a.body,a.title),br=tree.render('nested/b.md',b.body,b.title);
 assert.equal(ar.internalLinks,2);assert.deepEqual(ar.deadAnchors,[]);assert.match(ar.storage,/ri:content-title="B"/);assert.match(ar.storage,/ac:anchor="local"/);assert.equal(br.anchorsPlaced,1);assert.match(br.storage,/ac:name="anchor"/);
});

test('rendering reports missing anchors and does not leak context between documents',t=>{
 const {root}=workspace(t,{'a.md':'# A\n\n[No](#missing)','b.md':'# B\n\nPlain'});const tree=buildTreeRenderer(root,['a.md','b.md']);
 assert.deepEqual(tree.render('a.md',tree.docs['a.md'].body,'A').deadAnchors,['#missing']);assert.deepEqual(tree.render('b.md',tree.docs['b.md'].body,'B').deadAnchors,[]);
});

test('storage renders code safely and handles local versus remote images',t=>{
 const {root}=workspace(t);const r=toStorage('```js\nconst x = "]] >";\n]]>\n```\n\n![local](screen.png "width=500") ![remote](https://example.invalid/a.png)', 'doc.md',{},root);
 assert.match(r.storage,/\]\]\]\]><!\[CDATA\[>/);assert.match(r.storage,/ac:width="500"/);assert.match(r.storage,/ri:url/);assert.equal(r.images.length,1);assert.equal(r.images[0].abs,join(root,'screen.png'));
});

test('image bytes and page titles participate in change detection',t=>{
 const {root,put}=workspace(t,{'screen.png':'first'});const r=toStorage('![image](screen.png)','doc.md',{},root);const old=docHash('Title',r);
 assert.equal(old,docHash('Title',r));put('screen.png','second');assert.notEqual(old,docHash('Title',r));assert.notEqual(docHash('Title',r),docHash('Renamed',r));
});

test('HTML export strips CSS/scripts while retaining tables, lists, code language and attachments',()=>{
 const images=[];const html='<style>.x{color:red}</style><script>bad()</script><h2>Section</h2><ul><li><p>A</p></li><li><p>B</p></li></ul><table><tr><th>Name</th><th>Value</th></tr><tr><td>X</td><td>1</td></tr></table><pre>echo hello</pre><img src="/download/attachments/1/screen.png"/><img src="https://example.invalid/remote.png"/>';
 const md=htmlToMarkdown(html,{assetPrefix:'attachments/doc',onImage:f=>images.push(f),codeLangs:['bash']});
 assert.doesNotMatch(md,/color:red|bad\(\)/);assert.match(md,/## Section/);assert.match(md,/- +A\n- +B/);assert.match(md,/\| Name \| Value \|/);assert.match(md,/```bash\necho hello/);assert.deepEqual(images,['screen.png']);assert.match(md,/attachments\/doc\/screen.png/);assert.match(md,/https:\/\/example.invalid\/remote.png/);
});

test('code language order comes from storage including unspecified languages',()=>{
 assert.deepEqual(codeLanguagesFromStorage('<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">typescript</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="code"></ac:structured-macro>'),['typescript','']);
});

test('repair removes export artifacts and is idempotent without changing real Java',()=>{
 const original='---\ntitle: Title\n---\n# Title\n\n[data-colorid=x]{color:red;}Text\n\n- A\n\n- B\n\n```java\necho hello  \n```\n\n```java\npublic class Main {}\n```';
 const fixed=repairMarkdown(original);assert.ok(totalFixes(fixed.stats)>0);assert.doesNotMatch(fixed.text,/# Title|data-colorid/);assert.match(fixed.text,/```plaintext\necho hello\n```/);assert.match(fixed.text,/```java\npublic class Main/);assert.equal(repairMarkdown(fixed.text).text,fixed.text);
});
