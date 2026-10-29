import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createDocument} from '@mixmark-io/domino';
import {previewDocument} from '../dist/web/preview.js';
import {startWeb} from '../dist/web/server.js';
import {workspace} from './helpers/fixtures.mjs';

test('document preview renders Markdown, strips metadata and preserves HTML table widths and spans without writing',async t=>{
 const source='---\ntitle: Secret metadata\n---\n# 문서\n\n**굵게**\n\n<table style="width:100%;table-layout:fixed"><colgroup><col style="width:25%"><col style="width:75%"></colgroup><thead><tr><th>조사일</th><th rowspan="2">검색식</th></tr><tr><th>DB</th></tr></thead><tbody><tr><td colspan="2">본문</td></tr></tbody></table>';
 const {root,put}=workspace(t);const file=put('표.md',source);
 const {html}=await previewDocument(root,file);const doc=createDocument(html);
 assert.equal(doc.querySelector('h1').textContent,'문서');assert.match(doc.querySelector('strong').textContent,/굵게/);
 assert.doesNotMatch(html,/Secret metadata/);assert.equal(doc.querySelector('[rowspan]').getAttribute('rowspan'),'2');
 assert.equal(doc.querySelector('[colspan]').getAttribute('colspan'),'2');assert.match(doc.querySelector('table').getAttribute('style'),/width:100%/);
 assert.match(doc.querySelector('col').getAttribute('style'),/width:25%/);assert.equal(readFileSync(file,'utf8'),source);
});

test('preview isolates active content, external resources and unsafe styles',async t=>{
 const {root,put}=workspace(t);const file=put('doc.md','<script>window.bad=true</script>\n\n<iframe src="https://evil.invalid"></iframe><form><input></form>\n\n<img src="https://evil.invalid/pixel.png" onerror="alert(1)"><div onclick="alert(1)" style="color:red;position:fixed;background-image:url(https://evil.invalid)"><a href="javascript:alert(1)">safe label</a></div>');
 const {html}=await previewDocument(root,file);const doc=createDocument(html);
 assert.equal(doc.querySelectorAll('script,iframe,form,input,[onclick],[onerror],a[href],img[src]').length,0);
 assert.match(doc.querySelector('div').getAttribute('style'),/color:red/);assert.doesNotMatch(html,/position:fixed|background-image|window.bad/);
 assert.match(html,/default-src 'none'/);assert.match(html,/form-action 'none'/);
});

test('preview embeds only bounded local raster images within the selected root',async t=>{
 const {root,put}=workspace(t);const {root:outside,put:out}=workspace(t);
 put('images/그림.png',Buffer.from([137,80,78,71]));out('outside.png','secret');
 symlinkSync(join(outside,'outside.png'),join(root,'escape.png'));
 const file=put('doc.md','![로컬](images/그림.png)\n\n![탈출](escape.png)\n\n![외부](https://example.invalid/image.png)');
 const {html}=await previewDocument(root,file);const images=Array.from(createDocument(html).querySelectorAll('img'));
 assert.match(images[0].getAttribute('src'),/^data:image\/png;base64,/);assert.equal(images[1].getAttribute('src'),null);assert.equal(images[2].getAttribute('src'),null);
 await assert.rejects(previewDocument(root,out('outside.md','# outside')),/폴더 안/);
 await assert.rejects(previewDocument(root,put('.hidden/doc.md','# hidden')),/폴더 안/);
 await assert.rejects(previewDocument(root,put('huge.md','a'.repeat(1_000_001))),/1MB/);
});

test('document-preview API requires existing token/origin checks and rejects invalid selections',async t=>{
 const {root,put}=workspace(t);const file=put('doc.md','# API preview');
 const {server,url}=await startWeb({start:root,port:0});
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const shell=await(await fetch(url)).text();const token=shell.match(/name="csync-token" content="([^"]+)"/)[1];
 assert.match(shell,/id="document-preview-frame"[^>]*sandbox="allow-scripts"/);
 const headers={'Content-Type':'application/json','X-Csync-Token':token};
 const post=(headers,body)=>fetch(url+'/api/document-preview',{method:'POST',headers,body:JSON.stringify(body)});
 assert.equal((await post({'Content-Type':'application/json'},{base:root,file})).status,403);
 assert.equal((await post({...headers,Origin:'https://evil.invalid'},{base:root,file})).status,403);
 assert.equal((await post(headers,{base:root,file:root})).status,400);
 const result=await post(headers,{base:root,file});assert.equal(result.status,200);assert.match((await result.json()).html,/<h1>API preview<\/h1>/);
});

