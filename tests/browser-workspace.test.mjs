import test from 'node:test';import assert from 'node:assert/strict';
import {scanBrowserFiles,applyBrowserChanges,sha256} from '../src/web/client/browser-workspace.js';
class Directory {
 constructor(name='docs',events=[]){this.name=name;this.kind='directory';this.items=new Map();this.events=events;}
 async *entries(){yield* this.items.entries()}
 async getDirectoryHandle(name,{create=false}={}){if(!this.items.has(name)&&create)this.items.set(name,new Directory(name,this.events));const item=this.items.get(name);if(!item||item.kind!=='directory')throw Object.assign(Error('missing'),{name:'NotFoundError'});return item;}
 async getFileHandle(name,{create=false}={}){if(!this.items.has(name)&&create)this.put(name,'');const item=this.items.get(name);if(!item||item.kind!=='file')throw Object.assign(Error('missing'),{name:'NotFoundError'});return item;}
 async removeEntry(name){this.events.push('remove:'+name);this.items.delete(name)}
 put(name,text){const self=this;const item={kind:'file',name,bytes:new TextEncoder().encode(text),stamp:Date.now(),async getFile(){return new File([this.bytes],name,{lastModified:this.stamp})},async createWritable(){let bytes;return {async write(value){bytes=new Uint8Array(value);},async close(){self.events.push('write:'+name);if(self.fail===name)throw Error('write failed');item.bytes=bytes;item.stamp++;self.onWrite?.(name)},async abort(){}}}};this.items.set(name,item);return item;}
 text(name){return new TextDecoder().decode(this.items.get(name).bytes)}
}
const file=async(path,text)=>({path,size:new TextEncoder().encode(text).length,hash:await sha256(new TextEncoder().encode(text))});
const download=values=>async path=>new TextEncoder().encode(values[path]).buffer;
test('browser scan includes documents, attachments, env and metadata while excluding unrelated app folders',async()=>{
 const root=new Directory();root.put('a.md','A');root.put('.env','private');root.put('.secret','skip');root.items.set('.git',new Directory('.git'));const notes=await root.getDirectoryHandle('notes',{create:true});notes.put('b.md','B');const meta=await root.getDirectoryHandle('.csync',{create:true});meta.put('mapping.json','{}');const files=await scanBrowserFiles([{virtual:'/workspace/docs',handle:root}]);assert.deepEqual(files.map(f=>f.path),['/workspace/docs/.csync/mapping.json','/workspace/docs/.env','/workspace/docs/a.md','/workspace/docs/notes/b.md']);
});
test('all local changes are checked before the first write; unchanged local bytes may be replaced',async()=>{
 const root=new Directory();root.put('a.md','old');root.put('b.md','edited');const mount=[{virtual:'/w',handle:root}];const baseline=[await file('/w/a.md','old'),await file('/w/b.md','old')],changes={files:[await file('/w/a.md','new'),await file('/w/b.md','new')],removed:[]};
 await assert.rejects(applyBrowserChanges(mount,baseline,changes,download({'/w/a.md':'new','/w/b.md':'new'})),/로컬 파일이 바뀌/);assert.equal(root.text('a.md'),'old');assert.deepEqual(root.events,[]);
});
test('attachments and document writes precede metadata; identical resumed results are adopted without overwriting',async()=>{
 const root=new Directory();root.put('a.md','old');const meta=await root.getDirectoryHandle('.csync',{create:true});meta.put('mapping.json','old-map');const mounts=[{virtual:'/w',handle:root}],baseline=[await file('/w/a.md','old'),await file('/w/.csync/mapping.json','old-map')];const changes={files:[await file('/w/.csync/mapping.json','new-map'),await file('/w/a.md','new'),await file('/w/image.png','image')],removed:[]};const values={'/w/.csync/mapping.json':'new-map','/w/a.md':'new','/w/image.png':'image'};
 await applyBrowserChanges(mounts,baseline,changes,download(values));assert.deepEqual(root.events,['write:image.png','write:a.md','write:mapping.json']);let reads=0;await applyBrowserChanges(mounts,baseline,changes,async()=>{reads++;throw Error('not needed')});assert.equal(reads,0);assert.equal(root.text('a.md'),'new');
});
test('partial browser write failures restore unchanged writes and leave the original mapping intact',async()=>{
 const root=new Directory();root.put('a.md','old');const meta=await root.getDirectoryHandle('.csync',{create:true});meta.put('mapping.json','old-map');meta.fail='mapping.json';const mounts=[{virtual:'/w',handle:root}],baseline=[await file('/w/a.md','old'),await file('/w/.csync/mapping.json','old-map')];
 await assert.rejects(applyBrowserChanges(mounts,baseline,{files:[await file('/w/a.md','new'),await file('/w/.csync/mapping.json','new-map')],removed:[]},download({'/w/a.md':'new','/w/.csync/mapping.json':'new-map'})),/write failed/);assert.equal(root.text('a.md'),'old');assert.equal(meta.text('mapping.json'),'old-map');
});
test('concurrent edits made during application are never overwritten during rollback',async()=>{
 const root=new Directory();root.put('a.md','old');root.put('b.md','old');root.onWrite=name=>{if(name==='a.md'){root.items.get('a.md').bytes=new TextEncoder().encode('user-a');root.items.get('b.md').bytes=new TextEncoder().encode('user-b')}};const mounts=[{virtual:'/w',handle:root}],baseline=[await file('/w/a.md','old'),await file('/w/b.md','old')];
 await assert.rejects(applyBrowserChanges(mounts,baseline,{files:[await file('/w/a.md','new'),await file('/w/b.md','new')],removed:[]},download({'/w/a.md':'new','/w/b.md':'new'})),/확인이 필요한 파일/);assert.equal(root.text('a.md'),'user-a');assert.equal(root.text('b.md'),'user-b');
});
test('unknown paths, readonly references and mismatching downloaded bytes are rejected',async()=>{
 const root=new Directory();const mounts=[{virtual:'/w',handle:root}];for(const path of ['/etc/passwd','/w/../x'])await assert.rejects(applyBrowserChanges(mounts,[],{files:[await file(path,'x')],removed:[]},download({[path]:'x'})));
 await assert.rejects(applyBrowserChanges([{...mounts[0],readonly:true}],[],{files:[await file('/w/a.md','x')],removed:[]},download({'/w/a.md':'x'})),/참조/);
 await assert.rejects(applyBrowserChanges(mounts,[],{files:[await file('/w/a.md','x')],removed:[]},download({'/w/a.md':'wrong'})),/결과 파일이 바뀌/);assert.equal(root.items.size,0);
});

test('explicit operations can rehash files even when size and modification time are unchanged',async()=>{
 const root=new Directory();root.put('a.md','old');const mounts=[{virtual:'/w',handle:root}],cache=new Map(),before=await scanBrowserFiles(mounts,cache);root.items.get('a.md').bytes=new TextEncoder().encode('new');const refreshed=await scanBrowserFiles(mounts,cache,true);assert.notEqual(before[0].hash,refreshed[0].hash);
});
