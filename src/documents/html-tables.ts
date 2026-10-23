import MarkdownIt from 'markdown-it';

/** Keep a raw table in one token, including blank lines between its rows. */
export function htmlTableMarkdown(): MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: false });
  md.block.ruler.before('html_block', 'html_table', (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false;
    const source = state.getLines(start, end, state.blkIndent, false);
    if (!/^ {0,3}<table(?:\s|>)/i.test(source)) return false;
    let depth = 0;
    for (const match of source.matchAll(/<\/?table\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
      depth += /^<\//.test(match[0]) ? -1 : 1;
      if (depth) continue;
      if (silent) return true;
      const next = start + source.slice(0, match.index + match[0].length).split('\n').length;
      const token = state.push('html_block', '', 0);
      token.content = state.getLines(start, next, state.blkIndent, true);
      token.map = [start, next];
      state.line = next;
      return true;
    }
    return false;
  });
  return md;
}
