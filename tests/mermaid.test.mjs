import test from 'node:test';
import assert from 'node:assert/strict';
import { toStorage, docHash } from '../dist/markdown.js';
import { codeLanguagesFromStorage, htmlToMarkdown } from '../dist/html2md.js';
import { MERMAID_EXTENSION_KEY } from '../dist/mermaid.js';

const render = (body, rel = 'doc.md') => toStorage(body, rel, {}, process.cwd());
const diagram = '```mermaid\nflowchart TD\n  A[시작] --> B[완료]\n```';
const macros = storage => [...storage.matchAll(/<ac:adf-extension>([\s\S]*?)<ac:adf-fallback>/g)].map(m => m[1]);
const localId = macro => macro.match(/<ac:adf-parameter key="local-id">([^<]+)</)[1];

test('Mermaid code is retained and followed by the installed Forge viewer', () => {
  const { storage } = render(diagram);
  assert.deepEqual(codeLanguagesFromStorage(storage), ['mermaid']);
  assert.match(storage, /A\[시작\] --> B\[완료\]/);
  assert.match(storage, /<\/ac:structured-macro>\n<ac:adf-extension>/);
  const [macro] = macros(storage);
  assert.ok(macro.includes(MERMAID_EXTENSION_KEY));
  assert.ok(macro.includes(`ari:cloud:ecosystem::extension/${MERMAID_EXTENSION_KEY}`));
  assert.match(macro, new RegExp(`<ac:adf-attribute key="local-id">${localId(macro)}</`));
  assert.doesNotMatch(macro, /guest-params|accountId|cloudId|embeddedMacroContext/);
  assert.ok(storage.includes(`<ac:adf-fallback>${macro}</ac:adf-fallback>`));
});

test('multiple and identical diagrams have distinct stable IDs without render context leaks', () => {
  const body = `${diagram}\n\n\`\`\`js\nconst n = 1;\n\`\`\`\n\n${diagram}`;
  const first = render(body);
  const ids = macros(first.storage).map(localId);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(codeLanguagesFromStorage(first.storage), ['mermaid', 'js', 'mermaid']);
  render(diagram, 'another.md');
  const again = render(body);
  assert.equal(first.storage, again.storage);
  assert.equal(docHash('Title', first), docHash('Title', again));
  assert.notEqual(ids[0], localId(macros(render(diagram, 'another.md').storage)[0]));
});

test('ordinary code, inline examples and escaped outer fences do not add viewers', () => {
  for (const body of ['```js\nconst x = 1;\n```', '`mermaid`', '````markdown\n```mermaid\nflowchart TD\n```\n````', '    flowchart TD\n']) {
    assert.equal(macros(render(body).storage).length, 0);
  }
});

test('tilde fences, mixed case and nested Mermaid blocks work in document order', () => {
  const body = '~~~Mermaid\nsequenceDiagram\nA->>B: Hi\n~~~\n\n> ```mermaid\n> flowchart LR\n> A-->B\n> ```';
  const { storage } = render(body);
  assert.deepEqual(codeLanguagesFromStorage(storage), ['mermaid', 'mermaid']);
  assert.equal(macros(storage).length, 2);
});

test('Mermaid source is kept verbatim through XML-sensitive text and CDATA terminators', () => {
  const source = 'flowchart TD\n A["<tag> & ]]> 한글"] --> B';
  const { storage } = render(`\`\`\`mermaid\n${source}\n\`\`\``);
  const body = storage.match(/<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/)[1];
  const decoded = [...body.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map(m => m[1]).join('');
  assert.equal(decoded, source + '\n');
});

test('pull keeps the Mermaid language and recreates one viewer on the next push', () => {
  const storage = render(diagram).storage;
  const pulled = htmlToMarkdown('<pre>flowchart TD\n  A[시작] --&gt; B[완료]\n</pre>', {
    codeLangs: codeLanguagesFromStorage(storage),
  });
  assert.match(pulled, /```mermaid\n/);
  assert.equal(macros(render(pulled).storage).length, 1);
});
