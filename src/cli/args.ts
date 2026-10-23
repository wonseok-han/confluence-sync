/** Positional arguments shared by command dispatch and push selection. */
export function positionalArgs(argv: string[]): string[] {
  const values = new Set(['--base', '--reference-root', '--mapping', '--from-mapping', '--exclude', '--to', '--out', '--port', '--scope']);
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (values.has(argv[i])) { i++; continue; }
    if (!argv[i].startsWith('-')) result.push(argv[i]);
  }
  return result;
}
