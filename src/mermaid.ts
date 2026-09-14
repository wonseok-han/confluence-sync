import { createHash } from 'node:crypto';

// Atlassian Labs Mermaid Diagrams Viewer (Marketplace production deployment).
// Confirmed against the installed macro's editor/clipboard attributes.
export const MERMAID_EXTENSION_KEY = '23392b90-4271-4239-98ca-a3e96c663cbb/63d4d207-ac2f-4273-865c-0240d37f044a/static/mermaid-diagram';

/** Auto-detect pairs Mermaid code blocks and viewer macros in document order. */
export function mermaidMacro(document: string, ordinal: number): string {
  // Random IDs would change the storage hash on every push. Include the ordinal
  // so repeated identical diagrams still have distinct macro instances.
  const hex = createHash('sha256').update(`csync:mermaid:${document}:${ordinal}`).digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const node = `<ac:adf-node type="extension"><ac:adf-attribute key="extension-type">com.atlassian.ecosystem</ac:adf-attribute><ac:adf-attribute key="extension-key">${MERMAID_EXTENSION_KEY}</ac:adf-attribute><ac:adf-attribute key="parameters"><ac:adf-parameter key="local-id">${id}</ac:adf-parameter><ac:adf-parameter key="extension-id">ari:cloud:ecosystem::extension/${MERMAID_EXTENSION_KEY}</ac:adf-parameter><ac:adf-parameter key="extension-title">Mermaid diagram</ac:adf-parameter></ac:adf-attribute><ac:adf-attribute key="text">Mermaid diagram</ac:adf-attribute><ac:adf-attribute key="layout">default</ac:adf-attribute><ac:adf-attribute key="local-id">${id}</ac:adf-attribute></ac:adf-node>`;
  return `<ac:adf-extension>${node}<ac:adf-fallback>${node}</ac:adf-fallback></ac:adf-extension>\n`;
}
