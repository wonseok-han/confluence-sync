/** Notifications remain visible until explicitly dismissed; repeated visible messages are grouped. */
export function initSnackbars() {
  const region = document.getElementById('snackbars'), visible = new Map();
  return function notify(text, kind = 'info') {
    const key = kind + ':' + text;
    if (!text || visible.has(key)) return;
    const style = { error: ['작업을 완료하지 못했습니다', '!', '오류'], success: ['완료했습니다', '✓', '성공'], warning: ['확인이 필요합니다', '!', '주의'], info: ['안내', 'i', '안내'] }[kind];
    const card = document.createElement('div'); card.className = 'snackbar snackbar-' + kind; card.setAttribute('role', kind === 'error' || kind === 'warning' ? 'alert' : 'status');
    const icon = document.createElement('span'); icon.className = 'snackbar-icon'; icon.textContent = style[1]; icon.setAttribute('aria-hidden', 'true');
    const content = document.createElement('div'); content.className = 'snackbar-content';
    const title = document.createElement('strong'); title.textContent = style[0];
    const message = document.createElement('p'); message.textContent = text; content.append(title, message);
    const close = document.createElement('button'); close.type = 'button'; close.className = 'snackbar-close'; close.textContent = '×'; close.setAttribute('aria-label', style[2] + ' 알림 닫기');
    close.onclick = () => { card.remove(); visible.delete(key); };
    card.append(icon, content, close); visible.set(key, card); region.append(card);
  };
}
