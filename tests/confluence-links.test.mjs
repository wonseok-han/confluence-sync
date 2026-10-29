import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {isConfluenceWebPath} from '../dist/confluence/links.js';
import {toStorage} from '../dist/documents/markdown.js';
import {attachmentMapper} from '../dist/conversion/attachments.js';
import {extractPdfPages} from '../dist/conversion/pdf-pages.js';
import {workspace} from './helpers/fixtures.mjs';
import {validateWorkspace} from '../dist/web/hosted-files.js';

test('Confluence navigation paths are distinct from local, embedded and traversal paths',()=>{
 for(const path of ['/wiki/spaces/TEST/pages/201/Report','/wiki/spaces/TEST/overview','/wiki/display/~712020%3Auser','/wiki/spaces/TEST/pages/201/report.pdf#page=1','/wiki/plugins/recently-updated/changes.action?startIndex=10'])assert.equal(isConfluenceWebPath(path),true,path);
 for(const path of ['/Users/example/private.pdf','//wiki/spaces/TEST/pages/201','/wiki/spaces/TEST/../../etc/passwd','/wiki/spaces/TEST/%252e%252e/private','/wiki/spaces/TEST/dir\\file','/wiki/spaces/TEST/%00file'])assert.equal(isConfluenceWebPath(path),false,path);
});
test('Confluence links stay hyperlinks through conversion and never become local attachments',async t=>{
 const href='/wiki/spaces/TEST/pages/201/report.pdf#page=1',text=`[Report](${href})`;
 const {root}=workspace(t,{'README.md':text,'private.pdf':'private test data'});
 await validateWorkspace([{root,virtual:'/workspace/docs'}],false);
 let rewrites=0;
 const rendered=toStorage(text,'README.md',{},root,{rewriteHref:()=>{rewrites++;return join(root,'private.pdf')}});
 assert.equal(rewrites,0);assert.deepEqual(rendered.attachments,[]);assert.match(rendered.storage,/href="\/wiki\/spaces\/TEST\/pages\/201\/report.pdf#page=1"/);
 const mapper=attachmentMapper(join(root,'README.md'),root);assert.equal(mapper.rewrite(text),text);assert.equal(mapper.copies.size,0);
 const pdf=await extractPdfPages(text,join(root,'README.md'),root,join(root,'out'),true);assert.equal(pdf.text,text);assert.equal(pdf.pages,0);
});
