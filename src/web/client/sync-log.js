// Match status prefixes, not words inside document names or paths.
const tones = [
  ['error', /^(?:✗|(?:\w*Error|오류|실패)\s*[:：]|일부 작업이 실패)/],
  ['warning', /^(?:⚠|\[경고\])/],
  ['success', /^(?:\[(?:신규|폴더\+)\]|＋\s*생성|완료(?:\s|$))/],
  ['change', /^(?:\[변경\]|↻\s*갱신)/],
  ['reference', /^(?:참조 링크:|\[연결\]|🔗|♻)/],
  ['muted', /^(?:\[(?:동일|상위|폴더)\]|=\s*변경없음|·\s*상위|--dry-run:)/],
  ['info', /^(?:base:|대상:|📁)/],
];
export function renderSyncLog(element, text) {
  // Polling unchanged output must not disturb text selection or scrolling.
  if (element.textContent === text) return;
  const fragment = document.createDocumentFragment();
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const span = document.createElement('span');
    const tone = tones.find(([, pattern]) => pattern.test(line.trimStart()))?.[0] ?? 'default';
    span.className = 'sync-log-line sync-log-' + tone;
    span.textContent = line; // File names and server messages are plain text, never HTML.
    fragment.append(span);
  }
  element.replaceChildren(fragment);
}
