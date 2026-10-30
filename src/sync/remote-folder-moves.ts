/** Filesystem part of a remote folder move. Pull owns commit/rollback and baselines. */
import {existsSync,lstatSync,readdirSync,readFileSync} from 'node:fs';
import {resolve,relative,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {within} from './workspace.js';
import type {RemoteFolder} from './fetch.js';
import type {createClient} from '../confluence/client.js';

export type FolderMove = {from:string;to:string;pageId:string};
export function folderMoves(folders:RemoteFolder[]=[]):FolderMove[] {
 const all=folders.filter(f=>f.previousPath&&f.previousPath!==f.path).map(f=>({from:f.previousPath!,to:f.path,pageId:f.pageId})).sort((a,b)=>a.from.length-b.from.length);
 return all.filter(move=>!all.some(parent=>parent!==move&&move.from.startsWith(parent.from)&&move.to===parent.to+move.from.slice(parent.from.length)));
}
export function relocated(path:string,moves:FolderMove[]):string {
 const move=moves.find(m=>path.startsWith(m.from));
 return move?move.to+path.slice(move.from.length):path;
}
export function folderStamp(base:string,rel:string):string {
 const root=resolve(base,rel),entries:unknown[]=[];
 const walk=(path:string)=>{
  const info=lstatSync(path);
  if(info.isSymbolicLink())throw Error(`폴더 이동 중 심볼릭 링크는 지원하지 않습니다: ${rel}`);
  if(info.isDirectory()){entries.push([relative(root,path),'directory']);for(const entry of readdirSync(path).sort()){
   if(['.csync','.git','.confluence-workspace.json','.confluence-sync.json'].includes(entry))throw Error(`별도 작업공간이 있는 폴더는 자동 이동하지 않습니다: ${rel}`);
   walk(join(path,entry));
  }}else if(info.isFile())entries.push([relative(root,path),createHash('sha256').update(readFileSync(path)).digest('hex')]);
  else throw Error(`일반 파일이 아닌 항목이 있어 폴더를 이동할 수 없습니다: ${rel}`);
 };
 walk(root);return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
export function checkFolderDestination(base:string,move:FolderMove):void {
 const from=resolve(base,move.from),to=resolve(base,move.to);
 if(!within(base,from)||!within(base,to)||from===resolve(base)||to===resolve(base)||within(from,to)||within(to,from))throw Error(`안전하지 않은 폴더 이동: ${move.from} → ${move.to}`);
 if(!existsSync(from)||!lstatSync(from).isDirectory()||lstatSync(from).isSymbolicLink())throw Error(`이동할 로컬 폴더를 확인하세요: ${move.from}`);
 if(existsSync(to))throw Error(`폴더 이동 대상 경로가 이미 존재합니다: ${move.to}`);
 for(let path=dirname(to);within(base,path);path=dirname(path)){
  if(existsSync(path)&&(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink()))throw Error(`폴더 이동 대상의 상위 경로를 확인하세요: ${move.to}`);
  if(path===resolve(base))break;
 }
}
export async function verifyRemoteFolderMoves(client:ReturnType<typeof createClient>,moves:FolderMove[],folders:RemoteFolder[]):Promise<void> {
 for(let offset=0;offset<moves.length;offset+=100){
  const batch=moves.slice(offset,offset+100),expected=new Map(batch.map(move=>[move.pageId,folders.find(folder=>folder.pageId===move.pageId)?.parentId]));
  const query=new URLSearchParams({cql:`id in (${batch.map(move=>move.pageId).join(',')})`,expand:'ancestors,space',limit:'100'});
  const response=await client.api('/rest/api/content/search?'+query);
  if(!Array.isArray(response?.results)||response.results.length!==expected.size)throw Error('이동할 원격 폴더를 다시 확인할 수 없습니다. 로컬 폴더는 유지합니다.');
  const seen=new Set<string>();
  for(const folder of response.results){
   const id=String(folder?.id),parent=folder?.ancestors?.at(-1)?.id;
   if(!expected.has(id)||seen.has(id)||folder.type!=='folder'||parent==null||String(parent)!==expected.get(id))throw Error('가져오기 도중 원격 폴더 위치가 바뀌었습니다. Fetch 후 다시 확인하세요.');
   seen.add(id);
  }
 }
}
