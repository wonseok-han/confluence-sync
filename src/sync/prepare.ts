/** Prepare publication content without writing to the source workspace. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildVault, collectAssets } from '../documents/catalog.js';
import { prepareMarkdown } from '../conversion/markdown.js';
import { within } from './workspace.js';
import { buildTreeRenderer } from './render.js';

export async function preparePushTree(base: string, rels: string[], selected: string[], options?: { referenceRoots: string[]; baseUrl?: string }) {
  const stage = mkdtempSync(join(tmpdir(), 'csync-push-'));
  const dispose = () => rmSync(stage, { recursive: true, force: true });
  try {
    const chosen = new Set(selected);
    const sourceRenderer = buildTreeRenderer(base, rels);
    const vault = buildVault(rels, collectAssets(base).map(file => relative(base, file).split('\\').join('/')));
    for (const rel of rels) {
      const original = resolve(base, rel), destination = resolve(stage, rel);
      let text = readFileSync(original, 'utf8');
      if (chosen.has(rel)) {
        // Preview renders actual temporary PNGs too, so attachment hashes match Push.
        const converted = await prepareMarkdown(text, original, base, vault, stage, false, undefined, false);
        text = converted.text;
        for (const [asset, source] of converted.copies) {
          const target = resolve(stage, asset);
          mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
        }
      }
      // Use the publication renderer as the final asset authority: conversion may
      // miss balanced parentheses in Markdown paths or assets inside raw HTML.
      if (chosen.has(rel)) {
        const doc=sourceRenderer.docs[rel];
        for(const asset of sourceRenderer.render(rel,doc.body,doc.title).attachments){
          if(!within(base,asset.abs)||!existsSync(asset.abs))continue;
          const target=resolve(stage,relative(base,asset.abs));
          if(existsSync(target))continue;
          mkdirSync(dirname(target),{recursive:true});copyFileSync(asset.abs,target);
        }
      }
      mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, text);
    }
    return { ...buildTreeRenderer(stage, rels, options ? { ...options, referenceBase: base } : undefined), dispose };
  } catch (error) { dispose(); throw error; }
}
