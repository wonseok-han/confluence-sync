/** Private workspace storage for browser sessions. Paths are virtual at the HTTP boundary. */
import {readdir,lstat,readFile,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {resolve,join,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
import MarkdownIt from 'markdown-it';
import {createDocument} from '@mixmark-io/domino';
import {parse} from 'dotenv';
import {mapMarkdownText} from '../conversion/pdf-pages.js';
import {WIKILINK_RE,parseWikilink} from '../documents/anchors.js';
import {isConfluenceWebPath} from '../confluence/links.js';
export const MAX_FILE=100*1024*1024, MAX_TOTAL=512*1024*1024, MAX_FILES=20000;
export type FileEntry={path:string;hash:string;size:number};
export type Mount={virtual:string;root:string;readonly?:boolean};
export const digest=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
export function safeRelative(path:string):string {
 if(!path || path.includes('\\') || /[\x00-\x1f:]/.test(path) || path.startsWith('/') || path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('잘못된 파일 경로입니다.');
 return path;
}
export function permitted(path:string):boolean {
 const parts=path.split('/');return !parts.some((part,i)=>part==='node_modules'||part==='.git'||(part.startsWith('.')&&!(i===0&&['.csync','.env','.confluence-sync.json','.confluence-workspace.json','.confluence-syncignore'].includes(part))));
}
export function pathIn(mounts:Mount[],path:string):string {
 const mount=mounts.find(m=>path===m.virtual||path.startsWith(m.virtual+'/'));if(!mount)throw Error('선택한 브라우저 폴더 안의 경로만 사용할 수 있습니다.');
 const rel=path.slice(mount.virtual.length).replace(/^\//,'');if(rel)safeRelative(rel);return join(mount.root,rel);
}
export function virtualPath(mounts:Mount[],path:string):string {
 for(const mount of mounts){const rel=relative(mount.root,path);if(!rel)return mount.virtual;if(!rel.startsWith('..')&&!rel.startsWith('/'))return mount.virtual+'/'+rel.split('\\').join('/');}throw Error('작업공간 밖의 경로입니다.');
}
export async function snapshot(mounts:Mount[],cache=new Map<string,{stamp:string;hash:string}>()):Promise<FileEntry[]> {
 const files:FileEntry[]=[];let total=0;
 async function walk(mount:Mount,dir:string){for(const entry of await readdir(dir,{withFileTypes:true})){
  const file=join(dir,entry.name),rel=relative(mount.root,file).split('\\').join('/');if(!permitted(rel))continue;safeRelative(rel);
  const stat=await lstat(file);if(stat.isSymbolicLink())throw Error('작업공간의 심볼릭 링크는 지원하지 않습니다.');
  if(stat.isDirectory()){await walk(mount,file);continue;}if(!stat.isFile())continue;
  total+=stat.size;if(files.length>=MAX_FILES||stat.size>MAX_FILE||total>MAX_TOTAL)throw Error('작업공간 한도를 초과했습니다(파일 100MiB, 전체 512MiB, 20,000개).');
  const stamp=`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,old=cache.get(file),hash=old?.stamp===stamp?old.hash:digest(await readFile(file));cache.set(file,{stamp,hash});files.push({path:virtualPath(mounts,file),size:stat.size,hash});
 }}
 for(const mount of mounts)await walk(mount,mount.root);return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export function validateEnv(text:string){const env=parse(text);const base=env.CONFLUENCE_BASE_URL;if(!base)return;const url=new URL(base);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!(url.hostname==='api.atlassian.com'||url.hostname.endsWith('.atlassian.net')))throw Error('배포 웹은 Atlassian Cloud의 HTTPS 주소만 지원합니다.');}
/** Reject local link destinations that would make shared CLI code read server files.
 * Metadata-only Fetch does not follow document links; keep env/mapping checks.
 */
export async function validateWorkspace(mounts:Mount[],checkEnv=true,checkDocuments=true):Promise<void>{
 const parser=new MarkdownIt({html:true});const entries=await snapshot(mounts);
 const allowed=(file:string,target:string,webLink=false)=>{
  try{target=target.replace(/^<(.*)>$/,'$1');for(let i=0;i<4;i++){const decoded=decodeURIComponent(target);if(decoded===target)break;target=decoded;}}catch{throw Error('해석할 수 없는 링크 경로입니다.');}
  if(!target||target.startsWith('#')||/^(?:https?:|mailto:|data:)/i.test(target))return;
  if(webLink&&isConfluenceWebPath(target))return;
  if(/^[a-z][a-z\d+.-]*:|^\/\//i.test(target)||target.startsWith('/')||target.includes('\\'))throw Error(`${virtualPath(mounts,file)}: 서버의 절대 경로를 참조하는 문서는 처리할 수 없습니다.`);
  const path=resolve(dirname(file),target.split(/[?#]/)[0]);if(!mounts.some(m=>path===m.root||path.startsWith(m.root+'/')))throw Error('선택한 폴더 밖의 첨부·문서를 참조합니다. 참조 폴더를 추가하거나 링크를 수정하세요.');
 };
 for(const entry of entries){const file=pathIn(mounts,entry.path),rel=relative(mounts.find(m=>entry.path.startsWith(m.virtual+'/'))!.root,file);
  if(rel==='.env'){if(checkEnv)validateEnv(await readFile(file,'utf8'));continue;}
  if(rel==='.csync/mapping.json'||rel==='.confluence-sync.json'||rel==='.csync/index.json'){
   const value=JSON.parse(await readFile(file,'utf8'));for(const key of Object.keys(rel.endsWith('index.json')?value.entries??{}:value))safeRelative(key.replace(/\/$/,''));
  }
  if(!checkDocuments||!/\.md$/i.test(file)||rel.startsWith('.csync/'))continue;
  const text=await readFile(file,'utf8');
  const scan=(part:string)=>{
   for(const match of part.matchAll(/(?<!!)(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^()\s]+)\)/g)){if((part.slice(0,match.index).match(/\\+$/)?.[0].length??0)%2)continue;allowed(file,match[3],!match[1]);}
   for(const match of part.matchAll(WIKILINK_RE)){if((part.slice(0,match.index).match(/\\+$/)?.[0].length??0)%2)continue;const link=parseWikilink(match[1],match[2],match[3],match[4]);if(link?.target)allowed(file,link.target,!link.embed);}
   return part;
  };
  mapMarkdownText(text,scan,html=>scan(html.replace(/<!--[\s\S]*?-->|<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')));
  const inspect=(tokens:any[])=>{for(const token of tokens){if(token.type==='image')allowed(file,token.attrGet('src')??'');if(token.type==='link_open')allowed(file,token.attrGet('href')??'',true);if(token.children)inspect(token.children);
   if(token.type==='html_block'||token.type==='html_inline')for(const node of Array.from(createDocument(token.content).querySelectorAll('[href], [src]'))){if(node.hasAttribute('href'))allowed(file,node.getAttribute('href')??'',node.localName==='a');if(node.hasAttribute('src'))allowed(file,node.getAttribute('src')??'');}
  }};inspect(parser.parse(text,{}));
 }
}
/** Apply a complete upload transaction; rollback only files this transaction moved. */
export async function commitMirror(mounts:Mount[],stage:string,uploads:FileEntry[],removed:string[]){
 const applied:string[]=[],backups:{file:string;backup:string}[]=[];await mkdir(join(stage,'backup'),{recursive:true});
 try{
  for(const path of [...uploads.map(f=>f.path),...removed]){const file=pathIn(mounts,path);try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('파일 충돌을 확인하세요.');const backup=join(stage,'backup',String(backups.length));await rename(file,backup);backups.push({file,backup});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  for(let i=0;i<uploads.length;i++){const file=pathIn(mounts,uploads[i].path);await mkdir(dirname(file),{recursive:true});await rename(join(stage,String(i)),file);applied.push(file);}
 }catch(error){for(const file of applied.reverse())await rm(file,{force:true});for(const item of backups.reverse())await rename(item.backup,item.file);throw error;}
}
