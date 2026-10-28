import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workspace,mockFetch} from './helpers/fixtures.mjs';
import {bindScope} from './helpers/scope.mjs';
import {mappingPass} from '../dist/sync/pull.js';
import {mappingPath} from '../dist/sync/metadata.js';
import {fetchRemote} from '../dist/sync/fetch.js';
import {changeStaging} from '../dist/sync/staging.js';
const ansi=/\x1b\[[0-9;]*m/g;
const plain=text=>text.replace(ansi,'');
function environment(extra={}){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['FORCE_COLOR','NO_COLOR','NODE_DISABLE_COLORS','TERM'].includes(key)&&!key.startsWith('CONFLUENCE_')));
 return {...env,TERM:'xterm-256color',...extra};
}
const colors=pathToFileURL(resolve('dist/shared/colors.js')).href;
for(const [name,tty,env,args,on] of [
 ['terminal default',true,{},[],true],
 ['pipe default',false,{},[],false],
 ['forced pipe',false,{FORCE_COLOR:'1'},[],true],
 ['explicit option wins',true,{FORCE_COLOR:'1'},['--no-color'],false],
 ['NO_COLOR wins',true,{NO_COLOR:'1',FORCE_COLOR:'1'},[],false],
 ['dumb terminal wins',true,{TERM:'dumb',FORCE_COLOR:'1'},[],false],
 ['FORCE_COLOR=0 disables terminal color',true,{FORCE_COLOR:'0'},[],false],
])test(`color detection: ${name}`,()=>{
 const script=`Object.defineProperty(process.stdout,'isTTY',{value:${tty}});const c=await import(${JSON.stringify(colors)});process.stdout.write(c.red('message'));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script,'--',...args],{encoding:'utf8',env:environment(env)});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,on?'\x1b[31mmessage\x1b[39m':'message');
});

async function fixture(t){
 const files={'a-incoming.md':'# Incoming','b-conflict.md':'# Conflict','c-selected.md':'# Selected','d-local.md':'# Local','e-attention.md':'# Attention'};
 const {root,put}=workspace(t,files);bindScope(root,{scope:{id:'100',type:'page'},connection:{homepageId:'100'}});
 const paths=Object.keys(files),ids=paths.map((_,i)=>String(201+i));
 await mappingPass(root,mappingPath(root),new Map(paths.map((p,i)=>[ids[i],join(root,p)])),new Map(),new Map(ids.map(id=>[id,1])));
 const env={baseUrl:'https://example.invalid/wiki',spaceKey:'TEST',email:'demo@example.invalid',token:'synthetic-token'};
 mockFetch(t,[{path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100',body:{results:ids.map(id=>({id,spaceId:'space',parentId:'100',version:{number:['201','202'].includes(id)?2:1}}))}}]);
 await fetchRemote(root,env);
 for(const path of paths.slice(1))put(path,files[path]+'\n\nFirst edit\n');
 await changeStaging(root,['c-selected.md','e-attention.md'],'add',{baseUrl:env.baseUrl});put('e-attention.md','# Attention\n\nSecond edit\n');
 return {root,env:environment({CONFLUENCE_BASE_URL:env.baseUrl,CONFLUENCE_SPACE_KEY:env.spaceKey,CONFLUENCE_EMAIL:env.email,CONFLUENCE_API_TOKEN:env.token})};
}
function run(root,env,args,extra={}){return spawnSync(process.execPath,[resolve('dist/sync.js'),...args,'--base',root],{cwd:root,env:{...env,...extra},encoding:'utf8'});}

test('status uses semantic colors and disabling color preserves the exact readable text',async t=>{
 const {root,env}=await fixture(t);const colored=run(root,env,['status'],{FORCE_COLOR:'1'});
 assert.equal(colored.status,0,colored.stderr);
 for(const text of ['\x1b[36m↓ 받을 변경','\x1b[31m! 양쪽 변경','\x1b[33m! 확인 필요','\x1b[34m↑ 보낼 변경','\x1b[32m[추가됨]','\x1b[33m[재추가 필요]'])assert.ok(colored.stdout.includes(text),text);
 for(const [args,extra]of [[['status'],{}],[['status','--no-color'],{FORCE_COLOR:'1'}],[['status'],{NO_COLOR:'1',FORCE_COLOR:'1'}],[['status'],{FORCE_COLOR:'0'}]]){
  const result=run(root,env,args,extra);assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/\x1b\[/);assert.equal(result.stdout,plain(colored.stdout));
 }
});

test('diff colors only presentation; addition, deletion and uncolored diff contents match',async t=>{
 const {root,env}=await fixture(t);const args=['diff','c-selected.md'];const colored=run(root,env,args,{FORCE_COLOR:'1'}),uncolored=run(root,env,args);
 assert.equal(colored.status,0,colored.stderr);assert.match(colored.stdout,/\x1b\[31m-/);assert.match(colored.stdout,/\x1b\[32m\+/);assert.match(colored.stdout,/\x1b\[36m@@/);assert.equal(plain(colored.stdout),uncolored.stdout);
});

test('Fetch colorizes the cached metadata result without making another API request',async t=>{
 const {root,env}=await fixture(t);const colored=run(root,env,['fetch'],{FORCE_COLOR:'1'}),uncolored=run(root,env,['fetch']);
 assert.equal(colored.status,0,colored.stderr);assert.match(colored.stdout,/\x1b\[36m\[원격 변경\]/);assert.match(plain(colored.stdout),/이번 API 요청: 0회/);assert.equal(plain(colored.stdout),uncolored.stdout);
});

test('top-level errors support color and explicit opt-out without changing the exit code',t=>{
 const {root}=workspace(t);const env=environment({FORCE_COLOR:'1'});const colored=run(root,env,['unknown']),uncolored=run(root,env,['unknown','--no-color']);
 assert.equal(colored.status,1);assert.equal(uncolored.status,1);assert.match(colored.stderr,/\x1b\[31m/);assert.equal(plain(colored.stderr),uncolored.stderr);
});
