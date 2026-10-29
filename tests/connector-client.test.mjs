import test from 'node:test';import assert from 'node:assert/strict';
import {createConnection,loopbackEndpoint} from '../src/web/client/connection.js';
function fixture({hash='',saved,localToken='',response={mode:'connector',version:'2.0.0'},fetch:run}={}){
 const nodes=new Map(['local-connect-dialog','local-connect-form','local-connect-note','local-connect-submit','local-connect-endpoint','local-connect-token','local-disconnect','workspace-interface','local-connection-status','local-connect-command'].map(id=>[id,{value:'',textContent:'',disabled:false,hidden:true,inert:false,open:false,showModal(){this.open=true},close(){this.open=false},addEventListener(){}}]));
 const data=new Map(saved?[['csync.connector.v1',JSON.stringify(saved)]]:[]),calls=[],historyCalls=[];
 const storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const location={hash,pathname:'/',search:'',origin:'https://ui.example',reload(){this.reloaded=true}};
 const document={getElementById:id=>nodes.get(id),querySelector:q=>({content:q.includes('version')?'2.0.0':localToken})};
 const connection=createConnection({document,location,storage,history:{replaceState:(...a)=>historyCalls.push(a)},fetch:async(url,options)=>{calls.push({url,options});return run?run(url,options):{ok:true,json:async()=>response}}});
 return {connection,nodes,data,calls,historyCalls,location,submit:()=>nodes.get('local-connect-form').onsubmit({preventDefault(){}})};
}
const token='a'.repeat(64);
test('only literal loopback endpoints are accepted before sending credentials',()=>{
 assert.equal(loopbackEndpoint('http://127.0.0.1:4318'),'http://127.0.0.1:4318');
 for(const url of ['https://evil.example','http://127.0.0.1.evil.example','http://user@localhost:4318','http://localhost:4318/api','http://localhost:4318/?x=1','file:///tmp'])assert.throws(()=>loopbackEndpoint(url));
});
test('deployment requires explicit connection; fragment is scrubbed and never sent to hosting',async()=>{
 const s=fixture({hash:'#'+new URLSearchParams({csyncEndpoint:'http://127.0.0.1:4318',csyncToken:token})});assert.equal(s.calls.length,0);assert.equal(s.nodes.get('workspace-interface').inert,true);assert.equal(s.nodes.get('local-connect-dialog').open,true);assert.deepEqual(s.historyCalls[0],[null,'','/']);await s.submit();await s.connection.ready;
 assert.equal(s.nodes.get('local-connect-dialog').open,false);assert.equal(s.nodes.get('workspace-interface').inert,false);assert.equal(s.calls[0].url,'http://127.0.0.1:4318/api/connection');assert.equal(s.calls[0].options.targetAddressSpace,'loopback');assert.equal(s.calls[0].options.redirect,'error');
 await s.connection.request('/api/browse');assert.equal(s.calls.at(-1).options.headers['X-Csync-Token'],token);assert.equal(s.calls.at(-1).url,'http://127.0.0.1:4318/api/browse');assert.throws(()=>s.connection.request('//evil.example'));assert.ok(s.data.has('csync.connector.v1'));
});
test('invalid endpoint or key never triggers a request and version mismatch never enables files',async()=>{
 const s=fixture();s.nodes.get('local-connect-endpoint').value='https://evil.example';s.nodes.get('local-connect-token').value=token;await s.submit();assert.equal(s.calls.length,0);assert.equal(s.nodes.get('workspace-interface').inert,true);
 const mismatch=fixture({response:{mode:'connector',version:'1.0.0'}});mismatch.nodes.get('local-connect-endpoint').value='http://localhost:4318';mismatch.nodes.get('local-connect-token').value=token;await mismatch.submit();assert.match(mismatch.nodes.get('local-connect-note').textContent,/버전이 다릅니다/);assert.equal(mismatch.data.size,0);assert.equal(mismatch.nodes.get('workspace-interface').inert,true);
});
test('tab reload can restore a session; disconnect clears the key and resets all UI state',async()=>{
 const s=fixture({saved:{endpoint:'http://127.0.0.1:4318',token}});await s.connection.ready;assert.equal(s.calls.length,1);s.nodes.get('local-disconnect').onclick();assert.equal(s.data.size,0);assert.equal(s.location.reloaded,true);assert.throws(()=>s.connection.request('/api/browse'),/연결/);
});
test('expired sessions open a reconnect dialog and local web keeps its existing transport',async()=>{
 const s=fixture({saved:{endpoint:'http://localhost:4318',token},fetch:async()=>({ok:false,json:async()=>({error:'Expired'})})});await new Promise(resolve=>setImmediate(resolve));assert.equal(s.nodes.get('local-connect-dialog').open,true);assert.equal(s.data.size,0);assert.match(s.nodes.get('local-connect-note').textContent,/Expired/);
 const local=fixture({localToken:'local-only'});await local.connection.ready;await local.connection.request('/api/browse');assert.equal(local.calls[0].url,'/api/browse');assert.equal(local.calls[0].options.headers['X-Csync-Token'],'local-only');assert.equal(local.nodes.get('local-connect-dialog').open,false);
});
