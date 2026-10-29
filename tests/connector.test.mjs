import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,existsSync,rmSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {startWeb,deployedUi} from '../dist/web/server.js';import {tableEditorBridge} from '../dist/web/table-editor-script.js';import {workspace} from './helpers/fixtures.mjs';
const origin='https://ui.example.invalid';
async function runner(t,options={}){
 const {root}=workspace(t,{'a.md':'# Original\n\nLocal file'});const app=await startWeb({start:root,port:0,ui:origin,...options});t.after(()=>new Promise(done=>{app.server.close(done);app.server.closeAllConnections()}));
 const fragment=new URLSearchParams(new URL(app.connectUrl).hash.slice(1)),key=fragment.get('csyncToken');return {...app,root,key,headers:{Origin:origin,'X-Csync-Token':key}};
}
test('trusted UI needs both the exact Origin and its private key; local token never authorizes remote access',async t=>{
 const s=await runner(t);const localHtml=await(await fetch(s.url)).text(),localToken=localHtml.match(/name="csync-token" content="([^"]+)"/)[1];assert.notEqual(localToken,s.key);assert.equal(new URL(s.connectUrl).origin,origin);
 for(const headers of [{Origin:origin},{Origin:'https://evil.example', 'X-Csync-Token':s.key},{'X-Csync-Token':s.key},{Origin:origin,'X-Csync-Token':localToken},{Origin:'null','X-Csync-Token':s.key}])assert.equal((await fetch(s.url+'/api/browse',{headers})).status,403);
 const connection=await fetch(s.url+'/api/connection',{headers:s.headers});assert.equal(connection.status,200);assert.equal(connection.headers.get('access-control-allow-origin'),origin);assert.equal((await connection.json()).mode,'connector');assert.equal((await fetch(s.url,{headers:s.headers})).status,403);
 assert.equal((await fetch(s.url+'/api/browse',{headers:{'X-Csync-Token':localToken}})).status,200);
});
test('CORS preflight allows only explicit local API operations and never allows arbitrary headers or origins',async t=>{
 const s=await runner(t);const headers={Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-csync-token','Access-Control-Request-Private-Network':'true'};
 const response=await fetch(s.url+'/api/document-preview',{method:'OPTIONS',headers});assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-private-network'),'true');assert.equal(response.headers.get('access-control-allow-credentials'),null);
 for(const extra of [{'Access-Control-Request-Method':'DELETE'},{'Access-Control-Request-Headers':'authorization'},{Origin:'https://evil.example'}])assert.equal((await fetch(s.url+'/api/browse',{method:'OPTIONS',headers:{...headers,...extra}})).status,403);
});
test('deployed UI can browse, preview, convert and save only through the local runner',async t=>{
 const s=await runner(t);const post=(path,body)=>fetch(s.url+path,{method:'POST',headers:{...s.headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const listing=await(await fetch(s.url+'/api/browse',{headers:s.headers})).json();assert.equal(listing.entries[0].name,'a.md');
 const preview=await post('/api/document-preview',{base:s.root,file:join(s.root,'a.md')});assert.equal(preview.status,200);assert.match((await preview.json()).html,/Local file/);
 const out=s.root+'-output';t.after(()=>rmSync(out,{recursive:true,force:true}));const converted=await post('/api/convert',{base:s.root,file:join(s.root,'a.md'),to:'repair',fix:false,preview:false,out});assert.equal(converted.status,200,await converted.text());assert.equal(readFileSync(join(out,'a.md'),'utf8'),'# Original\n\nLocal file');assert.equal(readFileSync(join(s.root,'a.md'),'utf8'),'# Original\n\nLocal file');
});
test('connector keys expire when the local runner restarts and insecure public UI addresses are rejected',async t=>{
 const first=await runner(t),second=await runner(t);assert.notEqual(first.key,second.key);assert.equal((await fetch(second.url+'/api/browse',{headers:first.headers})).status,403);
 for(const value of ['http://public.example','https://user:pass@example.com','https://ui.example/#secret','https://ui.example/?token=secret','file:///tmp'])assert.throws(()=>deployedUi(value));assert.equal(deployedUi('http://127.0.0.1:8080/').origin,'http://127.0.0.1:8080');
});
test('static deployment output has no local token or backend and allows only the bundled table bridge',()=>{
 const html=readFileSync('dist/site/index.html','utf8');assert.match(html,/name="csync-token" content=""/);assert.match(html,/local-connect-dialog/);assert.ok(existsSync('dist/site/assets/app.js'));assert.equal(existsSync('dist/site/.env'),false);assert.equal(existsSync('dist/site/server.js'),false);
 const hash=createHash('sha256').update(`(${tableEditorBridge.toString()})()`).digest('base64');assert.ok(html.includes(`'sha256-${hash}'`));assert.match(html,/connect-src 'self' http:\/\/127\.0\.0\.1:\*/);assert.doesNotMatch(html,/script-src[^;]*unsafe-inline/);
});
