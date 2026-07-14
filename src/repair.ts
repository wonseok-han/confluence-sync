/**
 * 이미 내려받아 둔 .md 를 고친다(사후 보정).
 *
 * html2md 가 개선되기 전에 pull 한 문서에는 변환기 결함의 흔적이 남아 있다.
 * 스페이스를 통째로 다시 받지 않고도 같은 결과를 얻도록, 그 흔적들만 골라 되돌린다.
 * 파일을 덮어쓰므로 **확실한 것만** 고치고, 애매하면 손대지 않는다.
 */
import { relaxEscapes } from './html2md.js';
import { splitFrontmatter } from './obsidian.js';

export type RepairStats = {
  cssJunk: number;      // 본문에 새어 나온 CSS 규칙
  codeLang: number;     // 언어 미지정인데 java 로 찍힌 코드블록
  trailingWs: number;   // 코드블록 안 줄 끝 공백
  escapes: number;      // 불필요한 \ 이스케이프
  tightList: number;    // 리스트 항목 사이 빈 줄
  dupTitle: number;     // frontmatter title 과 겹치는 본문 H1
};

const emptyStats = (): RepairStats => ({ cssJunk: 0, codeLang: 0, trailingWs: 0, escapes: 0, tightList: 0, dupTitle: 0 });
export const totalFixes = (s: RepairStats) => Object.values(s).reduce((a, b) => a + b, 0);

const FENCE = /^\s*(?:```|~~~)/;

/** 리스트 항목이면 종류('ul'|'ol'), 아니면 null. 종류가 다르면 별개의 리스트다. */
function listKind(line: string): 'ul' | 'ol' | null {
  if (/^[ \t]*[-*+]\s/.test(line)) return 'ul';
  if (/^[ \t]*\d+[.)]\s/.test(line)) return 'ol';
  return null;
}

/**
 * Confluence export_view 는 색상 텍스트용 인라인 <style> 을 본문에(제목 안까지) 끼워 넣는데,
 * 예전 변환기는 그 CSS 텍스트를 그대로 뱉었다. `[data-colorid=xxx]{color:#fff;}` 같은 잔해다.
 * (turndown 이 이스케이프해 `\[data-colorid=...\]` 형태로 남아 있기도 하다.)
 */
function stripCssJunk(line: string): string {
  return line
    .replace(/\\?\[data-colorid=[^\]]*\\?\]\s*\{[^}]*\}/g, '') // 선택자 + 규칙 블록
    .replace(/\\?\[data-colorid=[^\]]*\\?\]/g, '')             // 선택자만 남은 것
    .replace(/\{\s*color\s*:\s*[^}]*\}/g, '');                 // 규칙만 남은 것
}

/**
 * 실제 Java 코드로 보이는가?
 * Confluence 는 언어를 지정하지 않은 code 매크로를 export 할 때 `brush: java` 를 기본으로 붙인다.
 * 그래서 예전 변환기는 거의 모든 코드블록을 ```java 로 찍었다. 진짜 Java 만 남기고 plaintext 로 되돌린다.
 */
function looksLikeJava(code: string): boolean {
  return (
    /^\s*(package|import)\s+(java|javax|com|org)\b/m.test(code) ||
    /\b(public|private|protected)\s+(static\s+)?(final\s+)?(class|interface|enum|void)\b/.test(code) ||
    /\bSystem\.(out|err)\.print/.test(code) ||
    /@Override\b/.test(code)
  );
}

/**
 * 리스트 항목 사이의 빈 줄을 없앤다(Confluence 의 <li><p> 때문에 생긴 loose list).
 * 앞뒤가 **같은 종류**의 항목일 때만 붙인다 — 번호 목록과 글머리 목록이 잇달아 나오는 경우
 * 그 사이의 빈 줄은 두 리스트를 갈라놓는 구분자라 지우면 하나로 합쳐져 버린다.
 */
function tightenLists(lines: string[], stats: RepairStats): string[] {
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) inFence = !inFence;

    if (!inFence && line.trim() === '' && out.length) {
      const prev = listKind(out[out.length - 1]);
      const next = listKind(lines[i + 1] ?? '');
      if (prev && prev === next) {
        stats.tightList++;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * frontmatter 에 title 이 있는데 본문 첫 헤딩이 같은 제목이면 그 H1 을 지운다.
 * 제목을 따로 표시하는 뷰어(Obsidian 등)에서 제목이 두 번 보이기 때문이다.
 * 제목이 다르면(본문이 실제로 다른 이야기로 시작하면) 손대지 않는다.
 */
function dropDuplicateTitle(src: string, stats: RepairStats): string {
  const { data, body } = splitFrontmatter(src);
  if (!data.title) return src;

  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.trim() !== '');
  if (i === -1) return src;

  const h1 = lines[i].match(/^#\s+(.*)$/);
  if (!h1 || h1[1].trim() !== data.title.trim()) return src;

  lines.splice(i, 1);
  while (lines[i]?.trim() === '') lines.splice(i, 1); // H1 뒤에 붙어 있던 빈 줄까지
  stats.dupTitle++;

  const fmBlock = src.slice(0, src.length - body.length);
  return fmBlock + lines.join('\n');
}

/** 문서 하나를 보정한다. 반환된 text 가 원본과 같으면 고칠 것이 없었다는 뜻. */
export function repairMarkdown(input: string): { text: string; stats: RepairStats } {
  const stats = emptyStats();
  const src = dropDuplicateTitle(input, stats);
  const lines = src.split('\n');
  const out: string[] = [];

  let inFence = false;
  let fenceStart = -1; // out 기준, 현재 코드블록 여는 줄의 인덱스

  for (const raw of lines) {
    if (FENCE.test(raw)) {
      if (!inFence) {
        inFence = true;
        fenceStart = out.length;
        out.push(raw);
      } else {
        // 코드블록 종료 — 모아둔 내용으로 언어를 판정한다
        inFence = false;
        const opener = out[fenceStart];
        if (/^\s*(?:```|~~~)java\s*$/.test(opener)) {
          const code = out.slice(fenceStart + 1).join('\n');
          if (!looksLikeJava(code)) {
            out[fenceStart] = opener.replace(/java\s*$/, 'plaintext');
            stats.codeLang++;
          }
        }
        out.push(raw);
      }
      continue;
    }

    if (inFence) {
      // 코드 안에서는 줄 끝 공백만 정리한다(코드 의미는 불변). 이스케이프·CSS 는 손대지 않는다.
      const trimmed = raw.replace(/[ \t]+$/, '');
      if (trimmed !== raw) stats.trailingWs++;
      out.push(trimmed);
      continue;
    }

    let line = raw;
    const noCss = stripCssJunk(raw);
    if (noCss !== raw) {
      stats.cssJunk++;
      // 잔해를 걷어낸 자리에 공백이 남는다: "#  {제거됨} 제목" → "# 제목"
      line = noCss.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '');
    }
    out.push(line);
  }

  // 이스케이프 완화는 코드블록을 알아서 건너뛴다(html2md 와 같은 규칙을 재사용)
  let text = relaxEscapes(tightenLists(out, stats).join('\n'));

  // relaxEscapes 가 어디를 바꿨는지 역추적하긴 어려우니, 사라진 백슬래시 개수로 센다
  const backslashes = (s: string) => (s.match(/\\/g) || []).length;
  stats.escapes = Math.max(0, backslashes(src) - backslashes(text));

  // CSS 잔해를 걷어내면 빈 껍데기 제목(`#` 만 남은 줄)이 생길 수 있다
  text = text.replace(/^#{1,6}[ \t]*$/gm, '');

  return { text, stats };
}
