import type MarkdownIt from 'markdown-it';

const styles: Record<string, { title: string; color: string; background: string }> = {
  note: { title: '노트', color: '#526078', background: '#f4f5f7' },
  abstract: { title: '요약', color: '#006b76', background: '#e6fcff' },
  info: { title: '안내', color: '#0747a6', background: '#deebff' },
  todo: { title: '할 일', color: '#0747a6', background: '#deebff' },
  tip: { title: '팁', color: '#006b76', background: '#e6fcff' },
  success: { title: '성공', color: '#006644', background: '#e3fcef' },
  question: { title: '질문', color: '#974f0c', background: '#fff0b3' },
  warning: { title: '주의', color: '#974f0c', background: '#fff0b3' },
  failure: { title: '실패', color: '#ae2a19', background: '#ffebe6' },
  danger: { title: '위험', color: '#ae2a19', background: '#ffebe6' },
  bug: { title: '버그', color: '#ae2a19', background: '#ffebe6' },
  example: { title: '예시', color: '#403294', background: '#eae6ff' },
  quote: { title: '인용', color: '#526078', background: '#f4f5f7' },
};
const aliases: Record<string, string> = { summary: 'abstract', tldr: 'abstract', hint: 'tip', important: 'tip', check: 'success', done: 'success', help: 'question', faq: 'question', caution: 'warning', attention: 'warning', fail: 'failure', missing: 'failure', error: 'danger', cite: 'quote' };
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Transform actual quote tokens, leaving code examples and ordinary quotes untouched. */
export function installCallouts(md: MarkdownIt, format: 'html' | 'storage') {
  md.core.ruler.after('inline', 'obsidian_callouts', state => {
    // Compatibility rendering is read-only and only used to verify older baselines.
    if (state.env?.legacyCallouts) return;
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open' || tokens[i + 1]?.type !== 'paragraph_open' || tokens[i + 2]?.type !== 'inline' || tokens[i + 3]?.type !== 'paragraph_close') continue;
      const inline = tokens[i + 2], newline = inline.content.indexOf('\n');
      const header = newline < 0 ? inline.content : inline.content.slice(0, newline);
      const match = header.match(/^\[!([a-z\d_-]+)\][+-]?(?:[ \t]+(.*))?[ \t]*$/i);
      if (!match) continue;
      let end = i + 1, depth = 1;
      for (; end < tokens.length; end++) {
        if (tokens[end].type === 'blockquote_open') depth++;
        if (tokens[end].type === 'blockquote_close' && --depth === 0) break;
      }
      if (end === tokens.length) continue;
      const raw = match[1].toLowerCase();
      const type = Object.hasOwn(aliases, raw) ? aliases[raw] : raw;
      const style = Object.hasOwn(styles, type) ? styles[type] : styles.note;
      tokens[i].type = 'callout_open'; tokens[i].meta = { ...style, title: match[2]?.trim() || style.title };
      tokens[end].type = 'callout_close';
      if (newline < 0) tokens.splice(i + 1, 3);
      else {
        inline.content = inline.content.slice(newline + 1);
        inline.children = [];
        state.md.inline.parse(inline.content, state.md, state.env, inline.children);
      }
    }
  });
  md.renderer.rules.callout_open = (tokens, idx) => {
    const { title, color, background } = tokens[idx].meta;
    if (format === 'html') return `<blockquote style="background-color:${background};color:${color}"><p><strong>${escape(title)}</strong></p>\n`;
    const parameter = (name: string, value: string) => `<ac:parameter ac:name="${name}">${escape(value)}</ac:parameter>`;
    return '<ac:structured-macro ac:name="panel">' + parameter('title', title) + parameter('borderColor', color) + parameter('titleColor', color) + parameter('titleBGColor', background) + parameter('bgColor', background) + '<ac:rich-text-body>\n';
  };
  md.renderer.rules.callout_close = () => format === 'html' ? '</blockquote>\n' : '</ac:rich-text-body></ac:structured-macro>\n';
}
