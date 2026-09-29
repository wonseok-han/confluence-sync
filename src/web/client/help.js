export function initHelp(currentMode) {
  const dialog = document.getElementById('help-dialog');
  document.getElementById('open-help').addEventListener('click', () => {
    dialog.showModal();
    // Start with the guide for the active task without changing the workspace.
    document.getElementById('help-' + currentMode()).scrollIntoView({ block: 'start' });
  });
  dialog.querySelectorAll('.help-nav a').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      document.querySelector(link.getAttribute('href')).scrollIntoView({ block: 'start' });
    });
  });
}
