import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workspace} from './helpers/fixtures.mjs';
const moduleUrl=pathToFileURL(resolve('dist/shared/progress.js')).href;
const env=(extra={})=>({...Object.fromEntries(Object.entries(process.env).filter(([key])=>!['FORCE_COLOR','CI','TERM','NO_COLOR'].includes(key)&&!key.startsWith('CONFLUENCE_'))),TERM:'xterm-256color',NO_COLOR:'1',...extra});
const header=(tty=false)=>`Object.defineProperty(process.stdout,'isTTY',{value:${tty}});Object.defineProperty(process.stderr,'isTTY',{value:${tty}});Object.defineProperty(process.stderr,'columns',{value:60});const {withProgress,progressStep}=await import(${JSON.stringify(moduleUrl)});`;
function run(script,{tty=false,extra={}}={}){return spawnSync(process.execPath,['--input-type=module','-e',header(tty)+script],{env:env(extra),encoding:'utf8',timeout:5000});}

test('interactive progress animates phases, preserves stdout logs and restores console methods',()=>{
 const result=run(`const original=console.log;await withProgress('작업 확인',async()=>{await new Promise(r=>setTimeout(r,130));progressStep('원격 페이지 확인');console.log('durable log');console.error('durable warning');await new Promise(r=>setTimeout(r,130));});console.log('restored='+String(original===console.log));await new Promise(r=>setTimeout(r,140));`,{tty:true});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'durable log\nrestored=true\n');assert.match(result.stderr,/⠋|⠙/);assert.match(result.stderr,/원격 페이지 확인/);assert.match(result.stderr,/\r\x1b\[2K/);assert.match(result.stderr,/durable warning/);
 assert.equal((result.stderr.match(/✓ 완료/g)||[]).length,1);assert.match(result.stderr,/✓ 완료 · 작업 확인\n$/);assert.doesNotMatch(result.stderr,/\d+(?:\.\d+)?초/);
});

for(const extra of [{},{CI:'true'},{TERM:'dumb'}])test(`non-interactive progress has start/end logs without cursor escapes: ${JSON.stringify(extra)}`,()=>{
 const result=run(`await withProgress('조회',async()=>{progressStep('페이지 1/2');console.log('result');await new Promise(r=>setTimeout(r,120));});`,{tty:!!Object.keys(extra).length,extra});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'result\n');assert.match(result.stderr,/^진행 · 조회\n✓ 완료 · 조회/);assert.doesNotMatch(result.stderr,/\x1b|\r|⠋|⠙/);assert.equal(result.stderr.trim().split('\n').length,2);assert.doesNotMatch(result.stderr,/\d+(?:\.\d+)?초/);
});

test('failure restores output and listeners and never prints a success result',()=>{
 const result=run(`const original=console.error;const before=process.listenerCount('SIGINT');try{await withProgress('실패 작업',async()=>{await new Promise(r=>setTimeout(r,100));throw Error('original error');});}catch(error){console.error(error.message);}console.log(String(original===console.error)+':'+String(before===process.listenerCount('SIGINT')));`,{tty:true});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'true:true\n');assert.match(result.stderr,/✗ 실패 · 실패 작업/);assert.match(result.stderr,/original error/);assert.doesNotMatch(result.stderr,/✓ 완료/);
});

test('a command reporting partial failure by exitCode is not labelled successful',()=>{
 const result=run(`await withProgress('부분 처리',async()=>{process.exitCode=1;});`);
 assert.equal(result.status,1);assert.match(result.stderr,/✗ 실패/);assert.doesNotMatch(result.stderr,/✓ 완료/);
});

test('direct process.exit cleans up progress and reports its failure code',()=>{
 const result=run(`await withProgress('직접 종료',async()=>{process.exit(2);});`,{tty:true});
 assert.equal(result.status,2);assert.match(result.stderr,/✗ 실패 · 직접 종료/);assert.match(result.stderr,/\r\x1b\[2K/);assert.doesNotMatch(result.stderr,/✓ 완료/);
});

for(const signal of ['SIGINT','SIGTERM'])test(`${signal} clears terminal state before normal signal termination`,{skip:process.platform==='win32'},async()=>{
 const child=spawn(process.execPath,['--input-type=module','-e',header(true)+`await withProgress('중단 작업',async()=>{console.log('READY');await new Promise(r=>setTimeout(r,10000));});`],{env:env(),stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>errors+=chunk);
 const ready=new Promise(resolve=>child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('READY'))resolve();}));
 const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,closedSignal)=>resolve({code,signal:closedSignal}));});
 try{await ready;child.kill(signal);const result=await closed;assert.equal(result.signal,signal);assert.match(errors,/− 중단 · 중단 작업/);assert.doesNotMatch(errors,/✓ 완료/);}finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});

test('long and multiline phase labels stay on one transient terminal line',()=>{
 const result=run(`await withProgress('단계',async()=>{progressStep('긴한글'.repeat(80)+'\\nnext\\x1b[2J');await new Promise(r=>setTimeout(r,110));});`,{tty:true});
 assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stderr,/\x1b\[2J/);assert.match(result.stderr,/…/);
 for(const frame of result.stderr.split('\r\x1b[2K').slice(0,-1)){const visible=frame.replace(/\x1b\[[\d;]*m/g,'');assert.ok(visible.length<60);}
});

test('help, version and env template creation do not start background loading',t=>{
 const {root}=workspace(t);const cli=resolve('dist/sync.js');for(const args of [[],['--help'],['status','--help'],['--version'],['init']]){
  const result=spawnSync(process.execPath,[cli,...args],{cwd:root,env:env(),encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stderr,/진행 ·|완료 ·|\x1b/);
 }
});

test('spinner keeps rendering while synchronous Markdown-like work blocks the main event loop',async()=>{
 const script=header(true)+`await withProgress('동기 검사',async()=>{console.log('CPU_START');const until=performance.now()+1200;while(performance.now()<until){};console.log('CPU_END');await new Promise(r=>setTimeout(r,50));});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env:env(),stdio:['ignore','pipe','pipe']});
 let busy=false,frames=0,errors='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',text=>{if(text.includes('CPU_START'))busy=true;if(text.includes('CPU_END'))busy=false;});
 child.stderr.on('data',text=>{errors+=text;if(busy)frames+=(text.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g)||[]).length;});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 assert.equal(code,0,errors);assert.ok(frames>=4,`expected animation during CPU work, observed ${frames} frames`);assert.match(errors,/✓ 완료 · 동기 검사\n$/);assert.doesNotMatch(errors,/\d+(?:\.\d+)?초/);
});

test('worker drawing cannot split durable console lines during repeated synchronous work',()=>{
 const result=run(`await withProgress('로그 확인',async()=>{for(let i=0;i<10;i++){console.log('line-'+i);const until=performance.now()+40;while(performance.now()<until){}}});`,{tty:true});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,Array.from({length:10},(_,i)=>'line-'+i).join('\n')+'\n');assert.match(result.stderr,/✓ 완료 · 로그 확인\n$/);
});
