/** Shared dotenv import/update rules. Only connection keys are imported. */
import { parse } from 'dotenv';
export const connectionKeys = ['CONFLUENCE_BASE_URL', 'CONFLUENCE_EMAIL', 'CONFLUENCE_API_TOKEN', 'CONFLUENCE_SPACE_KEY'] as const;
// Match dotenv assignments, including quoted multiline values, without rewriting unrelated content.
const assignments = () => /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
export function importConnection(text: string) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 12_000 || text.includes('\0')) throw new Error('.env 파일은 12KB 이하 텍스트여야 합니다.');
  const values = parse(text);
  if (!connectionKeys.some(key => Object.hasOwn(values, key))) throw new Error('Confluence 연결 환경변수가 없는 파일입니다.');
  const env: Record<string, string> = {}, raw: Record<string, string> = {};
  for (const match of text.matchAll(assignments())) raw[match[1]] = match[2] ?? '';
  for (const key of connectionKeys) env[key] = values[key]?.trim() ?? '';
  const content = connectionKeys.map(key => `${key}=${raw[key] ?? ''}`).join('\n') + '\n';
  return { env, content };
}
export function mergeConnection(existing: string, content: string): string {
  const remaining = existing.replace(assignments(), (match, key) => (connectionKeys as readonly string[]).includes(key) ? '' : match);
  return `${remaining.trimEnd()}${remaining.trim() ? '\n\n' : ''}${content}`;
}
