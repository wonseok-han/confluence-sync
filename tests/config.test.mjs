import test from 'node:test';
import assert from 'node:assert/strict';
import {readEnv} from '../dist/config.js';

test('configuration supports the legacy parent id but prefers the current setting',t=>{
 for(const key of ['CONFLUENCE_PARENT_ID','CONFLUENCE_PARENT_PAGE_ID']) {
  const old=process.env[key];delete process.env[key];t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});
 }
 process.env.CONFLUENCE_PARENT_PAGE_ID='legacy';assert.equal(readEnv().parentId,'legacy');
 process.env.CONFLUENCE_PARENT_ID='current';assert.equal(readEnv().parentId,'current');
});
