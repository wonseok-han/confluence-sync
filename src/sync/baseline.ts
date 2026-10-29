/** Immutable Markdown baselines for local diff; hashes never substitute for source text. */
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {workspacePath} from './metadata.js';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
function objectPath(base:string,id:string) {
  if(!/^[a-f0-9]{64}$/.test(id))throw new Error('비교 기준 식별자가 올바르지 않습니다.');
  workspacePath(base);
  const dir=join(base,'.csync/objects');
  try {if(!lstatSync(dir).isDirectory())throw new Error('비교 기준 폴더는 일반 폴더여야 합니다.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const path=join(dir,id+'.md');
  try {if(!lstatSync(path).isFile())throw new Error('비교 기준은 일반 파일이어야 합니다.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  return path;
}
export function storeBaseline(base:string,text:string) {
  const id=digest(text),path=objectPath(base,id);
  mkdirSync(join(base,'.csync/objects'),{recursive:true});
  if(!existsSync(path))writeFileSync(path,text,{flag:'wx',mode:0o600});
  if(readFileSync(path,'utf8')!==text)throw new Error('저장된 비교 기준의 내용이 올바르지 않습니다.');
  return id;
}
export function readBaseline(base:string,id:string) {
  const text=readFileSync(objectPath(base,id),'utf8');
  if(digest(text)!==id)throw new Error('저장된 비교 기준이 손상되었습니다.');
  return text;
}
