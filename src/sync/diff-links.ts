/** Reuse Pull link/anchor conversion in a disposable tree; user files stay read-only. */
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,relative} from 'node:path';
import {collectMarkdown,buildVault,vaultResolver} from '../documents/catalog.js';
import {buildFrontmatter,splitFrontmatter,resolveWikilinks} from '../documents/obsidian.js';
import {anchorPass,relinkPass,readDocInfo} from './pull.js';
import {normalizeWikiPaths} from './local-state.js';
import {buildIgnorer} from './ignore.js';
import {inNestedWorkspace} from './workspace.js';
import type {Mapping} from './mapping.js';
export function diffLinks(base:string,path:string,title:string,before:string,after:string,wiki:boolean,mapping:Mapping) {
  const ignore=buildIgnorer(base,[]),files=collectMarkdown(base).map(file=>relative(base,file).split('\\').join('/')).filter(file=>!ignore.ignores(file)&&!inNestedWorkspace(base,file));
  const stage=mkdtempSync(join(tmpdir(),'csync-diff-'));
  try {
    const file=resolve(stage,path),paths=new Map<string,string>(),refs=new Map<string,ReturnType<typeof readDocInfo>>();
    mkdirSync(dirname(file),{recursive:true});writeFileSync(file,buildFrontmatter({title})+before);
    for(const rel of files){const entry=mapping[rel];if(!entry||entry.type==='folder')continue;const target=resolve(stage,rel);paths.set(entry.pageId,target);if(rel!==path)refs.set(target,readDocInfo(resolve(base,rel)));}
    const pass=anchorPass([file],paths,refs);relinkPass([file],paths,wiki,pass.info);
    const body=splitFrontmatter(readFileSync(file,'utf8')).body.replace(/^\r?\n/,'');
    const vault=buildVault(files,[],base),lookup=vaultResolver(path,vault);
    const canonical=(text:string)=>resolveWikilinks(normalizeWikiPaths(base,path,text,files),lookup);
    return {before:canonical(body),after:canonical(after)};
  }finally{rmSync(stage,{recursive:true,force:true});}
}