test('preview client ignores stale responses and clears the document on folder selection',async t=>{
 const elements=new Map(['document-preview-frame','document-preview-status','document-preview-refresh','document-preview-toggle','document-preview-body','document-preview-actions','document-preview-chevron','document-preview-toggle-label'].map(id=>[id,{hidden:true,disabled:false,textContent:'',srcdoc:'',setAttribute(name,value){this[name]=value;},removeAttribute(name){this[name]='';}}]));
 const originalDocument=globalThis.document;
 globalThis.document={getElementById:id=>elements.get(id)};
 t.after(()=>{if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;});
 const {initDocumentPreview}=await import('../src/web/client/preview.js');
 let selection={base:'/docs',file:'/docs/a.md',folder:false};const requests=[];
 const client=initDocumentPreview({selection:()=>selection,api:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))});
 await client.update();assert.equal(requests.length,0);
 const first=elements.get('document-preview-toggle').onclick();selection={...selection,file:'/docs/b.md'};const second=client.update();
 requests[1].resolve({html:'<p>B</p>'});await second;
 requests[0].resolve({html:'<p>A</p>'});await first;
 const frame=elements.get('document-preview-frame');assert.equal(frame.srcdoc,'<p>B</p>');assert.equal(frame.hidden,false);
 const toggle=elements.get('document-preview-toggle');await toggle.onclick();assert.equal(toggle['aria-expanded'],'false');assert.equal(elements.get('document-preview-body').hidden,true);
 await client.update();assert.equal(requests.length,2);await toggle.onclick();assert.equal(requests.length,2);assert.equal(elements.get('document-preview-refresh').disabled,false);
 await toggle.onclick();selection={...selection,file:'/docs/c.md'};await client.update();assert.equal(requests.length,2);assert.equal(frame.srcdoc,'');
 const pending=toggle.onclick();assert.equal(requests.length,3);await toggle.onclick();requests[2].resolve({html:'<p>C</p>'});await pending;assert.equal(frame.srcdoc,'');
 const reopened=toggle.onclick();requests[3].resolve({html:'<p>C</p>'});await reopened;
 selection={...selection,folder:true};await client.update();assert.equal(frame.hidden,true);assert.equal(frame.srcdoc,'');
 assert.equal(elements.get('document-preview-refresh').disabled,true);
 selection={...selection,folder:false};const failed=client.update();requests[4].reject(new Error('missing'));await failed;
 assert.match(elements.get('document-preview-status').textContent,/missing/);assert.equal(frame.hidden,true);
});

test('table-format HTTP flow authorizes preview/save and writes only a reviewed plan',async t=>{
 const {sourceHash}=await import('../dist/web/table-format.js');
 const {root,put}=workspace(t);const source='# Heading\n\n| A | B |\n| --- | --- |\n| X | Y |\n';const file=put('doc.md',source);
 const {server,url}=await startWeb({start:root,port:0});t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const response=await fetch(url);const shell=await response.text();const token=shell.match(/name="csync-token" content="([^"]+)"/)[1];
 const headers={'Content-Type':'application/json','X-Csync-Token':token};
 const post=(path,body,extra={})=>fetch(url+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 assert.equal((await post('/api/table-format/save',{planId:'unknown'},{'X-Csync-Token':'wrong'})).status,403);
 assert.equal((await post('/api/table-format/save',{planId:'unknown'},{Origin:'https://evil.invalid'})).status,403);
 assert.equal((await post('/api/table-format/save',{planId:'unknown'})).status,400);
 const preview=await post('/api/table-format/preview',{base:root,file,hash:sourceHash(source),index:0,widths:[100,660]});
 assert.equal(preview.status,200);const plan=await preview.json();assert.equal(readFileSync(file,'utf8'),source);
 const saved=await post('/api/table-format/save',{planId:plan.planId});assert.equal(saved.status,200);assert.equal(readFileSync(file,'utf8'),plan.after);
 assert.equal((await post('/api/table-format/preview',{base:root,file,hash:sourceHash(source),index:0,widths:[100,660]})).status,400);
 const document=await(await post('/api/document-preview',{base:root,file})).json();
 const parsed=createDocument(document.html);assert.equal(parsed.querySelectorAll('script').length,1);assert.equal(parsed.querySelectorAll('script:not([nonce])').length,0);
 assert.match(response.headers.get('content-security-policy'),/nonce-/);
});
