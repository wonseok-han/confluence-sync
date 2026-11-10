/** Local edit detection is independent of rendered storage and incoming anchor links. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {readBaseline} from './baseline.js';
import {buildVault,vaultPath} from '../documents/catalog.js';
import {WIKILINK_RE} from '../documents/anchors.js';
import {mapProse,splitFrontmatter} from '../documents/obsidian.js';
import type { Rendered } from '../documents/markdown.js';
const GENERATED_PDF_PAGE=/^pdfjs-[a-f0-9]{24}-[1-9]\d*\.png$/i;
const MARKDOWN_NOTE_LINK=/(!?)\[([^\]\n]*)\]\((<[^>\n]+>|(?:\\.|[^()\s]|\((?:\\.|[^()\n])*\))+)\)/g;
const FENCE=/^\s*(?:```|~~~)/;
export function localStateHash(base: string, rel: string, rendered: Rendered, source?:string): string {
  const hash = createHash('sha256').update(source??readFileSync(resolve(base, rel)));
  for (const asset of [...rendered.attachments].sort((a, b) => a.filename.localeCompare(b.filename))) {
    hash.update('\0' + asset.filename + '\0');
    if(!GENERATED_PDF_PAGE.test(asset.filename))hash.update(createHash('sha256').update(readFileSync(asset.abs)).digest());
  }
  return hash.digest('hex');
}

/** Ignore only rewritten note paths; labels, fragments, code and assets remain exact. */
export function matchesLocalState(base:string,rel:string,rendered:Rendered,entry:{localHash?:string;localHashVersion?:2;sourceObject?:string},files:string[],actual=localStateHash(base,rel,rendered)):boolean {
  if(entry.localHash===actual)return true;
  if(!entry.localHash||!entry.sourceObject)return false;
  const before=readBaseline(base,entry.sourceObject),after=readFileSync(resolve(base,rel),'utf8');
  if(normalizeWikiPaths(base,rel,before,files)!==normalizeWikiPaths(base,rel,after,files))return false;
  if(localStateHash(base,rel,rendered,before)===entry.localHash)return true;
  return entry.localHashVersion===undefined&&rendered.attachments.length>0;
}

export function normalizeWikiPaths(base:string,rel:string,text:string,files:string[]):string {
  const vault=buildVault(files,[],base);
  const {body}=splitFrontmatter(text),prefix=text.slice(0,text.length-body.length);
  const wiki=mapProse(body,part=>part.replace(WIKILINK_RE,(whole,bang:string,target:string,hash?:string,alias?:string)=>{
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
  let inFence=false;
  const markdown=wiki.split('\n').map(line=>{
    if(FENCE.test(line)){inFence=!inFence;return line;}
    if(inFence)return line;
    const code=[...line.matchAll(/(`+).*?\1/g)].map(match=>[match.index!,match.index!+match[0].length]);
    return line.replace(MARKDOWN_NOTE_LINK,(whole,bang:string,label:string,raw:string,offset:number)=>{
      if(code.some(([start,end])=>start<=offset&&offset<end))return whole;
      if(bang)return whole;
      const destination=raw.replace(/^<(.*)>$/,'$1'),index=destination.indexOf('#');
      const target=index<0?destination:destination.slice(0,index),hash=index<0?'':destination.slice(index);
      if(!/\.md$/i.test(target)||/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target))return whole;
      const path=vaultPath(vault,target,false,rel);
      return path?`[[${path}${hash}|${label}]]`:whole;
    });
  }).join('\n');
  return prefix+markdown;
}
