import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudTarget,createConfluenceGateway,authorizeBlobUpload,transferPrefix} from '../src/web/gateway.mjs';
import {createConfluenceTransport,transferPrefix as browserPrefix} from '../src/web/client/confluence-transport.js';
import {build} from 'esbuild';
import {browserPlatform} from '../scripts/browser-platform.mjs';
const target='https://example.atlassian.net/wiki/rest/api/content/123/child/attachment';
const authorization='Basic '+Buffer.from('demo@example.com:synthetic-secret').toString('base64');
const request=(url=target,{method='GET',headers={},body}={})=>new Request('https://csync.example/api/confluence',{method:'POST',headers:{origin:'https://csync.example',authorization,'x-csync-target':url,'x-csync-method':method,...headers},body});
test('gateway only accepts Cloud API paths and disallows private hosts, foreign origins and remote DELETE',async()=>{
 for(const value of ['http://example.atlassian.net/wiki/api/v2/pages','https://localhost/wiki/api/v2/pages','https://example.atlassian.net.evil.com/wiki/api/v2/pages','https://api.atlassian.com/arbitrary','https://user:password@example.atlassian.net/wiki/api/v2/pages','https://example.atlassian.net:8443/wiki/api/v2/pages','https://example.atlassian.net/wiki/api%2fv2/pages'])assert.throws(()=>cloudTarget(value));
 assert.equal(cloudTarget('https://api.atlassian.com/ex/confluence/8ce0b60b-f869-4105-8b1f-1215636b2a45/wiki/api/v2/pages').hostname,'api.atlassian.com');
 let calls=0;const gateway=createConfluenceGateway({fetch:async()=>{calls++;return Response.json({ok:true});}});
 assert.equal((await gateway(request(target,{headers:{origin:'https://evil.example'}}))).status,403);
 assert.equal((await gateway(request(target,{method:'DELETE'}))).status,400);
 assert.equal((await gateway(request('https://127.0.0.1/wiki/api/v2/pages'))).status,400);assert.equal(calls,0);
});
test('gateway streams large downloads and only forwards necessary headers',async()=>{
 let received;const bytes=new Uint8Array(6*1024*1024);bytes[bytes.length-1]=97;
 const gateway=createConfluenceGateway({fetch:async(url,init)=>{received={url,init};return new Response(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),{headers:{'content-type':'image/png','set-cookie':'private=secret','atl-traceid':'trace',link:'</wiki/api/v2/pages?cursor=next>; rel="next"'}});}});
 const response=await gateway(request(target,{headers:{cookie:'must-not-forward=1'}}));assert.equal(response.status,200);assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('atl-traceid'),'trace');assert.match(response.headers.get('link'),/cursor=next/);assert.equal(received.init.headers.cookie,undefined);assert.equal(received.init.headers.Authorization,authorization);assert.equal((await response.arrayBuffer()).byteLength,bytes.length);
});
test('attachment redirects drop credentials and reject untrusted or insecure destinations',async()=>{
 const calls=[];const gateway=createConfluenceGateway({fetch:async(url,init)=>{calls.push({url,headers:{...init.headers}});return calls.length===1?new Response(null,{status:302,headers:{location:'https://api.media.atlassian.com/file/123/binary?token=signed'}}):new Response('file');}});
 assert.equal(await(await gateway(request(target))).text(),'file');assert.equal(calls[0].headers.Authorization,authorization);assert.equal(calls[1].headers.Authorization,undefined);
 for(const location of ['http://127.0.0.1/secret','https://evil.example/file']){let n=0;const g=createConfluenceGateway({fetch:async()=>{n++;return new Response(null,{status:302,headers:{location}});}});assert.equal((await g(request(target))).status,400);assert.equal(n,1);}
});
test('private uploads belong to the current target and credentials and are cleaned after forwarding or failure',async()=>{
 const prefix=transferPrefix(authorization,target);assert.equal(await browserPrefix(authorization,target),prefix);
 const blob='https://store.private.blob.vercel-storage.com/'+prefix+'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';const deleted=[];let writes=0,reads=0;
 const gateway=createConfluenceGateway({readBlob:async()=>{reads++;return {statusCode:200,blob:{size:4},stream:new Blob(['data']).stream()};},deleteBlob:async path=>deleted.push(path),fetch:async(_url,init)=>{writes++;assert.equal(await new Response(init.body).text(),'data');return Response.json({id:'1'});}});
 const result=await gateway(request(target,{method:'POST',headers:{'x-csync-upload':blob}}));assert.equal(result.status,200);assert.deepEqual(deleted,[blob]);assert.equal(writes,1);
 assert.equal((await gateway(request(target,{method:'POST',headers:{'x-csync-upload':blob.replace(prefix,'csync-transfer/other/')}}))).status,400);assert.equal(reads,1);
 const failing=createConfluenceGateway({readBlob:async()=>({statusCode:200,blob:{size:4},stream:new Blob(['data']).stream()}),deleteBlob:async path=>deleted.push(path),fetch:async()=>{throw Error('sensitive credentials must not appear');}});
 const r=await failing(request(target,{method:'POST',headers:{'x-csync-upload':blob}}));assert.equal(r.status,400);assert.doesNotMatch(await r.text(),/sensitive credentials/);assert.equal(deleted.length,2);
});
test('Blob token creation authenticates Confluence before allocating storage',async()=>{
 const path=transferPrefix(authorization,target)+'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',payload=JSON.stringify({target,authorization});let calls=0;
 const options=await authorizeBlobUpload(path,payload,{fetch:async(url,init)=>{calls++;assert.equal(url.href,'https://example.atlassian.net/wiki/rest/api/content?limit=1');assert.equal(init.headers.Authorization,authorization);return Response.json({results:[]});}});assert.equal(calls,1);assert.equal(options.allowOverwrite,false);assert.ok(options.maximumSizeInBytes>100*1024*1024);
 await assert.rejects(authorizeBlobUpload(path.replace('csync-transfer/','foreign/'),payload,{fetch:async()=>{calls++;}}));assert.equal(calls,1);
 await assert.rejects(authorizeBlobUpload(path,payload,{fetch:async()=>new Response(null,{status:401})}));
});
test('browser bridge sends small bodies directly and large multipart bodies through private storage',async()=>{
 const calls=[],uploads=[];const fetch=createConfluenceTransport({origin:'https://csync.example',fetch:async(url,options)=>{calls.push({url,options});return Response.json({ok:true});},uploadFile:async(path,blob,options)=>{uploads.push({path,blob,options});return {url:'https://store.private.blob.vercel-storage.com/'+path};}});
 await fetch(target,{method:'POST',headers:{authorization,'content-type':'application/json'},body:'{}'});assert.equal(calls[0].url,'https://csync.example/api/confluence');assert.equal(calls[0].options.headers['X-Csync-Target'],target);assert.equal(new TextDecoder().decode(calls[0].options.body),'{}');assert.equal(uploads.length,0);
 const form=new FormData();form.append('file',new Blob([new Uint8Array(4*1024*1024)]),'large.bin');await fetch(target,{method:'POST',headers:{authorization,'x-atlassian-token':'nocheck'},body:form});assert.equal(uploads.length,1);assert.equal(uploads[0].options.access,'private');assert.equal(calls[1].options.body,undefined);assert.ok(calls[1].options.headers['X-Csync-Upload']);assert.match(calls[1].options.headers['content-type'],/^multipart\/form-data; boundary=/);
});
test('real browser Blob SDK uses its own network path, not the Confluence bridge',async t=>{
 const bundled=await build({entryPoints:['src/web/client/confluence-transport.js'],bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent',plugins:[browserPlatform()],inject:['src/runtime/browser/globals.js']});
 const nativeCalls=[],relayed=[];let pathname;
 t.mock.method(globalThis,'fetch',async(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url),headers=new Headers(init.headers);nativeCalls.push(url.href);
  if(url.pathname==='/api/blob-upload'){
   const body=JSON.parse(init.body);pathname=body.payload.pathname;
   const payload={pathname,validUntil:Date.now()+600_000,maximumSizeInBytes:105*1024*1024};
   const encoded=Buffer.from('signature.'+Buffer.from(JSON.stringify(payload)).toString('base64')).toString('base64');
   return Response.json({clientToken:'vercel_blob_client_store_'+encoded});
  }
  assert.equal(url.origin,'https://vercel.com');assert.match(url.pathname,/^\/api\/blob/);
  const action=headers.get('x-mpu-action');
  if(action==='create')return Response.json({key:pathname,uploadId:'synthetic-upload'});
  if(action==='upload')return Response.json({etag:'synthetic-etag'});
  if(action==='complete')return Response.json({url:'https://store.private.blob.vercel-storage.com/'+pathname,downloadUrl:'https://store.private.blob.vercel-storage.com/'+pathname,pathname,contentType:'application/octet-stream',contentDisposition:'attachment'});
  assert.fail('Unexpected Blob action '+action);
 });
 const {createConfluenceTransport:browserBridge}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
 const fetch=browserBridge({origin:'https://csync.example',fetch:async(url,options)=>{relayed.push({url,options});return Response.json({ok:true});}});
 const form=new FormData();form.append('file',new Blob([new Uint8Array(4*1024*1024)]),'large.png');
 await fetch(target,{method:'POST',headers:{authorization,'x-atlassian-token':'nocheck'},body:form});
 assert.equal(relayed.length,1);assert.equal(relayed[0].url,'https://csync.example/api/confluence');assert.ok(relayed[0].options.headers['X-Csync-Upload']);assert.equal(relayed[0].options.body,undefined);assert.ok(nativeCalls.length>=4);
});
