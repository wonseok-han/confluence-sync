// Explicitly selected synthetic remote scope for tests that focus on conversion and push mechanics.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mappingPath, workspacePath } from '../../dist/sync/metadata.js';

export const scopeFixture = (overrides = {}) => ({ version: 2,
 connection: { baseUrl: 'https://example.invalid/wiki', spaceKey: 'TEST', spaceId: 'space', homepageId: 'home', ...overrides.connection },
 remoteRoot: { id: 'home', type: 'folder', path: '/', ...overrides.scope },
 scope: overrides.localScope ?? {path:'.',type:'folder'},
});
export function bindScope(root, overrides = {}) {
 const value = scopeFixture(overrides), path = workspacePath(root);
 mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); return value;
}
export function scopeResponder(root, steps, config = JSON.parse(readFileSync(workspacePath(root), 'utf8'))) {
 const known = new Set([config.remoteRoot.id, config.connection.homepageId]);
 for (const step of steps) {
  const id = step.path.match(/\/(?:pages|content)\/([^/?]+)/)?.[1]; if (id && id !== 'search') known.add(id);
  if (step.body?.id) known.add(String(step.body.id));
  for (const row of step.body?.results ?? []) if (row.id) known.add(String(row.id));
  if (step.path.startsWith('/wiki/api/v2/spaces?')) for (const row of step.body?.results ?? []) row.homepageId ??= config.connection.homepageId;
 }
 return (url, init = {}, expected) => {
  const path = new URL(url).pathname + new URL(url).search;
  if ((init.method ?? 'GET') !== 'GET' || expected?.path === path && (expected.method ?? 'GET') === 'GET') return null;
  const mapping = existsSync(mappingPath(root)) ? JSON.parse(readFileSync(mappingPath(root), 'utf8')) : {};
  for (const entry of Object.values(mapping)) known.add(entry.pageId);
  if(new URL(url).pathname==='/wiki/rest/api/content/search'){
   const ids=(new URL(url).searchParams.get('cql')??'').match(/id in \(([^)]+)\)/)?.[1]?.split(',')??[];
   const byId=new Map(Object.entries(mapping).map(([path,entry])=>[entry.pageId,{path,entry}]));
   if(ids.length&&ids.every(id=>byId.get(id)?.entry.type==='folder'))return {results:ids.map(id=>{
    const current=byId.get(id),ancestors=[{id:config.remoteRoot.id,title:'Scope'}];
    const parts=current.path.replace(/\/$/,'').split('/');parts.pop();let prefix='';
    for(const part of parts){prefix+=part+'/';const parent=mapping[prefix]??mapping[prefix+'README.md'];if(parent)ancestors.push({id:parent.pageId,title:part});}
    return {id,title:current.entry.title??current.path,type:'folder',space:{id:config.connection.spaceId},ancestors};
   })};
  }
  const match = path.match(/^\/wiki\/rest\/api\/content\/([^/?]+)\?expand=ancestors,space,version$/);
  if (match && known.has(match[1])) {
   const id = match[1], isRoot = id === config.remoteRoot.id;
   return { id, title: isRoot ? 'Scope' : id, type: isRoot ? config.remoteRoot.type : 'page', space: { id: config.connection.spaceId },
    ancestors: id === config.connection.homepageId ? [] : [{ id: config.connection.homepageId, title: 'Home' }, ...(!isRoot ? [{ id: config.remoteRoot.id, title: 'Scope' }] : [])] };
  }
  if (path === '/wiki/api/v2/spaces?keys=TEST') return { results: [{ id: config.connection.spaceId, homepageId: config.connection.homepageId }] };
  const page = path.match(/^\/wiki\/api\/v2\/pages\/([^/?]+)$/);
  const entry = page && Object.values(mapping).find(item => item.pageId === page[1]);
  if (entry?.remoteVersion) return { id: page[1], spaceId: config.connection.spaceId, version: { number: entry.remoteVersion } };
  return null;
 };
}
