/** In-worker filesystem. The browser transport owns all real disk writes and conflict checks.
 * Implements only the filesystem operations used by the shared CLI engine.
 * Missing paths and unsupported operations fail rather than silently doing nothing.
 */
import path from 'path-browserify';
import { Buffer } from 'buffer';

let clock = 0;
const files = new Map();
const key = value => path.resolve(String(value));
const failure = (code, name) => Object.assign(Error(`${code}: ${name}`), {code, path: name});
const get = name => {const p=key(name), item=files.get(p);if(!item)throw failure('ENOENT',p);return item;};
export function resetFilesystem(){files.clear();clock=Date.now();files.set('/',{directory:true,stamp:++clock});mkdirSync('/tmp');}
export const filesystemRevision=()=>clock;
export const exportFilesystem=()=>[...files].map(([name,item])=>[name,{...item,bytes:item.bytes?new Uint8Array(item.bytes):undefined}]);
export function importFilesystem(entries){files.clear();for(const [name,item] of entries){files.set(name,{...item,bytes:item.bytes?Buffer.from(item.bytes):undefined});clock=Math.max(clock,item.stamp);}}
export function existsSync(name){return files.has(key(name));}
export function statSync(name){const item=get(name);return {size:item.bytes?.length??0,mtimeMs:item.stamp,ctimeMs:item.stamp,mtime:new Date(item.stamp),isFile:()=>!item.directory,isDirectory:()=>item.directory,isSymbolicLink:()=>false};}
export const lstatSync=statSync;
export function realpathSync(name){get(name);return key(name);}
export function mkdirSync(name,options={}){
 const p=key(name);if(existsSync(p)){if(!get(p).directory||!options.recursive)throw failure('EEXIST',p);return;}
 const parent=path.dirname(p);if(options.recursive&&!existsSync(parent))mkdirSync(parent,options);
 if(!get(parent).directory)throw failure('ENOTDIR',parent);
 files.set(p,{directory:true,stamp:++clock});
}
export function readdirSync(name,options={}){
 const p=realpathSync(name);if(!get(p).directory)throw failure('ENOTDIR',p);
 const children=[...files.keys()].filter(f=>f!==p&&path.dirname(f)===p).sort();
 return children.map(f=>options.withFileTypes?{name:path.basename(f),isDirectory:()=>get(f).directory,isFile:()=>!get(f).directory,isSymbolicLink:()=>false}:path.basename(f));
}
export function readFileSync(name,options){const item=get(name);if(item.directory)throw failure('EISDIR',key(name));const encoding=typeof options==='string'?options:options?.encoding;return encoding?item.bytes.toString(encoding):Buffer.from(item.bytes);}
export function writeFileSync(name,data,options={}){
 const p=key(name);if(options?.flag==='wx'&&existsSync(p))throw failure('EEXIST',p);
 if(!get(path.dirname(p)).directory)throw failure('ENOTDIR',path.dirname(p));
 if(existsSync(p)&&get(p).directory)throw failure('EISDIR',p);
 const encoding=typeof options==='string'?options:options.encoding;
 files.set(p,{directory:false,bytes:Buffer.from(data,encoding),stamp:++clock});
}
export const constants={COPYFILE_EXCL:1};
export function copyFileSync(source,target,flags=0){if(flags&constants.COPYFILE_EXCL&&existsSync(target))throw failure('EEXIST',key(target));writeFileSync(target,readFileSync(source));}
export function renameSync(source,target){
 const a=key(source),b=key(target),item=get(a);if(a===b)return;
 if(!get(path.dirname(b)).directory)throw failure('ENOTDIR',b);
 if(item.directory){
  if(a==='/'||b.startsWith(a+'/'))throw failure('EINVAL',b);
  if(existsSync(b))throw failure('EEXIST',b);
  const moved=[...files].filter(([name])=>name===a||name.startsWith(a+'/'));
  for(const [name,value]of moved)files.set(b+name.slice(a.length),{...value,stamp:++clock});
  for(const [name]of moved)files.delete(name);
  return;
 }
 if(existsSync(b)&&get(b).directory)throw failure('EISDIR',b);files.set(b,{...item,stamp:++clock});files.delete(a);
}
export function rmSync(name,options={}){const p=key(name);if(!existsSync(p)){if(options.force)return;throw failure('ENOENT',p);}if(p==='/')throw failure('EPERM',p);if(get(p).directory&&!options.recursive&&readdirSync(p).length)throw failure('ENOTEMPTY',p);for(const f of files.keys())if(f===p||f.startsWith(p+'/'))files.delete(f);clock++;}
export function unlinkSync(name){if(get(name).directory)throw failure('EISDIR',key(name));rmSync(name);}
export function rmdirSync(name){if(!get(name).directory)throw failure('ENOTDIR',key(name));rmSync(name);}
export function mkdtempSync(prefix){const p=prefix+crypto.randomUUID();mkdirSync(p);return p;}
export function createReadStream(name){return {[Symbol.asyncIterator]:async function*(){yield readFileSync(name);}};}
export const readFile=async(...args)=>readFileSync(...args),writeFile=async(...args)=>writeFileSync(...args),readdir=async(...args)=>readdirSync(...args),stat=async(...args)=>statSync(...args),lstat=stat,realpath=async(...args)=>realpathSync(...args),mkdir=async(...args)=>mkdirSync(...args),rename=async(...args)=>renameSync(...args),rm=async(...args)=>rmSync(...args),unlink=async(...args)=>unlinkSync(...args),rmdir=async(...args)=>rmdirSync(...args),mkdtemp=async(...args)=>mkdtempSync(...args),copyFile=async(...args)=>copyFileSync(...args);
export default {existsSync,readFileSync,writeFileSync,statSync,lstatSync,realpathSync,mkdirSync,readdirSync,copyFileSync,renameSync,rmSync,unlinkSync,rmdirSync,mkdtempSync,createReadStream,constants};
resetFilesystem();
