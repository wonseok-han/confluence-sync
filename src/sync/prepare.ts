/** Prepare publication content without writing to the source workspace. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readDoc } from '../documents/catalog.js';
import { prepareMarkdown } from '../conversion/markdown.js';
import { within } from './workspace.js';
import { buildTreeRenderer } from './render.js';

export async function preparePushTree(base: string, rels: string[], selected: string[], options?: { referenceRoots: string[]; baseUrl?: string }) {
  const stage = mkdtempSync(join(tmpdir(), 'csync-push-'));
  const dispose = () => rmSync(stage, { recursive: true, force: true });
  try {
    const chosen = new Set(selected);
    const sourceRenderer = buildTreeRenderer(base, rels);
    const vault = sourceRenderer.vault;
    const preparedDocs = {...sourceRenderer.docs};
    for (const rel of rels.filter(rel => chosen.has(rel))) {
      const original = resolve(base, rel), destination = resolve(stage, rel);
      // Preview renders actual temporary PNGs too, so attachment hashes match Push.
      const converted = await prepareMarkdown(readFileSync(original, 'utf8'), original, base, vault, stage, false, undefined, false);
      for (const [asset, source] of converted.copies) {
        const target = resolve(stage, asset);
        mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
      }
      // Use the source renderer as the final asset authority: conversion may
      // miss balanced parentheses in Markdown paths or assets inside raw HTML.
      const doc=sourceRenderer.docs[rel];
      for(const asset of sourceRenderer.render(rel,doc.body,doc.title).attachments){
        if(!within(base,asset.abs)||!existsSync(asset.abs))continue;
        const target=resolve(stage,relative(base,asset.abs));
        if(existsSync(target))continue;
        mkdirSync(dirname(target),{recursive:true});copyFileSync(asset.abs,target);
      }
      mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, converted.text);
      preparedDocs[rel] = readDoc(stage, rel);
    }
    return { ...buildTreeRenderer(stage, rels, { referenceRoots:[],...options, referenceBase: base }, preparedDocs), original: sourceRenderer, dispose };
  } catch (error) { dispose(); throw error; }
}
