import test from 'node:test';
import assert from 'node:assert/strict';
import {readEnv} from '../dist/confluence/config.js';

test('legacy parent environment variables do not select a scope or parent',t=>{
 for(const key of ['CONFLUENCE_PARENT_ID','CONFLUENCE_PARENT_PAGE_ID']) {
  const old=process.env[key];process.env[key]='123';t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});
 }
 assert.equal('parentId' in readEnv(),false);
 assert.equal('scope' in readEnv(),false);
});
