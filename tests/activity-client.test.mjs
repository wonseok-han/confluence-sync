import test from 'node:test';
import assert from 'node:assert/strict';
import {createActivity,describeRequest} from '../src/web/client/activity.js';
function fixture(t){
 const names=['activity-panel','activity-title','activity-detail','activity-elapsed','activity-link','sync-stage-checking','button','region'];
 const nodes=new Map(names.map(id=>{const attrs=new Map(),classes=new Set();return [id,{hidden:true,textContent:'',attrs,classes,getAttribute:name=>attrs.get(name)??null,setAttribute:(name,value)=>attrs.set(name,value),removeAttribute:name=>attrs.delete(name),classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),toggle:(name,on)=>on?classes.add(name):classes.delete(name)}}]}));
 const intervals=new Set(),delays=new Map();let clock=100000;
 t.mock.method(globalThis,'setInterval',fn=>{intervals.add(fn);return fn});t.mock.method(globalThis,'clearInterval',id=>intervals.delete(id));
 t.mock.method(globalThis,'setTimeout',fn=>{delays.set(fn,fn);return fn});t.mock.method(globalThis,'clearTimeout',id=>delays.delete(id));
 const control=createActivity({get:id=>nodes.get(id),now:()=>clock});
 return {nodes,intervals,delays,control,advance:ms=>{clock+=ms;for(const tick of intervals)tick();},flush:()=>{for(const fn of [...delays.values()]){delays.delete(fn);fn();}}};
}

test('foreground requests show immediate activity, button state, elapsed time and release all state',t=>{
 const s=fixture(t);const task=s.control.begin({label:'원격 조회',button:'button',region:'region'});
 assert.equal(s.nodes.get('activity-panel').hidden,false);assert.equal(s.nodes.get('activity-title').textContent,'원격 조회');assert.equal(s.nodes.get('button').getAttribute('aria-busy'),'true');assert.ok(s.nodes.get('button').classes.has('is-loading'));
 s.advance(65000);assert.equal(s.nodes.get('activity-elapsed').textContent,'1분 5초 경과');task.end();task.end();
 assert.equal(s.nodes.get('activity-panel').hidden,true);assert.equal(s.nodes.get('region').getAttribute('aria-busy'),null);assert.equal(s.nodes.get('button').classes.has('is-loading'),false);assert.equal(s.intervals.size,0);
});

test('overlapping request and job tokens keep shared buttons loading until both finish',t=>{
 const s=fixture(t);s.nodes.get('region').setAttribute('aria-busy','false');
 const job=s.control.begin({label:'Fetch 작업',button:'button',region:'region',startedAt:new Date(70000).toISOString()});
 const request=s.control.begin({label:'목록 갱신',button:'button',region:'region'});assert.equal(s.nodes.get('activity-title').textContent,'목록 갱신');
 request.end();assert.equal(s.nodes.get('activity-title').textContent,'Fetch 작업');assert.equal(s.nodes.get('button').getAttribute('aria-busy'),'true');assert.equal(s.nodes.get('activity-elapsed').textContent,'30초 경과');
 job.end();assert.equal(s.nodes.get('region').getAttribute('aria-busy'),'false');assert.equal(s.intervals.size,0);
});

test('background checks never show the global panel or affect button/region busy state, and fast checks do not flash',t=>{
 const s=fixture(t);const fast=s.control.begin({label:'로컬 확인',background:true,button:'button',region:'region'});fast.end();s.flush();
 assert.equal(s.nodes.get('activity-panel').hidden,true);assert.equal(s.nodes.get('sync-stage-checking').classes.has('is-checking'),false);
 const slow=s.control.begin({label:'로컬 확인',background:true,button:'button',region:'region'});s.flush();
 assert.equal(s.nodes.get('sync-stage-checking').classes.has('is-checking'),true);assert.equal(s.nodes.get('button').getAttribute('aria-busy'),null);assert.equal(s.nodes.get('region').getAttribute('aria-busy'),null);assert.equal(s.intervals.size,0);
 slow.end();assert.equal(s.nodes.get('sync-stage-checking').getAttribute('aria-hidden'),'true');assert.equal(s.delays.size,0);
});

test('lost job observations remain visible as uncertain and a retry can resume them',t=>{
 const s=fixture(t);const task=s.control.begin({label:'가져오기',link:'#sync-results'});
 task.update({label:'진행 상태 확인 필요',detail:'서버 작업은 계속될 수 있습니다.',uncertain:true});assert.ok(s.nodes.get('activity-panel').classes.has('is-uncertain'));assert.equal(s.nodes.get('activity-link').hidden,false);
 task.update({label:'가져오는 중',uncertain:false});assert.equal(s.nodes.get('activity-panel').classes.has('is-uncertain'),false);
 task.end();task.update({label:'stale update'});assert.equal(s.nodes.get('activity-panel').hidden,true);assert.equal(s.intervals.size,0);
});

test('request descriptions distinguish polling, automatic checking, mutations, dialogs and conversion',()=>{
 assert.equal(describeRequest('/api/sync/job'),null);assert.equal(describeRequest('/api/sync/config',{}, {quiet:true}),null);
 assert.equal(describeRequest('/api/sync/staging',{}, {background:true}).background,true);assert.match(describeRequest('/api/sync/staging',{action:'add'}).label,/포함/);
 assert.equal(describeRequest('/api/sync/diff',{remote:true}).region,'sync-diff-dialog');assert.equal(describeRequest('/api/convert',{preview:true}).button,'preview');assert.equal(describeRequest('/api/convert',{preview:false}).button,'save');
 assert.equal(describeRequest('/api/sync/pull',{remoteOnly:true}).button,'sync-pull-remote');
});
