/** Infer local page moves without writing metadata or contacting Confluence. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFolderIndex, parentKeyOf, readDoc } from '../documents/catalog.js';
import type { Mapping } from './mapping.js';

export function reconcilePages(base: string, mapping: Mapping, allFiles: string[], selected: string[], scope: { id: string; type: string }): Mapping {
  const next = structuredClone(mapping);
  const byId = new Map(Object.entries(mapping).map(([key, entry]) => [entry.pageId, { key, entry }]));
  const oldFolders = buildFolderIndex(Object.keys(mapping).filter(key => key.endsWith('.md')));
  const folders = buildFolderIndex(allFiles);
  const docs = new Map(allFiles.map(key => [key, readDoc(base, key)]));
  const seen = new Map<string, string>();
  for (const [key, doc] of docs) {
    const id = doc.fm.pageId ?? mapping[key]?.pageId;
    if (!id) continue;
    if (mapping[key] && mapping[key].pageId !== id) throw new Error(`pageId 충돌: ${key}`);
    if (seen.has(id)) throw new Error(`문서 pageId 중복: ${seen.get(id)}, ${key} (#${id})`);
    seen.set(id, key);
    if (id === scope.id && (scope.type !== 'page' || key !== 'README.md')) throw new Error('스코프 루트의 매핑 경로는 README.md로 유지해야 합니다.');
  }
  for (const key of selected) {
    const doc = docs.get(key)!;
    const id = doc.fm.pageId ?? mapping[key]?.pageId;
    if (!id) continue;
    const prior = byId.get(id);
    if (prior?.entry.type === 'folder') throw new Error(`폴더 ID를 문서에 사용할 수 없습니다: ${key}`);
    if (prior && prior.key !== key && existsSync(resolve(base, prior.key))) throw new Error(`기존 pageId 경로가 남아 있습니다: ${prior.key}, ${key}`);
    const entry = { ...(prior?.entry ?? { pageId: id, title: doc.title }) };
    const parentKey = parentKeyOf(key, folders);
    const oldParentKey = prior ? parentKeyOf(prior.key, oldFolders) : undefined;
    const parentId = parentKey ? mapping[parentKey]?.pageId ?? docs.get(parentKey)?.fm.pageId : scope.id;
    const sameParent = !!prior && (oldParentKey === parentKey || !!parentId && prior.entry.remoteParentId === parentId);
    if (id === scope.id) {
      if (entry.pendingMove) throw new Error('스코프 루트는 이동할 수 없습니다.');
    } else if (!prior || !sameParent || entry.pendingMove) {
      entry.pendingMove = { parentKey };
    }
    if (prior && prior.key !== key) delete next[prior.key];
    next[key] = entry;
  }
  return next;
}
