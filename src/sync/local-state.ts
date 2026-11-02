/** Local edit detection is independent of rendered storage and incoming anchor links. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {readBaseline} from './baseline.js';
import {buildVault,vaultPath} from '../documents/catalog.js';
import {WIKILINK_RE} from '../documents/anchors.js';
import {mapProse,splitFrontmatter} from '../documents/obsidian.js';
import type { Rendered } from '../documents/markdown.js';
export function localStateHash(base: string, rel: string, rendered: Rendered, source?:string): string {
  const hash = createHash('sha256').update(source??readFileSync(resolve(base, rel)));
  for (const asset of [...rendered.attachments].sort((a, b) => a.filename.localeCompare(b.filename))) {
    hash.update('\0' + asset.filename + '\0');
    hash.update(createHash('sha256').update(readFileSync(asset.abs)).digest());
  }
  return hash.digest('hex');
}

/** Ignore only rewritten note paths; labels, fragments, code and assets remain exact. */
export function matchesLocalState(base:string,rel:string,rendered:Rendered,entry:{localHash?:string;sourceObject?:string},files:string[],actual=localStateHash(base,rel,rendered)):boolean {
  if(entry.localHash===actual)return true;
  if(!entry.localHash||!entry.sourceObject)return false;
  const before=readBaseline(base,entry.sourceObject),after=readFileSync(resolve(base,rel),'utf8');
  // Reusing the old source with current attachments must reproduce the stored hash.
  if(localStateHash(base,rel,rendered,before)!==entry.localHash)return false;
  return normalizeWikiPaths(base,rel,before,files)===normalizeWikiPaths(base,rel,after,files);
}

export function normalizeWikiPaths(base:string,rel:string,text:string,files:string[]):string {
  const vault=buildVault(files,[],base);
  const {body}=splitFrontmatter(text),prefix=text.slice(0,text.length-body.length);
  return prefix+mapProse(body,part=>part.replace(WIKILINK_RE,(whole,bang:string,target:string,hash?:string,alias?:string)=>{
    if(bang)return whole;
    const name=target.replace(/\\$/,'').trim(),path=vaultPath(vault,name,false,rel);
    if(!path)return whole;
    // A short ambiguous name is safe only when the target is in this directory.
    if(!name.includes('/')){
      const key=name.replace(/\.md$/i,'').normalize('NFC').toLowerCase();
      const candidates=files.filter(file=>file.split('/').at(-1)!.replace(/\.md$/i,'').normalize('NFC').toLowerCase()===key);
      const nearby=(rel.includes('/')?rel.slice(0,rel.lastIndexOf('/')+1):'')+name.replace(/\.md$/i,'')+'.md';
      if(candidates.length>1&&path.normalize('NFC').toLowerCase()!==nearby.normalize('NFC').toLowerCase())return whole;
    }
    return `[[${path}${hash??''}|${alias??name}]]`;
  }));
}
